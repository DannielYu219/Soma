import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ClockCounterClockwise, Check, Copy, DownloadSimple, Plus, Trash } from '@phosphor-icons/react'

export interface HistoryEntry { id: string; title: string; updatedAt: number }

/** One surface changes size; content never scales with the surface. */
export function ConversationHistory({ entries, activeId, open, onOpenChange, reduced, onSelect, onNew, onCopy, onExport, onDelete, notice }: {
  entries: HistoryEntry[]
  activeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  reduced: boolean
  onSelect: (id: string) => void
  onNew: () => void
  onCopy: (id: string) => void
  onExport: (id: string) => void
  onDelete: (id: string) => void
  notice: string
}) {
  const [contentVisible, setContentVisible] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readViewport = () => ({ width: innerWidth, height: innerHeight, topPadding: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-top-padding')) || 0 })
  const [viewport, setViewport] = useState(readViewport)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const first = useRef<HTMLButtonElement>(null)
  const size = viewport.width <= 640 ? 46 : 50
  const inset = viewport.width <= 640 ? 13 : 18
  const width = Math.min(344, Math.max(size, viewport.width - inset * 2))
  const top = inset + viewport.topPadding
  const height = Math.max(size, viewport.height - top - inset)
  const radius = size / 2
  const close = () => { onOpenChange(false); cancelDelete(); trigger.current?.focus() }
  useEffect(() => {
    const timeout = setTimeout(() => setContentVisible(open), reduced ? 0 : open ? 180 : 420)
    return () => clearTimeout(timeout)
  }, [open, reduced])
  const cancelDelete = () => { if (deleteTimer.current) clearTimeout(deleteTimer.current); setPendingDelete(null) }
  const confirmDelete = (id: string) => {
    if (pendingDelete === id) { cancelDelete(); onDelete(id); return }
    cancelDelete()
    setPendingDelete(id)
    deleteTimer.current = setTimeout(() => setPendingDelete(null), 5000)
  }

  useEffect(() => {
    const resize = () => setViewport(readViewport())
    const observer = new MutationObserver(resize)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-window-mode'] })
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); observer.disconnect() }
  }, [])

  useEffect(() => () => { if (deleteTimer.current) clearTimeout(deleteTimer.current) }, [])

  useEffect(() => {
    if (!open) return
    const pointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) { onOpenChange(false); cancelDelete() }
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (pendingDelete) cancelDelete(); else close() }
    }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('pointerdown', pointer)
      document.removeEventListener('keydown', keyboard, true)
    }
  }, [open, pendingDelete])

  return <div ref={root} className={`history-anchor ${open ? 'is-open' : ''}`} style={{ '--history-open-width': `${width}px`, '--history-open-height': `${height}px` } as CSSProperties}>
    <motion.div className="history-surface" initial={false} style={{ width: open ? width : size, height: open ? height : size, borderRadius: radius }}
      animate={{ width: open ? width : size, height: open ? height : size, borderRadius: open ? 18 : radius }}
      transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 330, damping: 38, mass: 1 }}>
      <button ref={trigger} className="history-trigger" aria-label="历史会话" aria-expanded={open} aria-controls={open ? 'conversation-history' : undefined}
        onClick={() => { if (open) cancelDelete(); onOpenChange(!open) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); onOpenChange(true); requestAnimationFrame(() => first.current?.focus()) }
        }}>
        <motion.span animate={{ rotate: open ? -30 : 0 }} transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 280, damping: 27 }}><ClockCounterClockwise size={22} weight="regular" /></motion.span>
      </button>
      <AnimatePresence>{contentVisible && <motion.div id="conversation-history" className="history-content" role="region" aria-label="历史会话列表"
        style={{ width }} initial={{ opacity: 0, y: reduced ? 0 : -5 }} animate={{ opacity: open ? 1 : 0, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -4 }}
        transition={{ duration: reduced ? 0 : 0.16, delay: reduced ? 0 : 0.06 }}>
        <span className="history-title">历史会话</span>
        <div className="history-list">
          <button ref={first} className="history-new" onClick={() => { close(); onNew() }}><Plus size={17} /><span>新对话</span></button>
          {entries.length === 0 ? <p className="history-empty">还没有历史对话</p> : <ul>{entries.map(entry => <li key={entry.id}>
            <div className="history-item">
              <button className="history-entry" aria-current={entry.id === activeId ? 'true' : undefined} onClick={() => { close(); onSelect(entry.id) }}>
                <span className="history-entry-copy"><span>{entry.title}</span><small>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(entry.updatedAt)}</small></span>
                {entry.id === activeId && <Check size={15} />}
              </button>
              <div className="history-actions">
                <button className="history-action" aria-label={`复制会话：${entry.title}`} title="复制会话" onClick={() => { cancelDelete(); onCopy(entry.id) }}><Copy size={15} /></button>
                <button className="history-action" aria-label={`导出会话：${entry.title}`} title="导出 Markdown" onClick={() => { cancelDelete(); onExport(entry.id) }}><DownloadSimple size={15} /></button>
                <button className={`history-action history-delete ${pendingDelete === entry.id ? 'confirm' : ''}`} aria-label={`${pendingDelete === entry.id ? '确认删除' : '删除'}会话：${entry.title}`} title={pendingDelete === entry.id ? '再次点击确认删除' : '删除会话'} onClick={() => confirmDelete(entry.id)}>{pendingDelete === entry.id ? <Check size={15} /> : <Trash size={15} />}</button>
              </div>
              {pendingDelete === entry.id && <span className="history-delete-hint" role="status">再次点击确认删除 · Esc 取消</span>}
            </div>
          </li>)}</ul>}
        </div>
        {notice && <span className="history-notice" role="status">{notice}</span>}
      </motion.div>}</AnimatePresence>
    </motion.div>
  </div>
}
