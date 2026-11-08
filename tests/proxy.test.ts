import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { loadConfig } from '../server/config.ts'
import { startSearxng } from '../server/searxng.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const python = join(root, '.searxng/venv/bin/python')
const execute = promisify(execFile)

test('proxy discovery and installed SearXNG network integration', { timeout: 60_000 }, async () => {
  const result = await execute(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'proxy_test.py', '-v'], {
    cwd: root,
    timeout: 55_000,
  })
  assert.match(result.stderr, /OK\s*$/)
  assert.doesNotMatch(result.stderr, /skipped=/, 'integration requires the installed SearXNG venv')
})

test('Node startup uses shared proxy launcher and exits on stdin EOF', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'soma-proxy-node-'))
  const packagePath = join(directory, 'searx')
  let child: ReturnType<typeof startSearxng> | undefined
  try {
    await mkdir(packagePath)
    await writeFile(join(packagePath, '__init__.py'), "settings = {'outgoing': {'proxies': {}}}\n")
    await writeFile(join(packagePath, 'webapp.py'), "import threading\nfrom searx import settings\nassert settings['outgoing']['proxies']['https://'] == 'socks5h://127.0.0.1:1082'\nprint('NODE_PROXY_READY', flush=True)\nthreading.Event().wait()\n")
    const saved = process.env.SOMA_SEARXNG_PROXY
    try {
      process.env.SOMA_SEARXNG_PROXY = 'socks5://127.0.0.1:1082'
      const cfg = loadConfig()
      child = startSearxng({ ...cfg, searxngDir: directory, searxngPython: python })
    } finally {
      if (saved === undefined) delete process.env.SOMA_SEARXNG_PROXY
      else process.env.SOMA_SEARXNG_PROXY = saved
    }
    const running = child
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error('Node launcher did not become ready')), 8_000)
      running.stdout!.on('data', chunk => {
        output += chunk.toString()
        if (output.includes('NODE_PROXY_READY')) {
          clearTimeout(timeout)
          resolve()
        }
      })
      running.once('error', error => { clearTimeout(timeout); reject(error) })
      running.once('exit', code => { clearTimeout(timeout); reject(new Error(`Launcher exited early: ${code}`)) })
    })
    const exited = once(running, 'exit', { signal: AbortSignal.timeout(5_000) })
    running.stdin!.end()
    const [code, signal] = await exited
    assert.equal(code, 0)
    assert.equal(signal, null)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    // mkdtemp returned this exact private directory; never remove a computed project path.
    assert.ok(directory.startsWith(join(tmpdir(), 'soma-proxy-node-')))
    await rm(directory, { recursive: true, force: true })
  }
})
