import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Config } from './config.ts'

const SETTINGS_PATH = fileURLToPath(new URL('./searxng/settings.yml', import.meta.url))
const LAUNCHER_PATH = fileURLToPath(new URL('./searxng/launcher.py', import.meta.url))

/**
 * Runs the pinned SearXNG source tree as a child process bound to 127.0.0.1.
 * Only started when SOMA_SEARXNG_AUTOSTART=1. Otherwise SOMA_SEARXNG_URL points at an instance you run yourself.
 */
export function startSearxng(cfg: Config): ChildProcess {
  const child = spawn(cfg.searxngPython, [LAUNCHER_PATH], {
    cwd: cfg.searxngDir,
    env: {
      ...process.env,
      PYTHONPATH: cfg.searxngDir,
      SOMA_SEARXNG_DIR: cfg.searxngDir,
      SOMA_EXIT_ON_STDIN_CLOSE: '1',
      SEARXNG_SETTINGS_PATH: SETTINGS_PATH,
      SEARXNG_SECRET: process.env.SEARXNG_SECRET || randomBytes(32).toString('hex'),
      SEARXNG_PORT: String(cfg.searxngPort),
      SEARXNG_BIND_ADDRESS: '127.0.0.1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', chunk => process.stdout.write(`[searxng] ${chunk}`))
  child.stderr?.on('data', chunk => process.stderr.write(`[searxng] ${chunk}`))
  child.on('exit', code => console.error(`[searxng] exited with code ${code}`))
  return child
}
