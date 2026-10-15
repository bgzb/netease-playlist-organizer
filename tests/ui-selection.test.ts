import test from 'node:test';
import assert from 'node:assert/strict';
import * as ui from '../panel/ui/panel';
import { snapshot, memoryStorage } from './fixtures/read';
import { makeSong } from './fixtures/synthetic';
import { LocalStore } from '../panel/scan/store';
import { createScanner, CollectionChangedError } from '../panel/scan/scan';
import { ReadError } from '../panel/client/requests';
const api = ui as any;
function model() { assert.equal(typeof api.PanelModel, 'function', 'selection state is not implemented'); return new api.PanelModel(); }
function loaded() { const m=model(); const s=snapshot(3); s.songs=[makeSong('1',{genres:['摇滚-日系摇滚']}),makeSong('2',{genres:null}),makeSong('3',{genres:['流行']})].map((s,position)=>({...s,position})); m.setLibrary(s); m.setFilters({...m.state.filters,genres:['摇滚-日系摇滚']}); m.setProgress({phase:'complete',processed:3,total:3},true); return m; }
test('changedSelectionClearsConfirmation', () => {
  const mutations=[(m:any)=>m.setFilters({...m.state.filters,bpmMin:80}),(m:any)=>m.manual('2','add'),(m:any)=>m.manual('1','remove'),(m:any)=>m.setTarget({kind:'new',name:'更名',privacy:10})];
  for(const mutate of mutations) { const m=loaded(); m.state.confirmation={uid:'7',sourceRevision:m.state.snapshot.revision,selectionVersion:m.state.selectionVersion,targetKey:'x',confirmedAt:1}; const old=m.state.selectionVersion; mutate(m); assert.equal(m.state.confirmation,null); assert.notEqual(m.state.selectionVersion,old); }
});
test('manual override changes version even when effective IDs are unchanged',()=>{const m=loaded();const old=m.state.selectionVersion;m.manual('1','add');assert.notEqual(m.state.selectionVersion,old);});
test('account and source changes clear stale preview and choices',()=>{const m=loaded();m.manual('2','add');m.setAccount('9');assert.equal(m.state.snapshot,null);assert.deepEqual([...m.state.added],[]);assert.equal(m.state.target,null);assert.deepEqual(m.preview().ids,[]);m.setLibrary(snapshot());m.manual('1','add');m.setLibrary({...snapshot(),sourcePlaylistId:'10'});assert.deepEqual([...m.state.added],[]);assert.equal(m.state.confirmation,null);});
test('empty conditions require explicit all songs and zero selection cannot generate',()=>{const m=model();m.setLibrary(snapshot());assert.equal(m.preview().ids.length,0);assert.match(m.preview().error,/条件/);m.setFilters({...m.state.filters,allSongs:true});assert.deepEqual(m.preview().ids,['1','2','3','4']);m.setFilters({...m.state.filters,allSongs:false,genres:['不存在']});m.setProgress({phase:'complete',processed:4,total:4},true);m.setTarget({kind:'new',name:'合成目标',privacy:10});assert.equal(m.canPrepare(),false);assert.equal(m.state.confirmation,null);});
test('three source ordered groups paginate at 50 and manual selection preserves order',()=>{const m=loaded();m.manual('3','add');m.manual('1','remove');assert.deepEqual(m.preview().ids,['3']);assert.deepEqual(m.preview().result.unknown.map((s:any)=>s.id),['2']);const rows=Array.from({length:103},(_,i)=>({...makeSong(String(i+1)),position:i}));assert.deepEqual(api.pageRows(rows,2).map((s:any)=>s.id),['101','102','103']);});
test('candidate counts keep full exact tags and stable ties',()=>{const m=loaded();assert.deepEqual(api.filterCandidates(m.state.snapshot.songs,'genres'),[{id:'流行',name:'流行',count:1},{id:'摇滚-日系摇滚',name:'摇滚-日系摇滚',count:1}].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id)));});
test('targets require explicit owned normal choice; duplicate names never auto select',async()=>{assert.equal(typeof api.readTargets,'function');const list=[{id:8,name:'喜欢',specialType:5,creator:{userId:7}},{id:10,name:'同名',privacy:10,specialType:0,subscribed:false,creator:{userId:7}},{id:11,name:'同名',privacy:0,specialType:0,subscribed:false,creator:{userId:7}},{id:12,name:'订阅',specialType:0,subscribed:true,creator:{userId:7}},{id:13,name:'别人的',specialType:0,creator:{userId:9}},{id:14,name:'特殊',specialType:1,creator:{userId:7}}];const targets=await api.readTargets(async()=>({code:200,more:false,playlist:list}),'7','8');assert.deepEqual(targets.map((t:any)=>t.id),['10','11']);const m=loaded();m.setTargets(targets);assert.equal(m.state.target,null);assert.throws(()=>m.chooseExisting('12'));m.chooseExisting('11');assert.deepEqual(m.state.target,{kind:'existing',id:'11'});});
test('dynamic malicious text is assigned as literal text without HTML sink',()=>{assert.equal(typeof api.textElement,'function');const doc={createElement:(tag:string)=>({tag,textContent:'',set innerHTML(_:string){throw Error('HTML sink used');}})};const raw='<img onerror=alert(1)>歌手';const e=api.textElement(doc,'span',raw);assert.equal(e.textContent,raw);assert.equal(e.tag,'span');});
test('controller surfaces persistence failure, continuation and real scanner reset',async()=>{assert.equal(typeof api.PanelController,'function');const store=new LocalStore({...memoryStorage(),setItem(){throw new Error('quota');}});let reset=0;const s=snapshot(2);const scanner=createScanner({readLibrary:async()=>s,readUid:async()=>'7',readMetadata:async()=>{const {genres,bpm,language}=makeSong('1');return {genres,bpm,language};},store,resetMetadataErrors:()=>reset++});const c=new api.PanelController({readLibrary:async()=>s,readUid:async()=>'7',readTargets:async()=>[],scanner,store});await c.readLibrary();await c.scan();assert.equal(c.model.state.persisted,false);assert.equal(c.model.state.progress.phase,'paused');assert.match(c.model.state.message,/存储/);c.continuePageOnly();await c.scan();assert.equal(c.model.state.progress.phase,'complete');assert.equal(c.model.state.persisted,false);await c.forceRefresh();assert.equal(reset,1);c.remove();});
test('collection change clears selection, reports differences and requires reread',async()=>{const old=snapshot(2),fresh=snapshot(3);let reads=0;const store=new LocalStore(memoryStorage());const scanner=createScanner({readLibrary:async()=>fresh,readUid:async()=>'7',readMetadata:async()=>{const {genres,bpm,language}=makeSong('1');return {genres,bpm,language};},store});const c=new api.PanelController({readLibrary:async()=>{reads++;return old;},readUid:async()=>'7',readTargets:async()=>[],scanner,store});await c.readLibrary();c.model.setFilters({...c.model.state.filters,allSongs:true});await c.scan();assert.equal(c.model.state.snapshot,null);assert.equal(c.model.state.confirmation,null);assert.match(c.model.state.message,/新增 1/);await c.scan();assert.equal(reads,1);assert.equal(c.status().writeVerification,'unverified');assert.equal('uid' in c.status(),false);c.remove();});
test('remove aborts request signal and late read cannot publish',async()=>{let done!:(s:any)=>void;let signal:AbortSignal|undefined;const store=new LocalStore(memoryStorage());const scanner=createScanner({readLibrary:async()=>snapshot(),readUid:async()=>'7',readMetadata:async()=>{const {genres,bpm,language}=makeSong('1');return {genres,bpm,language};},store});const c=new api.PanelController({readLibrary:async(s:AbortSignal)=>{signal=s;return new Promise(r=>done=r);},readUid:async()=>'7',readTargets:async()=>[],scanner,store});const pending=c.readLibrary();c.remove();assert.equal(signal?.aborted,true);done(snapshot());await pending;assert.equal(c.model.state.snapshot,null);assert.equal(c.status().installed,false);});


