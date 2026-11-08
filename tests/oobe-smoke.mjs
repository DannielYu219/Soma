import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import http from 'node:http'
const requests=[]
const upstream=http.createServer((req,res)=>{
 requests.push({url:req.url,headers:req.headers});
 res.setHeader('content-type','application/json');
 if(req.headers.authorization==='Bearer bad-key'){res.writeHead(401);res.end('{}');return}
 if(req.url.startsWith('/v1/models'))res.end(JSON.stringify({data:[{id:'model-one',display_name:'模型一'},{id:'model-two',display_name:'模型二'}],has_more:false}));
 else{res.writeHead(404);res.end('{}')}
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${upstream.address().port}`;
const stateDirectory=await mkdtemp(`${tmpdir()}/soma-state-test-`);
const app=createApp({...loadConfig({}),openaiBaseUrl:base+'/v1',anthropicBaseUrl:base},stateDirectory);
await new Promise(r=>app.listen(0,'127.0.0.1',r));
const targetUrl=`http://127.0.0.1:${app.address().port}/`;
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
  await wait('document.querySelector(".onboarding-view")')
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'欢迎来到 Soma')
  assert.equal(await evaluate('Boolean(document.querySelector("#message-input"))'),false)
  assert.equal(await evaluate('localStorage.getItem("soma-service-settings")'),null)
  assert.ok(!(await evaluate('document.body.innerText')).includes('本地后端'))
  await shot('soma-oobe-welcome')
  await fill('.onboarding-field input[type=url]',base+'/v1')
  await fill('.onboarding-secret input','bad-key')
  await click('.onboarding-fetch')
  await wait('document.querySelector("[role=alert]")')
  assert.match(await evaluate('document.querySelector("[role=alert]").textContent'),/拒绝/)
  await fill('.onboarding-secret input','test-key')
  await click('.onboarding-fetch')
  await wait('document.querySelector(".model-select-trigger")')
  await click('.model-select-trigger')
  await wait('document.querySelectorAll(".model-select-item").length >= 2')
  assert.equal(await evaluate('document.querySelector(".onboarding-actions button").disabled'),true)
  await evaluate('Array.from(document.querySelectorAll(".model-select-item")).find(e=>e.innerText.includes("model-two")).click()')
  await wait('document.querySelector(".model-select-trigger").innerText.includes("model-two")')
  await wait('!document.querySelector(".onboarding-actions button").disabled')
  await shot('soma-oobe-models')
  await click('.onboarding-actions button')
  await wait('document.querySelector("#message-input")')
  const saved=await evaluate('JSON.parse(localStorage.getItem("soma-service-settings"))')
  assert.equal(saved.model,'model-two'); assert.equal(saved.apiKey,'test-key'); assert.equal('backendUrl' in saved,false)
  await cdp('Page.reload')
  await wait('document.querySelector("#message-input")')
  await click('.composer-menu')
  await wait('document.querySelector(".menu-surface")')
  await evaluate('Array.from(document.querySelectorAll(".menu-row")).find(e=>e.innerText.includes("模型服务")).click()')
  await wait('document.querySelector(".onboarding-view")')
  assert.equal(await evaluate('document.querySelector("h1").textContent'),'模型服务')
  await click('[aria-label^="编辑服务："]')
  await wait('document.querySelector(".onboarding-provider")')
  assert.ok(!(await evaluate('document.body.innerText')).includes('本地后端'))
  await click('.onboarding-provider:nth-child(2)')
  assert.equal(await evaluate('document.querySelector(".onboarding-secret input").type'),'password')
  await fill('.onboarding-field input[type=url]',base)
  await fill('.onboarding-secret input','anthropic-key')
  await click('.onboarding-fetch')
  await wait('document.querySelector(".model-select-trigger")')
  await click('.model-select-trigger')
  await wait('document.querySelectorAll(".model-select-item").length >= 1')
  assert.ok(requests.some(r=>r.headers['x-api-key']==='anthropic-key'))
  await evaluate('Array.from(document.querySelectorAll(".model-select-popup:not([data-closed]) .model-select-item")).find(e=>e.innerText.includes("model-one")).click()')
  await wait('document.querySelector(".model-select-trigger").innerText.includes("model-one")')
  await click('.onboarding-actions button')
  await wait('document.querySelector("#message-input")')
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]})
  await evaluate(`Promise.all(['soma-service-profiles','soma-service-settings'].map(key=>fetch('/api/state',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({key,value:null})}))).then(()=>{localStorage.removeItem('soma-service-profiles');localStorage.removeItem('soma-service-settings')})`)
  await cdp('Page.reload')
  await wait('document.querySelector(".onboarding-view")')
  await wait('document.documentElement.dataset.theme === "dark"')
  await shot('soma-oobe-dark')
  console.log('PASS: isolated headless OOBE initial welcome, errors, model enumeration, explicit model selection, save/reload, provider switch, no backend settings, dark mode')
} finally { socket?.close(); chrome.kill('SIGTERM'); app.closeAllConnections(); upstream.closeAllConnections(); await new Promise(r=>app.close(r)); await new Promise(r=>upstream.close(r)); }
