import assert from 'node:assert/strict'
import test from 'node:test'
import { activeService, deleteProfile, restoreProfiles, upsertProfile } from '../src/lib/profiles.ts'
const settings = { provider: 'anthropic' as const, baseUrl: 'http://localhost:3000', model: 'main', apiKey: 'test-key', search: { enabled: true, model: 'fast' }, models: { items: [{ id: 'cached', name: 'Cached' }], updatedAt: 1_700_000_000_000 } }
test('legacy service migrates once and keeps private configuration per provider', () => {
  const state = restoreProfiles(null, JSON.stringify({ ...settings, backendUrl: 'wrong' }))
  assert.equal(state.profiles.length, 1)
  assert.equal(activeService(state).model, 'main')
  assert.equal('backendUrl' in activeService(state), false)
  const next = upsertProfile(state, { id: 'second', name: '第二个服务', settings: { ...settings, model: 'other', apiKey: 'other-key' } })
  assert.equal(next.profiles.length, 2)
  assert.equal(activeService(next).model, 'other')
  assert.equal(next.profiles[0].settings.search?.model, 'fast')
  assert.deepEqual(next.profiles[0].settings.models, { items: [{ id: 'cached', name: 'Cached' }], updatedAt: 1_700_000_000_000 })
  assert.deepEqual(restoreProfiles(JSON.stringify(next), null), next)
})
test('deleting one provider does not delete others or resurrect the legacy profile', () => {
  const state = upsertProfile(restoreProfiles(null, JSON.stringify(settings)), { id: 'second', name: 'second', settings })
  const next = deleteProfile(state, 'second')
  assert.equal(next.profiles.length, 1)
  assert.equal(next.activeId, next.profiles[0].id)
  const empty = deleteProfile(next, next.activeId)
  assert.equal(restoreProfiles(JSON.stringify(empty), JSON.stringify(settings)).profiles.length, 0)
})
