import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {parseListener,validateProcess,sameOwner,validateTarget,readLocalTargets,buildReadExpression,evaluateRead,safeResult}=await import(pathToFileURL(resolve(process.cwd(),'scripts/verify-read-support.mjs')).href);
const target={id:'A-123',type:'page',url:'orpheus://orpheus/app.html',webSocketDebuggerUrl:'ws://127.0.0.1:19319/devtools/page/A-123'};
test('listener accepts exactly one owner with IPv4 loopback and rejects wildcard, wrong port and multiple owners',()=>{
  assert.equal(parseListener('p123\nn127.0.0.1:19319\nn[::1]:19319'),123);
  for(const text of ['', 'p123\nn*:19319','p123\nn127.0.0.1:19320','p123\nn[::1]:19319','p123\nn127.0.0.1:19319\np124\nn127.0.0.1:19319','p0\nn127.0.0.1:19319'])assert.throws(()=>parseListener(text));
});
test('supported main process identity rejects helper, symlink, unsupported version and owner replacement',()=>{
  const exe='/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic';
  const info={identifier:'com.netease.163music',version:'3.1.1',build:'3019',executable:'NeteaseMusic'};
  const identity=validateProcess(123,exe,'start-A',info);sameOwner(identity,{...identity});
  assert.throws(()=>validateProcess(123,exe,'start-A',{...info,version:'3.2.0'}));
  assert.throws(()=>validateProcess(123,exe,'start-A',{...info,build:'3020'}));
  assert.throws(()=>validateProcess(123,exe,'start-A',{...info,identifier:'other'}));
  assert.throws(()=>validateProcess(123,exe.replace('/MacOS/NeteaseMusic','/MacOS/Helper'),'start-A',info));
  assert.throws(()=>validateProcess(123,exe,'start-A',info,'/other/path'));
  assert.throws(()=>sameOwner(identity,{...identity,started:'start-B'}));
});
test('only one exact main page and canonical same-origin websocket can be used',()=>{
  assert.equal(validateTarget([target]),target.webSocketDebuggerUrl);
  for(const ws of ['ws://localhost:19319/devtools/page/A-123','ws://127.0.0.1:19320/devtools/page/A-123','wss://127.0.0.1:19319/devtools/page/A-123','ws://user@127.0.0.1:19319/devtools/page/A-123','ws://127.0.0.1:19319/devtools/page/other','ws://127.0.0.1:19319/devtools/page/A-123?q=1','ws://127.0.0.1:19319/devtools/page/A-123#fragment','ws://evil.example/devtools/page/A-123','ws://127.0.0.1:19319/devtools/page/../page/A-123'])assert.throws(()=>validateTarget([{...target,webSocketDebuggerUrl:ws}]));
  for(const targets of [[],[target,target],[{...target,url:'orpheus://orpheus/app.html?x=1'}],[{...target,type:'iframe'}]])assert.throws(()=>validateTarget(targets));
});
function fixtureHTTP(status,chunks) {
  return {get(options,callback){assert.deepEqual(options,{hostname:'127.0.0.1',port:19319,path:'/json/list',agent:false});
    const req=new EventEmitter();req.destroy=()=>{};
    queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.resume=()=>{};res.destroy=()=>{};callback(res);for(const chunk of chunks)res.emit('data',Buffer.from(chunk));res.emit('end');});return req;
  }};
}
test('HTTP boundary refuses redirects, malformed JSON and oversized response without following destinations',async()=>{
  assert.deepEqual(await readLocalTargets(fixtureHTTP(200,['[]'])),[]);
  for(const [status,chunks] of [[302,['[]']],[200,['{bad']],[200,['x'.repeat(1_048_577)]]])await assert.rejects(()=>readLocalTargets(fixtureHTTP(status,chunks)));
});
test('result export is a count-only whitelist and rejects broken integrity or arbitrary errors',()=>{
  const result={supported:true,adapterVersion:'ncm-mac-3019-v1',status:'complete',integrity:{declared:3,ids:3,uniqueIds:3,details:3,ordered:true,uid:'SECRET'},raw:'SECRET'};
  assert.equal(JSON.stringify(safeResult(result)).includes('SECRET'),false);
  assert.throws(()=>safeResult({...result,integrity:{...result.integrity,uniqueIds:2}}));
  assert.throws(()=>safeResult({...result,integrity:{...result.integrity,declared:NaN}}));
  assert.throws(()=>safeResult({...result,status:'paused',reason:'SECRET'}));
});
test('CDP bridge sends only fixed read evaluation and rejects exception results',async()=>{
  const sent=[];
  class Socket extends EventTarget {constructor(url){super();assert.equal(url,target.webSocketDebuggerUrl);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}close(){}
    send(text){const call=JSON.parse(text);sent.push(call);queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:1,result:{result:{value:{status:'complete'}}}})})));}}
  assert.deepEqual(await evaluateRead(target.webSocketDebuggerUrl,'READ_ONLY',Socket),{status:'complete'});
  assert.deepEqual(sent,[{id:1,method:'Runtime.evaluate',params:{expression:'READ_ONLY',awaitPromise:true,returnByValue:true}}]);
  class Failed extends Socket {send(){queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:1,result:{exceptionDetails:{text:'SECRET'},result:{}}})})));}}
  await assert.rejects(()=>evaluateRead(target.webSocketDebuggerUrl,'READ_ONLY',Failed));
});
test('actual independent read bundle has no write routes or UI/storage and exports safe full integrity counts',async()=>{
  const expression=await buildReadExpression();
  for(const forbidden of ['/api/playlist/create','/api/playlist/manipulate/tracks','__ncmOrganizerV1','localStorage'])assert.equal(expression.includes(forbidden),false);
  const paths=[];
  const request=path=>async()=>{paths.push(path);switch(path){
    case '/api/w/nuser/account/get':return {code:200,profile:{userId:7,secret:'DO_NOT_EXPORT'}};
    case '/api/user/playlist':return {code:200,more:false,playlist:[{id:8,specialType:5,creator:{userId:7}}]};
    case '/api/v6/playlist/detail':return {code:200,playlist:{id:8,trackCount:2,trackIds:[{id:1},{id:2}],tracks:[{id:1,name:'PRIVATE_NAME',ar:[]}]}};
    case '/api/v3/song/detail':return {code:200,songs:[{id:2,name:'PRIVATE_NAME',ar:[]}]};
    default:assert.fail(path);
  }};
  const wiki=async()=>{const wikiSubElementVos=[];return {metas:wikiSubElementVos};};
  const req=Object.assign(()=>assert.fail('uncached module'),{m:{1:function(){const formatOption='',cacheStrategy='',fetchFrontEndEncryptError='';},2:function(){const wikiSubElementVos=[];const path='/api/music/wiki/home/song/desktop/get';}},c:{1:{exports:{request}},2:{exports:{wiki}}}});
  const context=vm.createContext({webpackJsonp:{push(entry){Object.values(entry[1]).forEach(factory=>factory({}, {}, req));}},setTimeout,clearTimeout,AbortController,performance});
  const result=await vm.runInContext(expression,context);assert.deepEqual(safeResult(result).integrity,{declared:2,ids:2,uniqueIds:2,details:2,ordered:true});
  assert.equal(JSON.stringify(result).includes('PRIVATE_NAME'),false);assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'),false);
  assert.equal(paths.every(path=>!path.includes('/playlist/create')&&!path.includes('/manipulate/')),true);
  assert.equal(context.__ncmOrganizerV1,undefined);
});
