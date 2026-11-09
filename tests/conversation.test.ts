import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import { editChapter, editWritingMode, editLineTarget, newCreatorDocument } from '../src/lib/creator.ts'
import { streamConversation } from '../src/lib/conversation.ts'

function listen(server: http.Server): Promise<void> { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)) }
function close(server: http.Server): Promise<void> { return new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
function url(server: http.Server): string { return `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
const evt = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data as object })}\n\n`

async function rig(reply: (request: any, response: http.ServerResponse, index: number) => void) {
  const captured: any[] = []
  const upstream = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => raw += chunk)
    req.on('end', () => {
      const request = { path: req.url, headers: req.headers, body: JSON.parse(raw) }
      captured.push(request)
      reply(request, res, captured.length - 1)
    })
  })
  await listen(upstream)
  const cfg = { ...loadConfig({}), openaiBaseUrl: `${url(upstream)}/v1`, anthropicBaseUrl: url(upstream), staticDir: '', allowedOrigins: [] }
  const app = createApp(cfg)
  await listen(app)
  return { api: url(app), upstream, app, captured }
}
const service = (provider: string) => ({ provider, baseUrl: '', model: 'test-model', apiKey: 'test-secret' })
const send = (api: string, provider: string, messages = [{ role: 'user', content: '你好' }], creator?: unknown, options: Record<string, unknown> = {}, creatorChanges?: unknown) => fetch(`${api}/api/conversation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: { ...service(provider), ...options }, messages, ...(creator === undefined ? {} : { creator }), ...(creatorChanges === undefined ? {} : { creatorChanges }) }) })
const events = (stream: string): Array<{ event: string; data: any }> => stream.trim().split('\n\n').map(block => ({ event: block.split('\n')[0].slice(7), data: JSON.parse(block.split('\n')[1].slice(6)) }))

test('streamConversation excludes persisted model cache metadata from request payload', async () => {
  const originalFetch = globalThis.fetch
  let sent: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response('event: done\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  try {
    const settings = { provider: 'openai-compatible' as const, baseUrl: '', model: 'main', apiKey: 'secret', search: { enabled: true, model: 'fast' }, reasoningEffort: 'high' as const, models: { items: [{ id: 'large', name: 'Large model list' }], updatedAt: 1_700_000_000_000 } }
    await streamConversation(settings, [{ role: 'user', content: 'hello' }], null, { text() {}, creator() {}, status() {} }, new AbortController().signal)
    assert.deepEqual(sent?.service, { provider: 'openai-compatible', baseUrl: '', model: 'main', apiKey: 'secret', search: { enabled: true, model: 'fast' }, reasoningEffort: 'high' })
  } finally { globalThis.fetch = originalFetch }
})

test('client sends a compact journal separately from the authoritative manuscript snapshot', async () => {
  const originalFetch = globalThis.fetch
  let sent: any
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body))
    return new Response('event: done\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  try {
    const initial = newCreatorDocument({ title: '作品', text: '旧段落' })
    const doc = editLineTarget(editWritingMode(editChapter(initial, initial.activeChapterId, { text: '新段落' }), 'lyrics'), initial.activeChapterId, 0, { count: 8, unit: 'syllables' })
    await streamConversation({ provider: 'responses', baseUrl: '', model: 'test', apiKey: '' }, [{ role: 'user', content: '继续' }], doc, { text() {}, creator() {}, status() {} }, new AbortController().signal)
    assert.match(sent.creatorChanges, /-旧段落\n\+新段落/)
    assert.equal(sent.creator.changes, undefined)
    assert.equal(sent.creator.aiSeenRevision, undefined)
    assert.equal(sent.creator.chapters[0].text, '新段落')
    assert.equal(sent.creator.writingMode, 'lyrics')
    assert.deepEqual(sent.creator.chapters[0].lineTargets, [{ count: 8, unit: 'syllables' }])
  } finally { globalThis.fetch = originalFetch }
})

test('openai-compatible streams a text event and requests streaming chat completions', async () => {
  const h = await rig((_request, res) => res.end('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'))
  try {
    const response = await send(h.api, 'openai-compatible')
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.match(text, /event: text\ndata: .*"delta":"你好"/)
    assert.match(text, /event: done/)
    assert.equal(h.captured[0].path, '/v1/chat/completions')
    assert.equal(h.captured[0].headers.authorization, 'Bearer test-secret')
    assert.equal(h.captured[0].body.stream, true)
    assert.equal(h.captured[0].body.messages[0].role, 'system')
  } finally { await close(h.app); await close(h.upstream) }
})

test('responses provider uses its own endpoint and streams text', async () => {
  const h = await rig((_request, res) => res.end(evt('response.output_text.delta', { delta: '大纲' }) + evt('response.completed', { response: { output: [] } })))
  try {
    const text = await (await send(h.api, 'responses')).text()
    assert.match(text, /event: text/)
    assert.match(text, /大纲/)
    assert.equal(h.captured[0].path, '/v1/responses')
  } finally { await close(h.app); await close(h.upstream) }
})

test('anthropic provider uses messages protocol and emits creator updates from the internal tool', async () => {
  const doc = { title: '短篇', chapters: [{ id: 'ch-1', title: '开端', text: '原稿' }], activeChapterId: 'ch-1', revision: 1 }
  const next = { ...doc, chapters: [{ ...doc.chapters[0], text: '修订稿' }], revision: 2 }
  const h = await rig((_request, res, index) => index === 0
    ? res.end(evt('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'update_creator', input: { document: next } } }) + evt('content_block_stop', { index: 0 }) + evt('message_stop', {}))
    : res.end(evt('content_block_start', { index: 0, content_block: { type: 'text', text: '已修订。' } }) + evt('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '已修订。' } }) + evt('message_stop', {})))
  try {
    const text = await (await send(h.api, 'anthropic', [{ role: 'user', content: '润色一下' }], doc)).text()
    assert.match(text, /event: creator/)
    assert.ok(events(text).some(item => item.event === 'status' && item.data.phase === 'creating'))
    assert.match(text, /修订稿/)
    assert.match(text, /event: done/)
    assert.equal(h.captured[0].path, '/v1/messages')
    assert.equal(h.captured[0].headers['x-api-key'], 'test-secret')
    assert.equal(h.captured[0].body.system[0].type, 'text')
    assert.equal(h.captured[0].body.system[0].cache_control.type, 'ephemeral')
    assert.equal(h.captured[1].body.messages.at(-1).content[0].type, 'tool_result')
    assert.ok(h.captured[0].body.messages.every((message: any) => message.role !== 'system'))
    assert.ok(h.captured[0].body.tools.some((tool: any) => tool.name === 'update_creator'))
  } finally { await close(h.app); await close(h.upstream) }
})

test('conversation rejects invalid URLs and malformed documents before upstream access', async () => {
  const h = await rig((_request, res) => res.end('data: [DONE]\n\n'))
  try {
    const unsafe = await fetch(`${h.api}/api/conversation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: { ...service('openai-compatible'), baseUrl: 'https://user:pass@example.com' }, messages: [{ role: 'user', content: 'x' }] }) })
    assert.equal(unsafe.status, 400)
    const invalidDoc = await send(h.api, 'openai-compatible', [{ role: 'user', content: 'x' }], { title: 'bad', chapters: [], activeChapterId: 'missing', revision: 0 })
    assert.equal(invalidDoc.status, 400)
    assert.equal(h.captured.length, 0)
  } finally { await close(h.app); await close(h.upstream) }
})

