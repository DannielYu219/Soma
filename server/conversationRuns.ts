import type { IncomingMessage, ServerResponse } from 'node:http'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { Config } from './config.ts'
import { handleConversation, readConversationBody } from './conversation.ts'
import { HttpError } from './types.ts'
import { writeJson } from './sse.ts'

export interface CreatorDocument {
  title: string
  chapters: Array<{ id: string; title: string; text: string }>
  activeChapterId: string
  revision: number
}
export interface RunSnapshot {
  id: string
  conversationId: string
  assistantId: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  text: string
  reasoning: string
  status: { phase: string; message: string }
  error?: string
  creators: Array<{ sequence: number; document: CreatorDocument }>
  createdAt: number
  updatedAt: number
  baseRevision?: number
}
const MAX_RUNNING = 8
const RUN_TIMEOUT_MS = 20 * 60 * 1000
const MAX_RUNS = 128
const MAX_RUN_BYTES = 2 * 1024 * 1024
const MAX_STORE_BYTES = 32 * 1024 * 1024
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const copy = <T>(value: T): T => structuredClone(value)

/** Only the small ServerResponse surface used by conversation.ts and sse.ts. No socket owns this response. */
class MemoryResponse {
  headersSent = false
  destroyed = false
  writableEnded = false
  statusCode = 200
  jsonError?: string
  private buffer = ''
  private json = false
  private event: (name: string, data: Record<string, any>) => void
  constructor(event: (name: string, data: Record<string, any>) => void = () => {}) { this.event = event }
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status
    this.headersSent = true
    this.json = headers['content-type']?.startsWith('application/json') ?? false
    return this
  }
  write(chunk: string): boolean {
    this.buffer += chunk
    if (this.json) return true
    let cut: number
    while ((cut = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut + 2)
      const name = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim()
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
      if (name && data) this.event(name, JSON.parse(data))
    }
    return true
  }
  end(chunk?: string) {
    if (chunk) this.write(chunk)
    if (this.json) this.jsonError = JSON.parse(this.buffer).error?.message
    this.writableEnded = true
    return this
  }
  asResponse(): ServerResponse { return this as unknown as ServerResponse }
}

export class ConversationRunStore {
  private readonly directory: string
  private readonly file: string
  private snapshots = new Map<string, RunSnapshot>()
  private controllers = new Map<string, AbortController>()
  private ready?: Promise<void>
  private mutation: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private persistenceError?: Error