test('mounted panel uses literal malicious song/artist text, reuses instance and removes its own DOM',async()=>{
  const entry=await import('../panel/ui/entry') as any;
  assert.equal(typeof entry.mountOrganizer,'function','mount lifecycle is not implemented');
  class Element {
    children:any[]=[];parent:any=null;hidden=false;dataset:any={};style:any={};attributes:any={};value='';checked=false;disabled=false;className='';onclick:any;onchange:any;oninput:any;shadowRoot:any=null;private text='';
    constructor(public tagName:string){}
    set textContent(value:string){this.text=value;this.children=[];}get textContent(){return this.text+this.children.map(c=>c.textContent??'').join('');}
    set innerHTML(_v:string){throw Error('HTML sink');}
    append(...nodes:any[]){for(const node of nodes){this.children.push(node);node.parent=this;}}
    replaceChildren(...nodes:any[]){for(const node of this.children)node.parent=null;this.children=[];this.append(...nodes);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter((x:any)=>x!==this);this.parent=null;}
    setAttribute(key:string,value:string){this.attributes[key]=value;}
    attachShadow(){this.shadowRoot=new Element('shadow');return this.shadowRoot;}
    querySelector(){return null;}focus(){}getBoundingClientRect(){return {bottom:55};}
  }
  const listeners=new Map<string,Function>();const body=new Element('body');const foreign=new Element('foreign');body.append(foreign);
  const doc:any={body,documentElement:body,createElement:(tag:string)=>new Element(tag),createTextNode:(text:string)=>{const e=new Element('#text');e.textContent=text;return e;},querySelector:()=>null,addEventListener:(event:string,fn:Function)=>listeners.set(event,fn),removeEventListener:(event:string)=>listeners.delete(event)};
  const m=loaded();m.state.snapshot.songs[0].name='<img onerror=alert(1)>';m.state.snapshot.songs[0].artists.value[0].name='<svg onload=alert(2)>';
  const store=new LocalStore(memoryStorage());const scanner=createScanner({readLibrary:async()=>snapshot(),readUid:async()=>'7',readMetadata:async()=>({genres:makeSong('1').genres,bpm:makeSong('1').bpm,language:makeSong('1').language}),store});
  const controller=new api.PanelController({readLibrary:async()=>snapshot(),readUid:async()=>'7',readTargets:async()=>[],scanner,store});controller.model.state=m.state;
  const scope:any={};const first=entry.mountOrganizer({document:doc,scope,controller});const again=entry.mountOrganizer({document:doc,scope,controller});assert.equal(first,again);assert.equal(body.children.length,2);
  const host=body.children[1];const all=(node:any):any[]=>[node,...node.children.flatMap(all)];assert.equal(all(host.shadowRoot).some(n=>['img','svg'].includes(n.tagName)),false);assert.match(host.shadowRoot.textContent,/<img onerror=alert\(1\)>/);assert.match(host.shadowRoot.textContent,/<svg onload=alert\(2\)>/);
  assert.equal(first.status().readReady,true);assert.equal(first.status().writeVerification,'unverified');first.remove();assert.deepEqual(body.children,[foreign]);assert.equal(scope.__ncmOrganizerV1,undefined);assert.equal(listeners.size,0);
  const replacement=entry.mountOrganizer({document:doc,scope,controller:new api.PanelController({readLibrary:async()=>snapshot(),readUid:async()=>'7',readTargets:async()=>[],scanner,store})});assert.notEqual(replacement,first);replacement.remove();
});


