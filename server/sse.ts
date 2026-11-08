import type { ServerResponse } from 'node:http'

export interface SseBlock { event?: string; data: string }

function parseBlock(raw: string): SseBlock | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return data.length ? { event, data: data.join('\n') } : null
}

/** Reads an upstream SSE body block by block. Works across chunk boundaries. */
export async function* readSse(response: Response): AsyncGenerator<SseBlock> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let pendingCR = false
  function normalize(value: string, final: boolean): string {
    let text = (pendingCR ? '\r' : '') + value
    pendingCR = !final && text.endsWith('\r')
    if (pendingCR) text = text.slice(0, -1)
    return text.replace(/\r\n?/g, '\n')
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += normalize(decoder.decode(value, { stream: !done }), done)
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const block = parseBlock(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 2)
        if (block) yield block
        cut = buffer.indexOf('\n\n')
      }
      if (done) break
    }
    const tail = parseBlock(buffer)
    if (tail) yield tail
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function parseJson(text: string): any {
  try { return JSON.parse(text) } catch { return null }
}

export function safeParse(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

export function writeSseHead(res: ServerResponse): void {
  if (res.headersSent) return
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

/** Chat Completions style: data-only frames. */
export function sseData(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

/** Responses and Messages style: named events with a matching `type` field. */
export function sseEvent(res: ServerResponse, name: string, payload: Record<string, unknown>): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`)
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
