import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
const base = resolve("../../dsh-link-opencode"),
  target = "src/host/opencode/vendor";
await mkdir(target, { recursive: true });
const files = [];
for (const name of [
  "backend.js",
  "bridge.js",
  "protocol.js",
  "runtime.js",
  "catalog.js",
]) {
  const bytes = await readFile(join(base, "lib", name));
  await writeFile(join(target, name), bytes);
  files.push({
    path: "lib/" + name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(
  "third-party/opencode-source.json",
  JSON.stringify(
    {
      repository: "https://github.com/Yocaihua8/dsh-link-opencode",
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: base,
        encoding: "utf8",
      }).trim(),
      status: execFileSync("git", ["status", "--porcelain"], {
        cwd: base,
        encoding: "utf8",
      })
        .trim()
        .split("\n"),
      files,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  "third-party/opencode-package.json",
  await readFile(join(base, "package.json")),
);
