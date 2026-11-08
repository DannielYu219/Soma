import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Pin the official distribution, including its checksum, so rebuilds use the same runtime.
const NODE_VERSION = '24.22.2'
const ARCHIVE_SHA256 = '1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115'
const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'build-resources/backend')
const executable = join(output, 'node')
const server = join(output, 'server.mjs')
const metadataPath = join(output, 'runtime.json')
const archiveName = `node-v${NODE_VERSION}-darwin-arm64.tar.xz`
const distributionUrl = `https://nodejs.org/dist/v${NODE_VERSION}`

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function proxyUrl() {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (process.env[name]) return process.env[name]
  }
  try {
    const settings = run('/usr/sbin/scutil', ['--proxy'])
    for (const protocol of ['HTTPS', 'HTTP']) {
      if (!new RegExp(`\\b${protocol}Enable : 1\\b`).test(settings)) continue
      const host = settings.match(new RegExp(`\\b${protocol}Proxy : (\\S+)`))?.[1]
      const port = settings.match(new RegExp(`\\b${protocol}Port : (\\d+)`))?.[1]
      if (host && port) return `http://${host}:${port}`
    }
  } catch { /* No system proxy configured. */ }
  return undefined
}

function download(url, destination) {
  const proxy = proxyUrl()
  run('/usr/bin/curl', [
    '--proto', '=https', '--tlsv1.2', '--fail', '--location', '--silent', '--show-error',
    '--retry', '2', '--connect-timeout', '20', '--max-time', '240',
    ...(proxy ? ['--proxy', proxy] : []), '--output', destination, url,
  ])
}

function inspectRuntime() {
  const info = JSON.parse(run(executable, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})']))
  assert.deepEqual(info, { version: NODE_VERSION, platform: 'darwin', arch: 'arm64' })
  const dependencies = run('/usr/bin/otool', ['-L', executable]).split('\n').slice(1)
    .map(line => line.trim().split(' (')[0]).filter(Boolean)
  assert(dependencies.length > 0, 'Node must have inspectable dynamic dependencies')
  for (const dependency of dependencies) {
    assert(dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/'), `Non-system Node dependency: ${dependency}`)
  }
  run('/usr/bin/codesign', ['--verify', '--strict', executable])
  return { ...info, dependencies }
}

async function ensureRuntime() {
  try {
    const existing = JSON.parse(await readFile(metadataPath, 'utf8'))
    if (existing.node.archiveSha256 === ARCHIVE_SHA256 &&
        existing.node.executableSha256 === sha256(await readFile(executable))) {
      const info = inspectRuntime()
      await readFile(join(output, 'LICENSE'))
      return { ...existing.node, ...info }
    }
  } catch { /* Missing or changed generated resources are rebuilt. */ }

  const temporary = await mkdtemp(join(tmpdir(), 'soma-node-runtime-'))
  try {
    const archive = join(temporary, archiveName)
    const checksums = join(temporary, 'SHASUMS256.txt')
    download(`${distributionUrl}/SHASUMS256.txt`, checksums)
    const published = (await readFile(checksums, 'utf8')).split('\n')
      .find(line => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0]
    assert.equal(published, ARCHIVE_SHA256, 'Published Node archive checksum does not match the pinned release')
    console.log(`Downloading official Node ${NODE_VERSION} for macOS arm64…`)
    download(`${distributionUrl}/${archiveName}`, archive)
    assert.equal(sha256(await readFile(archive)), ARCHIVE_SHA256, 'Node archive checksum mismatch')
    const extracted = `node-v${NODE_VERSION}-darwin-arm64`
    run('/usr/bin/tar', ['-xJf', archive, '-C', temporary, `${extracted}/bin/node`, `${extracted}/LICENSE`])
    await copyFile(join(temporary, extracted, 'bin/node'), executable)
    await chmod(executable, 0o755)
    await copyFile(join(temporary, extracted, 'LICENSE'), join(output, 'LICENSE'))
    return {
      ...inspectRuntime(),
      distributionUrl: `${distributionUrl}/${archiveName}`,
      archiveSha256: ARCHIVE_SHA256,
      executableSha256: sha256(await readFile(executable)),
    }
  } finally {
    // mkdtemp created this exact directory; verify its resolved parent before deletion.
    assert.equal(dirname(await realpath(temporary)), await realpath(tmpdir()))
    assert(temporary.startsWith(join(tmpdir(), 'soma-node-runtime-')))
    await rm(temporary, { recursive: true, force: true })
  }
}

assert.equal(process.platform, 'darwin', 'This packager targets macOS arm64')
assert.equal(process.arch, 'arm64', 'Run the packager with an arm64 host Node')
await mkdir(output, { recursive: true })
const node = await ensureRuntime()
// import.meta.url in the bundled search launcher resolves beside server.mjs.
await mkdir(join(output, 'searxng'), { recursive: true })
for (const file of ['launcher.py', 'settings.yml', 'proxy.py']) {
  const destination = join(output, 'searxng', file)
  await copyFile(join(root, 'server/searxng', file), destination)
  await chmod(destination, 0o644)
}
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['server/index.ts'],
  outfile: server,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'info',
})
// Only Node built-ins may remain external; no node_modules or source checkout is shipped.
for (const result of Object.values(bundle.metafile.outputs)) {
  for (const dependency of result.imports) {
    assert(dependency.external && dependency.path.startsWith('node:'), `Unexpected runtime import: ${dependency.path}`)
  }
}
const bundledSource = await readFile(server, 'utf8')
assert(!bundledSource.includes(resolve(root)), 'Bundled backend contains an absolute source checkout path')
assert(!/sourceMappingURL=/.test(bundledSource), 'Packaged backend must not reference a source map')
await writeFile(metadataPath, `${JSON.stringify({
  schemaVersion: 1,
  node,
  backend: { entry: 'server.mjs', format: 'esm', sha256: sha256(bundledSource), externalDependencies: 'node built-ins only' },
  launch: {
    executable: 'node', args: ['server.mjs'],
    environment: {
      SOMA_BACKEND_HOST: '127.0.0.1',
      SOMA_BACKEND_PORT: '<desktop-selected port>',
      SOMA_SESSION_TOKEN: '<fresh random per-launch secret, never bundled>',
      SOMA_STATIC_DIR: '<absolute packaged dist directory>',
      SOMA_SEARXNG_DIR: '<absolute packaged SearXNG source directory>',
      SOMA_SEARXNG_PYTHON: '<absolute packaged Python executable>',
      SOMA_SEARXNG_URL: 'http://127.0.0.1:<desktop-selected search port>',
      SOMA_SEARXNG_AUTOSTART: '0 when the desktop starts search; 1 to let this backend start it',
      SOMA_EXIT_ON_STDIN_CLOSE: '1',
    },
  },
}, null, 2)}\n`)
console.log(`Backend resources ready: ${output}`)
console.log(`Launch: ${executable} ${server}`)
