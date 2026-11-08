import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, CSSProperties } from 'react'
import { ArrowLeft, ClockCounterClockwise, DownloadSimple, Plus, Trash, SidebarSimple } from '@phosphor-icons/react'
import { Popover } from '@base-ui/react/popover'
import { motion } from 'motion/react'
import { addChapter, creatorChangePatch, creatorMarkdown, editChapter, editCreatorTitle, removeChapter } from './lib/creator'
import { creatorDocx, creatorExportFilename } from './lib/creatorExport'
import type { CreatorDocument } from './lib/creator'
import { createCreatorSelection } from './lib/creatorSelection'
import type { CreatorSelection } from './lib/creatorSelection'
import './creator.css'

/** Three quiet columns from the user's sketch: chapters, a continuous manuscript, and the same conversation. */
export function CreatorWorkspace({ document, onChange, onBack, onAttachSelection, children, reduced }: {
  document: CreatorDocument; onChange(document: CreatorDocument): void; onBack(): void; onAttachSelection(selection: CreatorSelection): void; children: ReactNode; reduced: boolean
}) {
  const pages = useRef<HTMLDivElement>(null)
  const refs = useRef(new Map<string, HTMLElement>())
  const [chaptersOpen, setChaptersOpen] = useState(true)
  const [chatWidth, setChatWidth] = useState(360)
  const layout = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number } | null>(null)

  function resizeChat(clientX: number) {
    const bounds = layout.current?.getBoundingClientRect()
    if (!bounds) return
    setChatWidth(Math.max(280, Math.min(520, bounds.right - clientX - 14)))
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId }
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    resizeChat(event.clientX)
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
  }

  function keyResize(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') { setChaptersOpen(value => !value); return }
    if (event.key === 'ArrowLeft') { event.preventDefault(); setChatWidth(width => Math.min(520, width + 20)) }
    if (event.key === 'ArrowRight') { event.preventDefault(); setChatWidth(width => Math.max(280, width - 20)) }
    if (event.key === 'Home') { event.preventDefault(); setChatWidth(520) }
    if (event.key === 'End') { event.preventDefault(); setChatWidth(280) }
  }
  const [selection, setSelection] = useState<{ quote: CreatorSelection; left: number; top: number } | null>(null)
  const selecting = useRef(false)
  useEffect(() => {
    const dismiss = () => setSelection(null)
    window.addEventListener('resize', dismiss)
    return () => window.removeEventListener('resize', dismiss)
  }, [])

  function captureSelection(element: HTMLTextAreaElement, chapterId: string) {
    if (selecting.current || window.document.activeElement !== element) return
    const quote = createCreatorSelection(document, chapterId, element.selectionStart, element.selectionEnd)
    const mirror = element.parentElement?.querySelector('.creator-text-measure')
    const node = mirror?.firstChild
    const viewport = pages.current?.getBoundingClientRect()
    if (!quote || !node || !viewport) { setSelection(null); return }
    // Measure against the existing, identically wrapped text mirror. Textareas do
    // not expose DOM selection rectangles, and pointer coordinates miss keyboard selections.
    const range = window.document.createRange()
    range.setStart(node, quote.start)
    range.setEnd(node, quote.end)
    const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.bottom > viewport.top + 50 && rect.top < viewport.bottom)
    const rect = element.selectionDirection === 'backward' ? rects[0] : rects.at(-1)
    if (!rect) { setSelection(null); return }
    const width = 112, height = 32, gap = 7
    const left = Math.max(viewport.left + 8, Math.min(rect.left, viewport.right - width - 8, window.innerWidth - width - 8))
    const top = rect.top - height - gap >= viewport.top + 50
      ? rect.top - height - gap
      : Math.min(rect.bottom + gap, viewport.bottom - height - 8)
    setSelection({ quote, left, top })
  }


  function select(id: string) {
    onChange({ ...document, activeChapterId: id })
    refs.current.get(id)?.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'start' })
  }
  function download(format: 'docx' | 'md') {
    const blob = format === 'docx'
      ? new Blob([Uint8Array.from(creatorDocx(document))], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
      : new Blob([creatorMarkdown(document)], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = window.document.createElement('a')
    link.href = url; link.download = creatorExportFilename(document.title, format); link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <motion.main key="creator" className="creator-view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .35 }}>
    <header className="creator-header">
      <button className="back-button" onClick={onBack}><ArrowLeft size={16} weight="bold" /><span>对话</span></button>
      <button className="creator-mobile-chapters icon-button" aria-label={chaptersOpen ? '切换到创作对话' : '切换到章节列表'} title={chaptersOpen ? '创作对话' : '章节列表'} onClick={() => setChaptersOpen(value => !value)}><SidebarSimple size={18} /></button>
      <span>Creator Mode</span>
      <div className="creator-actions">
        <Popover.Root><Popover.Trigger className="icon-button" aria-label="修改日志" title="修改日志"><ClockCounterClockwise size={18} /></Popover.Trigger>
          <Popover.Portal><Popover.Positioner sideOffset={8} align="end" className="creator-popover-positioner"><Popover.Popup className="creator-journal">
            <div className="creator-journal-heading"><strong>修改日志</strong><span>r{document.revision}</span></div>
            <p className="creator-journal-note">下一次发送消息时，AI 会先看到最新差异与完整文稿。保留近期记录。</p>
            {!(document.changes?.length) && <p className="creator-journal-note">还没有修改记录。从这里开始写。</p>}
            {document.changes?.slice().reverse().map(change => <details key={change.id} className="creator-change"><summary><span>r{change.revision} · {change.source === 'user' ? '你' : 'AI'} · {change.label || '未命名章节'}</span><small><span className="diff-added">+{change.added.length}</span> <span className="diff-removed">−{change.removed.length}</span></small></summary><time dateTime={new Date(change.timestamp).toISOString()}>{new Date(change.timestamp).toLocaleString()}</time><pre>{creatorChangePatch(change).split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : undefined}>{line}{'\n'}</span>)}</pre></details>)}
          </Popover.Popup></Popover.Positioner></Popover.Portal>
        </Popover.Root>
        <Popover.Root><Popover.Trigger className="icon-button" aria-label="导出作品" title="导出作品"><DownloadSimple size={18} /></Popover.Trigger>
          <Popover.Portal><Popover.Positioner sideOffset={8} align="end" className="creator-popover-positioner"><Popover.Popup className="creator-export-menu"><Popover.Close className="creator-export-option" onClick={() => download('docx')}>Word 文档 (.docx)</Popover.Close><Popover.Close className="creator-export-option" onClick={() => download('md')}>Markdown (.md)</Popover.Close></Popover.Popup></Popover.Positioner></Popover.Portal>
        </Popover.Root>
      </div>
    </header>
    <div ref={layout} className={`creator-layout ${chaptersOpen ? '' : 'chapters-collapsed'}`} style={{ '--chat-width': `${chatWidth}px` } as CSSProperties}>
      {chaptersOpen && <aside className="creator-chapters" aria-label="章节列表">
        <div className="creator-chapters-heading"><span>章节</span><button className="icon-button" aria-label="添加章节" onClick={() => onChange(addChapter(document))}><Plus size={17} weight="bold" /></button></div>
        <nav>{document.chapters.map((chapter, index) => <button key={chapter.id} className="creator-chapter" aria-current={chapter.id === document.activeChapterId ? 'true' : undefined} onClick={() => select(chapter.id)}><small>{String(index + 1).padStart(2, '0')}</small><span>{chapter.title || '未命名章节'}</span></button>)}</nav>
      </aside>}
      <section className="creator-manuscript" ref={pages} aria-label="作品文稿" onScroll={() => setSelection(null)}>
        <div className="creator-title-row"><button className="creator-collapse-chapters icon-button" aria-label={chaptersOpen ? '收起章节列表' : '展开章节列表'} title={chaptersOpen ? '收起章节列表' : '展开章节列表'} onClick={() => setChaptersOpen(value => !value)}><SidebarSimple size={18} /></button><label className="creator-title"><span className="sr-only">作品名称</span><input value={document.title} placeholder="未命名作品" onChange={event => onChange(editCreatorTitle(document, event.target.value))} /></label></div>
        {document.chapters.map((chapter, index) => <article key={chapter.id} ref={element => { if (element) refs.current.set(chapter.id, element); else refs.current.delete(chapter.id) }} className="creator-page" onFocus={() => { if (document.activeChapterId !== chapter.id) onChange({ ...document, activeChapterId: chapter.id }) }}>
          <div className="creator-page-top"><span>{String(index + 1).padStart(2, '0')}</span><button className="icon-button" aria-label={`删除章节：${chapter.title}`} disabled={document.chapters.length === 1} onClick={() => onChange(removeChapter(document, chapter.id))}><Trash size={15} /></button></div>
          <label><span className="sr-only">章节标题 {index + 1}</span><input className="creator-page-title" value={chapter.title} onChange={event => onChange(editChapter(document, chapter.id, { title: event.target.value }))} /></label>
          <label className="creator-text-editor"><span className="sr-only">章节正文 {index + 1}</span><span className="creator-text-measure" aria-hidden="true">{chapter.text + '\n'}</span><textarea className="creator-page-text" value={chapter.text} placeholder={index === 0 ? '从这里开始。也可以在右侧告诉我，你想写些什么。' : '这一章，接着写…'} onPointerDown={() => { selecting.current = true; setSelection(null) }} onPointerUp={event => { selecting.current = false; captureSelection(event.currentTarget, chapter.id) }} onPointerCancel={() => { selecting.current = false; setSelection(null) }} onSelect={event => captureSelection(event.currentTarget, chapter.id)} onBlur={event => { if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest('.creator-attach-selection'))) setSelection(null) }} onChange={event => { setSelection(null); onChange(editChapter(document, chapter.id, { text: event.target.value })) }} spellCheck={false} /></label>
        </article>)}
        <button className="creator-add-page" onClick={() => onChange(addChapter(document))}><Plus size={17} /><span>下一章</span></button>
      </section>
      <div className="creator-splitter" role="separator" aria-label="创作对话宽度" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={520} aria-valuenow={chatWidth} tabIndex={0} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onKeyDown={keyResize} />
      <aside className="creator-chat" aria-label="创作对话">{children}</aside>
    </div>
    {selection && selection.quote.revision === document.revision && createPortal(<button className="creator-attach-selection" style={{ left: selection.left, top: selection.top }} onPointerDown={event => event.preventDefault()} onKeyDown={event => { if (event.key === 'Escape') setSelection(null) }} onClick={() => { onAttachSelection(selection.quote); setSelection(null); if (window.matchMedia('(max-width: 760px)').matches) setChaptersOpen(false) }}>添加到对话</button>, window.document.body)}
  </motion.main>
}
