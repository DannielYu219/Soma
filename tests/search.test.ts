import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { loadConfig } from '../server/config.ts'
import { formatHits, runSearchTool, searchWithRecovery } from '../server/search.ts'
import { requestDateContext, runSearchSubagent } from '../server/conversation.ts'

const chunk = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`
async function fixture(reply: (path: string, body: any, res: http.ServerResponse) => void) {
  const server = http.createServer(async (req, res) => {
    let text = ''
    for await (const part of req) text += part
    reply(req.url!, text ? JSON.parse(text) : {}, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { cfg: { ...loadConfig({}), searxngUrl: base, openaiBaseUrl: `${base}/v1` }, stop: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
const service = { provider: 'openai-compatible', baseUrl: '', model: 'child', apiKey: '' }
const hit = { title: 'Original source', url: 'https://example.test/source', content: 'Original verifiable fact' }

test('search defaults preserve explicit result counts and evidence formatting stays bounded', () => {
  assert.equal(loadConfig({}).searchMaxResults, 8)
  assert.equal(loadConfig({ SOMA_SEARCH_MAX_RESULTS: '12' }).searchMaxResults, 12)
  const result = formatHits('query', Array.from({ length: 100 }, (_, index) => ({ title: `title ${index}`, url: `https://example.test/${index}`, snippet: 'x'.repeat(800) })))
  assert.ok(result.length < 16_200)
  assert.match(result, /资料长度上限/)
})