test('conversation surfaces upstream errors as named SSE error events', async () => {
  const h = await rig((_request, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } })) })
  try {
    const response = await send(h.api, 'openai-compatible')
    assert.equal(response.status, 200)
    assert.match(await response.text(), /event: error/)
  } finally { await close(h.app); await close(h.upstream) }
})

test('search child-agent uses a separate configurable model and returns summarized evidence to the stable main agent', async () => {
  const conversation = 'What changed in Nova this week?'
  const query = 'Nova weekly updates'
  const mainCalls: any[] = []
  const childCalls: any[] = []
  let searches = 0
  const upstream = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => raw += chunk)
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      const path = req.url ?? ''
      res.setHeader('content-type', 'text/event-stream')
      if (path === '/v1/chat/completions' && body.model === 'main-model') {
        mainCalls.push(body)
        const tool = { index: 0, id: `main-search-${mainCalls.length}`, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }
        res.write('data: {"choices":[{"delta":{"reasoning_content":"主模型正在核实"}}]}\n\n')
        if (mainCalls.length === 1) res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tool] } }] })}\n\ndata: [DONE]\n\n`)
        else { assert.match(body.messages.at(-1).content, /独立小机器人摘要/); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Soma 的助手依据资料作答。' } }] })}\n\ndata: [DONE]\n\n`) }
        return
      }
      if (path === '/v1/chat/completions' && body.model === 'fast-child') {
        childCalls.push(body)
        res.write('data: {"choices":[{"delta":{"reasoning_content":"PRIVATE_CHILD_THINKING"}}]}\n\n')
        if (childCalls.length === 1) res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'child-web', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }] } }] })}\n\ndata: [DONE]\n\n`)
        else res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '独立小机器人摘要：Nova 本周更新了导出功能。来源：https://example.test/release' } }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      if (path.startsWith('/search?')) {
        searches++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ results: [{ title: 'Nova release notes', url: 'https://example.test/release', content: 'Export was added this week.' }] }))
        return
      }
      res.writeHead(404); res.end()
    })
  })
  await listen(upstream)
  const api = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const app = createApp({ ...loadConfig({}), openaiBaseUrl: `${api}/v1`, searxngUrl: api, staticDir: '', allowedOrigins: [] })
  await listen(app)
  try {
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
    const result = await fetch(`${base}/api/conversation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      service: { ...service('openai-compatible'), model: 'main-model', reasoningEffort: 'high', baseUrl: `${api}/v1`, search: { enabled: true, model: 'fast-child' } },
      messages: [{ role: 'user', content: conversation }],
    }) })
    const stream = await result.text()
    assert.match(stream, /网络检索/)
    assert.match(stream, /Soma 的助手依据资料作答/)
    assert.doesNotMatch(stream, /PRIVATE_CHILD_THINKING|独立小机器人摘要/)
    const phases = events(stream).filter(item => item.event === 'status').map(item => item.data.phase)
    assert.deepEqual(phases, ['initial', 'waiting', 'thinking', 'search-agent', 'searching', 'search-agent', 'summarizing', 'returning', 'waiting', 'thinking', 'responding'])
    assert.equal(events(stream).filter(item => item.event === 'reasoning').length, 2)
    assert.equal(mainCalls[1].messages.find((item: any) => item.role === 'assistant').reasoning_content, '主模型正在核实')
    assert.equal(searches, 1)
    assert.equal(childCalls[0].model, 'fast-child')
    assert.equal(childCalls[0].messages.at(-1).content.includes(query), true)
    assert.equal(mainCalls[0].model, 'main-model')
    assert.equal(mainCalls[1].model, 'main-model')
    assert.ok(mainCalls.every(item => item.reasoning_effort === 'high'))
    assert.ok(childCalls.every(item => item.reasoning_effort === undefined))
    assert.equal(mainCalls[1].messages.some((item: any) => item.role === 'tool' && item.content.includes('独立小机器人摘要')), true)
    assert.equal(mainCalls[1].messages.some((item: any) => item.content?.includes('tools')), false)
  } finally { await close(app); await close(upstream) }
})

