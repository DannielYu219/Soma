import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, CSSProperties } from 'react'
import { ArrowLeft, ClockCounterClockwise, DownloadSimple, Plus, Trash, SidebarSimple, UploadSimple } from '@phosphor-icons/react'
import { Popover } from '@base-ui/react/popover'
import { motion } from 'motion/react'
import { addChapter, commitCreator, creatorChangePatch, creatorMarkdown, editChapter, editCreatorTitle, editWritingMode, editLineTarget, removeChapter } from './lib/creator'
import { creatorDocx, creatorExportFilename } from './lib/creatorExport'
import type { Chapter, CreatorDocument, LyricLineTarget } from './lib/creator'
import { newId } from './lib/id'
import { importCreatorFile } from './lib/creatorImport'
import { createCreatorSelection } from './lib/creatorSelection'
import type { CreatorSelection } from './lib/creatorSelection'
import './creator.css'

/** Measure logical line starts against the same wrapping mirror as the textarea. */
function LyricLineTargets({ chapter, onTarget }: { chapter: Chapter; onTarget(line: number, target: LyricLineTarget): void }) {
  const gutter = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<number[]>([])
  useLayoutEffect(() => {
    const mirror = gutter.current?.parentElement?.querySelector<HTMLElement>('.creator-text-measure')
    if (!mirror) return
    let active = true
    const measure = () => {
      if (!active) return
      const node = mirror.firstChild
      if (!node) return
      const origin = mirror.getBoundingClientRect().top
      const range = window.document.createRange()
      let offset = 0
      const next = chapter.text.split('\n').map(line => {
        range.setStart(node, offset)
        // The mirror includes a trailing newline, so even empty lines have a measurable range.
        range.setEnd(node, offset + 1)
        const top = range.getBoundingClientRect().top - origin
        offset += line.length + 1
        return top
      })
      setPositions(previous => previous.length === next.length && previous.every((top, index) => top === next[index]) ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(mirror)
    window.document.fonts.ready.then(measure)
    return () => { active = false; observer.disconnect() }
  }, [chapter.text])
  return <div ref={gutter} className="creator-lyric-gutter" aria-label={`${chapter.title}逐行目标`}>
    {chapter.text.split('\n').map((_, line) => {
      const target = chapter.lineTargets?.[line]
      const unit = target?.unit ?? 'characters'
      return <div className="creator-line-target" key={line} style={{ top: positions[line] ?? line * 28.5 }}>
        <input type="number" min={1} max={999} step={1} placeholder="—" value={target?.count ?? ''} aria-label={`${chapter.title} 第 ${line + 1} 行目标数`} title={`第 ${line + 1} 行：留空表示不限`} onChange={event => {
          const count = event.target.value === '' ? null : event.target.valueAsNumber
          if (count === null || (Number.isInteger(count) && count >= 1 && count <= 999)) onTarget(line, { count, unit })
        }} />
        <select value={unit} aria-label={`${chapter.title} 第 ${line + 1} 行计数单位`} onChange={event => onTarget(line, { count: target?.count ?? null, unit: event.target.value as LyricLineTarget['unit'] })}><option value="characters">字</option><option value="syllables">音节</option></select>
      </div>
    })}
  </div>
}

/** Three quiet columns from the user's sketch: chapters, a continuous manuscript, and the same conversation. */
export function CreatorWorkspace({ document, onChange, onBack, onAttachSelection, children, reduced }: {
  document: CreatorDocument; onChange(document: CreatorDocument): void; onBack(): void; onAttachSelection(selection: CreatorSelection): void; children: ReactNode; reduced: boolean
}) {
  const pages = useRef<HTMLDivElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const refs = useRef(new Map<string, HTMLElement>())
  const [chaptersOpen, setChaptersOpen] = useState(true)
  const [chatWidth, setChatWidth] = useState(360)
  const layout = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number } | null>(null)
  const [importError, setImportError] = useState('')

  async function importFile(file?: File) {
    if (!file) return
    setImportError('')
    if ((document.chapters.length > 1 || document.chapters.some(chapter => chapter.text.trim()) || (document.title.trim() && document.title !== '未命名作品')) && !window.confirm('导入会替换当前作品的标题、章节和正文。当前会话中的聊天记录不会改变。要继续吗？')) {
      if (importInput.current) importInput.current.value = ''
      return
    }
    try {
      const imported = await importCreatorFile(file)
      if (imported.chapters.length > 100 || imported.chapters.some(chapter => chapter.text.length > 100_000)) throw new Error('文件章节过多，或单章正文超过 100,000 个字符。')
      const chapters = imported.chapters.map(chapter => ({ ...chapter, id: newId() }))
      const replacement = { ...document, title: imported.title, chapters, activeChapterId: chapters[0].id }
      setSelection(null)
      onChange(commitCreator(document, replacement))
      setChaptersOpen(true)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '文件导入失败。')
    } finally {
      if (importInput.current) importInput.current.value = ''
    }
  }

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
      <div className="creator-writing-modes" role="group" aria-label="写作模式">
        <button aria-pressed={(document.writingMode ?? 'text') === 'text'} onClick={() => { setSelection(null); onChange(editWritingMode(document, 'text')) }}>文本写作</button>
        <button aria-pressed={document.writingMode === 'lyrics'} onClick={() => { setSelection(null); onChange(editWritingMode(document, 'lyrics')) }}>歌词写作</button>
      </div>
      <div className="creator-actions">
        <input ref={importInput} className="sr-only" type="file" accept=".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="选择要导入的 TXT、Markdown 或 DOCX 文件" onChange={event => { void importFile(event.currentTarget.files?.[0]) }} />
        <button className="icon-button" aria-label="导入作品" title="导入 TXT、Markdown 或 Word 文档" onClick={() => importInput.current?.click()}><UploadSimple size={18} /></button>
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
    {importError && <div className="creator-import-error" role="alert">{importError}<button onClick={() => setImportError('')} aria-label="关闭导入错误">关闭</button></div>}
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
          {document.writingMode === 'lyrics' && <p className="creator-lyrics-hint">行首设定目标字数 / 音节数，留空不限。AI 会读取这些要求。</p>}
          <div className={document.writingMode === 'lyrics' ? 'creator-chapter-body creator-lyrics-body' : 'creator-chapter-body'}>
          {document.writingMode === 'lyrics' && <LyricLineTargets chapter={chapter} onTarget={(line, target) => onChange(editLineTarget(document, chapter.id, line, target))} />}
          <label className="creator-text-editor"><span className="sr-only">章节正文 {index + 1}</span><span className="creator-text-measure" aria-hidden="true">{chapter.text + '\n'}</span><textarea className="creator-page-text" value={chapter.text} placeholder={index === 0 ? '从这里开始。也可以在右侧告诉我，你想写些什么。' : '这一章，接着写…'} onPointerDown={() => { selecting.current = true; setSelection(null) }} onPointerUp={event => { selecting.current = false; captureSelection(event.currentTarget, chapter.id) }} onPointerCancel={() => { selecting.current = false; setSelection(null) }} onSelect={event => captureSelection(event.currentTarget, chapter.id)} onBlur={event => { if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest('.creator-attach-selection'))) setSelection(null) }} onChange={event => { setSelection(null); onChange(editChapter(document, chapter.id, { text: event.target.value })) }} spellCheck={false} /></label>
          </div>
        </article>)}
        <button className="creator-add-page" onClick={() => onChange(addChapter(document))}><Plus size={17} /><span>下一章</span></button>
      </section>
      <div className="creator-splitter" role="separator" aria-label="创作对话宽度" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={520} aria-valuenow={chatWidth} tabIndex={0} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onKeyDown={keyResize} />
      <aside className="creator-chat" aria-label="创作对话">{children}</aside>
    </div>
    {selection && selection.quote.revision === document.revision && createPortal(<button className="creator-attach-selection" style={{ left: selection.left, top: selection.top }} onPointerDown={event => event.preventDefault()} onKeyDown={event => { if (event.key === 'Escape') setSelection(null) }} onClick={() => { onAttachSelection(selection.quote); setSelection(null); if (window.matchMedia('(max-width: 760px)').matches) setChaptersOpen(false) }}>添加到对话</button>, window.document.body)}
  </motion.main>
}
