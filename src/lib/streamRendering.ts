export const STREAM_MARKDOWN_LIMIT = 12_000
export const STREAM_RENDER_INTERVAL_MS = 120

export function getStreamRenderMode(text: string, streaming: boolean): 'markdown' | 'plain' {
  return streaming && text.length > STREAM_MARKDOWN_LIMIT ? 'plain' : 'markdown'
}
