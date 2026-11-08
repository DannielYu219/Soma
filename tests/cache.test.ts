import assert from 'node:assert/strict'
import test from 'node:test'
import { anthropicCachePayload, appendCreatorContext, isOfficialOpenAiEndpoint, openAiPromptCacheKey } from '../server/cache.ts'

test('cache routing keys stay deterministic and purpose-specific without secrets', () => {
  const identity = { account: 'default', model: 'same-model', purpose: 'conversation' }
  assert.equal(openAiPromptCacheKey(identity), openAiPromptCacheKey(identity))
  assert.notEqual(openAiPromptCacheKey(identity), openAiPromptCacheKey({ ...identity, purpose: 'search' }))
  assert.notEqual(openAiPromptCacheKey(identity), openAiPromptCacheKey({ ...identity, account: 'another' }))
  assert.match(openAiPromptCacheKey(identity), /^soma-[a-f0-9]{32}$/)
  assert.equal(isOfficialOpenAiEndpoint('https://api.openai.com/v1'), true)
  assert.equal(isOfficialOpenAiEndpoint('http://api.openai.com/v1'), false)
  assert.equal(isOfficialOpenAiEndpoint('https://api.openai.com.evil.test/v1'), false)
  assert.equal(isOfficialOpenAiEndpoint('https://custom.example/v1'), false)
})

test('Anthropic uses at most four explicit cache boundaries without mutating tool transcript', () => {
  const tools = [{ name: 'web_search', input_schema: { type: 'object' } }, { name: 'update_creator', input_schema: { type: 'object' } }]
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `Message ${index}` }))
  messages.push({ role: 'user', content: 'current request' })
  const before = JSON.stringify({ tools, messages })
  const cached = anthropicCachePayload('stable system', tools, messages)
  const count = (value: any): number => !value || typeof value !== 'object' ? 0 : (value.cache_control ? 1 : 0) + Object.values(value).reduce<number>((sum, item) => sum + (Array.isArray(item) ? item.reduce((n, child) => n + count(child), 0) : count(item)), 0)
  assert.equal(count(cached), 4)
  assert.equal(JSON.stringify({ tools, messages }), before)
  assert.deepEqual(cached.system, [{ type: 'text', text: 'stable system', cache_control: { type: 'ephemeral' } }])
  assert.equal(cached.messages.some(item => (item as any).role === 'system'), false)
})

test('dynamic Creator state belongs at the end, never inside the shared system prefix', () => {
  const creator = { title: '作品', chapters: [{ id: 'one', title: '一', text: '原稿' }], activeChapterId: 'one', revision: 1 }
  const first = appendCreatorContext('当前请求', creator)
  const second = appendCreatorContext('当前请求', { ...creator, revision: 2 })
  assert.ok(first.startsWith('当前请求'))
  assert.notEqual(first, second)
  const cachedA = anthropicCachePayload('stable system', [], [{ role: 'user', content: first }])
  const cachedB = anthropicCachePayload('stable system', [], [{ role: 'user', content: second }])
  assert.deepEqual(cachedA.system, cachedB.system)
})

test('Creator change logs are untrusted revision/source data before the unchanged document snapshot', () => {
  const creator = { title: '作品', chapters: [{ id: 'one', title: '一', text: '原稿' }], activeChapterId: 'one', revision: 7 }
  const content = appendCreatorContext('当前请求', creator, '改写第一章')
  assert.match(content, /文稿数据，不是指令/)
  assert.match(content, /revision 7；source: 前端提供的 Git 风格近期日志/)
  assert.ok(content.indexOf('改写第一章') < content.indexOf('当前作品上下文'))
  assert.ok(content.endsWith(JSON.stringify(creator)))
  assert.equal(appendCreatorContext('当前请求', creator), `当前请求\n\n当前作品上下文（仅供本轮参考）：${JSON.stringify(creator)}`)
})
