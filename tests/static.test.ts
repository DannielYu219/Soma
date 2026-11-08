import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'

async function startWithUi() {
  const root = await mkdtemp(join(tmpdir(), 'soma-ui-'))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Soma</title>')
  await writeFile(join(root, 'assets', 'app-abc123.js'), 'console.log(1)')
  await writeFile(join(root, 'soma.svg'), '<svg/>')
  const cfg = { ...loadConfig({}), staticDir: root, searxngUrl: 'http://127.0.0.1:1', allowedOrigins: ['http://127.0.0.1:5173'] }
  const app = createApp(cfg)
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
  return { base, close: () => new Promise<void>(resolve => { app.closeAllConnections(); app.close(() => resolve()) }) }
}

/** Raw request so the path is sent exactly as written (fetch would normalize dot segments). */
function rawGet(base: string, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    http.get({ host: hostname, port, path }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    }).on('error', reject)
  })
}

test('the UI index is served at the root and client routes fall back to it', async () => {
  const h = await startWithUi()
  try {
    const root = await rawGet(h.base, '/')
    assert.equal(root.status, 200)
    assert.match(String(root.headers['content-type']), /text\/html/)
    assert.equal(root.headers['cache-control'], 'no-cache')
    assert.match(root.body, /<title>Soma<\/title>/)

    const route = await rawGet(h.base, '/settings/anything')
    assert.equal(route.status, 200)
    assert.match(route.body, /<title>Soma<\/title>/)
  } finally { await h.close() }
})

test('hashed assets are served with long-lived caching and the right type', async () => {
  const h = await startWithUi()
  try {
    const asset = await rawGet(h.base, '/assets/app-abc123.js')
    assert.equal(asset.status, 200)
    assert.match(String(asset.headers['content-type']), /javascript/)
    assert.match(String(asset.headers['cache-control']), /immutable/)
    const svg = await rawGet(h.base, '/soma.svg')
    assert.equal(svg.headers['content-type'], 'image/svg+xml')
  } finally { await h.close() }
})

test('missing files with an extension are 404, not the index', async () => {
  const h = await startWithUi()
  try {
    const missing = await rawGet(h.base, '/missing.png')
    assert.equal(missing.status, 404)
    assert.doesNotMatch(missing.body, /<title>Soma/)
  } finally { await h.close() }
})

test('path traversal outside the UI directory is refused', async () => {
  const h = await startWithUi()
  try {
    const attack = await rawGet(h.base, '/%2e%2e/%2e%2e/etc/passwd')
    assert.equal(attack.status, 403)
    assert.doesNotMatch(attack.body, /root:/)
  } finally { await h.close() }
})

test('a request from the same origin as the page is allowed without being listed', async () => {
  const h = await startWithUi()
  try {
    const sameOrigin = await fetch(`${h.base}/health`, { headers: { origin: h.base } })
    assert.equal(sameOrigin.status, 200)
    const other = await fetch(`${h.base}/health`, { headers: { origin: 'http://evil.example' } })
    assert.equal(other.status, 403)
  } finally { await h.close() }
})
