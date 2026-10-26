import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'
import assert from 'node:assert/strict'



/** Check the actual tarball allowlist without overwriting any existing archive. */
async function checkPackage(entryUrl) {
  const root = fileURLToPath(new URL('../', entryUrl))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const options = { dshEngine: '0.2.1-rc.3', documents: ['docs/installation.md', 'THIRD_PARTY_NOTICES.md'], required: ['third-party/workbuddy-MIT.txt','third-party/opencode-MIT.txt'] }

  if (!process.env.npm_execpath) throw new Error('Run through npm run check:package')
  const [pack] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8' }))
  const files = new Set(pack.files.map(entry => entry.path))
  for (const target of Object.values(manifest.exports)) {
    for (const path of typeof target === 'string' ? [target] : Object.values(target)) {
      const relative = path.replace(/^\.\//, '')
      if (relative.includes('*')) {
        const pattern = new RegExp(`^${relative.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
        assert.ok([...files].some(file => pattern.test(file)), `Missing export: ${path}`)
      } else assert.ok(files.has(relative), `Missing export: ${path}`)
    }
  }
  for (const required of ['README.md', 'cordis.patch.yml', 'docs/verification.md',
    ...(options.noLicenseFile ? [] : ['LICENSE']), ...(options.documents ?? []), ...(options.required ?? [])]) {
    assert.ok(files.has(required), `Missing ${required}`)
  }
  if (options.portrait) {
    const portrait = await readFile(join(root, options.portrait))
    assert.equal(portrait.subarray(0, 3).toString('hex'), 'ffd8ff', 'Bundled portrait must retain its original JPEG format')
  }
  for (const path of files) {
    assert.ok(!/^(?:src|test|scripts|shared|node_modules|\.cache|output|\.playwright-cli)\//.test(path), `Unexpected package source/cache: ${path}`)
    assert.ok(!/(?:^|\/)(?:\.env|\.credentials|auth\.json)/.test(path), `Unexpected private config: ${path}`)
    if (!/\.(?:js|mjs|d\.ts)$/.test(path)) continue
    const source = await readFile(join(root, path), 'utf8')
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(root, dirname(path), match[1])
      // Runtime and declaration relative imports must remain inside the published package.
      const local = relative(root, target)
      const packed = local.replaceAll('\\', '/')
      assert.ok(local !== '..' && !local.startsWith(`..${sep}`)
        && (files.has(packed) || path.endsWith('.d.ts') && files.has(packed.replace(/(?<!\.d)\.[jt]s$/, '.d.ts'))), `Unpacked relative import: ${path} -> ${match[1]}`)
    }
  }
  assert.equal(manifest.engines.dsh, options.dshEngine ?? '0.2.1-rc.2')
  console.log(`${manifest.name}: package verified (${files.size} files, ${pack.unpackedSize} unpacked bytes).`)
}

await checkPackage(import.meta.url)
