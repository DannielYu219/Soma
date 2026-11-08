import { randomUUID } from 'node:crypto'
import type { Adapter, Sink, ToolCall, Turn, TurnHandlers, Writer } from '../types.ts'
import { HttpError, UpstreamError } from '../types.ts'
import type { Config } from '../config.ts'
import { parseJson, readSse, sseEvent, writeJson, writeSseHead } from '../sse.ts'

type Incoming = Record<string, string | string[] | undefined>

function header(incoming: Incoming, name: string): string | undefined {
  const value = incoming[name]
  return Array.isArray(value) ? value[0] : value
}

function responsesSink(writer: Writer, model: string): Sink {
  const { res, stream } = writer
  const id = `resp_${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const output: unknown[] = []
  let nextIndex = 0
  let begun = false
  let fullText = ''
  let message: { id: string; index: number; text: string } | null = null

  const event = (name: string, payload: Record<string, unknown>) => { if (stream) sseEvent(res, name, payload) }
  const skeleton = (status: string) => ({ id, object: 'response', created_at: created, model, status, output: [] as unknown[] })
  const begin = () => {
    if (begun) return
    begun = true
    if (stream) {
      writeSseHead(res)
      event('response.created', { response: skeleton('in_progress') })
      event('response.in_progress', { response: skeleton('in_progress') })
    }
  }
  const closeMessage = () => {
    if (!message) return
    const part = { type: 'output_text', text: message.text, annotations: [] }
    event('response.output_text.done', { item_id: message.id, output_index: message.index, content_index: 0, text: message.text })
    event('response.content_part.done', { item_id: message.id, output_index: message.index, content_index: 0, part })
    const item = { id: message.id, type: 'message', status: 'completed', role: 'assistant', content: [part] }
    event('response.output_item.done', { output_index: message.index, item })
    output[message.index] = item
    message = null
  }

  return {
    text(delta) {
      if (!delta) return
      begin()
      if (!message) {
        const itemId = `msg_${randomUUID()}`
        const index = nextIndex++
        message = { id: itemId, index, text: '' }
        event('response.output_item.added', { output_index: index, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
        event('response.content_part.added', { item_id: itemId, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      }
      message.text += delta
      fullText += delta
      event('response.output_text.delta', { item_id: message.id, output_index: message.index, content_index: 0, delta })
    },
    thinking() { /* Reasoning summaries are not forwarded. Reasoning items are replayed upstream as raw output. */ },
    signature() { /* Not used by Responses. */ },
    calls(list) {
      begin()
      closeMessage()
      for (const call of list) {
        const index = nextIndex++
        const itemId = `fc_${randomUUID()}`
        event('response.output_item.added', { output_index: index, item: { id: itemId, type: 'function_call', status: 'in_progress', call_id: call.id, name: call.name, arguments: '' } })
        event('response.function_call_arguments.delta', { item_id: itemId, output_index: index, delta: call.args })
        event('response.function_call_arguments.done', { item_id: itemId, output_index: index, arguments: call.args })
        const item = { id: itemId, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.args }
        event('response.output_item.done', { output_index: index, item })
        output[index] = item
      }
    },
    finish(_hasCalls) {
      begin()
      closeMessage()
      const full = { ...skeleton('completed'), output: output.filter(Boolean), output_text: fullText }
      if (stream) {
        event('response.completed', { response: full })
        res.end()
      } else {
        writeJson(res, 200, full)
      }
    },
    fail(error) {
      if (res.headersSent) {
        if (stream) {
          event('response.failed', { response: { id, object: 'response', status: 'failed', error: { code: error.type, message: error.message } } })
        }
        res.end()
        return
      }
      writeJson(res, error.status, { error: { message: error.message, type: error.type, param: null, code: null } })
    },
  }
}

export const responsesAdapter: Adapter = {
  itemsKey: 'input',

  init(body) {
    const input = body.input
    if (typeof input === 'string') return [{ role: 'user', content: input }]
    if (Array.isArray(input)) return [...input]
    if (input === undefined) return []
    throw new HttpError(400, 'input 必须是字符串或数组。')
  },

  tools(client, spec) {
    const kept = (Array.isArray(client) ? client : []).filter((tool: any) =>
      !String(tool?.type ?? '').startsWith('web_search') && tool?.name !== spec?.name)
    return spec ? [...kept, { type: 'function', name: spec.name, description: spec.description, parameters: spec.parameters }] : kept
  },

  upstreamUrl(cfg: Config) {
    return `${cfg.openaiBaseUrl.replace(/\/+$/, '')}/responses`
  },

  upstreamHeaders(cfg: Config, incoming) {
    const auth = header(incoming, 'authorization') ?? (cfg.openaiApiKey ? `Bearer ${cfg.openaiApiKey}` : undefined)
    return { 'content-type': 'application/json', accept: 'text/event-stream', ...(auth ? { authorization: auth } : {}) }
  },

  async parse(response: Response, handlers: TurnHandlers): Promise<Turn> {
    let text = ''
    const streamed: unknown[] = []
    let completedOutput: unknown[] | null = null
    for await (const block of readSse(response)) {
      const payload = parseJson(block.data)
      if (!payload) continue
      const type = payload.type ?? block.event
      switch (type) {
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (typeof payload.delta === 'string' && payload.delta) handlers.thinking(payload.delta)
          break
        case 'response.output_text.delta':
          if (payload.delta) {
            text += payload.delta
            handlers.text(payload.delta)
          }
          break
        case 'response.output_item.done':
          if (payload.item) streamed.push(payload.item)
          break
        case 'response.completed':
        case 'response.incomplete':
          completedOutput = payload.response?.output ?? null
          break
        case 'response.failed':
        case 'error':
          throw new UpstreamError(502, String(payload.response?.error?.message ?? payload.message ?? '上游返回错误'))
      }
    }
    // Some compatible services only send the full output on completion. Prefer the stream when it has items.
    const output = streamed.length ? streamed : completedOutput ?? []
    const calls: ToolCall[] = (output as any[])
      .filter(item => item?.type === 'function_call')
      .map(item => ({ id: String(item.call_id), name: String(item.name), args: String(item.arguments || '{}') }))
    return { text, calls, raw: output }
  },

  appendTurn(items, turn) {
    items.push(...turn.raw)
  },

  appendResults(items, results) {
    for (const result of results) items.push({ type: 'function_call_output', call_id: result.call.id, output: result.output })
  },

  createSink: responsesSink,
}