test('idle account check is cancelled on removal without publishing late account data',async()=>{
  let done!:(uid:string)=>void;let signal:AbortSignal|undefined;const store=new LocalStore(memoryStorage());
  const scanner=createScanner({readLibrary:async()=>snapshot(),readUid:async()=>'7',readMetadata:async()=>({genres:makeSong('1').genres,bpm:makeSong('1').bpm,language:makeSong('1').language}),store});
  const c=new api.PanelController({readLibrary:async()=>snapshot(),readUid:async(s:AbortSignal)=>{signal=s;return new Promise(r=>done=r);},readTargets:async()=>[],scanner,store});c.model.setLibrary(snapshot());
  const check=c.checkAccount();c.remove();assert.equal(signal?.aborted,true);done('9');await check;assert.equal(c.model.state.uid,'7');
});

test('safe error display includes numeric business code and excludes raw payloads',async()=>{
  const store=new LocalStore(memoryStorage());const scanner=createScanner({readLibrary:async()=>snapshot(),readUid:async()=>'7',readMetadata:async()=>({genres:makeSong('1').genres,bpm:makeSong('1').bpm,language:makeSong('1').language}),store});
  const error=new ReadError('business',503);(error as any).message='RAW_SECRET_MESSAGE';(error as any).options={secret:'RAW_SECRET_OPTION'};
  const c=new api.PanelController({readLibrary:async()=>{throw error;},readUid:async()=>'7',readTargets:async()=>[],scanner,store});await c.readLibrary();
  assert.match(c.model.state.message,/503/);assert.match(c.model.state.message,/业务/);assert.equal(c.model.state.message.includes('RAW_SECRET'),false);assert.equal(JSON.stringify(c.status()).includes('503'),false);c.remove();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('older idle monitor success cannot clear a newer guarded library read', async () => {
  const oldMonitor = deferred<string>();
  let uidReads = 0;
  let monitorSignal: AbortSignal | undefined;
  const store = new LocalStore(memoryStorage());
  const scanner = createScanner({ readLibrary: async () => snapshot(), readUid: async () => '7',
    readMetadata: async () => { const { genres, bpm, language } = makeSong('1'); return { genres, bpm, language }; }, store });
  const controller = new api.PanelController({ readLibrary: async () => snapshot(),
    readUid: async (signal?: AbortSignal) => { if (uidReads++ === 0) { monitorSignal = signal; return oldMonitor.promise; } return '7'; },
    readTargets: async () => [], scanner, store });
  controller.model.setLibrary(snapshot());
  const checking = controller.checkAccount();
  await controller.readLibrary();
  assert.equal(controller.model.state.snapshot.uid, '7');
  oldMonitor.resolve('9');
  await checking;
  assert.equal(controller.model.state.snapshot?.uid, '7');
  assert.equal(controller.model.state.uid, '7');
  assert.equal(monitorSignal?.aborted, true);
  controller.remove();
});

test('older idle monitor error cannot abort or clear a newer active scan', async () => {
  const oldMonitor = deferred<string>();
  const metadata = deferred<Pick<import('../panel/core/model').SongRecord, 'genres' | 'bpm' | 'language'>>();
  let metadataStarted!: () => void;
  const started = new Promise<void>(resolve => { metadataStarted = resolve; });
  let scanSignal: AbortSignal | undefined;
  const store = new LocalStore(memoryStorage());
  const scanner = createScanner({ readLibrary: async () => snapshot(1), readUid: async () => '7',
    readMetadata: async (_id, signal) => { scanSignal = signal; metadataStarted(); return metadata.promise; }, store });
  const controller = new api.PanelController({ readLibrary: async () => snapshot(1), readUid: async () => oldMonitor.promise,
    readTargets: async () => [], scanner, store });
  controller.model.setLibrary(snapshot(1));
  const checking = controller.checkAccount();
  const scanning = controller.scan();
  await started;
  oldMonitor.reject(new ReadError('login', 301));
  await checking;
  assert.equal(scanSignal?.aborted, false);
  assert.equal(controller.model.state.snapshot?.uid, '7');
  const { genres, bpm, language } = makeSong('1');
  metadata.resolve({ genres, bpm, language });
  await scanning;
  assert.equal(controller.model.state.progress.phase, 'complete');
  assert.equal(controller.model.state.uid, '7');
  controller.remove();
});

test('resumed scan replaces stale paused message before awaited metadata',async()=>{
  const pending=deferred<Pick<import('../panel/core/model').SongRecord,'genres'|'bpm'|'language'>>();
  let start!:()=>void;const started=new Promise<void>(r=>start=r);const s=snapshot(1),store=new LocalStore(memoryStorage());
  const scanner=createScanner({readLibrary:async()=>s,readUid:async()=>'7',readMetadata:async()=>{start();return pending.promise;},store});
  const c=new api.PanelController({readLibrary:async()=>s,readUid:async()=>'7',readTargets:async()=>[],scanner,store});c.model.setLibrary(s);c.model.state.message='扫描已暂停，可以继续。';
  const run=c.scan();await started;assert.doesNotMatch(c.model.state.message,/已暂停/);assert.match(c.model.state.message,/扫描/);
  pending.resolve({genres:s.songs[0].genres,bpm:s.songs[0].bpm,language:s.songs[0].language});await run;c.remove();
});

test('existing target confirmation visibility comes from fresh detail when list omits it',async()=>{
  const read=async(path:string,data:any)=>path==='/api/user/playlist'?{code:200,more:false,playlist:[{id:10,name:'目标',specialType:0,creator:{userId:7}}]}:{code:200,playlist:{id:Number(data.id),name:'目标',specialType:0,creator:{userId:7},privacy:10}};
  const targets=await api.readTargets(read,'7','8');assert.equal(targets[0].visibility,'private');
  await assert.rejects(()=>api.readTargets(async(path:string,data:any)=>path==='/api/user/playlist'?read(path,data):{code:200,playlist:{id:10,name:'目标',specialType:0,creator:{userId:9},privacy:10}},'7','8'));
});

test('plain collectionChanged recovery error clears old complete collection and reload retains durable journal',async()=>{
  const store=new LocalStore(memoryStorage()),s=snapshot(3);
  const saved={plan:{taskId:'saved-uncertain',uid:'7',sourcePlaylistId:'8',sourceRevision:'["1","2","3"]',selectionVersion:'old',songIds:['1','2','3'],target:{kind:'new',name:'合成待核对',privacy:10}},targetId:null,beforePlaylistIds:['8'],creationState:'uncertain',batches:[],confirmedIds:[],updatedAt:1};
  store.save('7',{schemaVersion:1,uid:'7',scan:null,writeJournal:saved} as any);
  const scanner=createScanner({readLibrary:async()=>s,readUid:async()=>'7',readMetadata:async()=>({genres:s.songs[0].genres,bpm:s.songs[0].bpm,language:s.songs[0].language}),store});
  const writer={recover:async()=>({candidates:[],presentIds:[],sourceIds:['3','2','1'],sourceChanged:true})};
  const c=new api.PanelController({readLibrary:async()=>s,readUid:async()=>'7',readTargets:async()=>[],scanner,store,writer});
  c.model.setLibrary(s);c.model.setProgress({phase:'complete',processed:3,total:3},true);c.model.setFilters({...c.model.state.filters,allSongs:true});
  c.model.state.writeProgress={phase:'complete',total:3,added:0,alreadyPresent:3,failed:0,targetId:'10'};
  await c.reviewRecovery();assert.equal(c.model.state.snapshot,null);assert.notEqual(c.model.state.progress.phase,'complete');assert.deepEqual(c.model.preview().ids,[]);
  assert.equal(c.model.state.writeProgress,null);assert.equal(c.model.state.writeReview,null);assert.equal(c.model.state.confirmation,null);assert.match(c.model.state.message,/重新读取/);
  assert.equal(store.load('7')!.writeJournal!.plan.taskId,'saved-uncertain');await c.readLibrary();assert.equal(c.model.state.recoveryJournal.plan.taskId,'saved-uncertain');c.remove();
});
