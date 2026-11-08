// One command for development: the backend on SOMA_BACKEND_PORT (default 8787) and the Vite UI on 5173.
// Vite proxies /v1 and /health to the backend, so the page talks to one origin, as it does in production.
import { spawn } from 'node:child_process'

const children = [
  spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, SOMA_STATIC_DIR: '' },
  }),
  spawn('node_modules/.bin/vite', ['--host', '0.0.0.0', '--port', '5173', '--strictPort'], {
    stdio: 'inherit',
  }),
]

let stopping = false
function stop(code) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  process.exitCode = code ?? 0
}

for (const child of children) {
  child.on('exit', code => stop(code))
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
