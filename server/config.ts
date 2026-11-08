import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))

export interface Config {
  host: string
  port: number
  /** Built web UI served from the same origin as the API. Empty string disables static serving. */
  staticDir: string
  /** Browser origins allowed to call the backend. Requests from other origins get 403. */
  allowedOrigins: string[]
  /** Upstream model services. The backend never stores client keys; these are optional fallbacks. */
  openaiBaseUrl: string
  anthropicBaseUrl: string
  openaiApiKey?: string
  anthropicApiKey?: string
  /** SearXNG instance the search tool queries. */
  searxngUrl: string
  searxngAutostart: boolean
  searxngPort: number
  searxngDir: string
  searxngPython: string
  searchMaxResults: number
  searchLanguage: string
  /** Search calls allowed per request before the model must answer without tools. */
  maxSearchRounds: number
}

type Env = Record<string, string | undefined>

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function loadConfig(env: Env = process.env): Config {
  const searxngPort = positive(env.SOMA_SEARXNG_PORT, 8888)
  return {
    host: env.SOMA_BACKEND_HOST || '127.0.0.1',
    port: positive(env.SOMA_BACKEND_PORT, 8787),
    staticDir: env.SOMA_STATIC_DIR ?? resolve(PROJECT_ROOT, 'dist'),
    allowedOrigins: (env.SOMA_ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173')
      .split(',').map(item => item.trim()).filter(Boolean),
    openaiBaseUrl: env.SOMA_OPENAI_BASE_URL || 'https://api.openai.com/v1',
    anthropicBaseUrl: env.SOMA_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    openaiApiKey: env.SOMA_OPENAI_API_KEY || undefined,
    anthropicApiKey: env.SOMA_ANTHROPIC_API_KEY || undefined,
    searxngUrl: env.SOMA_SEARXNG_URL || `http://127.0.0.1:${searxngPort}`,
    searxngAutostart: env.SOMA_SEARXNG_AUTOSTART === '1',
    searxngPort,
    searxngDir: env.SOMA_SEARXNG_DIR || resolve(PROJECT_ROOT, '.searxng/src'),
    searxngPython: env.SOMA_SEARXNG_PYTHON || resolve(PROJECT_ROOT, '.searxng/venv/bin/python'),
    searchMaxResults: positive(env.SOMA_SEARCH_MAX_RESULTS, 8),
    searchLanguage: env.SOMA_SEARCH_LANGUAGE || 'all',
    maxSearchRounds: positive(env.SOMA_MAX_SEARCH_ROUNDS, 4),
  }
}
