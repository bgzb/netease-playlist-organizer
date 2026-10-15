import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
class Element {
  children=[];parent=null;hidden=false;dataset={};style={setProperty(){}};attributes={};value='';checked=false;disabled=false;className='';shadowRoot=null;text='';
  constructor(tagName){this.tagName=tagName;}
  set textContent(value){this.text=value;this.children=[];} get textContent(){return this.text+this.children.map(c=>c.textContent??'').join('');}
  set innerHTML(_){throw Error('HTML sink');}
  append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this;}}
  replaceChildren(...nodes){for(const node of this.children)node.parent=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}
  setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}
  attachShadow(){this.shadowRoot=new Element('shadow');return this.shadowRoot;}
  querySelector(){return null;}focus(){}getBoundingClientRect(){return {bottom:55};}
}
const body=new Element('body');const listeners=new Map();
const document={body,documentElement:body,createElement:tag=>new Element(tag),createTextNode:text=>{const e=new Element('#text');e.textContent=text;return e;},location:{href:'orpheus://orpheus/app.html'},querySelector:()=>null,addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)};
const storage=new Map();const localStorage={get length(){return storage.size;},key:i=>[...storage.keys()][i]??null,getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
const calls=[],writes=[],targetTracks=new Set(),playlists=[{id:8,name:'喜欢',specialType:5,creator:{userId:7},privacy:10},{id:9,name:'合成已有目标',specialType:0,creator:{userId:7},privacy:0,subscribed:false}];const ids=[1,2,3];const detail=id=>({id,name:id===1?'<img onerror=alert(1)>':'合成曲目',ar:[{id:id===2?0:11,name:'<svg onload=alert(2)>'}]});
const apiFactory=path=>async data=>{
  calls.push(path);switch(path){
    case '/api/w/nuser/account/get':return {code:200,profile:{userId:7}};
    case '/api/user/playlist':return {code:200,more:false,playlist:playlists};
    case '/api/v6/playlist/detail': {const pid=String(data.id),p=playlists.find(p=>String(p.id)===pid),tracks=pid==='8'?ids:[...targetTracks];return {code:200,playlist:{...p,trackCount:tracks.length,trackIds:tracks.map(id=>({id})),tracks:pid==='8'?ids.map(detail):[]}};}
    case '/api/playlist/create':writes.push({path,data});playlists.push({id:10,name:data.name,specialType:0,creator:{userId:7},privacy:10,subscribed:false});return {code:200,playlist:{id:10}};
    case '/api/playlist/manipulate/tracks':writes.push({path,data});JSON.parse(data.trackIds).forEach(id=>targetTracks.add(id));return {code:200};
    case '/api/rep/ugc/song/get':return {code:200,data:{language:'国语'}};
    default:throw Error('Unexpected path '+path);
  }
};
const wiki=async id=>{const wikiSubElementVos=[];return {metas:[{title:'曲风',content:'摇滚-日系摇滚'},{title:'BPM',content:'100'}]};};
const openedPaths=[],navigationHistory={location:{pathname:'/'},push(path){this.location={pathname:path};openedPaths.push(path);}};const factories=[];factories[3]=function(){const formatOption='',cacheStrategy='',fetchFrontEndEncryptError='';};factories[5]=function(){const endpoint='/api/music/wiki/home/song/desktop/get';};factories[7]=function(){const wikiSubElementVos=[];};
factories[12]=function(){const marker='dva-tool getHistory getDispatch';return marker;};
const req=Object.assign(id=>{throw Error('unexpected uncached '+id);},{m:factories,c:{3:{exports:{request:apiFactory}},7:{exports:{wiki}},12:{exports:{a:{inited:true,history:navigationHistory}}}}});
const intervals=new Set();let intervalID=0;
const context=vm.createContext({document,localStorage,webpackJsonp:{push(entry){for(const factory of Object.values(entry[1]))factory({}, {}, req);}},AbortController,performance,setTimeout,clearTimeout,setInterval(){const id=++intervalID;intervals.add(id);return id;},clearInterval:id=>intervals.delete(id)});context.window=context;
const bundle=fs.readFileSync(process.argv[2]??'work/dist/panel.js','utf8');
const run=()=>vm.runInContext(bundle,context);const walk=node=>[node,...node.children.flatMap(walk)];
const button=label=>{const found=walk(body.children[0].shadowRoot).find(e=>e.tagName==='button'&&e.textContent===label);assert.ok(found,'button '+label);assert.equal(found.disabled,false);return found;};
const action=key=>{const found=walk(body.children[0].shadowRoot).find(e=>e.tagName==='button'&&e.dataset.key===key);assert.ok(found,'action '+key);assert.equal(found.disabled,false);return found;};
run();assert.equal(context.__ncmOrganizerV1.status().readReady,true);const instance=context.__ncmOrganizerV1;run();assert.equal(context.__ncmOrganizerV1,instance);assert.equal(body.children.length,1);
action('prepare').onclick();for(let tick=0;tick<120&&instance.status().scan?.phase!=='complete';tick++)await new Promise(r=>setTimeout(r,30));await new Promise(r=>setTimeout(r,280));assert.equal(instance.status().scan.phase,'complete');assert.equal(instance.status().scan.processed,3);assert.equal(instance.status().scan.coverage.artists,2/3);
const all=walk(body.children[0].shadowRoot).filter(e=>e.dataset.key==='all-songs')[0];all.checked=true;all.onchange();
const rows=walk(body.children[0].shadowRoot);assert.equal(rows.some(e=>['img','svg'].includes(e.tagName)),false);assert.match(body.children[0].shadowRoot.textContent,/<img onerror=alert\(1\)>/);assert.match(body.children[0].shadowRoot.textContent,/<svg onload=alert\(2\)>/);
const allowed=new Set(['/api/w/nuser/account/get','/api/user/playlist','/api/v6/playlist/detail','/api/v3/song/detail','/api/rep/ugc/song/get']);assert.equal(calls.filter(p=>!allowed.has(p)).length,0);
action('to-write').onclick();action('target-new').onclick();
button('审阅写入清单').onclick();await new Promise(r=>setTimeout(r,130));assert.equal(writes.length,0);
const selected=walk(body.children[0].shadowRoot).filter(e=>e.dataset.songId);assert.deepEqual(selected.map(e=>e.dataset.songId),['1','2','3']);
action('write-confirm').onclick();await new Promise(r=>setTimeout(r,180));
assert.equal(writes.length,2);assert.equal(writes[0].path,'/api/playlist/create');assert.equal(writes[0].data.privacy,10);assert.equal(writes[0].data.type,'NORMAL');assert.equal(writes[1].data.op,'add');assert.equal(targetTracks.size,3);
action('back-filter').onclick();action('to-write').onclick();button('恢复核对（只读）').onclick();await new Promise(r=>setTimeout(r,180));assert.equal(writes.length,2);
button('审阅写入清单').onclick();await new Promise(r=>setTimeout(r,130));action('write-confirm').onclick();await new Promise(r=>setTimeout(r,180));assert.equal(writes.length,2);
assert.deepEqual(openedPaths,[]);action('open-target').onclick();assert.deepEqual(openedPaths,['/playlist/10']);assert.equal(walk(body.children[0].shadowRoot).find(e=>e.dataset.action==='workspace').hidden,true);instance.show();assert.equal(writes.length,2);
action('finish').onclick();const finished=walk(body.children[0].shadowRoot);assert.equal(finished.find(e=>e.dataset.action==='workspace').hidden,false);assert.ok(finished.some(e=>e.dataset.page==='filter'));assert.equal(writes.length,2);
assert.equal(instance.status().writeVerification,'unverified');assert.equal(JSON.stringify(instance.status()).includes('uid'),false);
instance.remove();assert.equal(body.children.length,0);assert.equal(intervals.size,0);assert.equal(listeners.size,0);assert.equal(context.__ncmOrganizerV1,undefined);run();assert.notEqual(context.__ncmOrganizerV1,instance);context.__ncmOrganizerV1.remove();
console.log(JSON.stringify({bundle:process.argv[2]??'work/dist/panel.js',syntheticTotal:3,processed:3,artistCoverage:2/3,writeRequests:writes.length,unconfirmedWrites:0,repeatWrites:0,renderedHTMLNodes:0,reuseRemoveReinject:'pass',rawStatusData:'absent',readCalls:calls.length}));
