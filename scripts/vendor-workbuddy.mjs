// Deterministic declaration extraction. No upstream entrypoint is executed.
import ts from "typescript";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
const base = resolve(process.argv[2] ?? "../.cache/router-upstream-workbuddy");
const dest = resolve("src/host/workbuddy/vendor");
const methods = new Set([
  "constructor",
  "chatStream",
  "refreshToken",
  "fetchModels",
  "fetchCheckinStatus",
  "fetchBenefits",
  "readBenefitStatus",
  "claimBenefit",
  "claimDailyCheckin",
  "fetchEnterpriseCredits",
  "fetchCredits",
]);
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const receipt = [];
async function extract(file, roots) {
  const source = await readFile(join(base, "src", file), "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = new Map();
  for (let node of sf.statements) {
    if (
      ts.isClassDeclaration(node) &&
      node.name?.text === "WorkBuddyUpstreamClient"
    )
      node = ts.factory.updateClassDeclaration(
        node,
        node.modifiers,
        node.name,
        node.typeParameters,
        node.heritageClauses,
        node.members.filter((m) =>
          methods.has(
            ts.isConstructorDeclaration(m)
              ? "constructor"
              : m.name?.getText(sf),
          ),
        ),
      );
    const names = ts.isVariableStatement(node)
      ? node.declarationList.declarations.map((d) => d.name.getText(sf))
      : node.name
        ? [node.name.text]
        : [];
    for (const name of names) declarations.set(name, node);
  }
  const used = new Set(roots),
    nodes = new Set();
  function visit(node) {
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...used]) {
      const n = declarations.get(name);
      if (n && !nodes.has(n)) {
        nodes.add(n);
        visit(n);
        changed = true;
      }
    }
  }
  const imports = [];
  for (const n of sf.statements) {
    if (!ts.isImportDeclaration(n)) continue;
    const clause = n.importClause,
      bindings = clause?.namedBindings;
    if (!clause || !bindings || !ts.isNamedImports(bindings)) continue;
    const selected = bindings.elements.filter((s) => used.has(s.name.text));
    if (!selected.length) continue;
    imports.push(
      printer.printNode(
        ts.EmitHint.Unspecified,
        ts.factory.updateImportDeclaration(
          n,
          n.modifiers,
          ts.factory.updateImportClause(
            clause,
            clause.isTypeOnly,
            clause.name,
            ts.factory.updateNamedImports(bindings, selected),
          ),
          n.moduleSpecifier,
          n.attributes,
        ),
        sf,
      ),
    );
  }
  const text =
    "// Adapted from dingminhua/dsh-connect-workbuddy @ 3b558326a962aa2cfa57ff558b452f7635b447ac.\n// MIT; Copyright (c) 2026 LaoDing. See THIRD_PARTY_NOTICES.md.\n" +
    imports.join("\n") +
    "\n" +
    [...nodes]
      .sort((a, b) => a.pos - b.pos)
      .map((n) => printer.printNode(ts.EmitHint.Unspecified, n, sf))
      .join("\n\n") +
    "\n";
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, file), text);
  receipt.push({
    source: "src/" + file,
    sha256: createHash("sha256").update(source).digest("hex"),
    selectedRoots: roots,
    initialExtractSha256: createHash("sha256").update(text).digest("hex"),
  });
}
await extract("upstream.ts", [
  "WorkBuddyUpstreamClient",
  "WorkBuddyCredentialRejectedError",
  "parseCreditMultiplier",
  "regionOf",
]);
await extract("auth.ts", ["WorkBuddyCredential"]);
for (const file of [
  "oauth.ts",
  "context-rescue.ts",
  "promo.ts",
  "queue.ts",
  "native-modality.ts",
  "busy.ts",
]) {
  const source = await readFile(join(base, "src", file), "utf8");
  await writeFile(join(dest, file), source);
  receipt.push({
    source: "src/" + file,
    sha256: createHash("sha256").update(source).digest("hex"),
    copied: true,
  });
}
await mkdir("third-party", { recursive: true });
for (const [source, target] of [
  ["LICENSE", "workbuddy-MIT.txt"],
  ["THIRD_PARTY_NOTICES.md", "workbuddy-notices.md"],
])
  await writeFile(
    join("third-party", target),
    await readFile(join(base, source)),
  );
await writeFile(
  "third-party/workbuddy-source.json",
  JSON.stringify(
    {
      repository: "https://github.com/dingminhua/dsh-connect-workbuddy",
      commit: "3b558326a962aa2cfa57ff558b452f7635b447ac",
      files: receipt,
    },
    null,
    2,
  ) + "\n",
);
