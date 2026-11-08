import { cp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const resources = join(root, 'build-resources')
await mkdir(resources, { recursive: true })
for (const relative of ['backend/node', 'backend/server.mjs', 'search/soma-search/soma-search']) {
  if (!(await stat(join(resources, relative))).isFile()) throw new Error(`Missing runtime: ${relative}. Run npm run package:backend and npm run package:search first.`)
}
const ui = join(resources, 'ui')
if (resolve(ui) !== resolve(root, 'build-resources/ui')) throw new Error('Invalid UI staging path')
await rm(ui, { recursive: true, force: true })
await cp(join(root, 'dist'), ui, { recursive: true })
await cp(join(root, 'server/searxng/settings.yml'), join(resources, 'settings.yml'))
const licenses = join(resources, 'licenses')
await mkdir(licenses, { recursive: true })
await cp(join(root, '.searxng/src/LICENSE'), join(licenses, 'SearXNG-AGPL-3.0.txt'))
await cp(join(root, 'build-resources/backend/LICENSE'), join(licenses, 'Node-LICENSE.txt'))
// Ship the actual upstream source and our launcher so the search component remains inspectable.
execFileSync('/usr/bin/tar', ['-czf', join(licenses, 'SearXNG-source.tar.gz'), '--exclude=__pycache__', '--exclude=*.pyc', '-C', join(root, '.searxng'), 'src', '-C', root, 'server/searxng', 'scripts/package-search.py'])
await writeFile(join(licenses, 'NOTICE.txt'), `Soma desktop 0.1.0

SearXNG: official upstream source commit cccbc9e158b0ac3bb2158e9841a647a5bec57b57, AGPL-3.0.
Full bundled upstream search source and Soma's search launcher are in SearXNG-source.tar.gz.
Node.js: official macOS arm64 binary and LICENSE included; exact version/checksums in backend/runtime.json.
Python and Python modules: frozen with PyInstaller; included metadata/licenses are in search runtime resources.
React, Motion, Base UI, Phosphor: frontend dependency metadata in frontend-notices.json.

This local development distribution is ad-hoc signed, not Apple Developer ID notarized.
` )
const packages = ['react', 'react-dom', 'motion', '@base-ui/react', '@phosphor-icons/react', 'react-markdown', 'remark-gfm']
const notices = []
for (const name of packages) {
  const path = join(root, 'node_modules', name)
  const meta = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
  notices.push({ name, version: meta.version, license: meta.license })
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try { await cp(join(path, filename), join(licenses, name.replaceAll('/', '-') + '-' + filename)); break } catch {}
  }
}
await writeFile(join(licenses, 'frontend-notices.json'), JSON.stringify(notices, null, 2) + String.fromCharCode(10))
console.log('Desktop resources staged:', resources)
