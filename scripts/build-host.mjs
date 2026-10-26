import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2023",
  packages: "external",
});
console.log("Backend module built; client/patch/package acceptance pending.");
