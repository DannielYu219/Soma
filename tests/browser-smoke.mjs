// Isolated, headless browser: never connects to or activates a user's window.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const profile = await mkdtemp(`${tmpdir()}/soma-smoke-`)
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'http://127.0.0.1:5173/',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket
const pending = new Map()
let id = 0
try {
  const endpoint = await new Promise((resolve, reject) => {
    let text = ''
    const timeout = setTimeout(() => reject(new Error('Headless Chrome startup timeout')), 15000)
    chrome.stderr.on('data', chunk => {
      text += chunk.toString()
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    chrome.once('error', reject)
  })
  const host = new URL(endpoint).host
  let tabs = []
  for (let attempt = 0; attempt < 50; attempt++) {
    tabs = await (await fetch(`http://${host}/json`)).json()
    if (tabs.some(tab => tab.url.startsWith('http://127.0.0.1:5173'))) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const target = tabs.find(tab => tab.url.startsWith('http://127.0.0.1:5173'))
  if (!target) throw new Error(`Demo tab not found: ${JSON.stringify(tabs)}`)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data)
    const callback = pending.get(result.id)
    if (callback) { pending.delete(result.id); result.error ? callback.reject(result.error) : callback.resolve(result.result) }
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  const wait = async expression => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      try { if (await evaluate(`Boolean(${expression})`)) return } catch { /* Navigation replaces the context. */ }
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    throw new Error(`Timed out: ${expression}; ${await evaluate('document.body.innerText')}`)
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill = (selector, text) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e instanceof HTMLInputElement)Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});else Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const shot = async name => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
    await writeFile(new URL(`../artifacts/${name}.png`, import.meta.url), Buffer.from(data, 'base64'))
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  socket.addEventListener('message', event => {
    const payload = JSON.parse(event.data)
    if (payload.method === 'Runtime.exceptionThrown') console.error('Browser exception:', JSON.stringify(payload.params))
  })
  await wait("document.querySelector('#message-input')")
  assert.equal(await evaluate('document.querySelectorAll("h1").length'), 0)
  assert.equal(await evaluate('Math.round(document.querySelector(".composer").getBoundingClientRect().height)'), 50)
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#message-input")).fontSize'), '16px')
  await shot('soma-capsule-desktop')
  await fill('#message-input', '今天有一点累，想随便聊聊')
  await click('[aria-label="发送"]')
  await wait('document.querySelectorAll(".assistant-message").length===1')
  assert.equal(await evaluate('document.querySelectorAll(".project-link").length'), 0)
  // 气泡与输入框同源：同样的填充、同样的阴影，但没有描边。
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".user-message")).borderTopWidth'), '0px')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".user-message")).backgroundColor'), await evaluate('getComputedStyle(document.querySelector(".composer")).backgroundColor'))
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".user-message")).boxShadow'), await evaluate('getComputedStyle(document.querySelector(".composer")).boxShadow'))
  // 单行气泡是胶囊。
  assert.equal(await evaluate('document.querySelector(".user-message").classList.contains("single-line")'), true)
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".user-message")).borderRadius'), '999px')
  // 换行之后变成圆角矩形，和输入框多行时同一规则。
  await fill('#message-input', '这是一段比较长的话，用来确认气泡在换行之后会从胶囊变成圆角矩形，而不是被继续拉成一根很长的管子。')
  await click('[aria-label="发送"]')
  await wait('document.querySelectorAll(".user-message").length===2')
  await wait('document.querySelectorAll(".user-message.multi-line").length===1')
  assert.equal(await evaluate('getComputedStyle(document.querySelectorAll(".user-message")[1]).borderRadius'), '26px')
  await evaluate('new Promise(r=>setTimeout(r,500))')
  await shot('soma-bubbles')
  await wait('document.querySelectorAll(".assistant-message").length===2')
  await fill('#message-input', '写一篇散文')
  await click('[aria-label="发送"]')
  await wait('document.querySelector(".project-link")')
  await evaluate('new Promise(r=>setTimeout(r,650))')
  await shot('soma-minimal-conversation')
  await click('.project-link')
  await wait('document.querySelector("#document-editor")')
  await fill('#document-editor', '这是一段手动修改的文字。')
  await click('.back-button')
  await wait('document.querySelector(".project-access")')
  await click('.project-access')
  await wait('document.querySelector("#document-editor")')
  assert.equal(await evaluate('document.querySelector("#document-editor").value'), '这是一段手动修改的文字。')
  await shot('soma-minimal-project')
  await click('.back-button')
  await wait('document.querySelector(".composer-menu")')

  // 记忆：只有这次对话的内容，且可以逐条忘记。
  await evaluate('document.querySelector(".memory-access").click()')
  await wait('document.querySelector(".memory-canvas")')
  const memoryCount = await evaluate('document.querySelectorAll(".memory-list li").length')
  assert.ok(memoryCount >= 3, 'memory should hold this conversation only, got ' + memoryCount)
  assert.equal(await evaluate('document.querySelector(".memory-list li button .memory-text").textContent.length > 0'), true)
  await evaluate('new Promise(r=>setTimeout(r,400))')
  await shot('soma-memory')
  await click('.memory-list li button')
  await wait('document.querySelector(".memory-detail")')
  await click('.memory-forget')
  await wait(`document.querySelectorAll(".memory-list li").length === ${memoryCount - 1}`)
  await click('.back-button')
  await wait('document.querySelector(".composer-menu")')

  // History grows from its circle; switching preserves the project and scoped memories.
  const originalConversation = await evaluate('document.querySelector(".conversation").innerText')
  await click('.history-trigger')
  await wait('document.querySelector(".history-entry")')
  await evaluate('new Promise(r=>setTimeout(r,650))')
  assert.equal(await evaluate('Math.round(document.querySelector(".history-surface").getBoundingClientRect().width)'), 344)
  await shot('soma-history-open')
  await click('.history-new')
  await wait('document.querySelector(".empty")')
  assert.equal(await evaluate('document.querySelectorAll(".message").length'), 0)
  await wait('document.querySelector(".project-access") === null')
  await fill('#message-input', '你好，这是第二段对话')
  await click('[aria-label="发送"]')
  await wait('document.querySelectorAll(".assistant-message").length===1')
  await click('.history-trigger')
  await wait('document.querySelectorAll(".history-entry").length===2')
  await click('.history-entry:not([aria-current])')
  await wait('document.querySelector(".project-access")')
  assert.equal(await evaluate('document.querySelector(".conversation").innerText'), originalConversation)
  await click('.project-access')
  await wait('document.querySelector("#document-editor")')
  assert.equal(await evaluate('document.querySelector("#document-editor").value'), '这是一段手动修改的文字。')
  await click('.back-button')
  await wait('document.querySelector(".history-trigger")')
  await click('.history-trigger')
  await wait('document.querySelector("#conversation-history")')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await wait('document.querySelector(".history-trigger").getAttribute("aria-expanded")==="false"')
  await wait('document.querySelector(".composer-menu")')
  await click('.composer-menu')
  await wait('document.querySelector(".menu-surface")')
  await click('.menu-row')
  await wait('document.querySelector(".empty")')

  // This legacy fixture targets demo-only interactions. Current provider/OOBE coverage lives in oobe-smoke.mjs.
  await click('.composer-menu')
  await wait('document.querySelector(".menu-surface")')
  await evaluate('Array.from(document.querySelectorAll(".menu-row")).find(e=>e.innerText.includes("模型服务")).click()')
  await wait('document.querySelector(".onboarding-view")')
  await shot('soma-service-settings')
  await click('.back-button')
  await wait('document.querySelector(".composer-menu")')

  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await fill('#message-input', '第一行\n第二行\n第三行\n第四行')
  await wait('document.querySelector(".composer.multiline")')
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'))
  assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), true)
  await wait('document.querySelector(".reduce-motion") !== null')
  await click('.composer-menu')
  await wait('document.querySelector(".menu-surface")')
  await shot('soma-minimal-mobile-multiline')

  // 跟随系统：系统切深色，界面应自动跟着变，不需要任何操作。
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await wait('document.documentElement.dataset.theme === "dark"')
  assert.equal(await evaluate('matchMedia("(prefers-color-scheme: dark)").matches'), true)
  assert.equal(await evaluate('localStorage.getItem("soma-theme")'), null)
  await evaluate('new Promise(r=>setTimeout(r,450))')
  await shot('soma-dark-empty')
  await click('.composer-menu')
  await wait('document.querySelector(".menu-surface")')
  await shot('soma-dark-menu')
  await click('.theme-seg button:nth-child(2)')
  await wait('document.documentElement.dataset.theme === "light"')
  await click('.theme-seg button:nth-child(3)')
  await wait('document.documentElement.dataset.theme === "dark"')
  assert.equal(await evaluate('localStorage.getItem("soma-theme")'), 'dark')
  await click('.theme-seg button:nth-child(1)')
  await wait('localStorage.getItem("soma-theme") === null')
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await wait('document.documentElement.dataset.theme === "light"')

  console.log('PASS: clean entry, conversation, project, reset, mobile multiline, reduced motion, system dark mode; no visible browser used.')
} finally {
  socket?.close()
  chrome.kill('SIGTERM')
}
