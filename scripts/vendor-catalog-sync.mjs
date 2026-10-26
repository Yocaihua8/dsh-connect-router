// Extract only the fixed upstream roster merge helpers; do not execute upstream code.
import ts from 'typescript';
import { readFile, writeFile } from 'node:fs/promises';
const file = '../.cache/router-upstream-workbuddy/src/catalog-sync.ts';
const sf = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['LIVE_OWNED_FIELDS', 'overlayLiveCapabilities', 'mergeRoster']);
const printer = ts.createPrinter();
const nodes = sf.statements.filter(n => names.has(n.name?.text ?? n.declarationList?.declarations[0]?.name?.text));
await writeFile('src/host/workbuddy/vendor/catalog-sync.ts', '// Adapted from dingminhua/dsh-connect-workbuddy @ 3b558326a962aa2cfa57ff558b452f7635b447ac.\n// MIT; Copyright (c) 2026 LaoDing. See THIRD_PARTY_NOTICES.md.\nimport type { WorkBuddyUpstreamModel as WorkBuddyModelInfo } from "./upstream.js";\n' + nodes.map(n => printer.printNode(ts.EmitHint.Unspecified, n, sf)).join('\n'));
