import type { ChildProcess } from 'node:child_process'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { startSearxng } from './searxng.ts'

const cfg = loadConfig()
const searxng: ChildProcess | null = cfg.searxngAutostart ? startSearxng(cfg) : null

const server = createApp(cfg)
server.listen(cfg.port, cfg.host, () => {
  console.log(`Soma backend listening on http://${cfg.host}:${cfg.port}`)
  console.log(`Search: ${cfg.searxngUrl}${cfg.searxngAutostart ? ' (autostarted)' : ''}`)
})

function shutdown(): void {
  searxng?.kill()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// The desktop shell holds this process's stdin open. If the shell dies for any reason, the pipe closes
// and the backend exits with it, so no orphaned server keeps the port.
if (process.env.SOMA_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.resume()
  process.stdin.on('end', shutdown)
}
