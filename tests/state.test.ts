import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import { StateStore } from '../server/state.ts'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'soma-state-'))
  const cfg = { ...loadConfig({}), staticDir: '', allowedOrigins: [] }
  const server = createApp(cfg, directory)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    directory, url, store: new StateStore(directory),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) },
  }
}

async function request(url: string, method: string, body?: unknown) {
  return fetch(`${url}/api/state`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
}

test('state PUT persists allowlisted values across store and server restarts; null deletes', async () => {
  const h = await setup()
  try {
    const profile = { selected: 'local', nested: [1, null] }
    assert.equal((await request(h.url, 'PUT', { key: 'soma-service-profiles', value: profile })).status, 200)
    assert.equal((await request(h.url, 'PUT', { key: 'soma-service-settings', value: null })).status, 200)
    const restartedStore = new StateStore(h.directory)
    assert.deepEqual(await restartedStore.get(), { 'soma-service-profiles': profile })
    const get = await request(h.url, 'GET')
    assert.deepEqual(await get.json(), { version: 1, values: { 'soma-service-profiles': profile } })
    const file = JSON.parse(await readFile(join(h.directory, 'state.json'), 'utf8'))
    assert.equal(file.version, 1)
  } finally { await h.close() }
})

test('state endpoint rejects unknown keys, invalid bodies and unsupported methods', async () => {
  const h = await setup()
  try {
    assert.equal((await request(h.url, 'PUT', { key: '__proto__', value: { polluted: true } })).status, 400)
    assert.equal((await request(h.url, 'PUT', { key: 'soma-theme' })).status, 400)
    assert.equal((await request(h.url, 'POST')).status, 405)
    const invalid = await fetch(`${h.url}/api/state`, { method: 'PUT', body: '{bad' })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await h.store.get(), {})
  } finally { await h.close() }
})

test('state endpoint enforces the 10 MB request limit', async () => {
  const h = await setup()
  try {
    const response = await fetch(`${h.url}/api/state`, { method: 'PUT', body: `{"key":"soma-theme","value":"${'x'.repeat(10 * 1024 * 1024)}"}` })
    assert.equal(response.status, 413)
  } finally { await h.close() }
})

test('corrupt state is reported without being overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'soma-state-corrupt-'))
  try {
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'state.json')
    await writeFile(file, '{broken', { mode: 0o600 })
    const store = new StateStore(directory)
    await assert.rejects(store.get())
    await assert.rejects(store.put('soma-theme', 'dark'))
    assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('concurrent state updates are serialized without lost keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'soma-state-concurrent-'))
  try {
    const store = new StateStore(directory)
    await Promise.all([
      store.put('soma-theme', 'dark'),
      store.put('soma-active-conversation', 'c-1'),
      store.put('soma-conversations', [{ id: 'c-1' }]),
    ])
    assert.deepEqual(await store.get(), {
      'soma-theme': 'dark',
      'soma-active-conversation': 'c-1',
      'soma-conversations': [{ id: 'c-1' }],
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
