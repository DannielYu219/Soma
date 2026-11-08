import assert from 'node:assert/strict'
import test from 'node:test'
import { readSse } from '../server/sse.ts'

test('SSE decoding survives every-byte UTF8 and CRLF fragmentation', async () => {
  const encoder = new TextEncoder()
  const bytes = encoder.encode('event: text\r\ndata: {"delta":"你好"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n')
  let index = 0
  const body = new ReadableStream({ pull(controller) { if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index)); else controller.close() } })
  const frames = []
  for await (const frame of readSse(new Response(body))) frames.push(frame)
  assert.deepEqual(frames, [{ event: 'text', data: '{"delta":"你好"}' }, { event: 'done', data: '{}' }])
})

test('SSE multiline data and comment heartbeats preserve only meaningful frames', async () => {
  const frames = []
  for await (const frame of readSse(new Response(': heartbeat\n\nevent: lines\ndata: first\ndata: second\n\n'))) frames.push(frame)
  assert.deepEqual(frames, [{ event: 'lines', data: 'first\nsecond' }])
})

test('ending a consumer loop cancels the upstream reader', async () => {
  let cancelled = false
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')) }, cancel() { cancelled = true } })
  for await (const frame of readSse(new Response(body))) { assert.equal(frame.data, 'first'); break }
  assert.equal(cancelled, true)
})