  constructor(directory = process.env.SOMA_DATA_DIR || resolve('.soma-data')) {
    this.directory = join(resolve(directory), 'runs')
    this.file = join(this.directory, 'snapshots.json')
  }
  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      try {
        if ((await stat(this.file)).size > MAX_STORE_BYTES + MAX_RUN_BYTES) throw new Error('任务快照文件超过大小限制。')
        const saved = JSON.parse(await readFile(this.file, 'utf8'))
        if (saved.version !== 1 || !Array.isArray(saved.runs) || saved.runs.length > MAX_RUNS) throw new Error('任务快照文件格式无效。')
        for (const raw of saved.runs) {
          if (!safeId(raw.id) || !safeId(raw.conversationId) || !safeId(raw.assistantId) || !['running', 'completed', 'failed', 'cancelled'].includes(raw.state) || typeof raw.text !== 'string' || typeof raw.reasoning !== 'string' || !Array.isArray(raw.creators) || !Number.isFinite(raw.createdAt) || !Number.isFinite(raw.updatedAt) || !raw.status || typeof raw.status.phase !== 'string' || typeof raw.status.message !== 'string') throw new Error('任务快照文件格式无效。')
          // Reconstruct the public contract only; persisted request inputs are never loaded or retained.
          const snapshot: RunSnapshot = { id: raw.id, conversationId: raw.conversationId, assistantId: raw.assistantId, state: raw.state, text: raw.text, reasoning: raw.reasoning, status: { phase: raw.status.phase, message: raw.status.message }, creators: raw.creators, createdAt: raw.createdAt, updatedAt: raw.updatedAt, ...(typeof raw.error === 'string' ? { error: raw.error } : {}), ...(Number.isInteger(raw.baseRevision) ? { baseRevision: raw.baseRevision } : {}) }
          if (snapshot.state === 'running') {
            snapshot.state = 'failed'
            snapshot.error = 'Soma 后端已重新启动，之前的任务已中断。请重新发送。'
            snapshot.status = { phase: 'failed', message: snapshot.error }
            snapshot.updatedAt = Date.now()
          }
          this.snapshots.set(snapshot.id, snapshot)
        }
        this.prune()
        await this.persist()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })()
  }
  private prune() {
    const finished = [...this.snapshots.values()].filter(run => run.state !== 'running').sort((a, b) => a.updatedAt - b.updatedAt)
    let bytes = Buffer.byteLength(JSON.stringify([...this.snapshots.values()]))
    for (const run of finished) {
      if (Date.now() - run.updatedAt <= TTL_MS && this.snapshots.size <= MAX_RUNS && bytes <= MAX_STORE_BYTES) break
      this.snapshots.delete(run.id)
      bytes -= Buffer.byteLength(JSON.stringify(run))
    }
  }
  private persist(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    // Serialize at execution time so an older queued write can never overwrite newer output.
    const operation = this.mutation.then(async () => {
      this.prune()
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await chmod(this.directory, 0o700)
      const temporary = join(this.directory, `.snapshots-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, runs: [...this.snapshots.values()] }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await rename(temporary, this.file)
        this.persistenceError = undefined
      } finally { await rm(temporary, { force: true }) }
    })
    this.mutation = operation.catch(error => { this.persistenceError = error instanceof Error ? error : new Error(String(error)) })
    return operation
  }
  private schedulePersist() {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.persist().catch(() => {}) }, 100)
    this.timer.unref()
  }
  async get(id: string): Promise<RunSnapshot> {
    await this.initialize()
    this.prune()
    const run = this.snapshots.get(id)
    if (!run) throw new HttpError(404, '没有这个对话任务。')
    await this.persist()
    return copy(run)
  }
  async list(conversationId: string): Promise<RunSnapshot[]> {
    await this.initialize()
    this.prune()
    return copy([...this.snapshots.values()].filter(run => run.conversationId === conversationId).sort((a, b) => b.createdAt - a.createdAt))
  }
  async start(cfg: Config, body: Record<string, unknown>): Promise<{ run: RunSnapshot; created: boolean }> {
    for (const field of ['runId', 'conversationId', 'assistantId']) if (!safeId(body[field])) throw new HttpError(400, `${field} 必须是 1–100 字符的安全 id（字母、数字、下划线或连字符）。`)
    await this.initialize()
    const id = body.runId as string, conversationId = body.conversationId as string, assistantId = body.assistantId as string
    const existing = this.snapshots.get(id)
    if (existing) {
      if (existing.conversationId !== conversationId || existing.assistantId !== assistantId) throw new HttpError(409, 'runId 已用于其他对话或消息。')
      return { run: copy(existing), created: false }
    }
    // Reuse the existing validator and endpoint checks, but abort before any upstream request.
    const validation = new MemoryResponse()
    await handleConversation(cfg, body, validation.asResponse(), AbortSignal.abort())
    if (validation.statusCode >= 400) throw new HttpError(validation.statusCode, validation.jsonError || '对话参数无效。')
    // Another POST can have won while validation yielded.
    const winner = this.snapshots.get(id)
    if (winner) {
      if (winner.conversationId !== conversationId || winner.assistantId !== assistantId) throw new HttpError(409, 'runId 已用于其他对话或消息。')
      return { run: copy(winner), created: false }
    }
    if (this.controllers.size >= MAX_RUNNING) throw new HttpError(429, '正在运行的任务过多，请稍后重试。')
    if (this.persistenceError) throw new Error('任务快照无法保存，请检查数据目录。')
    const now = Date.now()
    const creator = body.creator as CreatorDocument | undefined
    const run: RunSnapshot = { id, conversationId, assistantId, state: 'running', text: '', reasoning: '', status: { phase: 'initial', message: '正在准备对话' }, creators: [], createdAt: now, updatedAt: now, ...(creator ? { baseRevision: creator.revision } : {}) }
    const controller = new AbortController()
    this.snapshots.set(id, run)
    this.controllers.set(id, controller)
    try { await this.persist() } catch (error) { this.snapshots.delete(id); this.controllers.delete(id); throw error }
    void this.execute(cfg, body, run, controller)
    return { run: copy(run), created: true }
  }
  private async execute(cfg: Config, body: Record<string, unknown>, run: RunSnapshot, controller: AbortController) {
    const service = body.service as { apiKey?: string } | undefined
    const secrets = [service?.apiKey, cfg.openaiApiKey, cfg.anthropicApiKey].filter((value): value is string => Boolean(value))
    const cleanError = (message: string) => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), message).slice(0, 2000)
    const response = new MemoryResponse((name, data) => {
      if (run.state !== 'running') return
      if (name === 'text' && typeof data.delta === 'string') run.text += data.delta
      else if (name === 'reasoning' && typeof data.delta === 'string') run.reasoning += data.delta
      else if (name === 'status') run.status = { phase: data.phase, message: data.message }
      else if (name === 'creator') run.creators.push({ sequence: run.creators.length + 1, document: data.document })
      else if (name === 'done') { run.state = 'completed'; run.status = { phase: 'completed', message: '回答已完成' } }
      else if (name === 'error') { run.state = 'failed'; run.error = cleanError(String(data.message)); run.status = { phase: 'failed', message: run.error } }
      run.updatedAt = Date.now()
      if (Buffer.byteLength(JSON.stringify(run)) > MAX_RUN_BYTES) {
        // Roll back the last unbounded output and stop the upstream rather than truncating a document.
        if (name === 'creator') run.creators.pop()
        if (name === 'text') run.text = run.text.slice(0, -data.delta.length)
        if (name === 'reasoning') run.reasoning = run.reasoning.slice(0, -data.delta.length)
        run.state = 'failed'; run.error = '任务输出超过 2 MB 限制。'; run.status = { phase: 'failed', message: run.error }
        controller.abort()
      }
      this.schedulePersist()
    })
    try {
      await handleConversation(cfg, body, response.asResponse(), controller.signal, RUN_TIMEOUT_MS)
      if (run.state === 'running') {
        run.state = 'failed'
        run.error = cleanError(response.jsonError || '任务未正常完成。')
        run.status = { phase: 'failed', message: run.error }
      }
    } catch (error) {
      if (run.state === 'running') {
        run.state = 'failed'; run.error = cleanError(error instanceof Error ? error.message : '对话任务失败。')
        run.status = { phase: 'failed', message: run.error }
      }
    } finally {
      run.updatedAt = Date.now()
      this.controllers.delete(run.id)
      await this.persist().catch(() => {})
    }
  }
  async cancel(id: string): Promise<RunSnapshot> {
    await this.initialize()
    const run = this.snapshots.get(id)
    if (!run) throw new HttpError(404, '没有这个对话任务。')
    if (run.state === 'running') {
      run.state = 'cancelled'; run.status = { phase: 'cancelled', message: '任务已停止' }; run.updatedAt = Date.now()
      this.controllers.get(id)?.abort()
    }
    await this.persist()
    return copy(run)
  }
}

export async function handleConversationRuns(req: IncomingMessage, res: ServerResponse, cfg: Config, store: ConversationRunStore, url: URL): Promise<void> {
  try {
    const root = '/api/conversation-runs'
    if (url.pathname === root) {
      if (req.method === 'POST') {
        const { run, created } = await store.start(cfg, await readConversationBody(req))
        writeJson(res, created ? 202 : 200, run)
        return
      }
      if (req.method === 'GET') {
        const conversationId = url.searchParams.get('conversationId')
        if (!safeId(conversationId)) throw new HttpError(400, '缺少有效的 conversationId。')
        writeJson(res, 200, { runs: await store.list(conversationId) })
        return
      }
    } else {
      const id = url.pathname.slice(root.length + 1)
      if (!safeId(id)) throw new HttpError(400, 'runId 无效。')
      if (req.method === 'GET' || req.method === 'DELETE') {
        writeJson(res, 200, req.method === 'DELETE' ? await store.cancel(id) : await store.get(id))
        return
      }
    }
    throw new HttpError(405, '这个接口只接受 GET、POST 或 DELETE。')
  } catch (error) {
    writeJson(res, error instanceof HttpError ? error.status : 500, { error: { message: error instanceof HttpError ? error.message : '无法读取或保存对话任务。' } })
  }
}
