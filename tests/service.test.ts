import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SERVICE, hasConfiguredService, restoreService } from '../src/lib/service.ts'

test('first launch needs a real saved provider, model and key', () => {
  assert.equal(hasConfiguredService(restoreService(null)), false)
  assert.deepEqual(restoreService('not-json'), DEFAULT_SERVICE)
  assert.equal(hasConfiguredService(restoreService(JSON.stringify({ provider: 'anthropic', baseUrl: 'http://localhost:3000', model: 'claude', apiKey: 'sk-user-key' }))), true)
  assert.equal(hasConfiguredService(restoreService(JSON.stringify({ provider: 'anthropic', model: '', apiKey: 'sk-user-key' }))), false)
  assert.equal(hasConfiguredService(restoreService(JSON.stringify({ provider: 'openai-compatible', model: 'gpt-test' }))), false)
})

test('reasoning effort survives restore and invalid values use the model default', () => {
  for (const reasoningEffort of ['auto', 'low', 'medium', 'high']) {
    assert.equal(restoreService(JSON.stringify({ reasoningEffort })).reasoningEffort, reasoningEffort)
  }
  assert.equal(restoreService(JSON.stringify({ reasoningEffort: 'unsupported' })).reasoningEffort, undefined)
})

test('model cache restores validated entries and timestamp without dropping reasoning/search', () => {
  const restored = restoreService(JSON.stringify({ provider: 'anthropic', model: 'missing-from-list', apiKey: 'key', reasoningEffort: 'high', search: { enabled: false, model: 'fast' }, models: { updatedAt: 1_700_000_000_000, items: [{ id: ' cached ', name: ' Cached ' }, { id: '', name: 'bad' }, { id: 'other', name: 4 }, null] } }))
  assert.deepEqual(restored.models, { updatedAt: 1_700_000_000_000, items: [{ id: 'cached', name: 'Cached' }, { id: 'other', name: 'other' }] })
  assert.equal(restored.model, 'missing-from-list')
  assert.equal(restored.search?.model, 'fast')
  assert.equal(restored.search?.enabled, false)
  assert.equal(restored.reasoningEffort, 'high')
  assert.equal(restoreService(JSON.stringify({ models: { updatedAt: 0, items: [{ id: 'ignored' }] } })).models, undefined)
  assert.equal(restoreService(JSON.stringify({ models: { updatedAt: Date.now(), items: [{ id: 'ignored' }] } })).models?.items[0].id, 'ignored')
})

test('legacy backendUrl is removed from model service configuration', () => {
  const restored = restoreService(JSON.stringify({ provider: 'anthropic', baseUrl: 'http://localhost:3000', backendUrl: 'http://localhost:3000', model: 'my-model', apiKey: 'secret' }))
  assert.equal(restored.baseUrl, 'http://localhost:3000')
  assert.equal('backendUrl' in restored, false)
  assert.equal(restored.apiKey, 'secret')
  assert.equal(restoreService(JSON.stringify({ provider: 'openai-compatible', baseUrl: '/v1', model: 'm', apiKey: 'k' })).baseUrl, '')
})
