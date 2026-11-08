import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import http from 'node:http'
import { HttpError } from './types.ts'
import { writeJson } from './sse.ts'

export const STATE_KEYS = [
  'soma-service-profiles',
  'soma-service-settings',
  'soma-theme',
  'soma-conversations',
  'soma-active-conversation',
] as const

export type StateKey = typeof STATE_KEYS[number]
type StateValues = Partial<Record<StateKey, unknown>>

const DEFAULT_DIR = resolve('.soma-data')

export class StateStore {
  private readonly file: string
  private mutation = Promise.resolve()

  constructor(directory = process.env.SOMA_DATA_DIR || DEFAULT_DIR) {
    this.file = join(resolve(directory), 'state.json')
  }

  async get(): Promise<StateValues> {
    return this.read()
  }

  async put(key: StateKey, value: unknown): Promise<StateValues> {
    const operation = this.mutation.then(async () => {
      const values = await this.read()
      if (value === null) delete values[key]
      else values[key] = value
      await this.write(values)
      return values
    })
    this.mutation = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async read(): Promise<StateValues> {
    try {
      const text = await readFile(this.file, 'utf8')
      const data: unknown = JSON.parse(text)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid state file structure')
      const values = (data as { values?: unknown }).values
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid state file structure')
      return values as StateValues
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private async write(values: StateValues): Promise<void> {
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const temporary = join(directory, `.state-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, values }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await chmod(temporary, 0o600)
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

export async function handleState(req: http.IncomingMessage, res: http.ServerResponse, store: StateStore): Promise<void> {
  try {
    if (req.method === 'GET') {
      writeJson(res, 200, { version: 1, values: await store.get() })
      return
    }
    if (req.method !== 'PUT') {
      writeJson(res, 405, { error: { message: '这个接口只接受 GET 或 PUT。', type: 'method_not_allowed' } })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > 10 * 1024 * 1024) throw new HttpError(413, '请求体超过 10 MB。')
      chunks.push(buffer)
    }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new HttpError(400, '请求体不是合法的 JSON。') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须是 JSON 对象。')
    const { key, value } = body as Record<string, unknown>
    if (typeof key !== 'string' || !STATE_KEYS.includes(key as StateKey) || !Object.hasOwn(body, 'value')) {
      throw new HttpError(400, '键无效或缺少 value。')
    }
    writeJson(res, 200, { version: 1, values: await store.put(key as StateKey, value) })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    writeJson(res, status, { error: { message: status === 500 ? '无法读取或保存状态。' : error instanceof Error ? error.message : '请求无效。' } })
  }
}
