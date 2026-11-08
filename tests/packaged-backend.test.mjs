import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const resources = fileURLToPath(new URL('../build-resources/backend/', import.meta.url))

async function freePort() {
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return port
}

test('relocated backend runs with system-only PATH and exits when its desktop stdin closes', { timeout: 20000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'soma-packaged-backend-test-'))
  let child
  let closed
  let output = ''
  try {
    const relocated = join(temporary, 'Backend Resources')
    const ui = join(temporary, 'Web Resources')
    await mkdir(relocated)
    await mkdir(ui)
    for (const name of ['node', 'server.mjs', 'LICENSE', 'runtime.json']) {
      await copyFile(join(resources, name), join(relocated, name))
    }
    await writeFile(join(ui, 'index.html'), '<!doctype html><title>Packaged Soma</title>')
    const metadata = JSON.parse(await readFile(join(relocated, 'runtime.json'), 'utf8'))
    assert.equal(metadata.node.platform, 'darwin')
    assert.equal(metadata.node.arch, 'arm64')
    assert(metadata.node.dependencies.every(path => path.startsWith('/usr/lib/') || path.startsWith('/System/')))
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    const session = 'packaged-smoke-test-session-not-a-production-secret'
    const cookie = `soma-session=${session}`
    child = spawn(join(relocated, 'node'), [join(relocated, 'server.mjs')], {
      cwd: temporary,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: temporary,
        TMPDIR: temporary,
        SOMA_BACKEND_HOST: '127.0.0.1',
        SOMA_BACKEND_PORT: String(port),
        SOMA_SESSION_TOKEN: session,
        SOMA_STATIC_DIR: ui,
        SOMA_SEARXNG_AUTOSTART: '0',
        SOMA_SEARXNG_URL: 'http://127.0.0.1:1',
        SOMA_EXIT_ON_STDIN_CLOSE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    closed = once(child, 'close')
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    let health
    for (let attempt = 0; attempt < 60; attempt++) {
      assert.equal(child.exitCode, null, `Backend exited early: ${output}`)
      try {
        health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })
        break
      } catch { await delay(100) }
    }
    assert(health, `Backend did not become ready: ${output}`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok', service: 'soma-backend', search: 'unavailable' })
    const unauthorized = await fetch(`${origin}/api/conversation`, { method: 'POST', body: '{}' })
    assert.equal(unauthorized.status, 401)
    await unauthorized.arrayBuffer()
    const bootstrap = await fetch(`${origin}/?session=${session}`, { redirect: 'manual' })
    assert.equal(bootstrap.status, 303)
    assert.equal(bootstrap.headers.get('location'), '/')
    assert.match(bootstrap.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\//)
    await bootstrap.arrayBuffer()
    const validation = await fetch(`${origin}/api/conversation`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
    })
    assert.equal(validation.status, 400)
    assert.match((await validation.json()).error.message, /service/)
    const method = await fetch(`${origin}/api/conversation`, { headers: { cookie } })
    assert.equal(method.status, 405)
    await method.arrayBuffer()
    const page = await fetch(`${origin}/`, { headers: { cookie } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Packaged Soma/)
    // Covers the lifetime contract used by the Rust shell, including accidental shell exit.
    child.stdin.end()
    const [code, signal] = await closed
    assert.equal(code, 0, output)
    assert.equal(signal, null)
    await assert.rejects(fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) }))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await closed
    }
    assert.equal(dirname(await realpath(temporary)), await realpath(tmpdir()))
    assert(temporary.startsWith(join(tmpdir(), 'soma-packaged-backend-test-')))
    await rm(temporary, { recursive: true, force: true })
  }
})
