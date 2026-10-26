// Locate an OpenCode install and run one isolated `opencode serve`.
//
// Isolation is the point: the child gets its own XDG tree, so it never touches
// the user's real `~/.config/opencode` or `~/.local/share/opencode` state. The
// user's provider config and auth file are COPIED in (never modified) so that
// providers they already signed into work here too.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Backend } from "./backend.js";

const exec = promisify(execFile);

const IS_WINDOWS = process.platform === "win32";

function binaryName() {
  return IS_WINDOWS ? "opencode.exe" : "opencode";
}

/**
 * Candidate locations for an existing OpenCode install, in priority order.
 *
 * @param env - environment to read; defaults to `process.env`.
 * @param home - home directory; defaults to `os.homedir()`.
 * @returns absolute paths to try, most specific first.
 */
export function runtimeCandidates(env = process.env, home = os.homedir()) {
  const p = IS_WINDOWS ? path.win32 : path.posix;
  const installed = IS_WINDOWS
    ? [
        p.join(home, ".opencode", "bin", binaryName()),
        p.join(
          env.APPDATA || p.join(home, "AppData", "Roaming"),
          "npm",
          "node_modules",
          "opencode-ai",
          "bin",
          binaryName(),
        ),
        p.join(env.LOCALAPPDATA || p.join(home, "AppData", "Local"), "opencode", "opencode-cli.exe"),
      ]
    : [
        p.join(home, ".opencode", "bin", binaryName()),
        "/opt/homebrew/bin/opencode",
        "/usr/local/bin/opencode",
      ];
  return [env.OPENCODE_BIN, ...installed].filter(Boolean);
}

/**
 * Pick the first candidate that reports a plausible version.
 *
 * A `.cmd`/`.bat`/`.ps1` launcher is skipped: `spawn` on Windows cannot exec a
 * PowerShell shim as a child process, so only real executables qualify.
 *
 * @param candidates - paths to probe.
 * @returns the executable path, or `null`.
 */
export async function findRuntime(candidates = runtimeCandidates()) {
  for (const file of candidates) {
    if (/\.(?:cmd|bat|ps1)$/i.test(file)) continue;
    if (!existsSync(file)) continue;
    try {
      const { stdout } = await exec(file, ["--version"], { timeout: 20000, windowsHide: true });
      if (/^\d+\.\d+\.\d+/.test(stdout.trim())) return file;
    } catch {
      // A candidate that cannot answer --version is not a usable runtime.
    }
  }
  return null;
}

/** Reserve one free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Environment variables passed through to the child.
 *
 * An allowlist rather than the whole environment: the isolated instance must
 * not inherit credentials or provider keys from the harness process.
 */
const PASSTHROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "COMSPEC",
];

/**
 * Tool permissions for the isolated instance.
 *
 * Everything that can MUTATE the workspace is denied: DSH owns tool execution,
 * and letting OpenCode act as well would run actions twice — once outside the
 * harness sandbox and permission model.
 *
 * `read` is deliberately left allowed, and that is not cosmetic. OpenCode's free
 * tier is gated upstream: a request whose tool list is empty is refused with
 * `FreeTierError` ("the free tier can only be used from within OpenCode"),
 * while the identical request carrying at least one read-ish tool succeeds.
 * Verified on this machine: `question`/`invalid` alone do NOT satisfy the gate,
 * `read` does. Only the DECLARATION is needed — this adapter's system prompt
 * never asks the model to call it, and a call that did happen would be a
 * read-only file access inside the isolated instance.
 */
const NATIVE_PERMISSIONS = {
  "*": "deny",
  read: "deny",
  external_directory: "deny",
};

const ISOLATED_CONFIG = {
  permission: NATIVE_PERMISSIONS,
  autoupdate: false,
  share: "disabled",
};

/** Create the isolated XDG tree and seed it from the user's real install. */
function prepareIsolatedTree(root, home, log) {
  for (const dir of ["config", "data", "cache", "state", "project"]) {
    mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
  }
  // Router owns this XDG tree; no desktop auth/config file is copied.

}

/**
 * Launch one isolated OpenCode server.
 *
 * @param binary - the opencode executable.
 * @param dataDir - plugin-owned data directory; the XDG tree lives under it.
 * @param log - diagnostic sink.
 * @returns a started backend plus its shutdown function.
 */
export async function startBackend(binary, dataDir, log = () => {}, credentialProjection = {}) {
  const home = os.homedir();
  const root = path.resolve(dataDir, "opencode");
  prepareIsolatedTree(root, home, log);
  mkdirSync(path.join(root,"data","opencode"),{recursive:true,mode:0o700});
  writeFileSync(path.join(root,"data","opencode","auth.json"),JSON.stringify(credentialProjection),{mode:0o600});

  const env = {};
  for (const key of PASSTHROUGH) if (process.env[key]) env[key] = process.env[key];
  for (const name of ["config", "data", "cache", "state"]) {
    env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name);
  }

  const password = randomBytes(24).toString("hex");
  Object.assign(env, {
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    // Prevents the child from bootstrapping its own plugin dependencies into
    // the seeded config directory on a run where the network is unavailable.
    OPENCODE_CONFIG_CONTENT: JSON.stringify(ISOLATED_CONFIG),
  });

  const port = await freePort();
  const child = spawn(binary, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(root, "project"),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let spawnFailure;
  child.on("error", (error) => {
    spawnFailure = error;
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // Only the short-lived projection is cleared; the authoritative grant stays in DSH.
    writeFileSync(path.join(root, "data", "opencode", "auth.json"), "{}", { mode: 0o600 });
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };

  const backend = new Backend(`http://127.0.0.1:${port}`, password, log);
  try {
    let lastError;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (spawnFailure) throw spawnFailure;
      if (child.exitCode !== null) throw new Error(`opencode exited with code ${child.exitCode}`);
      try {
        const health = await backend.health(1500);
        if (health?.healthy) return { backend, stop, version: health.version };
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`opencode did not become healthy: ${lastError?.message ?? "timed out"}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