test('Creator edits preserve the stable system, tools and historical prefix', async () => {
  const h = await rig((_request, res) => res.end('data: {"choices":[{"delta":{"content":"收到"}}]}\n\ndata: [DONE]\n\n'))
  const first = { title: '作品', chapters: [{ id: 'one', title: '第一章', text: '原稿' }], activeChapterId: 'one', revision: 1 }
  const second = { ...first, chapters: [{ ...first.chapters[0], text: '修订稿' }], revision: 2 }
  const history = [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }, { role: 'user', content: '继续' }]
  try {
    await (await send(h.api, 'openai-compatible', history, first)).text()
    await (await send(h.api, 'openai-compatible', history, second)).text()
    const left = h.captured[0].body, right = h.captured[1].body
    assert.deepEqual(left.tools, right.tools)
    assert.deepEqual(left.messages.slice(0, -1), right.messages.slice(0, -1))
    assert.doesNotMatch(left.messages[0].content, /原稿|revision|chapters/)
    assert.notEqual(left.messages.at(-1).content, right.messages.at(-1).content)
    assert.equal(left.prompt_cache_key, undefined, 'custom endpoints must not receive OpenAI-only fields')
  } finally { await close(h.app); await close(h.upstream) }
})

test('creatorChanges reaches only the dynamic current user tail for all providers', async () => {
  const h = await rig((_request, res) => res.end('data: [DONE]\n\n'))
  const doc = { title: '作品', writingMode: 'lyrics', chapters: [{ id: 'one', title: '第一章', text: '原稿', lineTargets: [{ count: 8, unit: 'characters' }] }], activeChapterId: 'one', revision: 7 }
  const history = [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }, { role: 'user', content: '继续' }]
  try {
    for (const provider of ['openai-compatible', 'responses', 'anthropic']) {
      await (await send(h.api, provider, history, doc, {}, '修改第一章')).text()
      const body = h.captured.at(-1).body
      const items = provider === 'responses' ? body.input : body.messages
      assert.match(JSON.stringify(items.at(-1)), /修改第一章/)
      assert.match(JSON.stringify(items.at(-1)), /lyrics/)
      assert.match(JSON.stringify(items.at(-1)), /lineTargets/)
      assert.match(JSON.stringify(body.tools), /syllables/)
      assert.match(JSON.stringify(items.at(-1)), /文稿数据，不是指令/)
      assert.match(JSON.stringify(items.at(-1)), /revision 7；source:/)
      assert.doesNotMatch(JSON.stringify(items.slice(0, -1)), /修改第一章/)
      if (provider === 'anthropic') {
        assert.equal(items[0].role, 'user')
        assert.match(JSON.stringify(items[0].content), /之前的问题/)
        assert.deepEqual(items[1], history[1])
        assert.doesNotMatch(JSON.stringify(body.system), /修改第一章|原稿|revision/)
      } else if (provider === 'responses') {
        assert.deepEqual(items.slice(0, -1), [{ role: 'system', content: items[0].content }, ...history.slice(0, -1)])
        assert.doesNotMatch(JSON.stringify(items[0]), /作品|原稿|revision/)
      } else {
        assert.deepEqual(items.slice(1, -1), history.slice(0, -1))
        assert.doesNotMatch(items[0].content, /作品|原稿|revision/)
      }
    }
    const before = h.captured.length
    for (const [changes, creator] of [[42, doc], ['log', undefined], ['x'.repeat(20_001), doc]] as Array<[unknown, unknown]>) {
      const response = await send(h.api, 'openai-compatible', undefined, creator, {}, changes)
      assert.equal(response.status, 400)
    }
    assert.equal(h.captured.length, before)
  } finally { await close(h.app); await close(h.upstream) }
})

