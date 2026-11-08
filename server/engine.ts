import type { Config } from './config.ts'
import type { Adapter, ToolSpec, Writer } from './types.ts'
import { UpstreamError } from './types.ts'

export const WEB_SEARCH: ToolSpec = {
  name: 'web_search',
  description: '在网上搜索最新信息。需要查证事实、了解时效内容或用户明确要求时使用。返回若干条结果（标题、链接、摘要）。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '搜索关键词' } },
    required: ['query'],
  },
}

export interface AgentInput {
  adapter: Adapter
  cfg: Config
  body: Record<string, unknown>
  headers: Record<string, string | string[] | undefined>
  writer: Writer
  signal: AbortSignal
  search: (rawArgs: string, signal: AbortSignal) => Promise<string>
}

/**
 * One client request, one agent loop. Each upstream turn streams straight to the client,
 * except web_search calls: those run here, their results go back upstream, and the loop continues.
 * Calls the client must handle (its own tools) are forwarded at the end of the turn.
 */
export async function runAgent(input: AgentInput): Promise<void> {
  const { adapter, cfg, body, headers, writer, signal, search } = input
  const sink = adapter.createSink(writer, String(body.model ?? ''))
  const items = adapter.init(body)

  // Everything except the conversation items and the stream flag is passed through unchanged.
  const base: Record<string, unknown> = { ...body }
  delete base[adapter.itemsKey]
  delete base.stream

  const url = adapter.upstreamUrl(cfg)
  const upstreamHeaders = adapter.upstreamHeaders(cfg, headers)
  let rounds = 0
  let searchEnabled = true

  for (;;) {
    const tools = adapter.tools(body.tools, searchEnabled ? WEB_SEARCH : null)
    const payload: Record<string, unknown> = { ...base, stream: true, [adapter.itemsKey]: items }
    if (tools.length > 0) payload.tools = tools
    else delete payload.tools

    const response = await fetch(url, { method: 'POST', headers: upstreamHeaders, body: JSON.stringify(payload), signal })
    if (!response.ok) throw new UpstreamError(response.status, await upstreamMessage(response))

    const turn = await adapter.parse(response, {
      text: sink.text,
      thinking: sink.thinking,
      signature: sink.signature,
    })

    const ours = turn.calls.filter(call => call.name === WEB_SEARCH.name)
    const others = turn.calls.filter(call => call.name !== WEB_SEARCH.name)
    if (ours.length > 0 && others.length === 0 && searchEnabled) {
      rounds++
      if (rounds >= cfg.maxSearchRounds) searchEnabled = false
      adapter.appendTurn(items, turn)
      const outputs = await Promise.all(ours.map(call => search(call.args, signal)))
      adapter.appendResults(items, ours.map((call, index) => ({ call, output: outputs[index] })))
      continue
    }

    if (turn.calls.length > 0) sink.calls(turn.calls)
    sink.finish(turn.calls.length > 0)
    return
  }
}

/** Pulls a readable message out of an upstream error body, whatever its shape. */
async function upstreamMessage(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown }
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
    if (typeof message === 'string' && message) return message
  } catch { /* Not JSON: fall through to the raw text. */ }
  return text.slice(0, 500) || `上游返回 ${response.status}`
}
