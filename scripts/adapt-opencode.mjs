import { readFile, writeFile } from "node:fs/promises";
const base = "src/host/opencode/vendor/";
let runtime = await readFile(base + "runtime.js", "utf8");
runtime = runtime.replace(
  "copyFileSync, existsSync, mkdirSync, chmodSync",
  "existsSync, mkdirSync, writeFileSync",
);
const seedStart = runtime.indexOf("  const seeds = ["),
  seedEnd = runtime.indexOf("\n}\n", seedStart);
runtime =
  runtime.slice(0, seedStart) +
  "  // Router owns this XDG tree; no desktop auth/config file is copied.\n" +
  runtime.slice(seedEnd);
runtime = runtime.replace(
  '  read: "allow",',
  '  read: "deny",\n  external_directory: "deny",',
);
runtime = runtime.replace(
  "startBackend(binary, dataDir, log = () => {})",
  "startBackend(binary, dataDir, log = () => {}, credentialProjection = {})",
);
runtime = runtime.replace(
  "  prepareIsolatedTree(root, home, log);",
  '  prepareIsolatedTree(root, home, log);\n  mkdirSync(path.join(root,"data","opencode"),{recursive:true,mode:0o700});\n  writeFileSync(path.join(root,"data","opencode","auth.json"),JSON.stringify(credentialProjection),{mode:0o600});',
);
runtime = runtime.replace(
  'child.stdout?.on("data", (data) => log(`[opencode] ${String(data).trim()}`));',
  'child.stdout?.on("data", () => {});',
);
runtime = runtime.replace(
  'child.stderr?.on("data", (data) => log(`[opencode:err] ${String(data).trim()}`));',
  'child.stderr?.on("data", () => {});',
);
await writeFile(base + "runtime.js", runtime);
let bridge = await readFile(base + "bridge.js", "utf8");
bridge = bridge.replace(
  "for (let attempt = 1; attempt <= 2; attempt += 1)",
  "for (let attempt = 1; attempt <= 1; attempt += 1)",
);
bridge = bridge.replace(
  "if (!canRepair(error, request)) throw error;",
  "throw error; // Router: no hidden second provider request.",
);
bridge = bridge.replace(
  "        addTokens(final.tokens, response?.info?.tokens);",
  `        const finish = response?.info?.finish;
        if (!['stop','tool-calls'].includes(finish)) {
          // Preserve plain text already streamed; never decode/release incomplete tools.
          throw new BridgeError('OpenCode did not confirm a complete response', 502, finish === 'length' ? 'OUTPUT_TRUNCATED' : 'MISSING_COMPLETION_EVIDENCE');
        }
        addTokens(final.tokens, response?.info?.tokens);`,
);
await writeFile(base + "bridge.js", bridge);
let catalog = await readFile(base + "catalog.js", "utf8");
catalog = catalog.replace(
  "const free =\n",
  'const knownPrice = typeof cost.input === "number" && Number.isFinite(cost.input) && cost.input >= 0 && typeof cost.output === "number" && Number.isFinite(cost.output) && cost.output >= 0;\n  const free = knownPrice &&\n',
);
catalog = catalog.replace(
  "    free,",
  "    free,\n    priceKnown: knownPrice,",
);
catalog = catalog.replace(
  "toolCall: capabilities.toolcall !== false",
  "toolCall: capabilities.toolcall === true",
);
await writeFile(base + "catalog.js", catalog);
