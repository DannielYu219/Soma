import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createApp } from '../server/app.ts'
import { loadConfig, type Config } from '../server/config.ts'

// ---- Fake upstream model services and a fake SearXNG -------------------------

interface Captured { url: string; headers: http.IncomingHttpHeaders; body: any }
interface Reply { status?: number; type?: string; body: string }

async function fakeServer(reply: (captured: Captured, index: number) => Reply) {
  const captured: Captured[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const entry: Captured = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
      captured.push(entry)
      const result = reply(entry, captured.length - 1)
      res.writeHead(result.status ?? 200, { 'content-type': result.type ?? 'text/event-stream' })
      res.end(result.body)
    })
  })
  await listen(server)
  return { base: baseOf(server), captured, close: () => closeServer(server) }
}

function listen(server: http.Server): Promise<void> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}
function baseOf(server: http.Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
}

const chatData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
const chatDone = 'data: [DONE]\n\n'
const named = (event: string, payload: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`

function searxResults(query: string) {
  return JSON.stringify({
    query,
    results: [
      { title: 'Example Title', url: 'https://example.com/a', content: 'A short snippet about the topic.' },
      { title: 'Second', url: 'https://example.org/b', content: 'More.' },
      { title: 'Not http', url: 'javascript:alert(1)', content: 'dropped' },
    ],
  })
}

async function fakeSearx() {
  return fakeServer((captured) => {
    if (captured.url.startsWith('/healthz')) return { type: 'text/plain', body: 'OK' }
    const query = new URL(captured.url, 'http://x').searchParams.get('q') ?? ''
    return { type: 'application/json', body: searxResults(query) }
  })
}

interface Harness {
  gateway: string
  upstream: Awaited<ReturnType<typeof fakeServer>>
  searx: Awaited<ReturnType<typeof fakeSearx>>
  close: () => Promise<void>
}

async function harness(
  upstreamReply: (captured: Captured, index: number) => Reply,
  overrides: Partial<Config> = {},
  searxBase?: string,
): Promise<Harness> {
  const upstream = await fakeServer(upstreamReply)
  const searx = await fakeSearx()
  const cfg: Config = {
    ...loadConfig({}),
    openaiBaseUrl: `${upstream.base}/v1`,
    anthropicBaseUrl: upstream.base,
    openaiApiKey: undefined,
    anthropicApiKey: undefined,
    searxngUrl: searxBase ?? searx.base,
    allowedOrigins: ['http://127.0.0.1:5173'],
    ...overrides,
  }
  const app = createApp(cfg)
  await listen(app)
  return {
    gateway: baseOf(app),
    upstream,
    searx,
    close: async () => { await closeServer(app); await upstream.close(); await searx.close() },
  }
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function chatFrames(text: string): any[] {
  return text.split('\n\n').map(block => block.trim()).filter(block => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map(block => JSON.parse(block.slice(6)))
}

// ---- Chat Completions -------------------------------------------------------

test('chat completions: streams text deltas and ends with [DONE]', async () => {
  const h = await harness(() => ({
    body: chatData({ choices: [{ index: 0, delta: { content: '你' } }] })
      + chatData({ choices: [{ index: 0, delta: { content: '好' } }] })
      + chatData({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + chatDone,
  }))
  try {
    const response = await post(h.gateway, '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await response.text()
    const frames = chatFrames(text)
    const content = frames.map(frame => frame.choices[0].delta.content ?? '').join('')
    assert.equal(content, '你好')
    assert.equal(frames.at(-1).choices[0].finish_reason, 'stop')
    assert.ok(text.trimEnd().endsWith('data: [DONE]'))
    assert.equal(h.upstream.captured[0].body.stream, true)
  } finally { await h.close() }
})

test('chat completions: web_search runs in the backend and the answer continues', async () => {
  const h = await harness((captured, index) => index === 0
    ? {
      body: chatData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":' } }] } }] })
        + chatData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Soma"}' } }] } }] })
        + chatData({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + chatDone,
    }
    : {
      body: chatData({ choices: [{ index: 0, delta: { content: '根据搜索，答案如下。' } }] })
        + chatData({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + chatDone,
    })
  try {
    const response = await post(h.gateway, '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: '查一下 Soma' }] })
    const frames = chatFrames(await response.text())
    assert.equal(frames.map(frame => frame.choices[0].delta.content ?? '').join(''), '根据搜索，答案如下。')
    assert.ok(frames.every(frame => !frame.choices[0].delta.tool_calls), 'web_search must not reach the client')

    assert.equal(h.searx.captured.length, 1)
    assert.equal(new URL(h.searx.captured[0].url, 'http://x').searchParams.get('q'), 'Soma')
    assert.equal(new URL(h.searx.captured[0].url, 'http://x').searchParams.get('format'), 'json')

    assert.equal(h.upstream.captured.length, 2)
    const first = h.upstream.captured[0].body
    assert.equal(first.tools.length, 1)
    assert.equal(first.tools[0].function.name, 'web_search')
    const second = h.upstream.captured[1].body.messages
    const tool = second.find((message: any) => message.role === 'tool')
    assert.equal(tool.tool_call_id, 'call_1')
    assert.match(tool.content, /Example Title/)
    assert.doesNotMatch(tool.content, /javascript:/)
    assert.ok(second.some((message: any) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_1'))
  } finally { await h.close() }
})

test('chat completions: calls for the client own tools are forwarded, not executed', async () => {
  const clientTool = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }
  const h = await harness(() => ({
    body: chatData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'w1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] } }] })
      + chatData({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + chatDone,
  }))
  try {
    const response = await post(h.gateway, '/v1/chat/completions', { model: 'm', stream: true, tools: [clientTool], messages: [{ role: 'user', content: '北京天气' }] })
    const frames = chatFrames(await response.text())
    const call = frames.find(frame => frame.choices[0].delta.tool_calls)
    assert.equal(call.choices[0].delta.tool_calls[0].function.name, 'get_weather')
    assert.equal(frames.at(-1).choices[0].finish_reason, 'tool_calls')
    assert.equal(h.searx.captured.length, 0)
    assert.equal(h.upstream.captured.length, 1)
    assert.ok(h.upstream.captured[0].body.tools.some((tool: any) => tool.function?.name === 'get_weather'))
  } finally { await h.close() }
})

test('chat completions: non-streaming request returns one JSON completion', async () => {
  const h = await harness(() => ({
    body: chatData({ choices: [{ index: 0, delta: { content: 'hi ' } }] })
      + chatData({ choices: [{ index: 0, delta: { content: 'there' } }] }) + chatDone,
  }))
  try {
    const response = await post(h.gateway, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const json = await response.json() as any
    assert.equal(json.object, 'chat.completion')
    assert.equal(json.choices[0].message.content, 'hi there')
    assert.equal(json.choices[0].finish_reason, 'stop')
  } finally { await h.close() }
})

test('upstream auth errors come back with the upstream status and message', async () => {
  const h = await harness(() => ({ status: 401, type: 'application/json', body: JSON.stringify({ error: { message: 'invalid api key' } }) }))
  try {
    const response = await post(h.gateway, '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 401)
    const json = await response.json() as any
    assert.equal(json.error.message, 'invalid api key')
  } finally { await h.close() }
})

test('client authorization header is forwarded upstream, not stored', async () => {
  const h = await harness(() => ({ body: chatData({ choices: [{ index: 0, delta: { content: 'ok' } }] }) + chatDone }))
  try {
    await post(h.gateway, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer client-key' })
    assert.equal(h.upstream.captured[0].headers.authorization, 'Bearer client-key')
  } finally { await h.close() }
})

test('max search rounds stop the loop and withdraw the search tool', async () => {
  const h = await harness((captured, index) => index === 0
    ? { body: chatData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"a"}' } }] } }] }) + chatDone }
    : { body: chatData({ choices: [{ index: 0, delta: { content: '只能凭已有信息回答。' } }] }) + chatDone },
  { maxSearchRounds: 1 })
  try {
    const response = await post(h.gateway, '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] })
    const frames = chatFrames(await response.text())
    assert.equal(frames.map(frame => frame.choices[0].delta.content ?? '').join(''), '只能凭已有信息回答。')
    assert.equal(h.upstream.captured.length, 2)
    assert.equal(h.upstream.captured[1].body.tools, undefined)
  } finally { await h.close() }
})

test('a failing search is reported to the model as text, and the request still completes', async () => {
  const h = await harness((captured, index) => index === 0
    ? { body: chatData({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"a"}' } }] } }] }) + chatDone }
    : { body: chatData({ choices: [{ index: 0, delta: { content: '好的。' } }] }) + chatDone },
  {}, 'http://127.0.0.1:1')
  try {
    const response = await post(h.gateway, '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] })
    assert.equal(response.status, 200)
    await response.text()
    const tool = h.upstream.captured[1].body.messages.find((message: any) => message.role === 'tool')
    assert.match(tool.content, /搜索暂时不可用/)
  } finally { await h.close() }
})

// ---- Responses --------------------------------------------------------------

test('responses: web_search function call runs, output goes back as function_call_output', async () => {
  const h = await harness((captured, index) => index === 0
    ? {
      body: named('response.output_item.done', { item: { type: 'function_call', id: 'fc_1', call_id: 'call_r1', name: 'web_search', arguments: '{"query":"Soma"}' } })
        + named('response.completed', { response: { output: [{ type: 'function_call', call_id: 'call_r1', name: 'web_search', arguments: '{"query":"Soma"}' }] } }),
    }
    : {
      body: named('response.output_text.delta', { delta: '找到了' })
        + named('response.output_item.done', { item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '找到了' }] } })
        + named('response.completed', { response: { output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '找到了' }] }] } }),
    })
  try {
    const response = await post(h.gateway, '/v1/responses', {
      model: 'm', stream: true, input: '搜一下 Soma',
      tools: [{ type: 'web_search_preview' }, { type: 'function', name: 'other', parameters: { type: 'object' } }],
    })
    const text = await response.text()
    assert.match(text, /event: response\.output_text\.delta/)
    assert.match(text, /找到了/)
    assert.match(text, /event: response\.completed/)
    assert.doesNotMatch(text, /web_search/)

    const first = h.upstream.captured[0].body
    assert.deepEqual(first.tools.map((tool: any) => tool.name).sort(), ['other', 'web_search'])
    assert.ok(!first.tools.some((tool: any) => String(tool.type).startsWith('web_search_preview')))
    const second = h.upstream.captured[1].body.input
    assert.equal(second[0].role, 'user')
    const output = second.find((item: any) => item.type === 'function_call_output')
    assert.equal(output.call_id, 'call_r1')
    assert.match(output.output, /Example Title/)
  } finally { await h.close() }
})

test('responses: non-streaming request returns a response object with output_text', async () => {
  const h = await harness(() => ({
    body: named('response.output_text.delta', { delta: '你好' })
      + named('response.output_item.done', { item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] } })
      + named('response.completed', { response: { output: [] } }),
  }))
  try {
    const json = await (await post(h.gateway, '/v1/responses', { model: 'm', input: 'hi' })).json() as any
    assert.equal(json.object, 'response')
    assert.equal(json.status, 'completed')
    assert.equal(json.output_text, '你好')
  } finally { await h.close() }
})

// ---- Anthropic Messages -----------------------------------------------------

test('messages: thinking signature survives the round trip and tool_result goes back', async () => {
  const h = await harness((captured, index) => index === 0
    ? {
      body: named('message_start', { message: { id: 'msg_u1', role: 'assistant', content: [] } })
        + named('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
        + named('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'let me look' } })
        + named('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG' } })
        + named('content_block_stop', { index: 0 })
        + named('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'web_search', input: {} } })
        + named('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } })
        + named('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"y"}' } })
        + named('content_block_stop', { index: 1 })
        + named('message_delta', { delta: { stop_reason: 'tool_use' } })
        + named('message_stop', {}),
    }
    : {
      body: named('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + named('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '好的' } })
        + named('content_block_stop', { index: 0 })
        + named('message_delta', { delta: { stop_reason: 'end_turn' } })
        + named('message_stop', {}),
    })
  try {
    const response = await post(h.gateway, '/v1/messages', { model: 'm', max_tokens: 100, stream: true, messages: [{ role: 'user', content: '查 y' }] }, { 'x-api-key': 'client-key', 'anthropic-version': '2023-06-01' })
    const text = await response.text()
    assert.match(text, /event: message_start/)
    assert.match(text, /"signature_delta"/)
    assert.match(text, /"SIG"/)
    assert.match(text, /"thinking_delta"/)
    assert.match(text, /好的/)
    assert.match(text, /event: message_stop/)
    assert.doesNotMatch(text, /"name":"web_search"/)

    assert.equal(h.upstream.captured[0].headers['x-api-key'], 'client-key')
    assert.equal(h.upstream.captured[0].url, '/v1/messages')
    const second = h.upstream.captured[1].body.messages
    const assistant = second.find((message: any) => message.role === 'assistant')
    assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'let me look', signature: 'SIG' })
    assert.equal(assistant.content[1].type, 'tool_use')
    assert.deepEqual(assistant.content[1].input, { query: 'y' })
    const result = second.at(-1)
    assert.equal(result.role, 'user')
    assert.equal(result.content[0].type, 'tool_result')
    assert.equal(result.content[0].tool_use_id, 'tu1')
    assert.match(result.content[0].content, /Example Title/)
  } finally { await h.close() }
})

test('messages: non-streaming request returns a message object', async () => {
  const h = await harness(() => ({
    body: named('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + named('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好' } })
      + named('content_block_stop', { index: 0 })
      + named('message_stop', {}),
  }))
  try {
    const json = await (await post(h.gateway, '/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).json() as any
    assert.equal(json.type, 'message')
    assert.equal(json.content[0].text, '你好')
    assert.equal(json.stop_reason, 'end_turn')
  } finally { await h.close() }
})

// ---- Health, origins, validation -------------------------------------------

test('health reports search availability for the settings page', async () => {
  const h = await harness(() => ({ body: '' }))
  try {
    const json = await (await fetch(`${h.gateway}/health`)).json() as any
    assert.equal(json.status, 'ok')
    assert.equal(json.search, 'available')
  } finally { await h.close() }
})

test('requests from unknown browser origins are rejected, allowed ones get CORS headers', async () => {
  const h = await harness(() => ({ body: chatDone }))
  try {
    const denied = await fetch(`${h.gateway}/health`, { headers: { origin: 'http://evil.example' } })
    assert.equal(denied.status, 403)
    const allowed = await fetch(`${h.gateway}/health`, { headers: { origin: 'http://127.0.0.1:5173' } })
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173')
  } finally { await h.close() }
})

test('invalid bodies are rejected with 400 before any upstream call', async () => {
  const h = await harness(() => ({ body: chatDone }))
  try {
    const notJson = await fetch(`${h.gateway}/v1/chat/completions`, { method: 'POST', body: '{bad' })
    assert.equal(notJson.status, 400)
    const noMessages = await post(h.gateway, '/v1/chat/completions', { model: 'm' })
    assert.equal(noMessages.status, 400)
    assert.equal(h.upstream.captured.length, 0)
  } finally { await h.close() }
})
