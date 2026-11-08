import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import type { RunSnapshot } from '../server/conversationRuns.ts'

const listen = (server: http.Server): Promise<void> => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = (server: http.Server): Promise<void> => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
const url = (server: http.Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const delta = (value: unknown) => `data: ${JSON.stringify({ choices: [{ delta: value }] })}\n\n`
const done = 'data: [DONE]\n\n'
const payload = (extra: Record<string, unknown> = {}) => ({ runId: 'run-1', conversationId: 'conversation-1', assistantId: 'assistant-1', service: { provider: 'openai-compatible', baseUrl: '', model: 'main', apiKey: 'private-key', search: { enabled: false } }, messages: [{ role: 'user', content: 'PRIVATE_REQUEST_TEXT' }], ...extra })
async function rig(reply: (body: any, res: http.ServerResponse, index: number, path: string) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'soma-runs-'))
  let calls = 0
  const upstream = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    reply(raw ? JSON.parse(raw) : {}, res, calls++, req.url || '')
  })
  await listen(upstream)
  const cfg = { ...loadConfig({}), openaiBaseUrl: `${url(upstream)}/v1`, searxngUrl: url(upstream), staticDir: '' }
  const app = createApp(cfg, directory)
  await listen(app)
  return { app, upstream, cfg, directory, api: url(app), calls: () => calls, async cleanup() { await close(app); await close(upstream); await rm(directory, { recursive: true, force: true }) } }
}
const post = (api: string, body = payload()) => fetch(`${api}/api/conversation-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = async (api: string, id = 'run-1'): Promise<RunSnapshot> => (await fetch(`${api}/api/conversation-runs/${id}`)).json()
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 4000
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'condition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('runs survive disconnected POST and GET, stay idempotent, and persist only snapshots', async () => {
  let finish: (() => void) | undefined
  let upstreamClosed = false
  const h = await rig((_body, res) => {
    res.write(delta({ reasoning_content: '思考' }) + delta({ content: 'first' }))
    res.on('close', () => { upstreamClosed = true })
    finish = () => res.end(delta({ content: ' final' }) + done)
  })
  try {
    // Disconnect after the entire POST body reached the server, before reading its response.
    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${h.api}/api/conversation-runs`, { method: 'POST', headers: { 'content-type': 'application/json' } })
      req.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error) })
      req.end(JSON.stringify(payload()), () => { req.destroy(); resolve() })
    })
    await until(() => !!finish)
    await new Promise<void>(resolve => {
      const req = http.get(`${h.api}/api/conversation-runs/run-1`, res => { res.destroy(); resolve() })
      req.on('error', () => resolve())
    })
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => post(h.api)))
    assert.ok(duplicates.every(res => res.status === 200))
    assert.equal(h.calls(), 1)
    assert.equal(upstreamClosed, false)
    assert.equal((await get(h.api)).text, 'first')
    assert.equal((await post(h.api, payload({ assistantId: 'different' }))).status, 409)
    finish!()
    await until(async () => (await get(h.api)).state === 'completed')
    const snapshot = await get(h.api)
    assert.equal(snapshot.text, 'first final')
    assert.equal(snapshot.reasoning, '思考')
    const listing = await (await fetch(`${h.api}/api/conversation-runs?conversationId=conversation-1`)).json()
    assert.equal(listing.runs[0].id, 'run-1')
    assert.deepEqual(await (await fetch(`${h.api}/api/conversation-runs?conversationId=other`)).json(), { runs: [] })
    const stored = await readFile(join(h.directory, 'runs', 'snapshots.json'), 'utf8')
    assert.doesNotMatch(stored, /private-key|PRIVATE_REQUEST_TEXT|service|messages/)
    await close(h.app)
    const restarted = createApp(h.cfg, h.directory)
    await listen(restarted)
    try { assert.deepEqual(await get(url(restarted)), snapshot) } finally { await close(restarted) }
  } finally { finish?.(); await h.cleanup() }
})

test('concurrent initial POSTs execute upstream once and DELETE really aborts it', async () => {
  let aborted = false
  const h = await rig((_body, res) => { res.write(delta({ content: 'partial' })); res.on('close', () => { aborted = true }) })
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => post(h.api)))
    assert.equal(results.filter(res => res.status === 202).length, 1)
    await until(() => h.calls() === 1)
    const stopped = await (await fetch(`${h.api}/api/conversation-runs/run-1`, { method: 'DELETE' })).json()
    assert.equal(stopped.state, 'cancelled')
    await until(() => aborted)
    assert.equal((await get(h.api)).state, 'cancelled')
    assert.equal((await post(h.api)).status, 200)
    assert.equal(h.calls(), 1)
  } finally { await h.cleanup() }
})

test('invalid input is rejected before upstream and upstream errors become failed snapshots', async () => {
  const h = await rig((_body, res) => { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'bad key private-key' } })) })
  try {
    for (const body of [payload({ runId: '../escape' }), payload({ conversationId: 2 }), payload({ messages: [] }), payload({ creator: { chapters: [] } }), payload({ service: { provider: 'openai-compatible', baseUrl: 'file:///etc/passwd', model: 'm', apiKey: '' } })]) {
      assert.equal((await post(h.api, body)).status, 400)
    }
    assert.equal(h.calls(), 0)
    assert.equal((await fetch(`${h.api}/api/conversation-runs`)).status, 400)
    assert.equal((await fetch(`${h.api}/api/conversation-runs/missing`)).status, 404)
    assert.equal((await post(h.api)).status, 202)
    await until(async () => (await get(h.api)).state === 'failed')
    assert.equal((await get(h.api)).error, 'bad key [redacted]')
  } finally { await h.cleanup() }
})

