import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { cancelConversationRun, observeConversationRun } from '../src/lib/conversationRuns.ts'
import type { PendingRun, RunSnapshot } from '../src/lib/conversationRuns.ts'
import type { ServiceSettings } from '../src/lib/conversation.ts'

class BrowserEvents extends EventTarget {
  hidden = false
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, callback, options)
    if (callback) {
      const listeners = this.listeners.get(type) || new Set()
      listeners.add(callback)
      this.listeners.set(type, listeners)
    }
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    super.removeEventListener(type, callback, options)
    if (callback) this.listeners.get(type)?.delete(callback)
  }

  count(type: string) { return this.listeners.get(type)?.size || 0 }
  get listenerCount() { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0) }
  fire(type: string) { this.dispatchEvent(new Event(type)) }
}

const run: PendingRun = { id: 'run /一', assistantId: 'assistant-1', appliedSequence: 0 }
const endpoint = `/api/conversation-runs/${encodeURIComponent(run.id)}`
const start = {
  conversationId: 'conversation-1',
  service: { provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'test', apiKey: 'test-key' } satisfies ServiceSettings,
  messages: [{ role: 'user' as const, content: 'hello' }],
  creator: null as import('../src/lib/creator.ts').CreatorDocument | null,
}
const snapshot = (extra: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id: run.id, conversationId: start.conversationId, assistantId: run.assistantId,
  state: 'running', text: 'first', reasoning: 'thinking', status: 'working', creators: [],
  createdAt: 1, updatedAt: 2, ...extra,
})
const json = (value: unknown, status = 200) => Response.json(value, { status })

async function until(check: () => boolean, description: string) {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return
    await setImmediate()
  }
  assert.fail(`Did not reach ${description}`)
}

function rig(t: TestContext, reply: (url: string, init: RequestInit, index: number) => Response | Promise<Response>) {
  const window = new BrowserEvents()
  const document = new BrowserEvents()
  const descriptors = new Map(['window', 'document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const calls: Array<{ url: string; init: RequestInit }> = []
  const controller = new AbortController()
  const updates: RunSnapshot[] = []
  const observations: Promise<void>[] = []
  let reconnects = 0
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    fetch: { configurable: true, value: (input: string, init: RequestInit = {}) => {
      const index = calls.length
      calls.push({ url: String(input), init })
      return reply(String(input), init, index)
    } },
  })
  t.after(async () => {
    controller.abort()
    try {
      await Promise.allSettled(observations)
      assert.equal(window.listenerCount, 0, 'window listeners are cleaned up')
      assert.equal(document.listenerCount, 0, 'document listeners are cleaned up')
    } finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  })
  return {
    window, document, controller, calls, updates,
    get reconnects() { return reconnects },
    observe(creation?: typeof start) {
      const observation = observeConversationRun(run, controller.signal, value => updates.push(value), () => { reconnects++ }, creation)
      observations.push(observation)
      // Attach a rejection handler immediately, including when a test awaits a wake first.
      void observation.catch(() => {})
      return observation
    },
    async polling() { await until(() => window.count('online') > 0, 'observer waiting for a wake event') },
  }
}

function pendingFetch(signal: AbortSignal) {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

test('POST retries Safari Load failed with the same idempotent payload, then switches to GET', { timeout: 2000 }, async t => {
  const h = rig(t, (_url, _init, index) => {
    if (index === 0) throw new TypeError('Load failed')
    return json(snapshot({ state: index === 1 ? 'running' : 'completed' }))
  })
  const observing = h.observe(start)
  await h.polling()
  assert.equal(h.reconnects, 1)
  assert.equal(h.updates.length, 0)
  h.window.fire('online')
  await until(() => h.updates.length === 1 && h.window.count('online') > 0, 'POST retry snapshot')
  assert.deepEqual(h.calls.slice(0, 2).map(call => call.init.method), ['POST', 'POST'])
  assert.equal(h.calls[0].init.body, h.calls[1].init.body)
  assert.deepEqual(JSON.parse(String(h.calls[1].init.body)), { runId: run.id, assistantId: run.assistantId, conversationId: start.conversationId, service: start.service, messages: start.messages })
  h.window.fire('online')
  await observing
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[2].url, endpoint)
  assert.equal(h.calls[2].init.method, undefined)
  assert.equal(h.updates.at(-1)?.state, 'completed')
})

test('GET retry delivers complete snapshots without duplicating text, reasoning, or creator events', { timeout: 2000 }, async t => {
  const creator = { sequence: 1, document: { title: 'Draft', revision: 1, activeChapterId: 'c', chapters: [{ id: 'c', title: 'One', text: 'content' }] } }
  const first = snapshot({ creators: [creator] })
  const last = snapshot({ state: 'completed', text: 'first final', reasoning: 'thinking done', creators: [creator], updatedAt: 3 })
  const h = rig(t, (_url, _init, index) => {
    if (index === 1) throw new TypeError('Load failed')
    if (index === 2) return json({ error: 'unavailable' }, 503)
    return json(index === 4 ? last : first)
  })
  const observing = h.observe()
  for (let index = 0; index < 4; index++) {
    await h.polling()
    assert.equal(h.calls.length, index + 1)
    h.window.fire('online')
    await until(() => h.calls.length === index + 2, 'next GET')
  }
  await observing
  assert.equal(h.reconnects, 2)
  assert.deepEqual(h.updates, [first, first, last])
  assert.ok(h.calls.every(call => call.url === endpoint && call.init.cache === 'no-store' && call.init.method === undefined))
  assert.equal(h.updates.at(-1)?.text, 'first final')
  assert.equal(h.updates.at(-1)?.reasoning, 'thinking done')
  assert.equal(h.updates.at(-1)?.creators.length, 1)
})

