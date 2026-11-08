import assert from 'node:assert/strict'
import test from 'node:test'
import type { CreatorDocument } from '../src/lib/creator.ts'
import { createCreatorSelection, creatorSelectionContext, resolveCreatorSelection, selectionLabel } from '../src/lib/creatorSelection.ts'

function document(text: string, revision = 4): CreatorDocument {
  return { title: '作品', revision, activeChapterId: 'chapter-1', chapters: [{ id: 'chapter-1', title: '第一章', text }] }
}
function select(doc: CreatorDocument, text: string, start = doc.chapters[0].text.indexOf(text)) {
  const selection = createCreatorSelection(doc, 'chapter-1', start, start + text.length)
  assert.ok(selection)
  return selection
}

test('creates a deterministic immutable snapshot with exact UTF-16 half-open offsets', () => {
  const doc = document('开头😀 引用\n正文 尾声')
  const original = structuredClone(doc)
  const selection = select(doc, '引用\n正文')
  assert.deepEqual(selection, {
    id: 'selection:chapter-1:4:5:10', chapterId: 'chapter-1', chapterTitle: '第一章', revision: 4,
    start: 5, end: 10, text: '引用\n正文', before: '开头😀 ', after: ' 尾声',
  })
  assert.deepEqual(doc, original)
  assert.deepEqual(select(doc, selection.text), selection)
  doc.chapters[0].text = '已修改'
  assert.equal(selection.text, '引用\n正文')
})

test('rejects absent chapters, empty/reversed/out-of-range/non-integer ranges and split surrogate pairs', () => {
  const doc = document('A😀B')
  for (const [start, end] of [[0, 0], [3, 2], [-1, 1], [0, 5], [0.5, 3], [0, Infinity], [NaN, 3], [1, 2], [2, 3]]) {
    assert.equal(createCreatorSelection(doc, 'chapter-1', start, end), null, `${start},${end}`)
  }
  assert.equal(createCreatorSelection(doc, 'missing', 0, 1), null)
  assert.equal(select(doc, '😀').text, '😀')
  assert.equal(createCreatorSelection(document(''), 'chapter-1', 0, 0), null)
})

test('same revision uses the saved occurrence even when text repeats', () => {
  const doc = document('相同\n相同\n相同')
  const selection = select(doc, '相同', 3)
  assert.deepEqual(resolveCreatorSelection(selection, doc), {
    status: 'resolved', start: 3, end: 5, startLine: 2, startColumn: 1, endLine: 2, endColumn: 3,
  })
})

test('relocates uniquely with both contexts after insertion and preserves the original snapshot', () => {
  const doc = document('引言\n' + '前'.repeat(80) + '引用😀' + '后'.repeat(80) + '\n末尾')
  const selection = select(doc, '引用😀')
  const snapshot = structuredClone(selection)
  const next = document('新增\n' + doc.chapters[0].text, 5)
  const location = resolveCreatorSelection(selection, next)
  assert.equal(location.status, 'resolved')
  if (location.status === 'resolved') {
    assert.equal(location.start, selection.start + 3)
    assert.equal(location.end, selection.end + 3)
    assert.equal(location.startLine, 3)
    assert.equal(location.startColumn, 81)
  }
  assert.deepEqual(selection, snapshot)
})

test('a revision change never trusts the old offset or nearest text over matching contexts', () => {
  const prefix = '前'.repeat(70)
  const suffix = '后'.repeat(70)
  const doc = document(prefix + '引用' + suffix)
  const selection = select(doc, '引用')
  const next = document('错'.repeat(70) + '引用' + '误'.repeat(70) + '\n' + doc.chapters[0].text, 5)
  const result = resolveCreatorSelection(selection, next)
  assert.equal(result.status, 'resolved')
  if (result.status === 'resolved') assert.equal(result.start, next.chapters[0].text.lastIndexOf('引用'))
})

test('does not relocate to the lone surviving duplicate when the original occurrence is deleted', () => {
  const doc = document('原始环境：引用；原始后文\n另一环境：引用；其他后文')
  const selection = select(doc, '引用')
  assert.deepEqual(resolveCreatorSelection(selection, document('另一环境：引用；其他后文', 5)), { status: 'stale' })
  assert.deepEqual(resolveCreatorSelection(selection, document('正文全部替换', 5)), { status: 'stale' })
})

test('identical contextual matches are ambiguous even if one still occupies the original offset', () => {
  const passage = '前'.repeat(70) + '引用' + '后'.repeat(70)
  const doc = document(passage)
  const selection = select(doc, '引用')
  assert.deepEqual(resolveCreatorSelection(selection, document(passage + '\n' + passage, 5)), { status: 'ambiguous' })
  assert.deepEqual(resolveCreatorSelection(selection, document('甲引用乙\n丙引用丁', 5)), { status: 'ambiguous' })
})

