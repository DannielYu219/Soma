import assert from 'node:assert/strict'
import test from 'node:test'
import { getStreamRenderMode, STREAM_MARKDOWN_LIMIT, STREAM_RENDER_INTERVAL_MS } from '../src/lib/streamRendering.ts'

test('active streams use Markdown only while still below the parse threshold', () => {
  assert.equal(getStreamRenderMode('', true), 'markdown')
  assert.equal(getStreamRenderMode('x'.repeat(STREAM_MARKDOWN_LIMIT), true), 'markdown')
  assert.equal(getStreamRenderMode('x'.repeat(STREAM_MARKDOWN_LIMIT + 1), true), 'plain')
})

test('completed content always returns to full Markdown regardless of size', () => {
  assert.equal(getStreamRenderMode('x'.repeat(STREAM_MARKDOWN_LIMIT * 10), false), 'markdown')
})

test('stream rendering is paced below the display refresh rate', () => {
  assert.ok(STREAM_RENDER_INTERVAL_MS >= 100)
  assert.ok(STREAM_RENDER_INTERVAL_MS <= 250)
})
