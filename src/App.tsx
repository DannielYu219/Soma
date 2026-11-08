import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { Popover } from '@base-ui/react/popover'
import { ArrowLeft, ArrowUp, ArrowUpRight, Brain, Check, Copy, DownloadSimple, FileText, PencilSimple, Plus, Square, Sun, X } from '@phosphor-icons/react'
import { Markdown } from './Markdown'
import { StreamingMarkdown } from './StreamingMarkdown'
import { ReasoningDisclosure } from './ReasoningDisclosure'
import { Surface } from './Surface'
import { ConversationHistory } from './ConversationHistory'
import { MemorySeaCanvas } from './MemorySea'
import { buildMemorySea, kindColor, kindLabel } from './lib/memorySea'
import { initialDocument } from './demo'
import { ServiceOnboarding } from './ServiceOnboarding'
import { DEFAULT_SERVICE, hasConfiguredService } from './lib/service'
import { activeService, deleteProfile, loadProfiles, PROFILE_KEY, upsertProfile } from './lib/profiles'
import type { ServiceProfiles } from './lib/profiles'
import { ProviderManager } from './ProviderManager'
import { persistValue, flushState } from './lib/persistence'
import { newId } from './lib/id'
import { CreatorWorkspace } from './CreatorWorkspace'
import { commitCreator, newCreatorDocument } from './lib/creator'
import type { CreatorDocument } from './lib/creator'
import { creatorSelectionContext, selectionLabel } from './lib/creatorSelection'
import type { CreatorSelection } from './lib/creatorSelection'
import { observeConversationRun, cancelConversationRun } from './lib/conversationRuns'
import type { PendingRun, RunSnapshot } from './lib/conversationRuns'
import { conversationFilename, conversationMarkdown } from './lib/conversationExport'
import type { ReasoningEffort, ServiceSettings } from './lib/conversation'

type Message = { id: string; role: 'user' | 'assistant'; paragraphs: string[]; reasoning?: string; project?: boolean; selections?: CreatorSelection[] }
type View = 'conversation' | 'creator' | 'project' | 'memory' | 'settings' | 'providers' | 'welcome'
type ThemeMode = 'system' | 'light' | 'dark'
type ConversationSnapshot = {
  id: string; title: string; updatedAt: number; messages: Message[]; input: string
  hasProject: boolean; documentText: string; forgotten: string[]; creator: CreatorDocument | null; selections?: CreatorSelection[]; pendingRun?: PendingRun; pendingCreator?: CreatorDocument | null
}
const spring = { type: 'spring' as const, stiffness: 240, damping: 32, mass: 1 }
const ease = [0.22, 1, 0.36, 1] as const

