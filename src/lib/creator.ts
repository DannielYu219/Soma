import { newId } from './id.ts'

export interface Chapter { id: string; title: string; text: string }
export interface CreatorChange {
  id: string; revision: number; timestamp: number; source: 'user' | 'ai'
  path: string; label: string; kind: 'edit' | 'add' | 'remove'
  oldStart: number; newStart: number; removed: string[]; added: string[]
}
export interface CreatorDocument {
  title: string
  chapters: Chapter[]
  activeChapterId: string
  revision: number
  changes?: CreatorChange[]
  aiSeenRevision?: number
}
const MAX_CHANGES = 80
const MAX_LOG_SIZE = 240_000

export function newCreatorDocument(existing?: { title: string; text: string }): CreatorDocument {
  const id = newId()
  return { title: existing?.title || '未命名作品', chapters: [{ id, title: '第一章', text: existing?.text || '' }], activeChapterId: id, revision: 0, changes: [] }
}

/** One contiguous line hunk. Common prefixes and suffixes stay out of the journal. */
function hunk(before: string, after: string) {
  const left = before === '' ? [] : before.split('\n')
  const right = after === '' ? [] : after.split('\n')
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  let end = 0
  while (end < left.length - start && end < right.length - start && left[left.length - end - 1] === right[right.length - end - 1]) end++
  return { oldStart: start + 1, newStart: start + 1, removed: left.slice(start, left.length - end), added: right.slice(start, right.length - end) }
}

/** Record only accepted mutations; selection and rejected AI proposals never become edits. */
export function commitCreator(before: CreatorDocument, proposed: CreatorDocument, source: CreatorChange['source'] = 'user', now = Date.now()): CreatorDocument {
  const revision = before.revision + 1
  const changes: CreatorChange[] = []
  function record(path: string, label: string, left: string, right: string, kind: CreatorChange['kind'] = 'edit') {
    if (left === right && kind === 'edit') return
    changes.push({ id: newId(), revision, timestamp: now, source, path, label, kind, ...hunk(left, right) })
  }
  record('title', '作品名称', before.title, proposed.title)
  for (const chapter of before.chapters) {
    const next = proposed.chapters.find(item => item.id === chapter.id)
    if (!next) record(`chapters/${chapter.id}`, chapter.title, `${chapter.title}\n${chapter.text}`, '', 'remove')
    else {
      record(`chapters/${chapter.id}/title`, `${chapter.title || '未命名章节'} · 标题`, chapter.title, next.title)
      record(`chapters/${chapter.id}/text`, next.title || '未命名章节', chapter.text, next.text)
    }
  }
  for (const chapter of proposed.chapters) {
    if (!before.chapters.some(item => item.id === chapter.id)) record(`chapters/${chapter.id}`, chapter.title, '', `${chapter.title}\n${chapter.text}`, 'add')
  }
  const oldOrder = before.chapters.filter(ch => proposed.chapters.some(item => item.id === ch.id)).map(ch => ch.id).join('\n')
  const newOrder = proposed.chapters.filter(ch => before.chapters.some(item => item.id === ch.id)).map(ch => ch.id).join('\n')
  record('chapters/order', '章节顺序', oldOrder, newOrder)
  if (!changes.length) return { ...before, activeChapterId: proposed.activeChapterId }
  const history = [...(before.changes ?? [])]
  const last = history.at(-1)
  // A short typing burst forms one readable patch, but never merges across an AI observation.
  if (source === 'user' && changes.length === 1 && last?.source === 'user' && last.kind === 'edit' && changes[0].kind === 'edit' && last.path === changes[0].path && now - last.timestamp < 1500 && last.revision > (before.aiSeenRevision ?? -1)) {
    const change = changes[0]
    const oldValue = change.path === 'title' ? before.title : before.chapters.find(ch => change.path === `chapters/${ch.id}/title` || change.path === `chapters/${ch.id}/text`)
    const value = typeof oldValue === 'string' ? oldValue : change.path.endsWith('/title') ? oldValue?.title : oldValue?.text
    if (value !== undefined) {
      const baseline = value === '' ? [] : value.split('\n')
      baseline.splice(last.newStart - 1, last.added.length, ...last.removed)
      const newValue = change.path === 'title' ? proposed.title : proposed.chapters.find(ch => change.path.startsWith(`chapters/${ch.id}/`))
      const text = typeof newValue === 'string' ? newValue : change.path.endsWith('/title') ? newValue?.title : newValue?.text
      if (text !== undefined) {
        history.pop()
        Object.assign(change, hunk(baseline.join('\n'), text), { id: last.id })
      }
    }
  }
  history.push(...changes.filter(change => change.kind !== 'edit' || change.removed.length || change.added.length))
  let size = 0
  const retained: CreatorChange[] = []
  for (let index = history.length - 1; index >= 0 && retained.length < MAX_CHANGES; index--) {
    const change = history[index]
    size += JSON.stringify(change).length
    if (size > MAX_LOG_SIZE) break
    retained.unshift(change)
  }
  return { ...proposed, revision, changes: retained, aiSeenRevision: before.aiSeenRevision }
}

