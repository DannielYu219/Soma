import { creatorChangesContext, creatorSnapshot } from './creator.ts'
import type { CreatorDocument } from './creator'

export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high'
export interface ServiceSettings { provider: 'openai-compatible' | 'responses' | 'anthropic'; baseUrl: string; model: string; apiKey: string; reasoningEffort?: ReasoningEffort; search?: { enabled?: boolean; model?: string }; models?: { items: Array<{ id: string; name: string }>; updatedAt: number } }
export interface ConversationMessage { role: 'user' | 'assistant'; content: string }
interface Handlers { text(delta: string): void; reasoning?(delta: string): void; creator(document: CreatorDocument): void; status(message: string): void }

/** Decode SSE incrementally, including CRLF split across packets and a UTF-8 character split across reads. */
export async function streamConversation(service: ServiceSettings, messages: ConversationMessage[], creator: CreatorDocument | null, handlers: Handlers, signal: AbortSignal): Promise<void> {
  const response = await fetch('/api/conversation', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: { provider: service.provider, baseUrl: service.baseUrl, model: service.model, apiKey: service.apiKey, ...(service.search ? { search: service.search } : {}), ...(service.reasoningEffort ? { reasoningEffort: service.reasoningEffort } : {}) }, messages, ...(creator ? { creator: creatorSnapshot(creator), creatorChanges: creatorChangesContext(creator) } : {}) }), signal,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.error?.message || `连接失败（${response.status}）`)
  }
  if (!response.body) throw new Error('服务没有返回内容。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false
  function frame(block: string) {
    const lines = block.split(/\r?\n/)
    const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
    const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!raw) return
    const data = JSON.parse(raw)
    if (name === 'text') handlers.text(data.delta)
    else if (name === 'reasoning' && typeof data.delta === 'string') handlers.reasoning?.(data.delta)
    else if (name === 'creator') handlers.creator(data.document)
    else if (name === 'status') handlers.status(data.message)
    else if (name === 'error') throw new Error(data.message || '回应暂时中断。')
    else if (name === 'done') completed = true
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
      }
      if (done) break
    }
    if (!completed && !signal.aborted) throw new Error('连接中断，已收到的内容已保留。')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
