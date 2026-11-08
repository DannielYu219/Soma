import type { Config } from './config.ts'
import { safeParse } from './sse.ts'

export interface SearchHit { title: string; url: string; snippet: string }

const TIMEOUT_MS = 60_000

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** Queries SearXNG's JSON API. Only http(s) results are kept. */
export async function searchWeb(cfg: Config, query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL('/search', cfg.searxngUrl)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('language', cfg.searchLanguage)
  url.searchParams.set('safesearch', '0')
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`SearXNG 返回 ${response.status}`)
  const data = await response.json() as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> }
  if (!data || !Array.isArray(data.results)) throw new Error('SearXNG 返回了无效的搜索结果。')
  const seen = new Set<string>()
  return data.results
    .filter(item => {
      if (!item || typeof item.url !== 'string' || item.url.length > 2048) return false
      try {
        const link = new URL(item.url)
        if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password) return false
        link.hash = ''
        if (seen.has(link.href)) return false
        seen.add(link.href)
        return true
      } catch { return false }
    })
    .slice(0, cfg.searchMaxResults)
    .map(item => ({
      title: (clean(item.title) || String(item.url)).slice(0, 500),
      url: String(item.url),
      snippet: clean(item.content).slice(0, 800),
    }))
}

export function formatHits(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) return `搜索 "${query}" 没有找到结果。`
  const lines: string[] = []
  let size = 0
  for (const hit of hits) {
    const line = `[${lines.length + 1}] ${hit.title}\n${hit.url}${hit.snippet ? `\n${hit.snippet}` : ''}`
    if (size + line.length > 16_000) break
    lines.push(line)
    size += line.length
  }
  return `搜索 "${query}" 的结果：\n\n${lines.join('\n\n')}${lines.length < hits.length ? '\n\n其余结果超过本轮资料长度上限。' : ''}`
}

export interface SearchOutcome { query: string; hits: SearchHit[]; output: string; attempts: number; available: boolean }

/** Retry a transient failure or empty response once; never turn failure text into evidence. */
export async function searchWithRecovery(cfg: Config, query: string, signal?: AbortSignal): Promise<SearchOutcome> {
  let reason = ''
  let available = false
  for (let attempt = 1; attempt <= 2; attempt++) {
    signal?.throwIfAborted()
    try {
      const hits = await searchWeb(cfg, query, signal)
      available = true
      if (hits.length || attempt === 2) return { query, hits, output: formatHits(query, hits), attempts: attempt, available: true }
    } catch (error) {
      signal?.throwIfAborted()
      reason = error instanceof Error ? error.message : String(error)
    }
  }
  const output = available ? formatHits(query, []) : `搜索暂时不可用（${reason}）。未获得可核实的网络结果；请明确说明无法核实最新资料，不要把已有知识或推测当作本次检索结果。`
  return { query, hits: [], output, attempts: 2, available }
}

/** Runs a search tool while preserving cancellation and reporting unavailability honestly. */
export async function runSearchTool(cfg: Config, rawArgs: string, signal?: AbortSignal): Promise<string> {
  const parsed = safeParse(rawArgs) as { query?: unknown } | null
  const query = typeof parsed?.query === 'string' ? parsed.query.trim() : ''
  if (!query) return '搜索失败：缺少 query 参数。'
  return (await searchWithRecovery(cfg, query, signal)).output
}
