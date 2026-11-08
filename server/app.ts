import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Config } from './config.ts'
import { runAgent } from './engine.ts'
import { chatAdapter } from './adapters/chat.ts'
import { responsesAdapter } from './adapters/responses.ts'
import { messagesAdapter } from './adapters/messages.ts'
import { runSearchTool } from './search.ts'
import { writeJson } from './sse.ts'
import { handleConversation, readConversationBody } from './conversation.ts'
import { ConversationRunStore, handleConversationRuns } from './conversationRuns.ts'
import { enumerateModels, readModelsBody } from './models.ts'
import { serveUi } from './static.ts'
import { handleState, StateStore } from './state.ts'
import { HttpError, UpstreamError, toApiError } from './types.ts'
import type { Adapter } from './types.ts'

const MAX_BODY_BYTES = 10 * 1024 * 1024
const PROBE_TTL_MS = 15000

const routes: Record<string, Adapter> = {
  '/v1/chat/completions': chatAdapter,
  '/v1/responses': responsesAdapter,
  '/v1/messages': messagesAdapter,
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体超过 10 MB。')
    chunks.push(chunk as Buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON。')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象。')
  return parsed as Record<string, unknown>
}

export function createApp(cfg: Config, stateDirectory?: string): http.Server {
  let probe = { at: 0, ok: false }
  const stateStore = new StateStore(stateDirectory)
  const runStore = new ConversationRunStore(stateDirectory)
  async function searchAvailable(): Promise<boolean> {
    if (Date.now() - probe.at < PROBE_TTL_MS) return probe.ok
    try {
      const response = await fetch(new URL('/healthz', cfg.searxngUrl), { signal: AbortSignal.timeout(1500) })
      probe = { at: Date.now(), ok: response.ok }
    } catch {
      probe = { at: Date.now(), ok: false }
    }
    return probe.ok
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin
    // The UI is served from this same origin, so its own requests are always allowed.
    const sameOrigin = origin !== undefined && (() => {
      try { return new URL(origin).host === req.headers.host } catch { return false }
    })()
    if (origin && !sameOrigin && !cfg.allowedOrigins.includes(origin)) {
      writeJson(res, 403, { error: { message: '这个来源不允许访问后端。', type: 'forbidden' } })
      return
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('access-control-allow-headers', String(req.headers['access-control-request-headers'] ?? 'authorization, content-type'))
      res.setHeader('access-control-max-age', '600')
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const session = process.env.SOMA_SESSION_TOKEN
    if (session && url.pathname !== '/health') {
      const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('soma-session='))?.slice(13)
      const supplied = url.pathname === '/' ? url.searchParams.get('session') || cookie : cookie
      const valid = typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(session) && timingSafeEqual(Buffer.from(supplied), Buffer.from(session))
      if (!valid) { writeJson(res, 401, { error: { message: '请从 Soma App 打开。' } }); return }
      if (url.pathname === '/' && url.searchParams.has('session')) {
        res.setHeader('set-cookie', `soma-session=${session}; HttpOnly; SameSite=Strict; Path=/`)
        res.writeHead(303, { location: '/' }); res.end(); return
      }
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, { status: 'ok', service: 'soma-backend', search: (await searchAvailable()) ? 'available' : 'unavailable' })
      return
    }
    if (url.pathname === '/api/state') {
      await handleState(req, res, stateStore)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/models') {
      const controller = new AbortController()
      res.on('close', () => { if (!res.writableEnded) controller.abort() })
      try {
        const body = await readModelsBody(req)
        const result = await enumerateModels(cfg, body, controller.signal)
        writeJson(res, 200, result)
      } catch (error) {
        if (controller.signal.aborted) { res.end(); return }
        const status = error instanceof HttpError || error instanceof UpstreamError ? error.status : 502
        const message = error instanceof Error ? error.message : '模型枚举失败。'
        writeJson(res, status, { error: { message, type: status >= 500 ? 'upstream_error' : 'invalid_request_error' } })
      }
      return
    }
    if (url.pathname === '/api/models') {
      writeJson(res, 405, { error: { message: '这个接口只接受 POST。', type: 'method_not_allowed' } })
      return
    }

    if (url.pathname === '/api/conversation-runs' || url.pathname.startsWith('/api/conversation-runs/')) {
      await handleConversationRuns(req, res, cfg, runStore, url)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/conversation') {
      const controller = new AbortController()
      res.on('close', () => { if (!res.writableEnded) controller.abort() })
      try {
        const body = await readConversationBody(req)
        await handleConversation(cfg, body, res, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) { res.end(); return }
        const status = error instanceof HttpError ? error.status : 400
        writeJson(res, status, { error: { message: error instanceof Error ? error.message : '请求无效。' } })
      }
      return
    }
    if (url.pathname === '/api/conversation') {
      writeJson(res, 405, { error: { message: '这个接口只接受 POST。' } })
      return
    }

    const adapter = routes[url.pathname]
    if (!adapter) {
      if (url.pathname.startsWith('/v1/')) {
        writeJson(res, 404, { error: { message: '没有这个接口。', type: 'not_found' } })
        return
      }
      // Use the raw path: URL parsing already folds dot segments, which would hide traversal attempts from the guard.
      const rawPath = (req.url ?? '/').split('?')[0]
      if (await serveUi(cfg.staticDir, req, res, rawPath)) return
      writeJson(res, 404, { error: { message: '没有这个页面。', type: 'not_found' } })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: { message: '这个接口只接受 POST。', type: 'method_not_allowed' } })
      return
    }

    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    let stream = false
    let model = ''
    try {
      const body = await readJson(req)
      stream = body.stream === true
      model = String(body.model ?? '')
      await runAgent({
        adapter,
        cfg,
        body,
        headers: req.headers,
        writer: { res, stream },
        signal: controller.signal,
        search: (rawArgs, signal) => runSearchTool(cfg, rawArgs, signal),
      })
    } catch (error) {
      if (controller.signal.aborted) { res.end(); return }
      adapter.createSink({ res, stream }, model).fail(toApiError(error))
    }
  })
}