test('aborting while polling stops observation without DELETE', { timeout: 2000 }, async t => {
  const h = rig(t, () => json(snapshot()))
  const observing = h.observe()
  await h.polling()
  h.controller.abort()
  await observing
  h.window.fire('online')
  h.window.fire('pageshow')
  assert.equal(h.calls.length, 1)
  assert.equal(h.reconnects, 0)
  assert.equal(h.updates.length, 1)
  assert.ok(h.calls.every(call => call.init.method !== 'DELETE'))
})

test('aborting an in-flight fetch aborts its signal without DELETE or reconnect error', { timeout: 2000 }, async t => {
  const h = rig(t, (_url, init) => pendingFetch(init.signal!))
  const observing = h.observe()
  assert.equal(h.calls[0].init.signal?.aborted, false)
  h.controller.abort()
  await observing
  assert.equal(h.calls[0].init.signal?.aborted, true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.reconnects, 0)
  assert.deepEqual(h.updates, [])
})

test('explicit cancel sends encoded DELETE with keepalive; missing tasks are already stopped', { timeout: 2000 }, async t => {
  const h = rig(t, (_url, _init, index) => new Response(null, { status: index === 0 ? 204 : index === 1 ? 404 : 503 }))
  await cancelConversationRun(run.id)
  await cancelConversationRun(run.id)
  await assert.rejects(cancelConversationRun(run.id), /停止请求未送达，请重试。/)
  assert.equal(h.calls.length, 3)
  for (const call of h.calls) {
    assert.equal(call.url, endpoint)
    assert.equal(call.init.method, 'DELETE')
    assert.equal(call.init.keepalive, true)
  }
})

test('server failed snapshot is delivered and rejects with its terminal error', { timeout: 2000 }, async t => {
  const failed = snapshot({ state: 'failed', text: 'partial', error: 'provider rejected request' })
  const h = rig(t, () => json(failed))
  await assert.rejects(h.observe(), /provider rejected request/)
  assert.deepEqual(h.updates, [failed])
  h.window.fire('online')
  assert.equal(h.calls.length, 1)
  assert.equal(h.reconnects, 0)
})

test('POST 400 is terminal and never retries even when online fires', { timeout: 2000 }, async t => {
  const h = rig(t, () => json({ error: { message: 'invalid conversation' } }, 400))
  await assert.rejects(h.observe(start), /invalid conversation/)
  h.window.fire('online')
  h.window.fire('pageshow')
  assert.equal(h.calls.length, 1)
  assert.equal(h.reconnects, 0)
  assert.deepEqual(h.updates, [])
})

test('POST 429 remains retryable', { timeout: 2000 }, async t => {
  const h = rig(t, (_url, _init, index) => index === 0 ? json({}, 429) : json(snapshot({ state: 'completed' })))
  const observing = h.observe(start)
  await h.polling()
  h.window.fire('online')
  await observing
  assert.equal(h.reconnects, 1)
  assert.deepEqual(h.calls.map(call => call.init.method), ['POST', 'POST'])
})

test('hidden visibility changes do not poll; returning visible wakes polling immediately', { timeout: 2000 }, async t => {
  const h = rig(t, (_url, _init, index) => json(snapshot({ state: index === 0 ? 'running' : 'completed' })))
  h.document.hidden = true
  const observing = h.observe()
  await h.polling()
  h.document.fire('visibilitychange')
  await setImmediate()
  assert.equal(h.calls.length, 1)
  h.document.hidden = false
  h.document.fire('visibilitychange')
  await observing
  assert.equal(h.calls.length, 2)
})

test('pageshow wakes polling immediately', { timeout: 2000 }, async t => {
  const h = rig(t, (_url, _init, index) => json(snapshot({ state: index === 0 ? 'running' : 'completed' })))
  const observing = h.observe()
  await h.polling()
  h.window.fire('pageshow')
  await observing
  assert.equal(h.calls.length, 2)
})

for (const event of ['visibilitychange', 'pageshow']) {
  test(`${event} aborts a stale in-flight fetch and permits fresh snapshot recovery`, { timeout: 2000 }, async t => {
    const h = rig(t, (_url, init, index) => index === 0 ? pendingFetch(init.signal!) : json(snapshot({ state: 'completed' })))
    const observing = h.observe()
    if (event === 'visibilitychange') {
      h.document.hidden = true
      h.document.fire(event)
      assert.equal(h.calls[0].init.signal?.aborted, false)
      h.document.hidden = false
      h.document.fire(event)
    } else h.window.fire(event)
    assert.equal(h.calls[0].init.signal?.aborted, true)
    await h.polling()
    assert.equal(h.reconnects, 1)
    h.window.fire('online')
    await observing
    assert.equal(h.calls.length, 2)
    assert.equal(h.controller.signal.aborted, false)
    assert.equal(h.updates.at(-1)?.state, 'completed')
  })
}


test('run creation sends lyric mode and line constraints without local history', async t => {
  const h = rig(t, () => json(snapshot({ state: 'completed' })))
  const creator = { title: '歌', writingMode: 'lyrics' as const, activeChapterId: 'one', revision: 3, changes: [], chapters: [{ id: 'one', title: '主歌', text: '一行', lineTargets: [{ count: 8, unit: 'syllables' as const }] }] }
  await h.observe({ ...start, creator })
  const payload = JSON.parse(String(h.calls[0].init.body))
  assert.equal(payload.creator.writingMode, 'lyrics')
  assert.deepEqual(payload.creator.chapters[0].lineTargets, creator.chapters[0].lineTargets)
  assert.equal(payload.creator.changes, undefined)
})
