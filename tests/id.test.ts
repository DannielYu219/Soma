import assert from 'node:assert/strict'
import test from 'node:test'
import { newId } from '../src/lib/id.ts'

test('IDs work on LAN HTTP without the secure-context randomUUID API', () => {
  const original = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: original.getRandomValues.bind(original) } })
  try {
    const ids = Array.from({ length: 100 }, () => newId())
    assert.equal(new Set(ids).size, ids.length)
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  } finally { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original }) }
})
