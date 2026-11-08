const KEYS = ['soma-service-profiles', 'soma-service-settings', 'soma-theme', 'soma-conversations', 'soma-active-conversation'] as const
const generations = new Map<string, number>()
const pending = new Map<string, unknown>()
let queue = Promise.resolve()
let timer: ReturnType<typeof setTimeout> | undefined
let diskAvailable = false

/** Hydrate before mounting React. Disk is authoritative; migrate local-only data once. */
export async function hydrateState(): Promise<void> {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' })
    if (!response.ok) throw new Error('无法读取本机设置')
    const data = await response.json() as { values: Record<string, unknown> }
    diskAvailable = true
    for (const key of KEYS) {
      if (Object.hasOwn(data.values, key)) localStorage.setItem(key, JSON.stringify(data.values[key]))
      else {
        const local = localStorage.getItem(key)
        if (local !== null) {
          let value: unknown
          try { value = JSON.parse(local) } catch { value = local }
          pending.set(key, value)
        }
      }
    }
    // Older versions stored theme as a raw string, not JSON.
    const theme = data.values['soma-theme']
    if (typeof theme === 'string') localStorage.setItem('soma-theme', theme)
    await flushState()
  } catch {
    // Preserve local data on corrupt or unavailable disk state; don't silently overwrite disk.
    window.dispatchEvent(new CustomEvent('soma-storage-error', { detail: '本机设置暂时无法读取，当前使用此窗口已有设置。' }))
  }
}

export function persistValue(key: string, value: unknown): void {
  if (!KEYS.includes(key as typeof KEYS[number])) throw new Error('未知设置项')
  if (value === null) localStorage.removeItem(key)
  else localStorage.setItem(key, key === 'soma-theme' ? String(value) : JSON.stringify(value))
  pending.set(key, value)
  generations.set(key, (generations.get(key) || 0) + 1)
  clearTimeout(timer)
  timer = setTimeout(() => void flushState(), 120)
}

export function flushState(): Promise<void> {
  if (!diskAvailable || pending.size === 0) return queue
  const batch = [...pending].map(([key, value]) => ({ key, value, generation: generations.get(key) || 0 }))
  pending.clear()
  queue = queue.then(async () => {
    for (const { key, value, generation } of batch) {
      try {
        const response = await fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }), keepalive: JSON.stringify(value).length < 40_000 })
        if (!response.ok) throw new Error('写入失败')
      } catch {
        if (!pending.has(key) && (generations.get(key) || 0) === generation) pending.set(key, value)
        window.dispatchEvent(new CustomEvent('soma-storage-error', { detail: '设置未能写入磁盘，窗口中的内容仍保留。' }))
      }
    }
  })
  return queue
}
window.addEventListener('pagehide', () => void flushState())
