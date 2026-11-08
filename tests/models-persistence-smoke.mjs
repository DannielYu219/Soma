// Real built UI and persistent backend, deterministic model-list endpoint.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
let requests = 0
let fail = false
const upstream = http.createServer((req, res) => {
  requests++
  res.setHeader('content-type', 'application/json')
  if (fail) { res.writeHead(503); res.end(JSON.stringify({error:{message:'暂时不可用'}})); return }
  res.end(JSON.stringify({data:[{id:'model-main'},{id:'model-fast'},{id:'model-other'}]}))
})
await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve))
const directory = await mkdtemp(`${tmpdir()}/soma-models-state-`)
const app = createApp(loadConfig({}),directory)
await new Promise(resolve => app.listen(0,'127.0.0.1',resolve))
const url = `http://127.0.0.1:${app.address().port}/`
const service = {provider:'openai-compatible',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,model:'model-main',apiKey:'test-key',search:{enabled:true,model:'model-fast'}}
const profile = await mkdtemp(`${tmpdir()}/soma-models-browser-`)
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,url],{stdio:['ignore','ignore','pipe']})
let socket
try {
  const endpoint = await new Promise((resolve,reject)=>{
    let text=''; const timer=setTimeout(()=>reject(new Error('Chrome startup timeout')),15000)
    chrome.stderr.on('data',chunk=>{text+=chunk; const found=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(found){clearTimeout(timer);resolve(found[1])}})
    chrome.once('error',reject)
  })
  let target
  for(let i=0;i<50&&!target;i++){
    target=(await(await fetch(`http://${new URL(endpoint).host}/json`)).json()).find(tab=>tab.url.startsWith(url))
    if(!target)await new Promise(resolve=>setTimeout(resolve,80))
  }
  assert.ok(target)
  socket=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}))
  let id=0;const pending=new Map()
  socket.addEventListener('message',event=>{const result=JSON.parse(event.data);const handler=pending.get(result.id);if(handler){pending.delete(result.id);result.error?handler.reject(result.error):handler.resolve(result.result)}})
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value}
  const wait=async expression=>{const deadline=Date.now()+10000;while(Date.now()<deadline){try{if(await evaluate(`Boolean(${expression})`))return}catch{}await new Promise(resolve=>setTimeout(resolve,60))}throw new Error(`Timeout ${expression}; ${await evaluate('document.body.innerText')}`)}
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const main='[aria-label="选择模型"]'
  const search='[aria-label="搜索时使用的快速模型"]'
  const pick=async(selector,text)=>{await click(selector);await wait('document.querySelector(".model-select-item")');await evaluate(`Array.from(document.querySelectorAll('.model-select-item')).find(item=>item.innerText.trim()===${JSON.stringify(text)} && item.closest('.model-select-popup')?.getAttribute('data-open')!==null && getComputedStyle(item.closest('.model-select-positioner')).visibility!=='hidden').click()`);await wait('!Array.from(document.querySelectorAll(".model-select-item")).some(item => item.getBoundingClientRect().height > 0)')}
  const openSettings=async()=>{await click('.composer-menu');await wait('document.querySelector(".menu-surface")');await evaluate(`Array.from(document.querySelectorAll('.menu-row')).find(item=>item.innerText.includes('模型服务')).click()`);await wait('document.querySelector(".provider-list")');await click('[aria-label^="编辑服务："]');await wait('document.querySelector(".onboarding-fetch")')}
  await cdp('Page.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`if(!localStorage.getItem('soma-service-settings'))localStorage.setItem('soma-service-settings',${JSON.stringify(JSON.stringify(service))})`})
  await cdp('Page.reload');await wait('document.querySelector("#message-input")')
  await openSettings()
  await click('.onboarding-fetch')
  await wait('document.querySelector(".onboarding-ok")')
  assert.equal(requests,1)
  await pick(main,'model-other')
  await pick(search,'model-fast')
  await click('.onboarding-actions button');await wait('document.querySelector("#message-input")')
  await openSettings()
  assert.equal(requests,1)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(main)}).textContent.includes('model-other')`),true)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(search)}).textContent.includes('model-fast')`),true)
  fail=true
  await click('.onboarding-fetch');await wait('document.querySelector(".onboarding-error")')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(main)}).textContent.includes('model-other')`),true)
  await pick(main,'model-main')
  await pick(search,'与对话模型相同')
  assert.equal(await evaluate('document.querySelector(".onboarding-actions button").disabled'),false)
  await click('.onboarding-actions button');await wait('document.querySelector("#message-input")')
  await wait(`fetch('/api/state').then(r=>r.json()).then(d=>d.values['soma-service-profiles']?.profiles[0]?.settings.search.model==='')`)
  // Simulate losing browser storage; disk must restore both cached list and independent selections.
  await evaluate(`['soma-service-settings','soma-service-profiles'].forEach(key=>localStorage.removeItem(key))`)
  await cdp('Page.reload');await wait('document.querySelector("#message-input")')
  await openSettings()
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(main)}).textContent.includes('model-main')`),true)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(search)}).textContent.includes('与对话模型相同')`),true)
  const state=await evaluate(`fetch('/api/state').then(r=>r.json())`)
  const saved=state.values['soma-service-profiles'].profiles[0].settings
  assert.equal(saved.models.items.length,3)
  assert.equal(saved.model,'model-main')
  assert.equal(saved.search.model,'')
  assert.equal(requests,2)
  console.log('PASS: provider model cache, independent choices, refresh failure recovery, empty follow-main option, disk restore without refetch')
} finally {
  socket?.close();chrome.kill('SIGTERM');app.closeAllConnections();upstream.closeAllConnections()
  await new Promise(resolve=>app.close(resolve));await new Promise(resolve=>upstream.close(resolve))
}
