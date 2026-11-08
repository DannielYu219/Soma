import { randomUUID } from 'node:crypto'
import type { Adapter, Sink, ToolCall, ToolSpec, Turn, TurnHandlers, Writer } from '../types.ts'
import { HttpError, UpstreamError } from '../types.ts'
import type { Config } from '../config.ts'
import { parseJson, readSse, safeParse, sseEvent, writeJson, writeSseHead } from '../sse.ts'

type Incoming = Record<string, string | string[] | undefined>
type Block = Record<string, any>

function header(incoming: Incoming, name: string): string | undefined {
  const value = incoming[name]
  return Array.isArray(value) ? value[0] : value
}

function messagesSink(writer: Writer, model: string): Sink {
  const { res, stream } = writer
  const id = `msg_${randomUUID()}`
  let begun = false
  let index = 0
  let open: { index: number; block: Block } | null = null
  const content: Array<Block | undefined> = []

  const event = (name: string, payload: Record<string, unknown>) => { if (stream) sseEvent(res, name, payload) }
  const begin = () => {
    if (begun) return
    begun = true
    if (stream) {
      writeSseHead(res)
      event('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
    }
  }
  const close = () => {
    if (!open) return
    event('content_block_stop', { index: open.index })
    open = null
  }
  const openBlock = (block: Block) => {
    close()
    const blockIndex = index++
    content[blockIndex] = block
    event('content_block_start', { index: blockIndex, content_block: { ...block } })
    open = { index: blockIndex, block }
  }
  const delta = (payload: Record<string, unknown>) => {
    if (open) event('content_block_delta', { index: open.index, delta: payload })
  }

  return {
    text(value) {
      if (!value) return
      begin()
      if (!open || open.block.type !== 'text') openBlock({ type: 'text', text: '' })
      open!.block.text += value
      delta({ type: 'text_delta', text: value })
    },
    thinking(value) {
      if (!value) return
      begin()
      if (!open || open.block.type !== 'thinking') openBlock({ type: 'thinking', thinking: '', signature: '' })
      open!.block.thinking += value
      delta({ type: 'thinking_delta', thinking: value })
    },
    signature(value) {
      if (!value || !open || open.block.type !== 'thinking') return
      open.block.signature += value
      delta({ type: 'signature_delta', signature: value })
    },
    calls(list) {
      begin()
      for (const call of list) {
        const block: Block = { type: 'tool_use', id: call.id, name: call.name, input: {} }
        openBlock(block)
        delta({ type: 'input_json_delta', partial_json: call.args })
        block.input = safeParse(call.args) ?? {}
      }
    },
    finish(hasCalls) {
      begin()
      close()
      const stop = hasCalls ? 'tool_use' : 'end_turn'
      if (stream) {
        event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 0 } })
        event('message_stop', {})
        res.end()
      } else {
        writeJson(res, 200, {
          id, type: 'message', role: 'assistant', model,
          content: content.filter(Boolean),
          stop_reason: stop, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        })
      }
    },
    fail(error) {
      if (res.headersSent) {
        if (stream) event('error', { error: { type: error.type, message: error.message } })
        res.end()
        return
      }
      writeJson(res, error.status, { type: 'error', error: { type: error.type, message: error.message } })
    },
  }
}

export const messagesAdapter: Adapter = {
  itemsKey: 'messages',

  init(body) {
    if (!Array.isArray(body.messages)) throw new HttpError(400, 'messages 必须是数组。')
    return [...body.messages]
  },

  tools(client, spec: ToolSpec | null) {
    const kept = (Array.isArray(client) ? client : []).filter((tool: any) =>
      !String(tool?.type ?? '').startsWith('web_search') && tool?.name !== spec?.name)
    return spec ? [...kept, { name: spec.name, description: spec.description, input_schema: spec.parameters }] : kept
  },

  upstreamUrl(cfg: Config) {
    const base = cfg.anthropicBaseUrl.replace(/\/+$/, '')
    return `${base.endsWith('/v1') ? base : `${base}/v1`}/messages`
  },

  upstreamHeaders(cfg: Config, incoming) {
    const key = header(incoming, 'x-api-key') ?? cfg.anthropicApiKey
    const beta = header(incoming, 'anthropic-beta')
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': header(incoming, 'anthropic-version') || '2023-06-01',
      ...(key ? { 'x-api-key': key } : {}),
      ...(beta ? { 'anthropic-beta': beta } : {}),
    }
  },

  async parse(response: Response, handlers: TurnHandlers): Promise<Turn> {
    let text = ''
    const blocks: Array<Block | undefined> = []
    const partial: string[] = []
    for await (const block of readSse(response)) {
      const payload = parseJson(block.data)
      if (!payload) continue
      const type = payload.type ?? block.event
      if (type === 'content_block_start') {
        const started: Block = { ...payload.content_block }
        blocks[payload.index] = started
        partial[payload.index] = ''
        if (started.type === 'text' && started.text) { text += started.text; handlers.text(started.text) }
        if (started.type === 'thinking' && started.thinking) handlers.thinking(started.thinking)
      } else if (type === 'content_block_delta') {
        const target = blocks[payload.index]
        const change = payload.delta ?? {}
        if (!target) continue
        if (change.type === 'text_delta') {
          target.text = (target.text ?? '') + change.text
          text += change.text
          handlers.text(change.text)
        } else if (change.type === 'thinking_delta') {
          target.thinking = (target.thinking ?? '') + change.thinking
          handlers.thinking(change.thinking)
        } else if (change.type === 'signature_delta') {
          target.signature = (target.signature ?? '') + change.signature
          handlers.signature(change.signature)
        } else if (change.type === 'input_json_delta') {
          partial[payload.index] += change.partial_json ?? ''
        }
      } else if (type === 'error') {
        throw new UpstreamError(502, String(payload.error?.message ?? '上游返回错误'))
      }
    }

    const raw: unknown[] = []
    const calls: ToolCall[] = []
    // forEach skips holes left by unused indexes, and keeps block order.
    blocks.forEach((block, index) => {
      if (!block) return
      if (block.type === 'tool_use') {
        const args = partial[index] || JSON.stringify(block.input ?? {})
        calls.push({ id: String(block.id), name: String(block.name), args })
        raw.push({ type: 'tool_use', id: block.id, name: block.name, input: safeParse(args) ?? {} })
      } else if (block.type === 'text') {
        raw.push({ type: 'text', text: block.text ?? '' })
      } else if (block.type === 'thinking') {
        raw.push({ type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' })
      } else if (block.type === 'redacted_thinking') {
        raw.push({ type: 'redacted_thinking', data: block.data })
      }
    })
    return { text, calls, raw }
  },

  appendTurn(items, turn) {
    items.push({ role: 'assistant', content: turn.raw })
  },

  appendResults(items, results) {
    items.push({ role: 'user', content: results.map(result => ({ type: 'tool_result', tool_use_id: result.call.id, content: result.output })) })
  },

  createSink: messagesSink,
}
