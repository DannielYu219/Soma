import type { IncomingMessage } from 'node:http'
import type { Config } from './config.ts'
import { HttpError, UpstreamError } from './types.ts'

const MAX_BODY_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const PAGE_LIMIT = 100
const MAX_PAGES = 20
const PROVIDERS = new Set(['openai-compatible', 'responses', 'anthropic'])

type Provider = 'openai-compatible' | 'responses' | 'anthropic'

export interface ModelService {
  provider: Provider
  baseUrl: string
  apiKey: string
}

export interface ModelInfo {
  id: string
  name: string
}

export interface ModelsResult {
  models: ModelInfo[]
  source: Provider
  verified: true
}

export async function readModelsBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体超过 64 KB。')
    chunks.push(chunk as Buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(400, '请求体必须是合法的 JSON 对象。')
  }
}

function serviceFromBody(body: Record<string, unknown>): ModelService {
  const raw = body.service && typeof body.service === 'object' && !Array.isArray(body.service)
    ? body.service as Record<string, unknown>
    : body
  if (typeof raw.provider !== 'string' || !PROVIDERS.has(raw.provider)
    || typeof raw.baseUrl !== 'string' || raw.baseUrl.length > 2048
    || typeof raw.apiKey !== 'string' || raw.apiKey.length > 4096) {
    throw new HttpError(400, 'service.provider、baseUrl 或 apiKey 无效。')
  }
  return { provider: raw.provider as Provider, baseUrl: raw.baseUrl, apiKey: raw.apiKey }
}

function baseUrl(service: ModelService, cfg: Config): URL {
  const fallback = service.provider === 'anthropic' ? cfg.anthropicBaseUrl : cfg.openaiBaseUrl
  const value = !service.baseUrl.trim() || service.baseUrl.trim() === '/v1' ? fallback : service.baseUrl.trim()
  let url: URL
  try { url = new URL(value) } catch { throw new HttpError(400, 'service.baseUrl 必须是绝对 HTTP(S) URL。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, 'service.baseUrl 必须是无凭据的 HTTP(S) URL。')
  }
  url.hash = ''
  return url
}

function modelsUrl(base: URL, provider: Provider): URL {
  const url = new URL(base.toString())
  const path = url.pathname.replace(/\/+$/, '')
  if (provider === 'anthropic') {
    if (path.endsWith('/models')) url.pathname = path
    else if (path.endsWith('/v1')) url.pathname = `${path}/models`
    else url.pathname = `${path}/v1/models`
  } else {
    url.pathname = path.endsWith('/models') ? path : `${path}/models`
  }
  return url
}

function requestHeaders(service: ModelService): Record<string, string> {
  if (service.provider === 'anthropic') {
    return {
      ...(service.apiKey ? { 'x-api-key': service.apiKey } : {}),
      'anthropic-version': '2023-06-01',
    }
  }
  return service.apiKey ? { authorization: `Bearer ${service.apiKey}` } : {}
}

async function readResponse(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new UpstreamError(502, '上游模型列表响应过大。')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(output)
}

function upstreamMessage(status: number): string {
  if (status === 401 || status === 403) return '上游模型服务拒绝了 API key。'
  if (status === 404) return '上游模型服务不支持 GET /models 模型枚举接口。'
  if (status === 429) return '上游模型服务请求过于频繁，请稍后重试。'
  if (status >= 500) return '上游模型服务暂时不可用。'
  return `上游模型服务返回 HTTP ${status}。`
}

async function fetchPage(url: URL, service: ModelService, signal: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: requestHeaders(service),
      redirect: 'manual',
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw new UpstreamError(504, '获取模型列表超过 20 秒。请确认服务已启动、API 地址正确，或稍后重试。')
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    throw new UpstreamError(502, local ? '无法连接本机模型服务。请确认该端口上的模型服务正在运行，并检查 http/https 与端口。' : '无法连接模型服务，请检查 API 地址及网络连接。')
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {})
    throw new UpstreamError(502, '模型列表接口发生重定向。为避免泄露密钥，请填写最终 API 根地址后重试。')
  }
  if (!response.ok) {
    await readResponse(response).catch(() => '')
    throw new UpstreamError(response.status, upstreamMessage(response.status))
  }
  const text = await readResponse(response)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new UpstreamError(502, '上游模型列表不是合法 JSON。') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UpstreamError(502, '上游模型列表格式无效。')
  return parsed as Record<string, unknown>
}

function parseModels(payload: Record<string, unknown>): ModelInfo[] {
  if (!Array.isArray(payload.data)) throw new UpstreamError(502, '上游模型列表缺少有效的 data 数组。')
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const raw of payload.data) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id.trim()) continue
    const id = item.id.trim()
    if (seen.has(id)) continue
    seen.add(id)
    const displayName = typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : typeof item.display_name === 'string' && item.display_name.trim()
        ? item.display_name.trim()
        : id
    models.push({ id, name: displayName })
  }
  if (payload.data.length > 0 && models.length === 0) throw new UpstreamError(502, '上游模型列表中的模型条目格式无效。')
  return models
}

export async function enumerateModels(cfg: Config, body: Record<string, unknown>, clientSignal: AbortSignal): Promise<ModelsResult> {
  const service = serviceFromBody(body)
  const base = baseUrl(service, cfg)
  const endpoint = modelsUrl(base, service.provider)
  const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  const models: ModelInfo[] = []

  for (let page = 0; page < (service.provider === 'anthropic' ? MAX_PAGES : 1); page += 1) {
    const pageUrl = new URL(endpoint.toString())
    if (service.provider === 'anthropic') {
      pageUrl.searchParams.set('limit', String(PAGE_LIMIT))
      if (page > 0) {
        const after = models.at(-1)?.id
        if (!after) break
        pageUrl.searchParams.set('after_id', after)
      }
    }
    const payload = await fetchPage(pageUrl, service, signal)
    const next = parseModels(payload)
    const seen = new Set(models.map(model => model.id))
    for (const model of next) if (!seen.has(model.id)) { models.push(model); seen.add(model.id) }
    if (service.provider !== 'anthropic' || payload.has_more !== true || next.length === 0) break
  }
  return { models, source: service.provider, verified: true }
}
