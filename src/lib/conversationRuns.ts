import type { CreatorDocument } from './creator'
import type { ConversationMessage, ServiceSettings } from './conversation'
import { creatorChangesContext, creatorSnapshot } from './creator.ts'

export interface PendingRun { id: string; assistantId: string; baseRevision?: number; appliedSequence: number }
export interface RunSnapshot {
  id: string; conversationId: string; assistantId: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  text: string; reasoning: string; status: string | { phase: string; message: string }; error?: string
  creators: Array<{ sequence: number; document: CreatorDocument }>
  createdAt: number; updatedAt: number; baseRevision?: number
}

/** Wake immediately when Safari returns, rather than trusting a suspended timer. */
function nextPoll(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); window.removeEventListener('pageshow', finish); window.removeEventListener('online', finish); document.removeEventListener('visibilitychange', visible); signal.removeEventListener('abort', finish); resolve() }
    const visible = () => { if (!document.hidden) finish() }
    const timer = setTimeout(finish, document.hidden ? 4000 : 700)
    window.addEventListener('pageshow', finish)
    window.addEventListener('online', finish)
    document.addEventListener('visibilitychange', visible)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

async function runFetch(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = setTimeout(abort, 12_000)
  let wasHidden = document.hidden
  const visibility = () => {
    if (document.hidden) wasHidden = true
    else if (wasHidden) abort()
  }
  signal.addEventListener('abort', abort, { once: true })
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pageshow', abort)
  if (signal.aborted) abort()
  try { return await fetch(url, { ...init, signal: controller.signal }) }
  finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pageshow', abort)
  }
}

async function getSnapshot(id: string, signal: AbortSignal): Promise<RunSnapshot | null> {
  const response = await runFetch(`/api/conversation-runs/${encodeURIComponent(id)}`, { cache: 'no-store' }, signal)
  if (response.status === 404) return null
  if (!response.ok) throw new Error('暂时无法同步回应')
  return response.json()
}

export async function cancelConversationRun(id: string): Promise<void> {
  const response = await fetch(`/api/conversation-runs/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true })
  if (!response.ok && response.status !== 404) throw new Error('停止请求未送达，请重试。')
}

/** The browser observes a server-owned task. Retrying creation is safe because its ID is stable. */
export async function observeConversationRun(run: PendingRun, signal: AbortSignal, update: (snapshot: RunSnapshot) => void, reconnecting: () => void, start?: { conversationId: string; service: ServiceSettings; messages: ConversationMessage[]; creator: CreatorDocument | null }): Promise<void> {
  let created = !start
  while (!signal.aborted) {
    try {
      let snapshot: RunSnapshot | null
      if (!created && start) {
        const { service, messages, creator, conversationId } = start
        const response = await runFetch('/api/conversation-runs', {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal,
          body: JSON.stringify({ runId: run.id, conversationId, assistantId: run.assistantId,
            service: { provider: service.provider, baseUrl: service.baseUrl, model: service.model, apiKey: service.apiKey, search: service.search, reasoningEffort: service.reasoningEffort }, messages,
            ...(creator ? { creator: creatorSnapshot(creator), creatorChanges: creatorChangesContext(creator) } : {}) }),
        }, signal)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          const data = await response.json().catch(() => null)
          throw new RunError(data?.error?.message || '请求未能开始，请重试。')
        }
        if (!response.ok) throw new Error('暂时无法同步回应')
        snapshot = await response.json()
        created = true
      } else snapshot = await getSnapshot(run.id, signal)
      if (!snapshot) throw new RunError('这次回应的后台记录不存在，请重新发送。')
      update(snapshot)
      if (snapshot.state !== 'running') {
        if (snapshot.state === 'failed') throw new RunError(snapshot.error || '回应暂时中断。')
        if (snapshot.state === 'cancelled') return
        return
      }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof RunError) throw error
      reconnecting()
    }
    await nextPoll(signal)
  }
}
class RunError extends Error {}
