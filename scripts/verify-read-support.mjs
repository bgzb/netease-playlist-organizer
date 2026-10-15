import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const PORT=19319;
const MAX_BYTES=1_048_576;
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const failure=()=>new Error('只读验证停止：进程、版本、回环目标或响应未通过验证。');
const command=(path,args)=>execFileSync(path,args,{encoding:'utf8',timeout:2000,maxBuffer:65536,stdio:['ignore','pipe','pipe']}).trim();

export function parseListener(output) {
  let current;const listeners=[];
  for(const line of output.split('\n')) {
    if(line.startsWith('p')) {current=Number(line.slice(1));if(!Number.isSafeInteger(current)||current<=0)throw failure();}
    else if(line.startsWith('n')) {
      if(!current||!['127.0.0.1:19319','[::1]:19319'].includes(line.slice(1)))throw failure();
      listeners.push({pid:current,address:line.slice(1)});
    }
  }
  if(!listeners.length||new Set(listeners.map(x=>x.pid)).size!==1||!listeners.some(x=>x.address==='127.0.0.1:19319'))throw failure();
  return listeners[0].pid;
}
export function validateProcess(pid,executable,started,info,canonical=executable) {
  if(!Number.isSafeInteger(pid)||pid<=0||!started||!executable.startsWith('/')||canonical!==executable
    ||info.identifier!=='com.netease.163music'||info.version!=='3.1.1'||info.build!=='3019'
    ||typeof info.executable!=='string'||!info.executable||/[\/\\]/.test(info.executable))throw failure();
  const suffix=`/Contents/MacOS/${info.executable}`;
  if(!executable.endsWith(suffix)||!executable.slice(0,-suffix.length).endsWith('.app'))throw failure();
  return {pid,executable,started,version:info.version,build:info.build};
}
export function inspectOwner() {
  const pid=parseListener(command('/usr/sbin/lsof',['-nP','-iTCP:19319','-sTCP:LISTEN','-Fpn']));
  const executable=command('/bin/ps',['-p',String(pid),'-o','comm=']);
  const started=command('/bin/ps',['-p',String(pid),'-o','lstart=']);
  const marker=executable.lastIndexOf('/Contents/MacOS/');
  if(marker<0)throw failure();
  const plist=executable.slice(0,marker)+'/Contents/Info.plist';
  const get=key=>command('/usr/bin/plutil',['-extract',key,'raw','-o','-',plist]);
  return validateProcess(pid,executable,started,{identifier:get('CFBundleIdentifier'),
    version:get('CFBundleShortVersionString'),build:get('CFBundleVersion'),executable:get('CFBundleExecutable')},realpathSync(executable));
}
export function sameOwner(before,after) {
  if(JSON.stringify(before)!==JSON.stringify(after))throw failure();
}
export function validateTarget(targets) {
  if(!Array.isArray(targets))throw failure();
  const main=targets.filter(t=>t?.type==='page'&&t.url==='orpheus://orpheus/app.html');
  if(main.length!==1)throw failure();
  const t=main[0];
  if(typeof t.id!=='string'||!/^[-\w]+$/.test(t.id)||typeof t.webSocketDebuggerUrl!=='string')throw failure();
  let url;try{url=new URL(t.webSocketDebuggerUrl);}catch{throw failure();}
  if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.port!==String(PORT)||url.username||url.password
    ||url.search||url.hash||url.pathname!==`/devtools/page/${t.id}`
    ||url.href!==t.webSocketDebuggerUrl)throw failure();
  return url.href;
}
export function readLocalTargets(httpClient=http) {
  return new Promise((resolve,reject)=>{
    let settled=false;let request;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){request?.destroy();reject(failure());}else resolve(value);};
    const timer=setTimeout(()=>finish(failure()),5000);
    // node:http uses a direct socket, no fetch dispatcher/proxy and no redirect following.
    request=httpClient.get({hostname:'127.0.0.1',port:PORT,path:'/json/list',agent:false},response=>{
      if(response.statusCode!==200){response.resume();finish(failure());return;}
      const chunks=[];let bytes=0;
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_BYTES){response.destroy();finish(failure());}else chunks.push(chunk);});
      response.on('error',()=>finish(failure()));
      response.on('end',()=>{try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(failure());}});
    });
    request.on('error',()=>finish(failure()));
  });
}
export async function buildReadExpression() {
  const {build}=await import('esbuild');
  const output=await build({absWorkingDir:ROOT,entryPoints:['scripts/verify-read-entry.ts'],bundle:true,
    platform:'browser',format:'iife',globalName:'NcmReadVerification',target:'es2020',write:false});
  const script=output.outputFiles[0].text;
  // Defense against accidentally pulling the product's write adapter into this independent bundle.
  if(['/api/playlist/create','/api/playlist/manipulate/tracks','__ncmOrganizerV1','localStorage'].some(text=>script.includes(text)))throw failure();
  return `(async()=>{${script}\nreturn await NcmReadVerification.runVerification();})()`;
}
export function evaluateRead(url,expression,WebSocketClass=globalThis.WebSocket) {
  if(typeof WebSocketClass!=='function')throw new Error('需要 Node.js 20.20.2 与 --experimental-websocket。');
  // Undici's native WebSocket handshake rejects redirects; URL is prevalidated, no custom proxy dispatcher.
  return new Promise((resolve,reject)=>{
    const socket=new WebSocketClass(url);let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.close();error?reject(failure()):resolve(value);};
    const timer=setTimeout(()=>finish(failure()),45_000);
    socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}})));
    socket.addEventListener('error',()=>finish(failure()));socket.addEventListener('close',()=>finish(failure()));
    socket.addEventListener('message',event=>{
      if(typeof event.data!=='string'||Buffer.byteLength(event.data)>MAX_BYTES){finish(failure());return;}
      try {
        const message=JSON.parse(event.data);if(message.id!==1)return;
        if(message.error||message.result?.exceptionDetails||!message.result?.result||!('value' in message.result.result))throw failure();
        finish(null,message.result.result.value);
      }catch{finish(failure());}
    });
  });
}
export function safeResult(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.adapterVersion!=='ncm-mac-3019-v1'
    ||typeof value.supported!=='boolean')throw failure();
  if(value.status==='complete'&&value.supported) {
    const i=value.integrity;const keys=['declared','ids','uniqueIds','details'];
    if(!i||keys.some(key=>!Number.isSafeInteger(i[key])||i[key]<0)||i.ordered!==true||keys.some(key=>i[key]!==i.declared))throw failure();
    return {supported:true,adapterVersion:value.adapterVersion,status:'complete',integrity:Object.fromEntries([...keys.map(key=>[key,i[key]]),['ordered',true]])};
  }
  if(value.status==='unsupported'&&!value.supported)return {supported:false,adapterVersion:value.adapterVersion,status:'unsupported'};
  const kinds=['network','login','permission','rateLimit','business','structure','accountChanged','collectionChanged','storage','paused'];
  if(value.status==='paused'&&value.supported&&kinds.includes(value.reason))return {supported:true,adapterVersion:value.adapterVersion,status:'paused',reason:value.reason};
  throw failure();
}
