// Isolated headless integration test: real UI -> Soma backend -> deterministic upstream.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'

const payloads = []
const upstream = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => raw += chunk)
  req.on('end', () => {
    payloads.push(JSON.parse(raw))
    res.setHeader('content-type', 'text/event-stream')
    const delta = value => res.write(`data: ${JSON.stringify({ choices: [{ delta: value }] })}\n\n`)
    delta({ reasoning_content: '先核实来源，再整理重点。' })
    setTimeout(() => {
      if (res.destroyed) return
      delta({ content: '## 今日摘要\n\n**重点新闻**\n\n1. 第一项\n2. 第二项\n\n[来源](https://example.com/news)\n\n```js\nconst answer = 42\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 新闻 | 已核实 |' })
      res.end('data: [DONE]\n\n')
    }, 1800)
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const directory = await mkdtemp(`${tmpdir()}/soma-reply-ui-`)
const app = createApp(loadConfig({}), directory)
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
const targetUrl = `http://127.0.0.1:${app.address().port}/`
const service = { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'reasoning-test', apiKey: 'test-key' }
const profile = await mkdtemp(`${tmpdir()}/soma-reply-chrome-`)
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, targetUrl], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error('Chrome startup timeout')), 15000)
    chrome.stderr.on('data', chunk => {
      output += chunk
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    chrome.once('error', reject)
  })
  const host = new URL(endpoint).host
  let target
  for (let i = 0; i < 50 && !target; i++) {
    target = (await (await fetch(`http://${host}/json`)).json()).find(tab => tab.url.startsWith(targetUrl))
    if (!target) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(target)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data)
    const request = pending.get(result.id)
    if (request) { pending.delete(result.id); result.error ? request.reject(result.error) : request.resolve(result.result) }
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = async expression => {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      try { if (await evaluate(`Boolean(${expression})`)) return } catch {}
      await new Promise(resolve => setTimeout(resolve, 70))
    }
    throw new Error(`Timeout: ${expression}`)
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill = text => evaluate(`(() => { const el = document.querySelector('#message-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', {bubbles: true})); })()`)
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `if (!localStorage.getItem('soma-service-settings')) localStorage.setItem('soma-service-settings', ${JSON.stringify(JSON.stringify(service))}); localStorage.setItem('soma-theme','dark');` })
  await cdp('Page.reload')
  await wait('document.querySelector("#message-input")')
  await click('.composer-menu')
  await wait('document.querySelector("#reasoning-effort")')
  await evaluate(`(() => { const el = document.querySelector('#reasoning-effort'); el.value='high'; el.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await wait('JSON.parse(localStorage.getItem("soma-service-settings")).reasoningEffort === "high"')
  await click('.composer-menu')
  await fill('但是按照莫里斯·拉威尔的说法就是，这只是在想象一个遥远时代的公主的场面，所以只是淡淡的忧伤，而不是真的悼亡。'.repeat(2))
  await click('[aria-label="发送"]')
  await wait('document.querySelector(".presence")?.innerText.includes("思考")')
  await wait('document.querySelector(".reasoning-disclosure")')
  assert.equal(await evaluate('document.querySelector(".reasoning-disclosure").open'), false)
  await click('.reasoning-disclosure summary')
  assert.equal(await evaluate('document.querySelector(".reasoning-disclosure").open'), true)
  assert.equal(await evaluate('document.querySelector(".reasoning-content").innerText.includes("先核实来源")'), true)
  await wait('document.querySelector(".assistant-message table") && !document.querySelector(".presence")')
  assert.equal(payloads[0].reasoning_effort, 'high')
  assert.equal(await evaluate('document.querySelector(".assistant-message h2").textContent'), '今日摘要')
  assert.equal(await evaluate('document.querySelector(".assistant-message strong").textContent'), '重点新闻')
  assert.equal(await evaluate('document.querySelectorAll(".assistant-message ol li").length'), 2)
  assert.equal(await evaluate('document.querySelector(".assistant-message pre code").textContent.includes("42")'), true)
  assert.equal(await evaluate('document.querySelector(".assistant-message a").href'), 'https://example.com/news')
  assert.equal(await evaluate('document.querySelectorAll(".new-conversation").length'), 0)
  await click('.history-trigger')
  await wait('Math.abs(document.querySelector(".history-surface").getBoundingClientRect().height - (innerHeight - 36)) < 1')
  const historyScreenshot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL('../artifacts/history-full-height.png', import.meta.url), Buffer.from(historyScreenshot.data, 'base64'))
  await click('.history-trigger')
  await wait('Math.abs(document.querySelector(".history-surface").getBoundingClientRect().height - 50) < 1')
  await evaluate(`(() => {
    const node = document.querySelector('.assistant-message > .markdown');
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  })()`)
  const selectionLayout = await evaluate(`(() => {
    const scroll = document.querySelector('.conversation-scroll');
    const reply = document.querySelector('.message.assistant');
    const box = reply.getBoundingClientRect();
    return {padding: parseFloat(getComputedStyle(scroll).paddingLeft), left:box.left, right:box.right, overflow:getComputedStyle(reply).overflowX, text:getSelection().toString()};
  })()`)
  assert.ok(selectionLayout.padding >= 32 && selectionLayout.padding < 160)
  assert.ok(selectionLayout.left >= 32 && selectionLayout.right <= 1248)
  const bubbleLayout = await evaluate(`(() => { const bubble=document.querySelector('.user-message'); const text=bubble.querySelector('p'); return {multi:bubble.classList.contains('multi-line'), fits:text.scrollWidth <= text.clientWidth + 1, width:document.querySelector('.conversation').clientWidth}; })()`)
  assert.ok(bubbleLayout.width >= 1000)
  assert.equal(bubbleLayout.multi, true)
  assert.equal(bubbleLayout.fits, true)
  assert.equal(selectionLayout.overflow, 'clip')
  assert.ok(selectionLayout.text.includes('今日摘要'))
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL('../artifacts/reply-selection-layout.png', import.meta.url), Buffer.from(screenshot.data, 'base64'))
  await evaluate('getSelection().removeAllRanges()')
  await wait('JSON.parse(localStorage.getItem("soma-conversations"))?.[0]?.messages.some(m => m.reasoning)')
  await cdp('Page.reload')
  await wait('document.querySelector(".reasoning-disclosure")')
  assert.equal(await evaluate('document.querySelector(".reasoning-content").textContent.includes("先核实来源")'), true)
  await click('.composer-menu')
  await wait('document.querySelector("#reasoning-effort")?.value === "high"')
  await click('.composer-menu')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await wait('document.documentElement.clientWidth === 390')
  await wait('document.documentElement.scrollWidth <= 390')
  await fill('停止这次回应')
  await click('[aria-label="发送"]')
  await wait('document.querySelector(".presence")')
  await click('[aria-label="停止回应"]')
  await wait('!document.querySelector(".presence") && !document.querySelector(".send-button").getAttribute("aria-label").includes("停止")')
  await click('.history-trigger')
  await wait('document.querySelector(".history-actions")')
  assert.equal(await evaluate('document.querySelectorAll(".history-entry").length'), 1)
  await click('.history-actions button[aria-label^="复制会话"]')
  await wait('document.querySelector(".history-notice")?.innerText.match(/复制|剪贴板/)')
  await cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: profile })
  await click('.history-actions button[aria-label^="导出会话"]')
  await wait('document.querySelector(".history-notice")?.innerText.includes("导出")')
  let exported
  for (let attempt = 0; attempt < 40; attempt++) {
    const files = await readdir(profile)
    exported = files.find(file => file.endsWith('.md'))
    if (exported) break
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  assert.ok(exported, 'Markdown transcript should download')
  const transcript = await readFile(`${profile}/${exported}`, 'utf8')
  assert.ok(transcript.includes('## 你') && transcript.includes('## Soma'))
  assert.ok(transcript.includes('先核实来源') && transcript.includes('今日摘要'))
  const savedBefore = await evaluate('JSON.parse(localStorage.getItem("soma-conversations"))?.length')
  await click('.history-action.history-delete')
  assert.equal(await evaluate('document.querySelectorAll(".history-entry").length'), 1)
  await wait('document.querySelector(".history-delete.confirm")')
  await click('.history-action.history-delete.confirm')
  await wait('document.querySelectorAll(".history-entry").length === 0 && document.querySelectorAll(".message").length === 0')
  await wait('JSON.parse(localStorage.getItem("soma-conversations"))?.length === 0')
  await wait('fetch("/api/state").then(r=>r.json()).then(d=>d.values["soma-conversations"]?.length === 0)')
  assert.ok(savedBefore > 0)
  console.log('PASS: active conversation deletion confirms, clears history and persists without resurrection')
  console.log('PASS: Markdown DOM, live reasoning/status, expand/collapse, effort payload and persistence, history restore, mobile overflow, stop cleanup')
} finally {
  socket?.close()
  chrome.kill('SIGTERM')
  app.closeAllConnections(); upstream.closeAllConnections()
  await new Promise(resolve => app.close(resolve))
  await new Promise(resolve => upstream.close(resolve))
}
