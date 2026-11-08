import type { ServiceSettings } from './conversation'

export type ModelOption = { id: string; name: string }

export const DEFAULT_SERVICE: ServiceSettings = { provider: 'openai-compatible', baseUrl: '', model: '', apiKey: '', search: { enabled: true, model: '' } }

export function mergeSearchSettings(settings: ServiceSettings, search: { enabled?: boolean; model?: string }): ServiceSettings {
  return { ...settings, search: { enabled: search.enabled !== false, model: typeof search.model === 'string' ? search.model.trim() : '' } }
}

const PROVIDERS: ServiceSettings['provider'][] = ['openai-compatible', 'responses', 'anthropic']

/** A saved service is usable only after both a key and a model were explicitly selected. */
export function hasConfiguredService(settings: ServiceSettings): boolean {
  return PROVIDERS.includes(settings.provider) && Boolean(settings.apiKey.trim() && settings.model.trim())
}

/** Old versions persisted backendUrl and a prefilled model. Neither is setup consent. */
export function loadSavedService(): ServiceSettings {
  try { return restoreService(localStorage.getItem('soma-service-settings')) }
  catch { return DEFAULT_SERVICE }
}

export function restoreService(raw: string | null): ServiceSettings {
  if (!raw) return DEFAULT_SERVICE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_SERVICE
    const saved = parsed as Record<string, unknown>
    const provider = PROVIDERS.includes(saved.provider as ServiceSettings['provider']) ? saved.provider as ServiceSettings['provider'] : DEFAULT_SERVICE.provider
    const search = saved.search && typeof saved.search === 'object' && !Array.isArray(saved.search) ? saved.search as Record<string, unknown> : undefined
    const cachedModels = saved.models && typeof saved.models === 'object' && !Array.isArray(saved.models) ? saved.models as Record<string, unknown> : undefined
    const modelItems = Array.isArray(cachedModels?.items) ? cachedModels.items.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const option = item as Record<string, unknown>
      return typeof option.id === 'string' && option.id.trim() ? [{ id: option.id.trim(), name: typeof option.name === 'string' && option.name.trim() ? option.name.trim() : option.id.trim() }] : []
    }).slice(0, 5000) : []
    const updatedAt = typeof cachedModels?.updatedAt === 'number' && Number.isFinite(cachedModels.updatedAt) && cachedModels.updatedAt > 0 ? cachedModels.updatedAt : 0
    return {
      provider,
      baseUrl: typeof saved.baseUrl === 'string' && saved.baseUrl !== '/v1' ? saved.baseUrl.trim() : '',
      model: typeof saved.model === 'string' ? saved.model.trim() : '',
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey.trim() : '',
      ...(modelItems.length && updatedAt ? { models: { items: modelItems, updatedAt } } : {}),
      ...(['auto', 'low', 'medium', 'high'].includes(String(saved.reasoningEffort)) ? { reasoningEffort: saved.reasoningEffort as ServiceSettings['reasoningEffort'] } : {}),
      search: { enabled: search?.enabled !== false, model: typeof search?.model === 'string' ? search.model.trim() : '' },
    }
  } catch { return DEFAULT_SERVICE }
}

export async function discoverModels(service: Pick<ServiceSettings, 'provider' | 'baseUrl' | 'apiKey'>, signal?: AbortSignal): Promise<ModelOption[]> {
  const response = await fetch('/api/models', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service }), signal,
  })
  const data = await response.json().catch(() => null) as { models?: ModelOption[]; error?: { message?: string } } | null
  if (!response.ok) throw new Error(data?.error?.message || `无法获取模型列表（${response.status}）。` )
  if (!Array.isArray(data?.models)) throw new Error('服务返回的模型列表不可用。')
  return data.models.filter(item => item && typeof item.id === 'string' && item.id.trim())
}