test('empty contexts anchor chapter edges and overlapping quotes are not silently selected', () => {
  const doc = document('aaa')
  const selection = select(doc, 'aa')
  assert.deepEqual(resolveCreatorSelection(selection, document('aaaa', 5)), { status: 'ambiguous' })
  const whole = select(document('整段'), '整段')
  assert.equal(resolveCreatorSelection(whole, document('整段', 5)).status, 'resolved')
  assert.equal(resolveCreatorSelection(whole, document('前整段后', 5)).status, 'stale')
})

test('deleted chapters never fall back to another chapter with the same title and content', () => {
  const doc = document('引用')
  const selection = select(doc, '引用')
  const next = { ...doc, revision: 5, chapters: [{ ...doc.chapters[0], id: 'replacement' }] }
  assert.deepEqual(resolveCreatorSelection(selection, next), { status: 'missing-chapter' })
})

test('line and column metadata preserve UTF-16, CRLF, LF, CR and multiline text', () => {
  const doc = document('😀a\r\n乙😀 引用\n第三行\r末行')
  const selection = select(doc, '引用\n第三行\r末行')
  const result = resolveCreatorSelection(selection, doc)
  assert.deepEqual(result, {
    status: 'resolved', start: 9, end: doc.chapters[0].text.length,
    startLine: 2, startColumn: 5, endLine: 4, endColumn: 3,
  })
  const emoji = select(doc, '😀a')
  const emojiResult = resolveCreatorSelection(emoji, doc)
  assert.equal(emojiResult.status, 'resolved')
  if (emojiResult.status === 'resolved') assert.equal(emojiResult.endColumn, 4)
})

test('context captures complete surrogate pairs and never normalizes Unicode or line endings', () => {
  const doc = document('😀' + '前'.repeat(63) + 'e\u0301\r\n' + '后'.repeat(63) + '😀')
  const selection = select(doc, 'e\u0301\r\n')
  assert.equal(selection.before, '😀' + '前'.repeat(63))
  assert.equal(selection.after, '后'.repeat(63) + '😀')
  assert.equal(selection.text, 'e\u0301\r\n')
  assert.equal(resolveCreatorSelection(selection, document(doc.chapters[0].text.normalize('NFC'), 5)).status, 'stale')
})

test('context includes identity, path, original revision and offsets, current lines and exact quoted text', () => {
  const doc = document('前言\n正文😀\r\n尾声')
  const selection = select(doc, '正文😀\r\n')
  const context = creatorSelectionContext([selection], doc)
  for (const expected of ['chapter-1', 'chapters/chapter-1/text', '原版本 r4', 'UTF-16', '0-based', '1-based', 'resolved', '行列 2:1–3:1', JSON.stringify(selection.text)]) {
    assert.ok(context.includes(expected), expected)
  }
  assert.equal(creatorSelectionContext([], doc), '')
  assert.match(creatorSelectionContext([selection]), /unverified/)
  assert.doesNotMatch(creatorSelectionContext([selection]), /行列 2:/)
  assert.match(creatorSelectionContext([selection], document('改写', 5)), /stale/)
  assert.match(creatorSelectionContext([selection], { ...doc, chapters: [] }), /missing-chapter/)
})

test('context explains ambiguity and preserves original versus renamed chapter titles', () => {
  const passage = '前'.repeat(70) + '引用' + '后'.repeat(70)
  const doc = document(passage)
  const selection = select(doc, '引用')
  const next = document(passage + passage, 5)
  next.chapters[0].title = '新标题'
  const context = creatorSelectionContext([selection], next)
  assert.match(context, /ambiguous/)
  assert.match(context, /第一章/)
  assert.match(context, /新标题/)
  assert.doesNotMatch(context, /行列 \d+:/)
})

test('malformed serialized selections fail safely and labels collapse whitespace without splitting emoji', () => {
  const doc = document('引用')
  const selection = select(doc, '引用')
  for (const patch of [{ text: '' }, { start: -1 }, { end: 10 }, { start: NaN }]) {
    assert.equal(resolveCreatorSelection({ ...selection, ...patch }, doc).status, 'stale')
  }
  assert.equal(selectionLabel({ ...selection, text: '一\r\n 二\t三' }), '第一章 · 一 二 三')
  assert.equal(selectionLabel({ ...selection, chapterTitle: '', text: '😀'.repeat(33) }), '未命名章节 · ' + '😀'.repeat(32) + '…')
})
