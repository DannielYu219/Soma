import assert from 'node:assert/strict'
import test from 'node:test'
import { demoReply, initialDocument, shorterDocument } from '../src/demo.ts'

test('casual and emotional conversations do not create projects', () => {
  for (const input of ['你好', '今天很累', '下雨了', '我想安静一会儿']) {
    assert.equal(demoReply(input, false).kind, 'conversation')
  }
})
test('talking about writing does not accidentally create a project', () => {
  assert.equal(demoReply('最近没有写作的心情', false).kind, 'conversation')
})
test('an explicit creative request creates a project', () => {
  for (const input of ['写一篇散文', '把它写成一个故事', '写一段文字']) {
    assert.equal(demoReply(input, false).kind, 'creation')
  }
})
test('revision requires an existing project', () => {
  assert.equal(demoReply('再短一点', true).kind, 'revision')
  assert.equal(demoReply('再短一点', false).kind, 'conversation')
  assert.ok(shorterDocument.length < initialDocument.text.length)
})
