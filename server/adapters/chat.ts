import { randomUUID } from 'node:crypto'
import type { Adapter, Sink, ToolCall, ToolSpec, Turn, TurnHandlers, Writer } from '../types.ts'
import { HttpError, UpstreamError } from '../types.ts'
import type { Config } from '../config.ts'
import { parseJson, readSse, sseData, writeJson, writeSseHead } from '../sse.ts'

type Incoming = Record<string, string | string[] | undefined>

function header(incoming: Incoming, name: string): string | undefined {
  const value = incoming[name]
  return Array.isArray(value) ? value[0] : value
}

function chatSink(writer: Writer, model: string): Sink {
  const { res, stream } = writer
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let begun = false
  let text = ''
  const calls: ToolCall[] = []

  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const begin = () => {
    if (begun) return
    begun = true
    if (stream) {
      writeSseHead(res)
      sseData(res, chunk({ role: 'assistant' }))
    }
  }

  return {
    text(delta) {
      if (!delta) return
      begin()
      text += delta
      if (stream) sseData(res, chunk({ content: delta }))
    },
    thinking() { /* Chat Completions has no thinking channel in this gateway. */ },
    signature() { /* Same as thinking. */ },
    calls(list) {
      begin()
      list.forEach((call, index) => {
        calls.push(call)
        if (stream) sseData(res, chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] }))
      })
    },
    finish(hasCalls) {
      begin()
      const reason = hasCalls ? 'tool_calls' : 'stop'
      if (stream) {
        sseData(res, chunk({}, reason))
        sseData(res, '[DONE]')
        res.end()
        return
      }
      writeJson(res, 200, {
        id, object: 'chat.completion', created, model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: calls.length && !text ? null : text,
            ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } })) } : {}),
          },
          finish_reason: reason,
        }],
      })
    },
    fail(error) {
      if (res.headersSent) {
        if (stream) {
          sseData(res, { error: { message: error.message, type: error.type } })
          sseData(res, '[DONE]')
        }
        res.end()
        return
      }
      writeJson(res, error.status, { error: { message: error.message, type: error.type, param: null, code: null } })
    },
  }
}

export const chatAdapter: Adapter = {
  itemsKey: 'messages',

  init(body) {
    if (!Array.isArray(body.messages)) throw new HttpError(400, 'messages 必须是数组。')
    return [...body.messages]
  },

  tools(client, spec) {
    const kept = (Array.isArray(client) ? client : []).filter((tool: any) =>
      !String(tool?.type ?? '').startsWith('web_search') && tool?.function?.name !== spec?.name)
    return spec ? [...kept, { type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.parameters } }] : kept
  },

  upstreamUrl(cfg: Config) {
    return `${cfg.openaiBaseUrl.replace(/\/+$/, '')}/chat/completions`
  },

  upstreamHeaders(cfg: Config, incoming) {
    const auth = header(incoming, 'authorization') ?? (cfg.openaiApiKey ? `Bearer ${cfg.openaiApiKey}` : undefined)
    return { 'content-type': 'application/json', accept: 'text/event-stream', ...(auth ? { authorization: auth } : {}) }
  },

  async parse(response: Response, handlers: TurnHandlers): Promise<Turn> {
    let text = ''
    let reasoning = ''
    let reasoningKey = 'reasoning_content'
    const calls = new Map<number, ToolCall>()
    for await (const block of readSse(response)) {
      if (block.data === '[DONE]') break
      const chunk = parseJson(block.data)
      if (chunk?.error) throw new UpstreamError(502, String(chunk.error.message ?? '上游返回错误'))
      const delta = chunk?.choices?.[0]?.delta
      if (!delta) continue
      const thinkingKey = typeof delta.reasoning_content === 'string' ? 'reasoning_content' : 'reasoning'
      if (typeof delta[thinkingKey] === 'string' && delta[thinkingKey]) {
        reasoningKey = thinkingKey
        reasoning += delta[thinkingKey]
        handlers.thinking(delta[thinkingKey])
      }
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content
        handlers.text(delta.content)
      }
      for (const part of delta.tool_calls ?? []) {
        const index = typeof part.index === 'number' ? part.index : calls.size
        const slot = calls.get(index) ?? { id: '', name: '', args: '' }
        if (part.id) slot.id = part.id
        if (part.function?.name && !slot.name) slot.name = part.function.name
        if (part.function?.arguments) slot.args += part.function.arguments
        calls.set(index, slot)
      }
    }
    const list = [...calls.values()].map(call => ({ id: call.id || `call_${randomUUID()}`, name: call.name, args: call.args || '{}' }))
    return { text, calls: list, raw: reasoning ? [{ [reasoningKey]: reasoning }] : [] }
  },

  appendTurn(items, turn) {
    const message: Record<string, unknown> = { role: 'assistant', content: turn.text || null, ...turn.raw[0] as object }
    if (turn.calls.length) message.tool_calls = turn.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }))
    items.push(message)
  },

  appendResults(items, results) {
    for (const result of results) items.push({ role: 'tool', tool_call_id: result.call.id, content: result.output })
  },

  createSink: chatSink,
}
