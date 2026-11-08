import http from 'node:http'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const state = await mkdtemp(`${tmpdir()}/soma-resume-preview-`)
let calls=0
const upstream=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
 const body=JSON.parse(raw); res.setHeader('content-type','text/event-stream');
 if(req.url==='/count'){res.end(JSON.stringify({calls}));return}
 calls++
 let count=0
 const timer=setInterval(()=>{count++;res.write(`data: ${JSON.stringify({choices:[{delta:{content:`第${count}段回应。`}}]})}\n\n`);if(count===20){clearInterval(timer);res.end('data: [DONE]\n\n')}},600)
 res.on('close',()=>clearInterval(timer))
})})
await new Promise(r=>upstream.listen(45984,'127.0.0.1',r))
const app=createApp({...loadConfig({}),host:'0.0.0.0',port:45983},state)
await new Promise(r=>app.listen(45983,'0.0.0.0',r))
console.log('RESUME_PREVIEW_READY http://192.168.1.96:45983 state='+state)
process.on('SIGTERM',()=>{app.closeAllConnections();upstream.closeAllConnections();app.close();upstream.close()})