export function editCreatorTitle(document: CreatorDocument, title: string): CreatorDocument {
  return commitCreator(document, { ...document, title })
}
export function editChapter(document: CreatorDocument, id: string, patch: Partial<Pick<Chapter, 'title' | 'text'>>): CreatorDocument {
  return commitCreator(document, { ...document, chapters: document.chapters.map(chapter => chapter.id === id ? { ...chapter, ...patch } : chapter) })
}
export function addChapter(document: CreatorDocument): CreatorDocument {
  const chapter = { id: newId(), title: `第 ${document.chapters.length + 1} 章`, text: '' }
  return commitCreator(document, { ...document, chapters: [...document.chapters, chapter], activeChapterId: chapter.id })
}
export function removeChapter(document: CreatorDocument, id: string): CreatorDocument {
  if (document.chapters.length === 1 || !document.chapters.some(chapter => chapter.id === id)) return document
  const index = document.chapters.findIndex(chapter => chapter.id === id)
  const chapters = document.chapters.filter(chapter => chapter.id !== id)
  return commitCreator(document, { ...document, chapters, activeChapterId: document.activeChapterId === id ? chapters[Math.min(index, chapters.length - 1)].id : document.activeChapterId })
}
export function creatorMarkdown(document: CreatorDocument): string {
  return `# ${document.title}\n\n${document.chapters.map(chapter => `## ${chapter.title}\n\n${chapter.text}`).join('\n\n')}\n`
}
export function creatorChangePatch(change: CreatorChange): string {
  return `--- ${change.kind === 'add' ? '/dev/null' : change.path}\n+++ ${change.kind === 'remove' ? '/dev/null' : change.path}\n@@ -${change.oldStart},${change.removed.length} +${change.newStart},${change.added.length} @@\n${[...change.removed.map(line => `-${line}`), ...change.added.map(line => `+${line}`)].join('\n')}`
}
/** Latest patches first, bounded separately from the complete authoritative document snapshot. */
export function creatorChangesContext(document: CreatorDocument): string {
  const unseen = (document.changes ?? []).filter(change => change.revision > (document.aiSeenRevision ?? -1))
  const header = `修改日志：AI 上次已观察版本 ${document.aiSeenRevision ?? '未知'} → 当前版本 ${document.revision}。以下为近期保留的修改，完整现稿为准。\n`
  let output = header
  for (const change of unseen.slice().reverse()) {
    const patch = `\nr${change.revision} | ${change.source === 'user' ? '用户' : 'AI'} | ${change.label}\n${creatorChangePatch(change)}\n`
    if (output.length + patch.length > 19_800) { output += '\n其余差异因长度限制省略，请核对完整现稿。'; break }
    output += patch
  }
  return unseen.length ? output : `${header}没有尚未观察的日志；请使用当前完整文稿。`
}