export default function App() {
  const restored = useRef<ConversationSnapshot | null>((() => {
    try { const id = JSON.parse(localStorage.getItem('soma-active-conversation') || 'null'); const list = JSON.parse(localStorage.getItem('soma-conversations') || '[]'); return Array.isArray(list) ? list.find(item => item.id === id) || null : null } catch { return null }
  })())
  const [activeConversationId, setActiveConversationId] = useState<string>(() => restored.current?.id || newId())
  const [history, setHistory] = useState<ConversationSnapshot[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('soma-conversations') || '[]')
      return Array.isArray(saved) ? saved.filter(item => item && typeof item.id === 'string' && Array.isArray(item.messages)).map(item => ({ ...item, creator: item.creator ?? null })) : []
    } catch { return [] }
  })
  const [messages, setMessages] = useState<Message[]>(() => restored.current?.messages || [])
  const [selections, setSelections] = useState<CreatorSelection[]>(() => restored.current?.selections || [])
  const [input, setInput] = useState(() => restored.current?.input || '')
  const [thinking, setThinking] = useState(false)
  const [respondingId, setRespondingId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessageText, setEditingMessageText] = useState('')
  const [view, setView] = useState<View>(() => hasConfiguredService(activeService(loadProfiles())) ? 'conversation' : 'welcome')
  const [hasProject, setHasProject] = useState(() => restored.current?.hasProject || false)
  const [documentText, setDocumentText] = useState(() => restored.current?.documentText || initialDocument.text)
  const [creator, setCreator] = useState<CreatorDocument | null>(() => restored.current?.creator || null)
  const [pendingCreator, setPendingCreator] = useState<CreatorDocument | null>(() => restored.current?.pendingCreator || null)
  const [replyError, setReplyError] = useState('')
  const [historyNotice, setHistoryNotice] = useState('')
  const historyStoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const historyStoreFrame = useRef<number | null>(null)
  const historyPersistPending = useRef(false)
  const historyNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deletedIds = useRef(new Set<string>())
  const [activity, setActivity] = useState('')
  const creatorRef = useRef(creator)
  creatorRef.current = creator
  const scrollFrame = useRef<number | null>(null)
  const [pendingRun, setPendingRun] = useState<PendingRun | undefined>(() => restored.current?.pendingRun)
  const pendingRunRef = useRef(pendingRun)
  pendingRunRef.current = pendingRun
  const request = useRef<AbortController | null>(null)
  const creatorObservation = useRef<{ revision: number; previous?: number } | null>(null)
  const streamBuffers = useRef(new Map<string, { text: string; reasoning: string; scheduled: boolean }>())
  const flushStream = useCallback((id: string, force = false) => {
    const buffer = streamBuffers.current.get(id)
    if (!buffer || (!force && buffer.scheduled)) return
    buffer.scheduled = true
    const commit = () => {
      buffer.scheduled = false
      setMessages(previous => {
        let changed = false
        const next = previous.map(message => {
          if (message.id !== id) return message
          if (message.paragraphs[0] === buffer.text && message.reasoning === (buffer.reasoning || undefined)) return message
          changed = true
          return { ...message, paragraphs: [buffer.text], ...(buffer.reasoning ? { reasoning: buffer.reasoning } : {}) }
        })
        return changed ? next : previous
      })
    }
    if (force) commit()
    else requestAnimationFrame(commit)
  }, [])
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [profiles, setProfiles] = useState<ServiceProfiles>(loadProfiles)
  const serviceSettings = activeService(profiles)
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const [onboardingKey, setOnboardingKey] = useState(0)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('soma-theme')
      return stored === 'light' || stored === 'dark' ? stored : 'system'
    } catch { return 'system' }
  })
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const reduced = prefersReducedMotion
  const textarea = useRef<HTMLTextAreaElement>(null)
  const composerSurface = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const conversation = useRef<HTMLDivElement>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const followBottom = useRef(true)
  const returnToProject = useRef<HTMLButtonElement>(null)
  const [multiline, setMultiline] = useState(false)
  const [forgotten, setForgotten] = useState<Set<string>>(() => new Set(restored.current?.forgotten || []))
  const [selectedMemory, setSelectedMemory] = useState<string | null>(null)
  const hasMessages = messages.length > 0
  const currentSnapshot = useRef<ConversationSnapshot | null>(null)
  currentSnapshot.current = {
    id: activeConversationId,
    title: messages.find(message => message.role === 'user')?.paragraphs.join(' ').replace(/\s+/g, ' ').slice(0, 32) || '未命名对话',
    updatedAt: Date.now(), messages, input, hasProject, documentText, forgotten: [...forgotten], creator, selections, pendingRun, pendingCreator,
  }

  // Keep independent snapshots of each conversation, including its own project and memory.
  useEffect(() => {
    const current = currentSnapshot.current
    if (!current || deletedIds.current.has(current.id) || (current.messages.length === 0 && !current.creator && !current.input.trim())) return
    setHistory(previous => [current, ...previous.filter(item => item.id !== current.id && !deletedIds.current.has(item.id))])
  }, [activeConversationId, messages, input, hasProject, documentText, forgotten, creator, selections, pendingRun, pendingCreator])

  const historySnapshot = useRef<ConversationSnapshot[]>([])
  historySnapshot.current = history
  useEffect(() => {
    if (historyStoreFrame.current !== null) cancelAnimationFrame(historyStoreFrame.current)
    historyStoreFrame.current = requestAnimationFrame(() => {
      historyStoreFrame.current = null
      historyPersistPending.current = true
      if (historyStoreTimer.current) clearTimeout(historyStoreTimer.current)
      historyStoreTimer.current = setTimeout(() => {
        try {
          persistValue('soma-conversations', historySnapshot.current)
          historyPersistPending.current = false
        } catch { setReplyError('本机存储空间不足，请先导出文稿。') }
        historyStoreTimer.current = null
      }, 1200)
    })
    return () => { if (historyStoreFrame.current !== null) cancelAnimationFrame(historyStoreFrame.current) }
  }, [history])

  useEffect(() => {
    const flushHistory = () => {
      if (currentSnapshot.current) {
        const current = currentSnapshot.current
        const list = [current, ...historySnapshot.current.filter(item => item.id !== current.id && !deletedIds.current.has(item.id))]
        historySnapshot.current = list
        try { persistValue('soma-conversations', list); void flushState() } catch { /* Last good snapshot remains on disk. */ }
      }
      if (!historyPersistPending.current) return
      if (historyStoreTimer.current) clearTimeout(historyStoreTimer.current)
      if (historyStoreFrame.current !== null) cancelAnimationFrame(historyStoreFrame.current)
      try { persistValue('soma-conversations', historySnapshot.current) } catch { /* Keep the last good snapshot in local storage. */ }
      historyPersistPending.current = false
      historyStoreTimer.current = null
      historyStoreFrame.current = null
    }
    const hidden = () => { if (document.hidden) flushHistory() }
    window.addEventListener('pagehide', flushHistory)
    document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('pagehide', flushHistory); document.removeEventListener('visibilitychange', hidden) }
  }, [])

  useEffect(() => {
    const onError = (event: Event) => setReplyError((event as CustomEvent<string>).detail)
    window.addEventListener('soma-storage-error', onError)
    return () => window.removeEventListener('soma-storage-error', onError)
  }, [])

  useEffect(() => {
    persistValue('soma-active-conversation', activeConversationId)
  }, [activeConversationId])

  const resolvedTheme: 'light' | 'dark' = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode

  const memorySea = useMemo(() => {
    const sea = buildMemorySea(messages, creator ? { title: creator.title, text: creator.chapters.map(chapter => chapter.text).join('\n\n') } : hasProject ? { ...initialDocument, text: documentText } : null)
    if (forgotten.size === 0) return sea
    const nodes = sea.nodes.filter(node => !forgotten.has(node.id))
    const ids = new Set(nodes.map(node => node.id))
    return { nodes, edges: sea.edges.filter(edge => ids.has(edge.a) && ids.has(edge.b)) }
  }, [messages, hasProject, documentText, forgotten, creator])

  function persistProfiles(next: ServiceProfiles) {
    persistValue(PROFILE_KEY, next)
    persistValue('soma-service-settings', activeService(next))
    setProfiles(next)
  }

  function saveService(settings: ServiceSettings, name?: string) {
    try {
      const id = editingProfileId || newId()
      const existing = profiles.profiles.find(item => item.id === id)
      persistProfiles(upsertProfile(profiles, { id, name: name || existing?.name || settings.model, settings }))
      setReplyError(''); setView('conversation')
      return true
    } catch { setReplyError('无法保存服务设置，请检查本机可用存储空间。'); return false }
  }

  function openServiceSettings() {
    setMenuOpen(false)
    setView(profiles.profiles.length ? 'providers' : 'welcome')
  }

  function editService(id: string | null) {
    setEditingProfileId(id); setOnboardingKey(previous => previous + 1); setView('settings')
  }

  function selectService(id: string) {
    try { persistProfiles({ ...profiles, activeId: id }); setView('conversation') }
    catch { setReplyError('无法保存服务设置。') }
  }

  function setReasoningEffort(reasoningEffort: ReasoningEffort) {
    const profile = profiles.profiles.find(item => item.id === profiles.activeId)
    if (!profile) return
    try { persistProfiles(upsertProfile(profiles, { ...profile, settings: { ...profile.settings, reasoningEffort } })) }
    catch { setReplyError('无法保存思考等级。') }
  }

  function removeService(id: string) {
    try {
      const next = deleteProfile(profiles, id)
      persistProfiles(next)
      if (!next.profiles.length) { setEditingProfileId(null); setView('welcome') }
    } catch { setReplyError('无法删除服务。') }
  }

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (event: MediaQueryListEvent | MediaQueryList) => setPrefersReducedMotion(event.matches)
    sync(media)
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const sync = (event: MediaQueryListEvent | MediaQueryList) => setSystemDark(event.matches)
    sync(media)
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme === 'dark' ? '#1c1c1c' : '#f6f6f6')
    try {
      persistValue('soma-theme', themeMode)
    } catch { /* Preference is optional; theme still applies for this session. */ }
  }, [themeMode, resolvedTheme])

  useEffect(() => () => {
    request.current?.abort()
    if (timer.current) clearTimeout(timer.current)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    if (historyNoticeTimer.current) clearTimeout(historyNoticeTimer.current)
    if (historyStoreTimer.current) clearTimeout(historyStoreTimer.current)
    if (historyStoreFrame.current !== null) cancelAnimationFrame(historyStoreFrame.current)
  }, [])

  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = '28px'
    const height = Math.min(element.scrollHeight, 168)
    element.style.height = `${height}px`
    setMultiline(height > 34)
  }, [input, view])

  useLayoutEffect(() => {
    if (editor.current) {
      editor.current.style.height = 'auto'
      editor.current.style.height = `${editor.current.scrollHeight}px`
    }
  }, [documentText, view])

  useEffect(() => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      const area = scrollArea.current
      if (area && followBottom.current) area.scrollTo({ top: area.scrollHeight, behavior: 'instant' })
      scrollFrame.current = null
    })
    return () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current) }
  }, [messages, thinking, activity, reduced, view])

  const stop = useCallback((cancel = true) => {
    const stopRun = pendingRunRef.current
    if (cancel && stopRun) {
      void cancelConversationRun(stopRun.id).then(() => {
        const list = historySnapshot.current.map(snapshot => snapshot.pendingRun?.id === stopRun.id ? { ...snapshot, pendingRun: undefined } : snapshot)
        historySnapshot.current = list; setHistory(list); persistValue('soma-conversations', list)
      }).catch(error => setReplyError(error.message))
      setPendingRun(undefined)
    }
    setEditingMessageId(null); setEditingMessageText('')
    setHistoryOpen(false)
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const observation = creatorObservation.current
    if (observation && creatorRef.current) {
      const unobserved = { ...creatorRef.current, aiSeenRevision: observation.previous }
      creatorRef.current = unobserved
      setCreator(unobserved)
    }
    creatorObservation.current = null
    request.current?.abort()
    streamBuffers.current.clear()
    request.current = null
    setMessages(previous => previous.filter(message => message.paragraphs.join('').trim() || message.reasoning?.trim()))
    setThinking(false); setRespondingId(null); setActivity('')
  }, [])

  const fresh = useCallback(() => {
    stop(false)
    setPendingRun(undefined)
    setActiveConversationId(newId())
    setMessages([]); setInput(''); setSelections([]); setView(hasConfiguredService(serviceSettings) ? 'conversation' : 'welcome'); setMenuOpen(false)
    setHasProject(false); setDocumentText(initialDocument.text)
    setCreator(null); setPendingCreator(null); setReplyError('')
    setForgotten(new Set()); setSelectedMemory(null); setCopied(false); setCopyError('')
    followBottom.current = true
    requestAnimationFrame(() => textarea.current?.focus())
  }, [stop, serviceSettings])

  function showHistoryNotice(message: string) {
    setHistoryNotice(message)
    if (historyNoticeTimer.current) clearTimeout(historyNoticeTimer.current)
    historyNoticeTimer.current = setTimeout(() => setHistoryNotice(''), 2600)
  }

  function exportConversation(id: string) {
    const snapshot = history.find(item => item.id === id)
    if (!snapshot) return
    const blob = new Blob([conversationMarkdown(snapshot)], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = conversationFilename(snapshot.title); link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    showHistoryNotice('会话已导出为 Markdown。')
  }

  async function copyConversation(id: string) {
    const snapshot = history.find(item => item.id === id)
    if (!snapshot) return
    try { await navigator.clipboard.writeText(conversationMarkdown(snapshot)); showHistoryNotice('会话已复制。') }
    catch { showHistoryNotice('无法访问剪贴板，请改用导出。') }
  }

  function removeConversation(id: string) {
    const snapshot = history.find(item => item.id === id)
    if (!snapshot) return
    const next = history.filter(item => item.id !== id)
    try {
      // Persist synchronously before changing the active conversation so effects cannot resurrect a deleted snapshot.
      persistValue('soma-conversations', next)
      deletedIds.current.add(id)
      setHistory(next)
      if (id === activeConversationId) {
        stop()
        followBottom.current = true
        setCopied(false); setCopyError('')
        const replacement = next[0]
        if (replacement) {
          setPendingRun(replacement.pendingRun)
          setActiveConversationId(replacement.id); setMessages(replacement.messages); setInput(replacement.input || ''); setSelections(replacement.selections || [])
          setHasProject(Boolean(replacement.hasProject)); setDocumentText(replacement.documentText || initialDocument.text)
          setCreator(replacement.creator || null); setPendingCreator(replacement.pendingCreator || null); setReplyError('')
          setForgotten(new Set(replacement.forgotten || [])); setSelectedMemory(null)
          setView(replacement.creator ? 'creator' : 'conversation')
        } else {
          setActiveConversationId(newId()); setMessages([]); setInput(''); setSelections([])
          setHasProject(false); setDocumentText(initialDocument.text); setCreator(null); setPendingCreator(null)
          setForgotten(new Set()); setSelectedMemory(null); setReplyError('')
          setView(hasConfiguredService(serviceSettings) ? 'conversation' : 'welcome')
        }
      }
      showHistoryNotice('会话已删除。')
    } catch { showHistoryNotice('删除未能保存，请稍后重试。') }
  }

  const selectConversation = (id: string) => {
    const snapshot = history.find(item => item.id === id)
    if (!snapshot) return
    if (snapshot.id === activeConversationId) { setHistoryOpen(false); return }
    stop(false)
    setPendingRun(snapshot.pendingRun)
    setActiveConversationId(snapshot.id); setMessages(snapshot.messages); setInput(snapshot.input || ''); setSelections(snapshot.selections || [])
    setHasProject(Boolean(snapshot.hasProject)); setDocumentText(snapshot.documentText || initialDocument.text)
    setCreator(snapshot.creator || null); setPendingCreator(snapshot.pendingCreator || null); setReplyError('')
    setForgotten(new Set(snapshot.forgotten || [])); setSelectedMemory(null)
    setView(snapshot.creator ? 'creator' : 'conversation'); setMenuOpen(false); setCopyError(''); setCopied(false)
    followBottom.current = true
  }

  const back = useCallback(() => {
    setView('conversation'); setCopyError('')
    requestAnimationFrame(() => returnToProject.current?.focus())
  }, [])

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && view !== 'conversation' && view !== 'welcome') { event.preventDefault(); back() }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); fresh() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [fresh, back, view])

  function startCreator() {
    if (!creator) setCreator(newCreatorDocument(hasProject ? { title: initialDocument.title, text: documentText } : undefined))
    setView('creator'); setMenuOpen(false)
  }

  async function send(edit?: { messageId: string; text: string }) {
    const attached = edit ? messages.find(message => message.id === edit.messageId)?.selections || [] : selections
    const value = (edit?.text ?? input).trim() || (attached.length ? '请看看引用的这段文稿。' : '')
    if (!value || thinking || request.current) return
    if (edit && !messages.some(message => message.id === edit.messageId && message.role === 'user')) return
    if (!hasConfiguredService(serviceSettings)) {
      setView('welcome')
      return
    }
    const assistantId = newId()
    const sentCreator = creatorRef.current
    const run: PendingRun = { id: newId(), assistantId, baseRevision: sentCreator?.revision, appliedSequence: 0 }
    const history = edit
      ? [...messages.slice(0, messages.findIndex(message => message.id === edit.messageId)), { id: edit.messageId, role: 'user' as const, paragraphs: [value], ...(attached.length ? { selections: attached } : {}) }]
      : [...messages, { id: newId(), role: 'user' as const, paragraphs: [value], ...(attached.length ? { selections: attached } : {}) }]
    setEditingMessageId(null); setEditingMessageText('')
    followBottom.current = true
    setMessages([...history, { id: assistantId, role: 'assistant', paragraphs: [''] }])
    streamBuffers.current.set(assistantId, { text: '', reasoning: '', scheduled: false })
    if (!edit) { setInput(''); setSelections([]) }
    if (edit) setPendingCreator(null)
    setThinking(true); setRespondingId(assistantId); setMenuOpen(false); setReplyError(''); setActivity('正在连接…')
    if (sentCreator) {
      creatorObservation.current = { revision: sentCreator.revision, previous: sentCreator.aiSeenRevision }
      const observed = { ...sentCreator, aiSeenRevision: sentCreator.revision }
      creatorRef.current = observed
      setCreator(observed)
    }
    setPendingRun(run)
    pendingRunRef.current = run
    // Persist the user turn, placeholder and task identity before handing work to the server.
    const snapshot = { ...currentSnapshot.current!, messages: [...history, { id: assistantId, role: 'assistant' as const, paragraphs: [''] }], input: edit ? input : '', selections: edit ? selections : [], pendingRun: run }
    persistValue('soma-conversations', [snapshot, ...historySnapshot.current.filter(item => item.id !== snapshot.id)])
    void flushState()
    await watchRun(run, {
      conversationId: activeConversationId, service: serviceSettings,
      messages: history.filter(message => message.paragraphs.join('').trim()).map((message, index) => ({ role: message.role, content: message.paragraphs.join('\n\n') + (message.selections?.length ? '\n\n' + creatorSelectionContext(message.selections, index === history.length - 1 ? sentCreator ?? undefined : undefined) : '') })),
      creator: sentCreator,
    })
  }

  async function watchRun(run: PendingRun, start?: Parameters<typeof observeConversationRun>[4]) {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setThinking(true); setRespondingId(run.assistantId); setActivity('正在同步回应…'); setReplyError('')
    let expectedRevision = run.baseRevision === undefined ? undefined : run.baseRevision + run.appliedSequence
    let appliedSequence = run.appliedSequence
    try {
      await observeConversationRun(run, controller.signal, (snapshot: RunSnapshot) => {
        if (controller.signal.aborted) return
        const buffer = { text: snapshot.text, reasoning: snapshot.reasoning, scheduled: false }
        streamBuffers.current.set(run.assistantId, buffer)
        flushStream(run.assistantId, true)
        setActivity(typeof snapshot.status === 'string' ? snapshot.status : snapshot.status.message)
        let conflict = currentSnapshot.current?.pendingCreator
        for (const change of snapshot.creators) {
          if (change.sequence <= appliedSequence) continue
          const current = creatorRef.current
          if (current && current.revision === expectedRevision) {
            const next = commitCreator(current, change.document, 'ai')
            creatorRef.current = next; setCreator(next); expectedRevision = next.revision
          } else { conflict = change.document; setPendingCreator(change.document) }
          appliedSequence = change.sequence
        }
        const pending = snapshot.state === 'running' ? { ...run, appliedSequence } : undefined
        pendingRunRef.current = pending
        setPendingRun(pending)
        // Save without requestAnimationFrame: iOS may suspend painting before pagehide.
        const current = currentSnapshot.current
        if (current) {
          const nextMessages = current.messages.some(message => message.id === run.assistantId)
            ? current.messages.map(message => message.id === run.assistantId ? { ...message, paragraphs: [snapshot.text], reasoning: snapshot.reasoning || undefined } : message)
            : [...current.messages, { id: run.assistantId, role: 'assistant' as const, paragraphs: [snapshot.text], reasoning: snapshot.reasoning || undefined }]
          const next = { ...current, messages: nextMessages, creator: creatorRef.current, pendingRun: pending, pendingCreator: conflict, updatedAt: Date.now() }
          currentSnapshot.current = next
          setMessages(nextMessages)
          const list = [next, ...historySnapshot.current.filter(item => item.id !== next.id)]
          historySnapshot.current = list
          setHistory(list)
          persistValue('soma-conversations', list)
        }
      }, () => setActivity('连接暂时中断，正在同步后台回应…'), start)
    } catch (error) {
      if (!controller.signal.aborted) {
        setReplyError(error instanceof Error ? error.message : '回应暂时中断。')
        if (creatorObservation.current && creatorRef.current) {
          const next = { ...creatorRef.current, aiSeenRevision: creatorObservation.current.previous }
          creatorRef.current = next; setCreator(next)
        }
        pendingRunRef.current = undefined; setPendingRun(undefined)
      }
    } finally {
      if (request.current === controller) {
        creatorObservation.current = null
        request.current = null
        setThinking(false); setRespondingId(null); setActivity('')
        streamBuffers.current.delete(run.assistantId)
      }
    }
  }

  useEffect(() => {
    if (!pendingRunRef.current || request.current) return
    void watchRun(pendingRunRef.current)
    const observer = request.current as AbortController | null
    return () => {
      observer?.abort()
      if (request.current === observer) request.current = null
    }
    // Task identity, rather than streamed content, determines which observer is attached.
  }, [activeConversationId, pendingRun?.id])

  function beginEdit(message: Message) {
    if (thinking || message.role !== 'user') return
    setEditingMessageId(message.id)
    setEditingMessageText(message.paragraphs.join('\n\n'))
  }

  function cancelEdit() { setEditingMessageId(null); setEditingMessageText('') }

  function resendEdit() {
    if (!editingMessageId || !editingMessageText.trim() || thinking) return
    void send({ messageId: editingMessageId, text: editingMessageText })
  }

  function inputKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
  }

  async function copyDocument() {
    try {
      await navigator.clipboard.writeText(documentText)
      setCopied(true); setCopyError('')
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1800)
    } catch { setCopyError('暂时无法访问剪贴板，可以直接选中文字复制。') }
  }

  function download() {
    const blob = new Blob([`# ${initialDocument.title}\n\n${documentText}\n`], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `${initialDocument.title}.md`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const entrance = reduced ? { opacity: 0 } : { opacity: 0, y: 8, filter: 'blur(4px)' }
  const settled = { opacity: 1, y: 0, filter: 'blur(0px)' }
  const transition = reduced ? { duration: 0 } : { duration: 0.5, ease }

  const chatSurface = <>
          <div ref={scrollArea} className="conversation-scroll" onScroll={event => {
            const el = event.currentTarget
            followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}>
            <section ref={conversation} className="conversation" role="log" aria-label="对话" aria-live="polite" aria-relevant="additions" aria-busy={thinking}>
              {view === 'creator' && messages.length === 0 && <p className="creator-chat-empty">告诉我想写些什么，我们从一个想法开始。</p>}
              {pendingCreator && <div className="creator-conflict" role="status">你刚才修改了文稿。我把这次建议暂存了。<div><button onClick={() => { if (creatorRef.current) { const next = commitCreator(creatorRef.current, pendingCreator, 'ai'); creatorRef.current = next; setCreator(next) } setPendingCreator(null) }}>采用建议</button><button onClick={() => setPendingCreator(null)}>保留我的修改</button></div></div>}
              {messages.map((message, index) => <motion.article key={message.id} className={`message ${message.role}`} initial={entrance} animate={settled} transition={{ ...transition, delay: reduced ? 0 : index === 0 ? 0.2 : 0 }}>
                {message.role === 'user' ? <div className="message-user-content">
                  {editingMessageId === message.id ? <div className="message-edit"><label className="sr-only" htmlFor={`edit-message-${message.id}`}>修改消息</label><textarea id={`edit-message-${message.id}`} className="message-edit-input" value={editingMessageText} onChange={event => setEditingMessageText(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') cancelEdit(); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') resendEdit() }} autoFocus /><div className="message-edit-actions"><button className="message-action" onClick={cancelEdit}>取消</button><button className="message-action" disabled={!editingMessageText.trim()} onClick={resendEdit}>重新发送</button></div></div> : <><UserBubble paragraphs={message.paragraphs} />{message.selections?.map(selection => <details className="creator-sent-selection" key={selection.id}><summary><FileText size={13} />{selectionLabel(selection)}</summary><blockquote>{selection.text}</blockquote></details>)}<div className="message-actions">{!thinking && <button className="message-action" aria-label="修改并重新发送" title="修改并重新发送" onClick={() => beginEdit(message)}><PencilSimple size={15} /><span>编辑</span></button>}</div></>}
                </div> : <div className="assistant-message">
                  {message.reasoning && <ReasoningDisclosure content={message.reasoning} streaming={respondingId === message.id} />}
                  {message.paragraphs.some(paragraph => paragraph.trim()) && (respondingId === message.id
                    ? <StreamingMarkdown streaming={thinking}>{message.paragraphs.join('\n\n')}</StreamingMarkdown>
                    : <Markdown>{message.paragraphs.join('\n\n')}</Markdown>)}
                  {message.project && <motion.button className="project-link" initial={{ opacity: 0, y: reduced ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...transition, delay: reduced ? 0 : 0.2 }} onClick={() => setView('project')}><FileText size={16} weight="regular" /><span>{initialDocument.title}</span><ArrowUpRight size={14} /></motion.button>}
                </div>}
              </motion.article>)}
              <AnimatePresence>{thinking && <motion.div key="presence" className="presence" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.2 }}><span className="presence-mark" aria-hidden="true" /><span>{activity || '正在回应…'}</span></motion.div>}</AnimatePresence>
              {replyError && <p className="conversation-notice" role="alert">{replyError}{/401|403|密钥|模型|配置|认证/.test(replyError) && <button onClick={openServiceSettings}>服务设置</button>}</p>}
            </section>
          </div>
          <div className="edge-fade" aria-hidden="true" />

          <motion.div className="composer-position" layout="position" transition={reduced ? { duration: 0 } : { ...spring, stiffness: 140, damping: 25 }}>
            {selections.length > 0 && <div className="creator-selection-attachments" aria-label="文稿引用附件">{selections.map(selection => <div className="creator-selection-attachment" key={selection.id}><FileText size={15} /><span title={selection.text}><strong>{selection.chapterTitle || '未命名章节'}</strong><small>{selection.text.replace(/\s+/g, ' ').slice(0, 60)}</small></span><button className="icon-button" aria-label={`移除引用：${selection.chapterTitle}`} onClick={() => setSelections(items => items.filter(item => item.id !== selection.id))}><X size={14} /></button></div>)}</div>}
            <motion.div ref={composerSurface} layout className={`composer ${multiline ? 'multiline' : ''}`} transition={reduced ? { duration: 0 } : spring}>
              <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <Popover.Trigger className="icon-button composer-menu" aria-label="更多选项"><motion.span animate={{ rotate: menuOpen ? 45 : 0 }} transition={reduced ? { duration: 0 } : spring}><Plus size={20} weight="regular" /></motion.span></Popover.Trigger>
                <AnimatePresence>{menuOpen && <Popover.Portal keepMounted><Popover.Positioner anchor={composerSurface} side={hasMessages ? 'top' : 'bottom'} align="start" sideOffset={14} className="popover-positioner"><Popover.Popup className="popup-shell" render={<motion.div initial={{ opacity: 0, y: reduced ? 0 : hasMessages ? 5 : -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : 3 }} transition={transition} />}>
                  <Surface className="menu-surface" radius={24}>
                    <Popover.Title className="sr-only">对话选项</Popover.Title>
                    <button className="menu-row" onClick={startCreator}><FileText size={17} /><span>Creator Mode</span><ArrowUpRight size={14} /></button>
                    <button className="menu-row" onClick={fresh}><Plus size={17} /><span>新对话</span><kbd>⌘ N</kbd></button>
                    {hasProject && <button className="menu-row" onClick={() => { setMenuOpen(false); setView('project') }}><FileText size={17} /><span>{initialDocument.title}</span><ArrowUpRight size={14} /></button>}
                    <div className="menu-row theme-row"><Sun size={17} /><span>外观</span><div className="theme-seg" role="radiogroup" aria-label="外观">{(['system', 'light', 'dark'] as const).map((mode, index) => <button key={mode} role="radio" aria-checked={themeMode === mode} tabIndex={themeMode === mode ? 0 : -1} onClick={() => setThemeMode(mode)}>{['系统', '浅色', '深色'][index]}</button>)}</div></div>
                    <div className="reasoning-settings">
                      <label htmlFor="reasoning-effort"><Brain size={17} /><span>思考等级</span></label>
                      <select id="reasoning-effort" value={serviceSettings.reasoningEffort || 'auto'} disabled={thinking} onChange={event => setReasoningEffort(event.target.value as ReasoningEffort)}>
                        <option value="auto">自动</option><option value="low">轻量</option><option value="medium">标准</option><option value="high">深入</option>
                      </select>
                      <small>取决于模型支持；可展开模型返回的思考内容。</small>
                    </div>
                    <button className="menu-row" onClick={openServiceSettings}><Sun size={17} /><span>模型服务</span><ArrowUpRight size={14} /></button>
                  </Surface>
                </Popover.Popup></Popover.Positioner></Popover.Portal>}</AnimatePresence>
              </Popover.Root>
              <label htmlFor="message-input" className="sr-only">写下想说的话</label>
              <textarea ref={textarea} id="message-input" value={input} onChange={event => setInput(event.target.value)} onKeyDown={inputKey} rows={1} placeholder={hasMessages ? '继续聊…' : '想聊些什么？'} />
              <motion.button className={`send-button ${input.trim() || selections.length || thinking ? 'ready' : ''}`} whileTap={reduced ? undefined : { scale: 0.92 }} onClick={() => thinking ? stop() : send()} disabled={!thinking && !input.trim() && !selections.length} aria-label={thinking ? '停止回应' : '发送'}><AnimatePresence initial={false} mode="wait"><motion.span key={thinking ? 'stop' : 'send'} initial={{ opacity: 0, y: reduced ? 0 : 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -3 }} transition={{ duration: reduced ? 0 : 0.12 }}>{thinking ? <Square size={11} weight="fill" /> : <ArrowUp size={18} weight="bold" />}</motion.span></AnimatePresence></motion.button>
            </motion.div>
          </motion.div>
  </>

  return <LayoutGroup>
    <div className={`app ${reduced ? 'reduce-motion' : ''} ${historyOpen && view === 'conversation' ? 'history-open' : ''}`}>
      <div className="native-titlebar" data-tauri-drag-region aria-hidden="true" />
      {(hasMessages || history.length > 0) && view === 'conversation' && <ConversationHistory
        entries={history} activeId={activeConversationId} reduced={reduced} open={historyOpen} onOpenChange={setHistoryOpen}
        onSelect={selectConversation} onNew={fresh}
        onCopy={copyConversation} onExport={exportConversation} onDelete={removeConversation} notice={historyNotice}
      />}
      <AnimatePresence initial={false} mode="wait" onExitComplete={() => {
        if (view === 'conversation') requestAnimationFrame(() => textarea.current?.focus())
      }}>
        {view === 'conversation' && <motion.main key="conversation" className={`conversation-view ${hasMessages ? 'entered' : 'empty'}`} initial={{ opacity: 0, x: reduced ? 0 : -15 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : -15, filter: reduced ? 'none' : 'blur(3px)' }} transition={transition}>
          <AnimatePresence>{hasMessages && <motion.header className="conversation-header" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.4, delay: reduced ? 0 : 0.25 }}>
            <span className="history-placeholder" aria-hidden="true" />
            <div className="header-right">
              <button className="memory-access" onClick={() => { setSelectedMemory(null); setView('memory') }}>记忆</button>
              {creator && <button className="project-access" onClick={startCreator}><FileText size={14} /><span>{creator.title}</span><ArrowUpRight size={13} /></button>}
              {hasProject && <button ref={returnToProject} className="project-access" onClick={() => setView('project')}><FileText size={14} /><span>{initialDocument.title}</span><ArrowUpRight size={13} /></button>}
            </div>
          </motion.header>}</AnimatePresence>

          {chatSurface}
        </motion.main>}
        {view === 'creator' && creator && <CreatorWorkspace document={creator} onChange={document => { creatorRef.current = document; setCreator(document) }} onAttachSelection={selection => { setSelections(items => items.some(item => item.id === selection.id) ? items : [...items, selection]); requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true })) }} onBack={back} reduced={reduced}>
          <div className="creator-chat-heading">一起写</div>{chatSurface}
        </CreatorWorkspace>}
        {view === 'project'  && <motion.main key="project" className="project-view" initial={{ opacity: 0, x: reduced ? 0 : 24, filter: reduced ? 'none' : 'blur(4px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, x: reduced ? 0 : 24, filter: reduced ? 'none' : 'blur(4px)' }} transition={transition}>
          <header className="project-header">
            <button className="back-button" onClick={back}><ArrowLeft size={17} /><span>对话</span></button>
            <span className="project-location">{initialDocument.title}</span>
            <div className="project-actions"><button className="memory-access" onClick={() => { setSelectedMemory(null); setView('memory') }}>记忆</button><button className="icon-button" onClick={copyDocument} aria-label={copied ? '已复制' : '复制文稿'} title="复制文稿">{copied ? <Check size={18} /> : <Copy size={18} />}</button><button className="icon-button" onClick={download} aria-label="下载 Markdown" title="下载 Markdown"><DownloadSimple size={18} /></button></div>
          </header>
          <div className="project-scroll"><article className="writing-page">
            <h1>{initialDocument.title}</h1>
            <label htmlFor="document-editor" className="sr-only">编辑文稿</label>
            <textarea ref={editor} id="document-editor" value={documentText} onChange={event => setDocumentText(event.target.value)} spellCheck={false} />
            {copyError && <p className="inline-error" role="alert">{copyError}</p>}
          </article></div>
        </motion.main>}
        {view === 'welcome' && <ServiceOnboarding key="welcome" initial={serviceSettings} setup onBack={() => {}} onSave={saveService} reduced={reduced} />}
        {view === 'providers' && <ProviderManager state={profiles} onSelect={selectService} onEdit={editService} onAdd={() => editService(null)} onDelete={removeService} onBack={back} />}
        {view === 'settings' && <ServiceOnboarding key={`settings-${onboardingKey}`} initial={profiles.profiles.find(item => item.id === editingProfileId)?.settings || DEFAULT_SERVICE} initialName={profiles.profiles.find(item => item.id === editingProfileId)?.name || ''} setup={false} onBack={() => setView('providers')} onSave={saveService} reduced={reduced} />}
        {view === 'memory' && <motion.main key="memory" className="memory-view" initial={{ opacity: 0, x: reduced ? 0 : 24, filter: reduced ? 'none' : 'blur(4px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, x: reduced ? 0 : 24, filter: reduced ? 'none' : 'blur(4px)' }} transition={transition}>
          <header className="project-header">
            <button className="back-button" onClick={back}><ArrowLeft size={17} /><span>对话</span></button>
            <span className="project-location">记忆 · 只属于这次对话</span>
            <div className="project-actions"><span className="memory-count">{memorySea.nodes.length} 条</span></div>
          </header>
          <div className="memory-body">
            {memorySea.nodes.length === 0
              ? <div className="memory-empty"><p>这次对话还没有留下什么。</p><span>说几句话，它们会出现在这里。</span></div>
              : <>
                <div className="memory-stage">
                  <MemorySeaCanvas sea={memorySea} theme={resolvedTheme} selectedId={selectedMemory} onSelect={setSelectedMemory} />
                  <div className="memory-legend">{(['mood', 'talk', 'work'] as const).map(kind => <span key={kind}><i style={{ background: kindColor[kind][resolvedTheme] }} />{kindLabel[kind]}</span>)}</div>
                </div>
                <aside className="memory-panel">
                  {selectedMemory && (() => {
                    const node = memorySea.nodes.find(item => item.id === selectedMemory)
                    if (!node) return null
                    return <div className="memory-detail"><span className="memory-kind">{kindLabel[node.kind]}</span><p>{node.text}</p><button className="memory-forget" onClick={() => { setForgotten(previous => new Set(previous).add(node.id)); setSelectedMemory(null) }}>不再记住这条</button></div>
                  })()}
                  <ul className="memory-list" aria-label="这次对话记住的内容">
                    {memorySea.nodes.map(node => <li key={node.id}><button className={node.id === selectedMemory ? 'active' : ''} aria-pressed={node.id === selectedMemory} onClick={() => setSelectedMemory(node.id)}><span className="memory-dot" style={{ background: kindColor[node.kind][resolvedTheme] }} /><span className="memory-kind">{kindLabel[node.kind]}</span><span className="memory-text">{node.text}</span></button></li>)}
                  </ul>
                </aside>
              </>}
          </div>
        </motion.main>}
      </AnimatePresence>
    </div>
  </LayoutGroup>
}

/**
 * The bubble is the composer's twin: same fill, same shadow, no stroke.
 * Shape follows the same rule too — one line is a capsule, more is a rounded
 * rectangle. Line count is measured from real line boxes, not guessed.
 */
function UserBubble({ paragraphs }: { paragraphs: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [singleLine, setSingleLine] = useState(true)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      // Measure the text itself: the bubble's min-height would otherwise inflate a one-line bubble.
      const first = element.querySelector('p')
      if (!first || paragraphs.length !== 1) { setSingleLine(false); return }
      const lineHeight = Number.parseFloat(getComputedStyle(first).lineHeight) || 24
      setSingleLine(first.getBoundingClientRect().height < lineHeight * 1.5)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [paragraphs])
  return <div ref={ref} className={`user-message ${singleLine ? 'single-line' : 'multi-line'}`}>
    {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
  </div>
}