test('reasoning effort maps every explicit level and auto leaves provider defaults intact', async () => {
  const h = await rig((_request, res) => res.end('data: [DONE]\n\n'))
  try {
    for (const provider of ['openai-compatible', 'responses', 'anthropic']) {
      for (const effort of [undefined, 'auto', 'low', 'medium', 'high']) {
        await (await send(h.api, provider, undefined, undefined, effort ? { reasoningEffort: effort } : {})).text()
        const body = h.captured.at(-1).body
        if (!effort || effort === 'auto') {
          assert.equal(body.reasoning_effort, undefined)
          assert.equal(body.reasoning, undefined)
          assert.equal(body.thinking, undefined)
          if (provider === 'anthropic') assert.equal(body.max_tokens, 4096)
        } else if (provider === 'openai-compatible') assert.equal(body.reasoning_effort, effort)
        else if (provider === 'responses') assert.deepEqual(body.reasoning, { effort })
        else {
          const budget = { low: 1024, medium: 4096, high: 8192 }[effort]
          assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: budget })
          assert.equal(body.max_tokens, budget + 4096)
        }
      }
    }
    const before = h.captured.length
    for (const invalid of ['', 'max', null, 42, {}, ['low']]) {
      const response = await send(h.api, 'responses', undefined, undefined, { reasoningEffort: invalid })
      assert.equal(response.status, 400)
      assert.match(await response.text(), /reasoningEffort/)
    }
    assert.equal(h.captured.length, before)
  } finally { await close(h.app); await close(h.upstream) }
})

