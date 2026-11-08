import assert from 'node:assert/strict'
import test from 'node:test'
import { addChapter, commitCreator, creatorChangePatch, creatorChangesContext, creatorMarkdown, editChapter, editCreatorTitle, newCreatorDocument, removeChapter } from '../src/lib/creator.ts'

test('Creator documents are fresh and isolated between conversations', () => {
  const left = newCreatorDocument()
  const right = newCreatorDocument()
  assert.notEqual(left.chapters[0].id, right.chapters[0].id)
  const edited = editChapter(left, left.activeChapterId, { text: '只属于左边的作品' })
  assert.equal(edited.revision, left.revision + 1)
  assert.equal(right.chapters[0].text, '')
  assert.equal(left.chapters[0].text, '')
})

test('adding and removing chapters preserves a valid selected chapter', () => {
  const initial = newCreatorDocument()
  const added = addChapter(initial)
  assert.equal(added.chapters.length, 2)
  assert.equal(added.activeChapterId, added.chapters[1].id)
  const removed = removeChapter(added, added.activeChapterId)
  assert.equal(removed.chapters.length, 1)
  assert.equal(removed.activeChapterId, removed.chapters[0].id)
  assert.equal(removeChapter(removed, removed.activeChapterId), removed)
})

test('Creator export includes ordered titles and manuscript text', () => {
  const initial = newCreatorDocument({ title: '作品', text: '第一段。' })
  const added = addChapter(initial)
  const complete = editChapter(added, added.activeChapterId, { title: '后记', text: '最后一段。' })
  const markdown = creatorMarkdown(complete)
  assert.ok(markdown.startsWith('# 作品'))
  assert.ok(markdown.indexOf('第一段。') < markdown.indexOf('最后一段。'))
  assert.ok(markdown.includes('## 后记'))
})

test('journal records exact changed lines, renames, additions and deletions without selection noise', () => {
  const initial = newCreatorDocument({ title: '旧名', text: '不动\n旧行\n结尾' })
  const edited = editChapter(initial, initial.activeChapterId, { text: '不动\n新行\n结尾' })
  assert.deepEqual(edited.changes?.[0].removed, ['旧行'])
  assert.deepEqual(edited.changes?.[0].added, ['新行'])
  assert.match(creatorChangePatch(edited.changes![0]), /@@ -2,1 \+2,1 @@\n-旧行\n\+新行/)
  assert.equal(editChapter(edited, initial.activeChapterId, { text: edited.chapters[0].text }).revision, edited.revision)
  assert.equal(removeChapter(edited, 'missing'), edited)
  const named = editCreatorTitle(edited, '新名')
  assert.equal(named.changes?.at(-1)?.path, 'title')
  const added = addChapter(named)
  assert.equal(added.changes?.at(-1)?.kind, 'add')
  const removed = removeChapter(added, initial.activeChapterId)
  assert.equal(removed.changes?.at(-1)?.kind, 'remove')
  assert.match(creatorChangePatch(removed.changes!.at(-1)!), /-新行/)
})

test('typing bursts coalesce reversibly, but never across an AI observation', () => {
  const initial = newCreatorDocument({ title: '作品', text: '第一行\n原稿\n末行' })
  const one = commitCreator(initial, { ...initial, chapters: [{ ...initial.chapters[0], text: '第一行\n新稿\n末行' }] }, 'user', 1000)
  const two = commitCreator(one, { ...one, chapters: [{ ...one.chapters[0], text: '第一行\n新稿续写\n末行' }] }, 'user', 1200)
  assert.equal(two.changes?.length, 1)
  assert.deepEqual(two.changes?.[0].removed, ['原稿'])
  assert.deepEqual(two.changes?.[0].added, ['新稿续写'])
  const observed = { ...two, aiSeenRevision: two.revision }
  const three = commitCreator(observed, { ...observed, chapters: [{ ...observed.chapters[0], text: '第三稿' }] }, 'user', 1400)
  assert.equal(three.changes?.length, 2)
  const context = creatorChangesContext(three)
  assert.match(context, /-新稿续写/)
  assert.doesNotMatch(context, /-原稿/)
  const reverted = commitCreator(two, initial, 'user', 1300)
  assert.equal(reverted.changes?.length, 0)
})

test('accepted AI edits append to local journal and old documents migrate lazily', () => {
  const old = { title: '旧作品', chapters: [{ id: 'old', title: '章节', text: '原稿' }], activeChapterId: 'old', revision: 9 }
  const edited = commitCreator(old, { ...old, chapters: [{ ...old.chapters[0], text: 'AI 稿' }] }, 'ai')
  assert.equal(edited.revision, 10)
  assert.equal(edited.changes?.[0].source, 'ai')
  assert.equal(JSON.parse(JSON.stringify(edited)).changes[0].added[0], 'AI 稿')
  assert.match(creatorChangesContext(edited), /r10 \| AI/)
  assert.equal(newCreatorDocument().changes?.length, 0)
})

test('journal and AI context stay bounded and chapter reordering is visible', () => {
  let doc = addChapter(newCreatorDocument())
  doc = commitCreator(doc, { ...doc, chapters: doc.chapters.slice().reverse() }, 'ai')
  assert.equal(doc.changes?.at(-1)?.path, 'chapters/order')
  for (let index = 0; index < 100; index++) doc = commitCreator(doc, { ...doc, title: `名称 ${index}` }, 'ai')
  assert.equal(doc.changes?.length, 80)
  assert.ok(creatorChangesContext(doc).length <= 20000)
  const huge = editChapter(doc, doc.activeChapterId, { text: '长'.repeat(100_000) })
  assert.ok(creatorChangesContext(huge).length <= 20000)
  assert.match(creatorChangesContext(huge), /长度限制/)
})
