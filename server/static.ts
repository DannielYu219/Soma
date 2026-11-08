import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Serves the built web UI from the same origin as the API. Unknown extensionless paths fall back
 * to index.html so client-side routes survive a refresh. Returns false when the request is not for the UI.
 */
export async function serveUi(root: string, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!root) return false
  const base = resolve(root)
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400).end()
    return true
  }
  // Refuse dot segments and NUL bytes outright. normalize() clamps "/../x" to "/x" and would hide the attempt.
  if (decoded.includes('\0') || decoded.split(/[\\/]/).includes('..')) {
    res.writeHead(403).end()
    return true
  }
  const target = resolve(join(base, normalize(decoded)))
  if (target !== base && !target.startsWith(base + sep)) {
    res.writeHead(403).end()
    return true
  }

  let file = target
  if (!(await isFile(file))) {
    if (extname(decoded)) return false
    file = join(base, 'index.html')
  }
  if (!(await isFile(file))) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('界面尚未构建。请先运行 npm run build。')
    return true
  }

  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  // Hashed assets never change, so they can be cached forever. index.html must always be fresh.
  const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
  res.writeHead(200, { 'content-type': type, 'cache-control': cache })
  if (req.method === 'HEAD') { res.end(); return true }
  createReadStream(file).pipe(res)
  return true
}