for (const provider of ['openai-compatible', 'responses', 'anthropic']) {
  test(`${provider} forwards only upstream reasoning deltas with real stage transitions`, async () => {
    const h = await rig((_request, res) => {
      if (provider === 'openai-compatible') res.end('data: {"choices":[{"delta":{"reasoning":"先核实"}}]}\n\ndata: {"choices":[{"delta":{"reasoning":"再回答"}}]}\n\ndata: {"choices":[{"delta":{"content":"答案"}}]}\n\ndata: [DONE]\n\n')
      else if (provider === 'responses') res.end(evt('response.reasoning_summary_text.delta', { delta: '先核实' }) + evt('response.reasoning_text.delta', { delta: '再回答' }) + evt('response.output_text.delta', { delta: '答案' }) + evt('response.completed', { response: { output: [] } }))
      else res.end(evt('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '先核实' } }) + evt('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '再回答' } }) + evt('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } }) + evt('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' } }) + evt('content_block_start', { index: 2, content_block: { type: 'text', text: '答案' } }) + evt('message_stop', {}))
    })
    try {
      const stream = await (await send(h.api, provider)).text()
      const received = events(stream)
      assert.deepEqual(received.map(item => item.event), ['status', 'status', 'status', 'reasoning', 'reasoning', 'status', 'text', 'done'])
      assert.deepEqual(received.filter(item => item.event === 'reasoning').map(item => item.data), [{ type: 'reasoning', delta: '先核实' }, { type: 'reasoning', delta: '再回答' }])
      assert.deepEqual(received.filter(item => item.event === 'status').map(item => item.data.phase), ['initial', 'waiting', 'thinking', 'responding'])
      assert.doesNotMatch(stream, /PRIVATE_SIGNATURE|PRIVATE_REDACTED/)
    } finally { await close(h.app); await close(h.upstream) }
  })
}

for (const provider of ['responses', 'anthropic']) {
  test(`${provider} preserves reasoning and tool results on a creator continuation`, async () => {
    const doc = { title: '作品', chapters: [{ id: 'one', title: '第一章', text: '原稿' }], activeChapterId: 'one', revision: 1 }
    const next = { ...doc, revision: 2 }
    const reasoning = provider === 'responses'
      ? { type: 'reasoning', id: 'rs-1', summary: [{ type: 'summary_text', text: '修改作品' }], encrypted_content: 'OPAQUE_REASONING' }
      : { type: 'thinking', thinking: '修改作品', signature: 'SIGNED_THINKING' }
    const h = await rig((_request, res, index) => {
      if (provider === 'responses') {
        const output = [reasoning, { type: 'function_call', call_id: 'edit-1', name: 'update_creator', arguments: JSON.stringify({ document: next }) }]
        res.end(index === 0
          ? evt('response.reasoning_summary_text.delta', { delta: '修改作品' }) + output.map(item => evt('response.output_item.done', { item })).join('') + evt('response.completed', { response: { output } })
          : evt('response.output_text.delta', { delta: '已完成' }) + evt('response.completed', { response: { output: [] } }))
      } else res.end(index === 0
        ? evt('content_block_start', { index: 0, content_block: reasoning }) + evt('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'edit-1', name: 'update_creator', input: { document: next } } }) + evt('message_stop', {})
        : evt('content_block_start', { index: 0, content_block: { type: 'text', text: '已完成' } }) + evt('message_stop', {}))
    })
    try {
      const stream = await (await send(h.api, provider, undefined, doc, { reasoningEffort: 'high' })).text()
      assert.equal(h.captured.length, 2)
      for (const request of h.captured) {
        if (provider === 'responses') assert.deepEqual(request.body.reasoning, { effort: 'high' })
        else assert.deepEqual(request.body.thinking, { type: 'enabled', budget_tokens: 8192 })
      }
      const continuation = h.captured[1].body
      if (provider === 'responses') {
        assert.deepEqual(continuation.input.find((item: any) => item.type === 'reasoning'), reasoning)
        assert.equal(continuation.input.at(-1).type, 'function_call_output')
        assert.equal(continuation.input.at(-1).call_id, 'edit-1')
      } else {
        assert.deepEqual(continuation.messages.at(-2).content[0], reasoning)
        assert.equal(continuation.messages.at(-1).content[0].type, 'tool_result')
        assert.equal(continuation.messages.at(-1).content[0].tool_use_id, 'edit-1')
      }
      assert.deepEqual(events(stream).filter(item => item.event === 'status').map(item => item.data.phase), ['initial', 'waiting', 'thinking', 'creating', 'waiting', 'responding'])
      assert.match(stream, /已完成/)
      assert.doesNotMatch(stream, /OPAQUE_REASONING|SIGNED_THINKING/)
    } finally { await close(h.app); await close(h.upstream) }
  })
}

test('reasoning reaches the client before the upstream turn completes', { timeout: 2000 }, async () => {
  let finish: (() => void) | undefined
  const h = await rig((_request, res) => {
    res.write('data: {"choices":[{"delta":{"reasoning_content":"实时思考"}}]}\n\n')
    finish = () => res.end('data: {"choices":[{"delta":{"content":"最终答案"}}]}\n\ndata: [DONE]\n\n')
  })
  try {
    const response = await send(h.api, 'openai-compatible')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let stream = ''
    while (!stream.includes('event: reasoning')) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false)
      stream += decoder.decode(chunk.value, { stream: true })
    }
    assert.match(stream, /实时思考/)
    assert.doesNotMatch(stream, /event: done|最终答案/)
    finish!()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stream += decoder.decode(chunk.value, { stream: true })
    }
    assert.match(stream, /最终答案/)
    assert.match(stream, /event: done/)
  } finally { finish?.(); await close(h.app); await close(h.upstream) }
})