test('request date follows the host timezone across a UTC day boundary', () => {
  const before = process.env.TZ
  try {
    process.env.TZ = 'Asia/Shanghai'
    assert.equal(requestDateContext(new Date('2026-11-04T17:00:00Z')), '2026-11-05（Asia/Shanghai）')
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})

test('search retries transient and empty responses, deduplicates sources, and bounds persistent failures', async () => {
  let calls = 0
  let mode = 'transient'
  const h = await fixture((_path, _body, res) => {
    calls++
    if (mode === 'failure' || mode === 'transient' && calls === 1) { res.writeHead(503); res.end(); return }
    res.end(JSON.stringify({ results: mode === 'empty' && calls === 1 ? [] : [hit, { ...hit, url: `${hit.url}#duplicate` }, { url: 'javascript:bad' }, null] }))
  })
  try {
    let result = await searchWithRecovery(h.cfg, 'query')
    assert.equal(result.attempts, 2)
    assert.equal(result.hits.length, 1)
    mode = 'empty'; calls = 0
    result = await searchWithRecovery(h.cfg, 'query')
    assert.equal(result.hits.length, 1)
    assert.equal(calls, 2)
    mode = 'failure'; calls = 0
    const output = await runSearchTool(h.cfg, '{"query":"query"}')
    assert.equal(calls, 2)
    assert.match(output, /搜索暂时不可用/)
    assert.doesNotMatch(output, /Original verifiable fact/)
  } finally { await h.stop() }
})

test('malformed search responses fail honestly and cancellation is not swallowed', async () => {
  let calls = 0
  const h = await fixture((_path, _body, res) => { calls++; res.end('{"results":{}}') })
  try {
    assert.match(await runSearchTool(h.cfg, '{"query":"query"}'), /无效的搜索结果/)
    assert.equal(calls, 2)
    const controller = new AbortController()
    controller.abort(new Error('cancelled-search'))
    await assert.rejects(runSearchTool(h.cfg, '{"query":"query"}', controller.signal), /cancelled-search/)
    assert.equal(calls, 2)
  } finally { await h.stop() }
})

for (const failure of ['no-tools', 'upstream', 'broken-summary']) {
  test(`delegated query executes and raw evidence survives ${failure}`, async () => {
    const searches: string[] = []
    const bodies: any[] = []
    const h = await fixture((path, body, res) => {
      if (path.startsWith('/search?')) { searches.push(new URL(path, 'http://test').searchParams.get('q')!); res.end(JSON.stringify({ results: [hit] })); return }
      bodies.push(body)
      if (failure === 'upstream') { res.writeHead(503); res.end(); return }
      if (failure === 'broken-summary' && bodies.length === 2) { res.end('data: {"error":{"message":"summary failed"}}\n\n'); return }
      res.end(chunk({ content: 'Summary omitted all original sources' }))
    })
    try {
      const output = await runSearchSubagent(h.cfg, service, 'original query this week', new AbortController().signal, () => {}, '2026-11-04')
      assert.deepEqual(searches, ['original query this week'])
      assert.match(output, /Original verifiable fact/)
      assert.match(output, /https:\/\/example.test\/source/)
      assert.match(bodies[0].messages.at(-1).content, /2026-11-04/)
      assert.doesNotMatch(bodies[0].messages[0].content, /2026-11-04/)
      if (failure !== 'no-tools') assert.doesNotMatch(output, /Summary omitted/)
    } finally { await h.stop() }
  })
}

test('worker can recover with a revised query, receives tool outputs, and cannot search duplicate queries forever', async () => {
  const searches: string[] = []
  const bodies: any[] = []
  const h = await fixture((path, body, res) => {
    if (path.startsWith('/search?')) {
      const query = new URL(path, 'http://test').searchParams.get('q')!
      searches.push(query)
      res.end(JSON.stringify({ results: query === 'original' ? [] : [hit] })); return
    }
    bodies.push(body)
    if (bodies.length <= 2) res.end(chunk({ tool_calls: [{ index: 0, id: `call-${bodies.length}`, function: { name: 'web_search', arguments: '{"query":"revised"}' } }] }))
    else res.end(chunk({ content: 'Helpful summary' }))
  })
  try {
    const output = await runSearchSubagent(h.cfg, service, 'original', new AbortController().signal, () => {})
    assert.deepEqual(searches, ['original', 'original', 'revised'])
    assert.equal(bodies.length, 3)
    assert.equal(bodies[1].messages.at(-1).role, 'tool')
    assert.match(bodies[1].messages.at(-1).content, /Original verifiable fact/)
    assert.match(output, /没有找到结果/)
    assert.match(output, /Original verifiable fact/)
  } finally { await h.stop() }
})

test('worker query fanout is capped even if a model returns too many calls', async () => {
  const queries: string[] = []
  const bodies: any[] = []
  const h = await fixture((path, body, res) => {
    if (path.startsWith('/search?')) {
      queries.push(new URL(path, 'http://test').searchParams.get('q')!)
      res.end(JSON.stringify({ results: [hit] })); return
    }
    bodies.push(body)
    res.end(bodies.length === 1 ? chunk({ tool_calls: Array.from({ length: 8 }, (_, index) => ({ index, id: `call-${index}`, function: { name: 'web_search', arguments: JSON.stringify({ query: `extra-${index}` }) } })) }) : chunk({ content: 'summary' }))
  })
  try {
    const output = await runSearchSubagent(h.cfg, service, 'original', new AbortController().signal, () => {})
    assert.deepEqual(queries, ['original', 'extra-0', 'extra-1', 'extra-2'])
    assert.equal(bodies.length, 2)
    assert.match(output, /Original verifiable fact/)
  } finally { await h.stop() }
})

test('no successful search cannot become model-generated evidence', async () => {
  let summaries = 0
  const h = await fixture((path, _body, res) => {
    if (path.startsWith('/search?')) { res.writeHead(503); res.end(); return }
    summaries++
    res.end(chunk({ content: 'INVENTED_RESULT' }))
  })
  try {
    const output = await runSearchSubagent(h.cfg, service, 'original', new AbortController().signal, () => {})
    assert.match(output, /搜索暂时不可用/)
    assert.doesNotMatch(output, /INVENTED_RESULT/)
    assert.equal(summaries, 1)
  } finally { await h.stop() }
})
