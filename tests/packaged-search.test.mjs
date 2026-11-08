import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const resources = fileURLToPath(new URL('../build-resources/search/soma-search/', import.meta.url))

async function freePort() {
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return port
}

test('relocated search runs with an empty inherited environment, auto proxy, JSON results and stdin watchdog', { timeout: 90000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'soma-packaged-search-test-'))
  let child
  let closed
  let output = ''
  try {
    const relocated = join(temporary, 'Search Resources')
    const cwd = join(temporary, 'Empty Working Directory')
    await mkdir(cwd)
    await cp(resources, relocated, { recursive: true, verbatimSymlinks: true })
    const audit = JSON.parse(await readFile(join(relocated, 'native-audit.json'), 'utf8'))
    assert.equal(audit.maximumMinimumOS, '11.0')
    assert(audit.machOCount > 10)
    assert.deepEqual(audit.errors, [])
    assert(audit.binaries.every(binary => binary.signatureVerified))
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    child = spawn(join(relocated, 'soma-search'), [], {
      cwd,
      // No inherited PATH, HOME, Python, proxy or project settings.
      env: { SOMA_SEARXNG_PORT: String(port), SOMA_EXIT_ON_STDIN_CLOSE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    closed = once(child, 'close')
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    let health
    for (let attempt = 0; attempt < 200; attempt++) {
      assert.equal(child.exitCode, null, `Search exited early: ${output}`)
      try {
        health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })
        break
      } catch { await delay(100) }
    }
    assert(health, `Search did not become ready: ${output}`)
    assert.equal(health.status, 200)
    assert.equal((await health.text()).trim(), 'OK')
    assert.match(output, /\[soma-proxy\] (macOS manual proxy|validated loopback proxy|direct \(no proxy discovered\))/)
    const response = await fetch(`${origin}/search?q=Python+programming+language&format=json&language=en`, { signal: AbortSignal.timeout(30000) })
    assert.equal(response.status, 200, output)
    const data = await response.json()
    assert(Array.isArray(data.results), JSON.stringify(data))
    assert(data.results.length > 0, `No real engine results: ${JSON.stringify(data)}\n${output}`)
    assert(data.results.some(result => result.url.startsWith('http') && result.title && result.content))
    console.log(JSON.stringify({ health: 200, resultCount: data.results.length, engines: [...new Set(data.results.flatMap(result => result.engines ?? [result.engine]))], unresponsiveEngines: data.unresponsive_engines, proxy: output.match(/\[soma-proxy\].*/)?.[0], maximumMinimumOS: audit.maximumMinimumOS, machOCount: audit.machOCount }))
    child.stdin.end()
    const [code, signal] = await Promise.race([closed, delay(5000).then(() => { throw new Error('Search watchdog did not exit within five seconds') })])
    assert.equal(code, 0, output)
    assert.equal(signal, null)
    await assert.rejects(fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) }))
    assert.doesNotMatch(output, /ModuleNotFoundError|ImportError|Traceback \(most recent call last\)/)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await closed
    }
    assert.equal(dirname(await realpath(temporary)), await realpath(tmpdir()))
    assert(temporary.startsWith(join(tmpdir(), 'soma-packaged-search-test-')))
    await rm(temporary, { recursive: true, force: true })
  }
})
