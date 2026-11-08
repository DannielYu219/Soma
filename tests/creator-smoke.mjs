import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import http from 'node:http'
const upstream = http.createServer((req,res) => {
 let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
  const body=JSON.parse(raw); res.setHeader('content-type','text/event-stream');
  const tool=body.messages?.find(m=>m.role==='tool');
  if(!tool && body.messages?.some(m=>m.content?.includes('写开头'))){
   const doc={title:'雨停以前',chapters:[{id:'opening',title:'第一章',text:'雨落在窗沿上。'}],activeChapterId:'opening',revision:1};
   res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'edit1',type:'function',function:{name:'update_creator',arguments:JSON.stringify({document:doc})}}]}}]})+'\n\ndata: [DONE]\n\n');
  }else { res.write('data: '+JSON.stringify({choices:[{delta:{content:'我把开头放进文稿了。'}}]})+'\n\n'); setTimeout(()=>res.end('data: [DONE]\n\n'),30); }
 });
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const stateDirectory=await mkdtemp(`${tmpdir()}/soma-state-test-`);
const app=createApp({...loadConfig({}),openaiBaseUrl:`http://127.0.0.1:${upstream.address().port}/v1`},stateDirectory);
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
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('soma-service-settings',JSON.stringify({provider:'openai-compatible',baseUrl:'/v1',backendUrl:'',model:'test',apiKey:'test'}));`});
  await cdp('Page.reload');
  await wait("document.querySelector('#message-input')");
  await click('.composer-menu');
  await wait('document.querySelector(".menu-surface")');
  const menuEdges = await evaluate('(()=>{const a=document.querySelector(".composer").getBoundingClientRect();const b=document.querySelector(".menu-surface").getBoundingClientRect();return {composer:a.left,menu:b.left}})()');
  assert.ok(Math.abs(menuEdges.composer-menuEdges.menu)<1, 'popup must align to composer outer edge: '+JSON.stringify(menuEdges));
  await evaluate('Array.from(document.querySelectorAll(".menu-row")).find(e=>e.innerText.includes("Creator Mode")).click()');
  await wait('document.querySelector(".creator-view")');
  assert.equal(await evaluate('document.querySelectorAll(".creator-page").length'),1);
  await fill('.creator-page-text','保留这一段手写文字。');
  await click('[aria-label="添加章节"]');
  await wait('document.querySelectorAll(".creator-page").length===2');
  await fill('#message-input','写开头');
  await click('[aria-label="发送"]');
  await wait('document.querySelector(".creator-page-text").value.includes("雨落")');
  await wait('document.querySelectorAll(".assistant-message").length===1');
  await wait('document.querySelector("[aria-label=发送]")');
  assert.equal(await evaluate('document.querySelector(".creator-title input").value'),'雨停以前');
  const bounds=await evaluate('Array.from(document.querySelectorAll(".creator-chapters,.creator-manuscript,.creator-chat")).map(e=>{const r=e.getBoundingClientRect();return {x:r.x,width:r.width}})');
  assert.ok(bounds[0].x<bounds[1].x && bounds[1].x<bounds[2].x);
  await shot('soma-creator-light');
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
  await wait('document.documentElement.dataset.theme==="dark"');
  await shot('soma-creator-dark');
  await click('.creator-header .back-button');
  await wait('document.querySelector(".conversation-view")');
  const bubbleCenter = await evaluate('(()=>{const a=document.querySelector(".user-message.single-line");const p=a.querySelector("p");const x=a.getBoundingClientRect();const y=p.getBoundingClientRect();return Math.abs((x.top+x.bottom)/2-(y.top+y.bottom)/2)})()');
  assert.ok(bubbleCenter<=1, 'single-line bubble text must be vertically centered: '+bubbleCenter);
  await click('.history-trigger');
  await wait('document.querySelector(".history-new")');
  await click('.history-new');
  await wait('document.querySelector(".conversation-view.empty")');
  assert.equal(await evaluate('document.querySelectorAll(".creator-page").length'),0);
  await click('.history-trigger');
  await wait('document.querySelector(".history-entry")');
  await click('.history-entry');
  await wait('document.querySelector(".creator-view")');
  assert.equal(await evaluate('document.querySelector(".creator-page-text").value'),'雨落在窗沿上。');
  await evaluate('new Promise(r=>setTimeout(r,500))');
  await cdp('Page.reload');
  await wait('document.querySelector(".history-trigger")');
  await click('.history-trigger');
  await wait('document.querySelector(".history-entry")');
  await click('.history-entry');
  await wait('document.querySelector(".creator-view")');
  assert.equal(await evaluate('document.querySelector(".creator-page-text").value'),'雨落在窗沿上。');
  console.log('PASS: headless Creator entry, chapters, streamed Agent update, isolated sessions, local restore, light/dark');
} finally { socket?.close(); chrome.kill('SIGTERM'); app.closeAllConnections(); upstream.closeAllConnections(); await new Promise(r=>app.close(r)); await new Promise(r=>upstream.close(r)); }