test('disabled search removes the tool for every provider without changing the stable system prefix', async () => {
  const h = await rig((_request, res) => res.end('data: [DONE]\n\n'))
  try {
    for (const provider of ['openai-compatible', 'responses', 'anthropic']) {
      await (await send(h.api, provider, undefined, undefined, { search: { enabled: false } })).text()
      const body = h.captured.at(-1).body
      assert.deepEqual(body.tools ?? [], [])
      const items = body.messages ?? body.input
      assert.match(JSON.stringify(items.at(-1)), /请求日期与时区/)
      assert.doesNotMatch(JSON.stringify(body.system ?? items[0]), /请求日期/)
    }
  } finally { await close(h.app); await close(h.upstream) }
})

test('conversation aborts the upstream request when the client disconnects', async () => {
  let aborted = false
  const h = await rig((_request, res) => {
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
    res.on('close', () => { aborted = true })
  })
  try {
    const controller = new AbortController()
    const response = await fetch(`${h.api}/api/conversation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: service('openai-compatible'), messages: [{ role: 'user', content: 'x' }] }), signal: controller.signal })
    await response.body?.getReader().read()
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(aborted, true)
  } finally { await close(h.app); await close(h.upstream) }
})


test('lyric constraints survive an AI tool replacement that omits metadata', async () => {
  const doc = { title: '歌', writingMode: 'lyrics', chapters: [{ id: 'ch-1', title: '主歌', text: '原稿\n尾句', lineTargets: [{ count: 7, unit: 'characters' }, { count: 8, unit: 'syllables' }] }], activeChapterId: 'ch-1', revision: 1 }
  const next = { title: '歌', chapters: [{ id: 'ch-1', title: '主歌', text: '新增\n原稿\n尾句' }], activeChapterId: 'ch-1', revision: 2 }
  const h = await rig((_request, res, index) => index === 0
    ? res.end(evt('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'update_creator', input: { document: next } } }) + evt('content_block_stop', { index: 0 }) + evt('message_stop', {}))
    : res.end(evt('message_stop', {})))
  try {
    const output = events(await (await send(h.api, 'anthropic', undefined, doc)).text()).find(item => item.event === 'creator')!.data.document
    assert.equal(output.writingMode, 'lyrics')
    assert.deepEqual(output.chapters[0].lineTargets, [null, ...doc.chapters[0].lineTargets])
  } finally { await close(h.app); await close(h.upstream) }
})

test('invalid lyric metadata is rejected before upstream access', async () => {
  const h = await rig((_request, res) => res.end('data: [DONE]\n\n'))
  const doc = { title: '歌', chapters: [{ id: 'one', title: '主歌', text: '一行' }], activeChapterId: 'one', revision: 0 }
  try {
    for (const target of [{ count: 0, unit: 'characters' }, { count: 1000, unit: 'characters' }, { count: 3.5, unit: 'syllables' }, { count: 8, unit: 'words' }, {}, '8']) {
      const response = await send(h.api, 'openai-compatible', undefined, { ...doc, chapters: [{ ...doc.chapters[0], lineTargets: [target] }] })
      assert.equal(response.status, 400)
    }
    assert.equal((await send(h.api, 'openai-compatible', undefined, { ...doc, writingMode: 'song' })).status, 400)
    assert.equal((await send(h.api, 'openai-compatible', undefined, { ...doc, chapters: [{ ...doc.chapters[0], lineTargets: [null, null] }] })).status, 400)
    assert.equal(h.captured.length, 0)
  } finally { await close(h.app); await close(h.upstream) }
})
