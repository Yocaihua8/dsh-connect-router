import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'



/** Build from the plugin's installed tools; no runtime import refers to this workspace script. */
async function buildPlugin(entryUrl) {
  const root = fileURLToPath(new URL('../', entryUrl))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const options = {}

  const require = createRequire(join(root, 'package.json'))
  const { build } = await import(pathToFileURL(require.resolve('esbuild')).href)
  const { WorkspaceAnalyzer, FaceModelEmitter, writeWorkspaceArtifacts } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-generator')).href)
  // The official generator needs a packages/ workspace and protocol source identity.
  const workspace = join(root, '.cache/typert')
  const staged = join(workspace, 'packages/plugin')
  const protocol = join(workspace, 'packages/protocol')
  await cp(dirname(require.resolve('@deepseek-ai/dsh-typert-protocol/package.json')), protocol, { recursive: true })
  for (const entry of await readdir(join(protocol, 'lib/types'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue
    const source = join(entry.parentPath, entry.name)
    const target = source.replace(join(protocol, 'lib/types'), join(protocol, 'src')).replace(/\.d\.ts$/, '.ts')
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target)
  }
  await mkdir(staged, { recursive: true })
  await cp(join(root, 'src'), join(staged, 'src'), { recursive: true })
  for (const asset of options.assets ?? []) await cp(join(root, asset), join(staged, asset), { recursive: true })
  const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'))
  config.include = ['src/index.ts', 'src/host/**/*.ts', 'src/shared/**/*.ts']
  config.compilerOptions.allowImportingTsExtensions = true
  config.compilerOptions.lib.push('ESNext.Disposable')
  config.compilerOptions.paths = { '@deepseek-ai/dsh-typert-protocol': [join(protocol, 'src/index.ts')] }
  await writeFile(join(protocol, 'tsconfig.json'), JSON.stringify({ compilerOptions: config.compilerOptions, include: ['src/**/*.ts'] }, null, 2))
  const hostManifest = structuredClone(manifest)
  delete hostManifest.exports['./client']
  await writeFile(join(staged, 'package.json'), JSON.stringify(hostManifest, null, 2))
  await writeFile(join(staged, 'tsconfig.json'), JSON.stringify(config, null, 2))
  await writeFile(join(workspace, 'tsconfig.host.json'), JSON.stringify({
    ...config, files: [], include: [], references: [{ path: './packages/plugin/tsconfig.json' }, { path: './packages/protocol/tsconfig.json' }],
  }, null, 2))
  const model = new WorkspaceAnalyzer({ root: workspace, packages: [manifest.name], faces: ['host'] }).analyze()
  const artifacts = model.faces.flatMap(face => face.packages.map(pkg => ({
    ...new FaceModelEmitter(face).emit(pkg.name), packageRoot: pkg.root,
  })))
  if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('Expected one generated Host and Remote contribution')
  writeWorkspaceArtifacts(workspace, artifacts)
  await mkdir(join(root, 'lib'), { recursive: true })
  for (const name of ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts']) {
    await cp(join(staged, 'lib', name), join(root, 'lib', name))
  }
  await build({
    absWorkingDir: root, entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true,
    platform: 'node', format: 'esm', target: 'es2023', packages: 'external',
  })
  for (const name of ['types', ...options.publicModules ?? []]) {
    await build({ absWorkingDir: root, entryPoints: [`src/shared/${name}.ts`], outfile: `lib/shared/${name}.js`,
      bundle: true, packages: 'external', format: 'esm', platform: 'neutral' })
  }
  await build({
    absWorkingDir: root, entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true,
    platform: 'browser', format: 'cjs', target: 'es2022', loader: { '.css': 'text' },
    external: ['react', 'react/jsx-runtime', 'react-dom', 'zod', '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-api-gateway/client'],
    banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
    footer: { js: 'return module.exports; }});' },
  })
  for (const name of ['tsconfig.json', 'tsconfig.client.json']) {
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', name], { cwd: root, stdio: 'inherit' })
  }
  console.log(`${manifest.name}: built Host, browser module, declarations, and Typert RPC artifacts.`)
}

await buildPlugin(import.meta.url)
