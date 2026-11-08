import type { ServiceSettings } from './conversation'
import { DEFAULT_SERVICE, hasConfiguredService, restoreService } from './service.ts'

export interface ServiceProfile { id: string; name: string; settings: ServiceSettings }
export interface ServiceProfiles { version: 1; activeId: string; profiles: ServiceProfile[] }
export const PROFILE_KEY = 'soma-service-profiles'
export function restoreProfiles(raw: string | null, legacy: string | null): ServiceProfiles {
  try {
    const value = JSON.parse(raw || 'null')
    if (value?.version === 1 && Array.isArray(value.profiles)) {
      const seen = new Set<string>()
      const profiles: ServiceProfile[] = value.profiles.filter((item: ServiceProfile) => {
        if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) return false
        seen.add(item.id); return true
      }).map((item: ServiceProfile) => ({ id: item.id, name: typeof item.name === 'string' ? item.name : '模型服务', settings: restoreService(JSON.stringify(item.settings)) }))
      return { version: 1, profiles, activeId: profiles.some(item => item.id === value.activeId) ? value.activeId : profiles[0]?.id || '' }
    }
  } catch { /* Migrate the older single-service setting below. */ }
  const settings = restoreService(legacy)
  const id = 'migrated-service'
  return { version: 1, activeId: hasConfiguredService(settings) ? id : '', profiles: hasConfiguredService(settings) ? [{ id, name: '我的模型服务', settings }] : [] }
}
export function loadProfiles(): ServiceProfiles {
  try { return restoreProfiles(localStorage.getItem(PROFILE_KEY), localStorage.getItem('soma-service-settings')) }
  catch { return { version: 1, activeId: '', profiles: [] } }
}
export function activeService(state: ServiceProfiles): ServiceSettings {
  return state.profiles.find(item => item.id === state.activeId)?.settings || DEFAULT_SERVICE
}
export function upsertProfile(state: ServiceProfiles, profile: ServiceProfile): ServiceProfiles {
  return { version: 1, activeId: profile.id, profiles: state.profiles.some(item => item.id === profile.id) ? state.profiles.map(item => item.id === profile.id ? profile : item) : [...state.profiles, profile] }
}
export function deleteProfile(state: ServiceProfiles, id: string): ServiceProfiles {
  const profiles = state.profiles.filter(item => item.id !== id)
  return { ...state, profiles, activeId: id === state.activeId ? profiles[0]?.id || '' : state.activeId }
}