test('restart marks interrupted snapshots failed with a clear explanation', async () => {
  const h = await rig((_body, res) => res.end(done))
  try {
    await mkdir(join(h.directory, 'runs'))
    const now = Date.now()
    await writeFile(join(h.directory, 'runs', 'snapshots.json'), JSON.stringify({ version: 1, runs: [{ id: 'run-1', conversationId: 'conversation-1', assistantId: 'assistant-1', state: 'running', text: 'saved partial', reasoning: '', status: { phase: 'searching', message: '正在搜索' }, creators: [], createdAt: now, updatedAt: now }] }))
    const restored = await get(h.api)
    assert.equal(restored.state, 'failed')
    assert.equal(restored.text, 'saved partial')
    assert.match(restored.error!, /重新启动.*中断/)
    assert.equal(h.calls(), 0)
  } finally { await h.cleanup() }
})

test('Creator updates accumulate in order with stable sequences and baseRevision', async () => {
  const creator = { title: '作品', chapters: [{ id: 'one', title: '第一章', text: 'PRIVATE_MANUSCRIPT' }], activeChapterId: 'one', revision: 4 }
  const h = await rig((_body, res, index) => {
    if (index < 2) res.end(delta({ tool_calls: [{ index: 0, id: `edit-${index}`, type: 'function', function: { name: 'update_creator', arguments: JSON.stringify({ document: { ...creator, chapters: [{ ...creator.chapters[0], text: `新稿${index}` }], revision: 5 + index } }) } }] }) + done)
    else res.end(delta({ content: '完成' }) + done)
  })
  try {
    await post(h.api, payload({ creator }))
    await until(async () => (await get(h.api)).state === 'completed')
    const snapshot = await get(h.api)
    assert.equal(snapshot.baseRevision, 4)
    assert.deepEqual(snapshot.creators.map(item => [item.sequence, item.document.revision]), [[1, 5], [2, 6]])
    assert.deepEqual((await get(h.api)).creators, snapshot.creators)
    assert.doesNotMatch(await readFile(join(h.directory, 'runs', 'snapshots.json'), 'utf8'), /PRIVATE_MANUSCRIPT/)
  } finally { await h.cleanup() }
})

test('runtime concurrency and output limits bound upstream work', async () => {
  const finishes: Array<() => void> = []
  const h = await rig((_body, res) => { res.write(delta({ content: 'partial' })); finishes.push(() => res.end(done)) })
  try {
    for (let index = 0; index < 8; index++) assert.equal((await post(h.api, payload({ runId: `run-${index}` }))).status, 202)
    assert.equal((await post(h.api, payload({ runId: 'overflow' }))).status, 429)
    assert.equal((await post(h.api, payload({ runId: 'run-0' }))).status, 200)
    await until(() => finishes.length === 8)
    finishes.forEach(finish => finish())
    await until(async () => (await get(h.api, 'run-7')).state === 'completed')
  } finally { finishes.forEach(finish => finish()); await h.cleanup() }
  const large = await rig((_body, res) => res.end(delta({ content: 'x'.repeat(2 * 1024 * 1024 + 1) }) + done))
  try {
    await post(large.api)
    await until(async () => (await get(large.api)).state === 'failed')
    const run = await get(large.api)
    assert.match(run.error!, /2 MB/)
    assert.equal(run.text, '')
  } finally { await large.cleanup() }
})

test('expired completed snapshots are pruned on restart', async () => {
  const h = await rig((_body, res) => res.end(done))
  try {
    await mkdir(join(h.directory, 'runs'))
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000
    await writeFile(join(h.directory, 'runs', 'snapshots.json'), JSON.stringify({ version: 1, runs: [{ id: 'run-1', conversationId: 'conversation-1', assistantId: 'assistant-1', state: 'completed', text: 'old', reasoning: '', status: { phase: 'completed', message: '完成' }, creators: [], createdAt: old, updatedAt: old }] }))
    assert.equal((await fetch(`${h.api}/api/conversation-runs/run-1`)).status, 404)
    assert.deepEqual(await (await fetch(`${h.api}/api/conversation-runs?conversationId=conversation-1`)).json(), { runs: [] })
  } finally { await h.cleanup() }
})

test('disconnect during search leaves the run active and its final answer recoverable', async () => {
  let finishSearch: (() => void) | undefined
  let mainCalls = 0
  let searchClosed = false
  const h = await rig((body, res, _index, path) => {
    if (path.startsWith('/search?')) {
      finishSearch = () => { if (res.writableEnded) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ results: [{ title: 'Weather', url: 'https://example.test/weather', content: 'Weather report' }] })) }
      res.on('close', () => { searchClosed = true })
    } else if (body.model === 'main') {
      mainCalls++
      res.end(mainCalls === 1 ? delta({ tool_calls: [{ index: 0, id: 'search-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"weather"}' } }] }) + done : delta({ content: '搜索后的答案' }) + done)
    } else res.end(done)
  })
  try {
    const request = payload()
    request.service.search = { enabled: true, model: 'worker' } as typeof request.service.search
    await post(h.api, request)
    await until(() => !!finishSearch)
    const controller = new AbortController()
    await fetch(`${h.api}/api/conversation-runs/run-1`, { signal: controller.signal })
    controller.abort()
    assert.equal((await get(h.api)).status.phase, 'searching')
    assert.equal(searchClosed, false)
    finishSearch!()
    await until(async () => (await get(h.api)).state === 'completed')
    assert.equal((await get(h.api)).text, '搜索后的答案')
  } finally { finishSearch?.(); await h.cleanup() }
})
