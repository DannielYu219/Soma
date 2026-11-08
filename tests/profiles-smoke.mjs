import http from 'node:http'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'

const directory = await mkdtemp(`${tmpdir()}/soma-profiles-ui-`)
const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-one' }, { id: 'model-two' }] })); return }
  let body=''; req.on('data',chunk=>body+=chunk);req.on('end',()=>{ res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'在，我们继续聊。'}}]})+'\n\ndata: [DONE]\n\n') })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${upstream.address().port}`
const app = createApp({ ...loadConfig({}), openaiBaseUrl: `${base}/v1` }, directory)
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
const targetUrl = `http://127.0.0.1:${app.address().port}/`
// Isolated, headless browser: never connects to or activates a user's window.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const profile = await mkdtemp(`${tmpdir()}/soma-smoke-`)
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, targetUrl,
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
    if (tabs.some(tab => tab.url.startsWith(targetUrl))) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const target = tabs.find(tab => tab.url.startsWith(targetUrl))
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
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `if(!localStorage.getItem('soma-service-settings'))localStorage.setItem('soma-service-settings',JSON.stringify({provider:'openai-compatible',baseUrl:'${base}/v1',model:'model-one',apiKey:'test-key'}))` })
  await cdp('Page.reload')
  await wait('document.querySelector("#message-input")')
  await click('.composer-menu'); await wait('document.querySelector(".menu-surface")')
  await evaluate('Array.from(document.querySelectorAll(".menu-row")).find(e=>e.innerText.includes("模型服务")).click()')
  await wait('document.querySelector(".provider-list")')
  assert.equal(await evaluate('document.querySelectorAll(".provider-list li").length'),1)
  await click('.provider-add'); await wait('document.querySelector(".onboarding-provider")')
  await fill('.onboarding-field input:not([type])', '第二个服务')
  await fill('input[type=url]', base+'/v1'); await fill('.onboarding-secret input','second-key')
  await click('.onboarding-fetch'); await wait('document.querySelector(".model-select-trigger")')
  await evaluate('document.querySelector(".model-select-trigger").click()'); await wait('document.querySelectorAll(".model-select-item").length>=2')
  await evaluate('Array.from(document.querySelectorAll(".model-select-item")).find(e=>e.innerText.includes("model-two")).click()')
  await click('.onboarding-actions button'); await wait('document.querySelector("#message-input")')
  await fill('#message-input','你好'); await click('[aria-label="发送"]'); await wait('document.querySelector(".assistant-message")')
  await click('.history-trigger'); await wait('document.querySelector(".history-new")')
  await click('.history-new'); await wait('document.querySelectorAll(".message").length===0')
  await fill('#message-input','尚未发送的草稿')
  await evaluate('new Promise(resolve=>setTimeout(resolve,800))')
  await evaluate('Promise.all(["soma-service-profiles","soma-service-settings","soma-conversations","soma-active-conversation"].map(k=>localStorage.removeItem(k)))')
  await cdp('Page.reload'); await wait('document.querySelector("#message-input")')
  assert.equal(await evaluate('document.querySelector("#message-input").value'),'尚未发送的草稿')
  await click('.composer-menu'); await wait('document.querySelector(".menu-surface")')
  await evaluate('Array.from(document.querySelectorAll(".menu-row")).find(e=>e.innerText.includes("模型服务")).click()')
  await wait('document.querySelectorAll(".provider-list li").length===2')
  const state=await evaluate('fetch("/api/state").then(r=>r.json())')
  assert.equal(state.values['soma-service-profiles'].profiles.length,2)
  assert.equal(state.values['soma-service-profiles'].profiles.find(p=>p.id===state.values['soma-service-profiles'].activeId).name,'第二个服务')
  await click('.provider-list li:first-child .provider-select'); await wait('document.querySelector("#message-input")')
  await evaluate('new Promise(resolve=>setTimeout(resolve,300))')
  await cdp('Page.reload'); await wait('document.querySelector("#message-input")')
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("soma-service-settings")).model'),'model-one')
  console.log('PASS: multiple providers, durable settings restore after local storage loss, provider switch, new chat and drafts')
} finally { socket?.close(); chrome.kill('SIGTERM'); app.closeAllConnections(); upstream.closeAllConnections(); await new Promise(r=>app.close(r)); await new Promise(r=>upstream.close(r)); }
