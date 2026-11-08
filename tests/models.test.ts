import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'

function listen(server: http.Server): Promise<void> { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)) }
function close(server: http.Server): Promise<void> { return new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
function url(server: http.Server): string { return `http://127.0.0.1:${(server.address() as AddressInfo).port}` }

type Protocol = 'openai-compatible' | 'responses' | 'anthropic'
interface Fixture {
  api: string
  upstream: http.Server
  upstreamBase: string
  captured: Array<{ path: string; headers: http.IncomingHttpHeaders }>
  close(): Promise<void>
}

async function fixture(protocol: Protocol, response: (req: http.IncomingMessage, res: http.ServerResponse) => void, apiKey = 'secret-key'): Promise<Fixture> {
  const captured: Array<{ path: string; headers: http.IncomingHttpHeaders }> = []
  const upstream = http.createServer((req, res) => {
    captured.push({ path: req.url ?? '', headers: req.headers })
    response(req, res)
  })
  await listen(upstream)
  const base = url(upstream)
  const app = createApp({
    ...loadConfig({}),
    openaiBaseUrl: `${base}/v1`,
    anthropicBaseUrl: base,
    staticDir: '',
    allowedOrigins: [],
  })
  await listen(app)
  return { api: url(app), upstream, upstreamBase: base, captured, close: async () => { await close(app); await close(upstream) } }
}

async function enumerate(api: string, service: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${api}/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(service),
  })
}

for (const protocol of ['openai-compatible', 'responses'] as const) {
  test(`${protocol} enumerates models with bearer auth`, async () => {
    const h = await fixture(protocol, (_req, res) => res.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta', name: 'Beta' }] })))
    try {
      const response = await enumerate(h.api, { provider: protocol, baseUrl: '', apiKey: 'secret-key' })
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()).models, [{ id: 'alpha', name: 'alpha' }, { id: 'beta', name: 'Beta' }])
      assert.equal(h.captured[0].path, '/v1/models')
      assert.equal(h.captured[0].headers.authorization, 'Bearer secret-key')
    } finally { await h.close() }
  })
}

test('anthropic enumerates models with official headers and pagination', async () => {
  let calls = 0
  const h = await fixture('anthropic', (req, res) => {
    calls += 1
    const query = new URL(req.url ?? '/', 'http://local').searchParams
    res.end(JSON.stringify(calls === 1
      ? { data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: true }
      : { data: [{ id: 'claude-b', display_name: 'Claude B' }], has_more: false }))
    assert.equal(query.get('limit'), '100')
  })
  try {
    const response = await enumerate(h.api, { provider: 'anthropic', baseUrl: '', apiKey: 'anthropic-secret' })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).models, [{ id: 'claude-a', name: 'Claude A' }, { id: 'claude-b', name: 'Claude B' }])
    assert.equal(h.captured[0].path, '/v1/models?limit=100')
    assert.equal(h.captured[0].headers['x-api-key'], 'anthropic-secret')
    assert.equal(h.captured[0].headers['anthropic-version'], '2023-06-01')
    assert.match(h.captured[1].path, /after_id=claude-a/)
  } finally { await h.close() }
})

test('anthropic custom endpoint and /v1 fallback are supported', async () => {
  const h = await fixture('anthropic', (_req, res) => res.end(JSON.stringify({ data: [{ id: 'local-model' }] })))
  try {
    const response = await enumerate(h.api, { provider: 'anthropic', baseUrl: h.upstreamBase, apiKey: 'key' })
    assert.equal(response.status, 200)
    assert.equal(h.captured[0].path, '/v1/models?limit=100')
    const fallback = await enumerate(h.api, { provider: 'anthropic', baseUrl: '/v1', apiKey: 'key' })
    assert.equal(fallback.status, 200)
    assert.equal(h.captured.at(-1)?.path, '/v1/models?limit=100')
  } finally { await h.close() }
})

test('malformed upstream data, unsupported endpoint, and redirect are helpful errors', async () => {
  const malformed = await fixture('openai-compatible', (_req, res) => res.end(JSON.stringify({ nope: [] })))
  try {
    const response = await enumerate(malformed.api, { provider: 'openai-compatible', baseUrl: '', apiKey: 'key' })
    assert.equal(response.status, 502)
    assert.match((await response.json()).error.message, /data 数组/)
  } finally { await malformed.close() }

  const unsupported = await fixture('anthropic', (_req, res) => { res.writeHead(404); res.end('not found') })
  try {
    const response = await enumerate(unsupported.api, { provider: 'anthropic', baseUrl: '', apiKey: 'key' })
    assert.equal(response.status, 404)
    assert.match((await response.json()).error.message, /不支持 GET \/models/)
  } finally { await unsupported.close() }

  const redirected = await fixture('openai-compatible', (_req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); res.end() })
  try {
    const response = await enumerate(redirected.api, { provider: 'openai-compatible', baseUrl: '', apiKey: 'key' })
    assert.equal(response.status, 502)
    assert.match((await response.json()).error.message, /重定向/)
  } finally { await redirected.close() }
})

test('rejects URL credentials before upstream access', async () => {
  const h = await fixture('openai-compatible', (_req, res) => res.end(JSON.stringify({ data: [{ id: 'x' }] })))
  try {
    const unsafe = await enumerate(h.api, { provider: 'openai-compatible', baseUrl: 'https://user:pass@example.com', apiKey: 'key' })
    assert.equal(unsafe.status, 400)
    assert.equal(h.captured.length, 0)
  } finally { await h.close() }
})
