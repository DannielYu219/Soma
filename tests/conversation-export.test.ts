import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationFilename, conversationMarkdown } from '../src/lib/conversationExport.ts'
import { createCreatorSelection } from '../src/lib/creatorSelection.ts'

test('export retains the selected manuscript text and original location', () => {
  const doc = { title: '作品', chapters: [{ id: 'first', title: '开头', text: '甲\n乙段\n丙' }], activeChapterId: 'first', revision: 3 }
  const selection = createCreatorSelection(doc, 'first', 2, 4)!
  const content = conversationMarkdown({ title: '引用', messages: [{ role: 'user', paragraphs: ['润色这里'], selections: [selection] }] })
  assert.match(content, /润色这里/)
  assert.match(content, /chapters\/first\/text/)
  assert.match(content, /原版本 r3；原 offset \[2,4\)/)
  assert.match(content, /乙段/)
})

test('export keeps message order, Markdown and optional reasoning', () => {
  const content = conversationMarkdown({ title: '雨夜对话', messages: [
    { role: 'user', paragraphs: ['为什么？'] },
    { role: 'assistant', paragraphs: ['第一段', '**重点**'], reasoning: '先比较两点。' },
    { role: 'user', paragraphs: ['再谈谈'] },
    { role: 'assistant', paragraphs: ['好的。'] },
  ] })
  assert.equal(content, '# 雨夜对话\n\n## 你\n\n为什么？\n\n---\n\n## Soma\n\n#### 思考内容\n\n先比较两点。\n\n第一段\n\n**重点**\n\n---\n\n## 你\n\n再谈谈\n\n---\n\n## Soma\n\n好的。\n')
})

test('export skips unfinished blank assistant messages and sanitizes titles', () => {
  assert.equal(conversationMarkdown({ title: '\n  草稿  ', messages: [{ role: 'assistant', paragraphs: [''] }, { role: 'user', paragraphs: ['继续'] }] }), '# 草稿\n\n## 你\n\n继续\n')
  assert.equal(conversationFilename('  ../<>:/\\|?*  '), '未命名对话.md')
  assert.equal(conversationFilename('摘录：第一章.  '), '摘录 第一章.md')
})
