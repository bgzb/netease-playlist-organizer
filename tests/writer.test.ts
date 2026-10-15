import test from 'node:test';
import assert from 'node:assert/strict';
import * as writerModule from '../panel/write/writer';
import * as requests from '../panel/client/requests';
import type { WritePlan, WriteConfirmation, ReadPath } from '../panel/core/model';
import { LocalStore } from '../panel/scan/store';
import { memoryStorage, snapshot } from './fixtures/read';
const api = writerModule as any;
const transport = requests as any;
function plan(count=3, target:WritePlan['target']={kind:'new',name:'合成目标',privacy:10}):WritePlan {
  return {taskId:'synthetic-task',uid:'7',sourcePlaylistId:'8',sourceRevision:snapshot(count).revision,
    selectionVersion:'selection-1',songIds:snapshot(count).ids,target};
}
function confirmation(p:WritePlan):WriteConfirmation {return {uid:p.uid,sourceRevision:p.sourceRevision,selectionVersion:p.selectionVersion,targetKey:JSON.stringify(p.target),confirmedAt:1};}
function fixture(count=3) {
  let uid='7'; let revision=snapshot(count).ids;
  const tracks=new Set<string>();const calls:{path:string;data:Record<string,unknown>}[]=[];
  const lists:any[]=[{id:8,name:'喜欢',specialType:5,creator:{userId:7},privacy:10}];
  let loseCreate=false,loseAdd=false,addPartial=false,rateLimit=false;
  let onAdd: (()=>Promise<void>|void)|undefined;
  const storage=memoryStorage();const store=new LocalStore(storage);
  const read=async(path:ReadPath,data:Record<string,unknown>)=>{
    if(path==='/api/w/nuser/account/get')return {code:200,profile:{userId:uid}};
    if(path==='/api/user/playlist')return {code:200,more:false,playlist:lists};
    if(path==='/api/v6/playlist/detail') {const pid=String(data.id);const p=lists.find(p=>String(p.id)===pid);return {code:200,playlist:{...p,trackCount:pid==='8'?revision.length:tracks.size,trackIds:(pid==='8'?revision:[...tracks]).map(id=>({id})),tracks:[]}};}
    throw Error('unexpected read');
  };
  const factory=(path:string)=>async(data:Record<string,unknown>)=>{
    calls.push({path,data});
    if(path==='/api/playlist/create'){lists.push({id:10,name:data.name,specialType:0,subscribed:false,creator:{userId:uid},privacy:10});if(loseCreate)throw Error('private raw cause');return {code:200,playlist:{id:10}};}
    if(path==='/api/playlist/manipulate/tracks'){await onAdd?.();if(rateLimit)return {code:429};const ids=JSON.parse(String(data.trackIds));(addPartial?ids.slice(0,1):ids).forEach((id:string)=>tracks.add(id));if(loseAdd)throw Error('timeout');return {code:200};}
    throw Error('unexpected write path');
  };
  const make=()=>{assert.equal(typeof api.createWriter,'function','confirmed writer not implemented');assert.equal(typeof transport.createWriteApi,'function','restricted write transport not implemented');return api.createWriter({read,write:transport.createWriteApi(factory),store,now:()=>1});};
  return {make,store,storage,calls,tracks,lists,read,factory,setUid:(v:string)=>uid=v,setRevision:(v:string[])=>revision=v,
    loseCreate:()=>loseCreate=true,loseAdd:()=>{loseAdd=true;addPartial=true;},normalAdd:()=>{loseAdd=false;addPartial=false;},limit:()=>rateLimit=true,onAdd:(fn:()=>Promise<void>|void)=>onAdd=fn};
}
const signal=()=>new AbortController().signal;
test('unconfirmedPlanMakesNoWriteRequests',async()=>{const f=fixture(),w=f.make();await assert.rejects(w.executeWrite(plan(),null,signal(),()=>{}));assert.equal(f.calls.length,0);});
test('changed confirmation and changed ordered source reject before writes',async()=>{
  for(const mutation of ['uid','sourceRevision','selectionVersion','targetKey']){const f=fixture(),p=plan(),c:any=confirmation(p);c[mutation]='changed';await assert.rejects(f.make().executeWrite(p,c,signal(),()=>{}));assert.equal(f.calls.length,0);}
  const f=fixture(),p=plan();f.setRevision(['3','2','1']);const r=await f.make().executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(r.status,'paused');assert.equal(f.calls.length,0);
});
test('source and non-owned targets rejected and same-name target never auto selected',async()=>{
  for(const targetId of ['8','11']){const f=fixture();f.lists.push({id:11,name:'合成目标',specialType:0,creator:{userId:9},privacy:0});const p=plan(3,{kind:'existing',id:targetId});const r=await f.make().executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(r.status,'error');assert.equal(f.calls.length,0);}
  const f=fixture();f.lists.push({id:12,name:'合成目标',specialType:0,creator:{userId:7},privacy:10});const p=plan();const r=await f.make().executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(r.status,'error');assert.equal(f.calls.length,0);
});
test('lostCreateResponseDoesNotCreateAgain',async()=>{
  const f=fixture();f.loseCreate();const p=plan(),w=f.make();const firstReport=await w.executeWrite(p,confirmation(p),signal(),()=>{});
  assert.equal(firstReport.status,'uncertain');assert.equal(f.store.load('7')!.writeJournal!.creationState,'uncertain');
  const recovered=await f.make().recover(p,signal());assert.deepEqual(recovered.candidates.map((p:any)=>p.id),['10']);
  const second=await f.make().executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(second.status,'uncertain');
  assert.equal(f.calls.filter(c=>c.path==='/api/playlist/create').length,1);assert.equal(f.calls.filter(c=>c.path==='/api/playlist/manipulate/tracks').length,0);
});
test('writes only private create and serial <=50 add; repeat adds nothing already present',async()=>{
  const f=fixture(103),p=plan(103),w=f.make();const r=await w.executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(r.status,'complete');assert.equal(f.tracks.size,103);
  assert.deepEqual(f.calls[0],{path:'/api/playlist/create',data:{name:'合成目标',privacy:10,type:'NORMAL'}});
  assert.deepEqual(f.calls.slice(1).map(c=>JSON.parse(String(c.data.trackIds)).length),[50,50,3]);
  assert.ok(f.calls.slice(1).every(c=>c.data.op==='add'&&c.data.pid==='10'&&c.data.imme==='true'));
  const repeat=await w.executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(repeat.status,'complete');assert.equal(f.calls.length,4);assert.deepEqual(repeat.alreadyPresentIds,p.songIds);
});
test('account changes during batch blocks every later write',async()=>{
  const f=fixture(60);f.onAdd(()=>{f.setUid('9');});const p=plan(60);const r=await f.make().executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(r.status,'paused');assert.equal(f.calls.length,2);assert.equal(f.store.load('7')!.writeJournal!.batches[0].state,'uncertain');
});
test('adding timeout reads back partial success and explicit confirmed resume adds only missing',async()=>{
  const f=fixture();f.loseAdd();const p=plan(),w=f.make();const r=await w.executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(r.status,'uncertain');assert.deepEqual(r.addedIds,['1']);assert.deepEqual(r.unconfirmedIds,['2','3']);assert.equal(f.calls.length,2);
  const recovery=await w.recover(p,signal());assert.deepEqual(recovery.presentIds,['1']);assert.equal(f.calls.length,2);
  f.normalAdd();const resumed=await w.executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(resumed.status,'complete');assert.deepEqual(JSON.parse(String(f.calls[2].data.trackIds)),['2','3']);
});
test('rate limiting pauses without automatic retry',async()=>{const f=fixture();f.limit();const p=plan();const r=await f.make().executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(r.status,'paused');assert.equal(f.calls.length,2);});
test('journal save fails before next network and scan checkpoint is preserved',async()=>{
  const f=fixture();const scan={snapshot:snapshot(),completedIds:[],cache:{},phase:'paused' as const,updatedAt:1};f.store.save('7',{schemaVersion:1,uid:'7',scan,writeJournal:null});
  const p=plan();await f.make().executeWrite(p,confirmation(p),signal(),()=>{});assert.deepEqual(f.store.load('7')!.scan,scan);
  const g=fixture();g.storage.setItem=()=>{throw Error('quota');};const r=await g.make().executeWrite(plan(),confirmation(plan()),signal(),()=>{});assert.equal(r.status,'paused');assert.equal(g.calls.length,0);
  const h=fixture(60);h.onAdd(()=>{h.storage.setItem=()=>{throw Error('quota');};});const q=plan(60);const halted=await h.make().executeWrite(q,confirmation(q),signal(),()=>{});assert.equal(halted.status,'paused');assert.equal(h.calls.length,2);
});
test('write transport runtime rejects wrong routes, del, invalid privacy and oversized payloads',async()=>{
  const f=fixture();assert.equal(typeof transport.createWriteApi,'function');const write=transport.createWriteApi(f.factory);
  for(const [path,data] of [['/api/playlist/delete',{id:'10'}],['/api/playlist/create',{name:'x',privacy:0,type:'NORMAL'}],['/api/playlist/create',{name:'x',privacy:10,type:'NORMAL',extra:'secret'}],['/api/playlist/manipulate/tracks',{op:'del',pid:'10',trackIds:'["1"]',imme:'true'}],['/api/playlist/manipulate/tracks',{op:'add',pid:'10',trackIds:JSON.stringify(snapshot(51).ids),imme:'true'}]])await assert.rejects(write(path,data));
  assert.equal(f.calls.length,0);
});

import { PanelController } from '../panel/ui/panel';
import { createScanner } from '../panel/scan/scan';
function controllerFixture(count=3) {
  const f=fixture(count);const s=snapshot(count);
  const scanner=createScanner({readLibrary:async()=>s,readUid:async()=>'7',readMetadata:async()=>({genres:s.songs[0].genres,bpm:s.songs[0].bpm,language:s.songs[0].language}),store:f.store});
  const c:any=new PanelController({readLibrary:async()=>s,readUid:async()=>'7',readTargets:(uid:string,source:string,s:AbortSignal)=>(targetUi as any).readTargets(f.read,uid,source,s),scanner,store:f.store,writer:f.make()} as any);
  c.model.setLibrary(s);c.model.setProgress({phase:'complete',processed:count,total:count},true);
  c.model.setFilters({...c.model.state.filters,allSongs:true});c.model.setTarget({kind:'new',name:'合成目标',privacy:10});
  return {f,c};
}
test('UI preparation and changed selection never dispatch real writer transport without new final confirmation',async()=>{
  const {f,c}=controllerFixture();assert.equal(typeof c.prepareWrite,'function','UI write review not implemented');
  c.prepareWrite();assert.equal(f.calls.length,0);
  c.model.manual('1','remove');await c.confirmWrite();assert.equal(f.calls.length,0);
  c.prepareWrite();await c.confirmWrite();assert.equal(f.tracks.size,2);assert.deepEqual([...f.tracks],['2','3']);assert.equal(c.status().writeVerification,'unverified');c.remove();
});
test('filter, manual and target edits during awaited add abort every later writer batch',async()=>{
  for(const mutate of [(c:any)=>c.model.manual('1','remove'),(c:any)=>c.model.setFilters({...c.model.state.filters,bpmMin:80}),(c:any)=>c.model.setTarget({kind:'new',name:'修改目标',privacy:10})]){
    const {f,c}=controllerFixture(60);assert.equal(typeof c.prepareWrite,'function');f.onAdd(()=>mutate(c));c.prepareWrite();await c.confirmWrite();assert.equal(f.calls.length,2);assert.equal(c.model.state.confirmation,null);assert.equal(c.model.state.writeReport.status,'paused');c.remove();
  }
});
test('remove during issued add accounts for operation and schedules no later batches',async()=>{
  const {f,c}=controllerFixture(60);assert.equal(typeof c.prepareWrite,'function');f.onAdd(()=>c.remove());c.prepareWrite();await c.confirmWrite();assert.equal(f.calls.length,2);assert.equal(f.store.load('7')!.writeJournal!.batches[0].state,'uncertain');
});
test('explicit candidate adoption requires a fresh target review and prevents another create',async()=>{
  const f=fixture();f.loseCreate();const p=plan(),w=f.make();await w.executeWrite(p,confirmation(p),signal(),()=>{});
  const next={...p,target:{kind:'existing' as const,id:'10'},selectionVersion:'fresh-review'};
  assert.equal(typeof w.adoptCandidate,'function');await w.adoptCandidate(p,'10',next,signal());
  await assert.rejects(w.executeWrite(next,confirmation(p),signal(),()=>{}));assert.equal(f.calls.length,1);
  const r=await w.executeWrite(next,confirmation(next),signal(),()=>{});assert.equal(r.status,'complete');assert.equal(f.calls.length,2);
});

import * as targetUi from '../panel/ui/target';
const renderWriteControls=(doc:Document,c:any,page=0)=>{const footer=doc.createElement('footer'),root=doc.createElement('div');root.append((targetUi as any).renderWriteControls(doc,c,{footer,page,setPage:()=>{}}),footer);return root;};
function testDocument() {
  class Element {
    children:Element[]=[];dataset:Record<string,string>={};disabled=false;onclick:(()=>unknown)|null=null;private text='';
    constructor(public tagName:string){}set textContent(v:string){this.text=v;this.children=[];}get textContent():string{return this.text+this.children.map(c=>c.textContent).join('');}
    append(...nodes:Element[]){this.children.push(...nodes);}setAttribute(){}set innerHTML(_v:string){throw Error('HTML sink');}
  }
  return {createElement:(tag:string)=>new Element(tag)} as unknown as Document;
}
test('actual confirmation renderer shows every selected song/manual flag and dispatches only final click',async()=>{
  const {f,c}=controllerFixture(53);c.model.manual('1','add');c.model.state.snapshot.songs[0].name='<svg onload=alert(1)>';
  const doc=testDocument();assert.equal(typeof renderWriteControls,'function','final write controls not implemented');
  let root:any=renderWriteControls(doc,c);const all=(n:any):any[]=>[n,...n.children.flatMap(all)];
  const review=all(root).find(n=>n.dataset.key==='write-review');assert.ok(review);review.onclick();assert.equal(f.calls.length,0);
  root=renderWriteControls(doc,c);const rows=all(root).filter(n=>n.dataset.songId);assert.equal(rows.length,50);const rest=all(renderWriteControls(doc,c,1)).filter(n=>n.dataset.songId);assert.equal(rest.length,3);assert.deepEqual([...rows,...rest].map(n=>n.dataset.songId),snapshot(53).ids);
  assert.match(root.textContent,/人工加入/);assert.match(root.textContent,/私密/);assert.match(root.textContent,/<svg onload=alert\(1\)>/);assert.equal(all(root).some(n=>n.tagName==='svg'),false);
  const button=all(root).find(n=>n.dataset.key==='write-confirm');assert.ok(button);await button.onclick();assert.equal(f.tracks.size,53);c.remove();
});
test('recovery UI exposes candidate choice without selecting or writing automatically',async()=>{
  const {f,c}=controllerFixture();f.loseCreate();c.prepareWrite();await c.confirmWrite();const before=f.calls.length;
  await c.reviewRecovery();assert.equal(f.calls.length,before);assert.equal(c.model.state.confirmation,null);assert.deepEqual(c.model.state.recoveryCandidates.map((p:any)=>p.id),['10']);
  const root:any=renderWriteControls(testDocument(),c);const all=(n:any):any[]=>[n,...n.children.flatMap(all)];
  const choice=all(root).find(n=>n.dataset.key==='recovery-10');assert.ok(choice);await choice.onclick();assert.equal(f.calls.length,before);assert.equal(c.model.state.confirmation,null);
  c.prepareWrite();await c.confirmWrite();assert.equal(f.calls.filter(c=>c.path==='/api/playlist/create').length,1);assert.equal(f.tracks.size,3);c.remove();
});

test('create rate limit pauses with one request and cannot blindly recreate',async()=>{
  const f=fixture();let creates=0;
  const w=api.createWriter({read:f.read,write:transport.createWriteApi((path:string)=>async()=>{assert.equal(path,'/api/playlist/create');creates++;return {code:429};}),store:f.store});
  const p=plan(),r=await w.executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(r.status,'paused');assert.ok(r.errors.includes('rateLimit'));
  const retry=await w.executeWrite(p,confirmation(p),signal(),()=>{});assert.equal(retry.status,'uncertain');assert.equal(creates,1);
});
test('candidate adoption retains recovery network records rather than overwriting a stale journal copy',async()=>{
  const f=fixture();f.loseCreate();const p=plan(),w=f.make();await w.executeWrite(p,confirmation(p),signal(),()=>{});
  const before=f.store.load('7')!.writeJournal!.operations!.filter(op=>op.kind==='/api/user/playlist').length;
  await w.adoptCandidate(p,'10',{...p,target:{kind:'existing',id:'10'},selectionVersion:'new'},signal());
  const operations=f.store.load('7')!.writeJournal!.operations!;
  assert.equal(operations.filter(op=>op.kind==='/api/user/playlist').length,before+1);assert.ok(operations.every(op=>op.state!=='pending'));
});

test('source changes during uncertain creation can be inspected and explicitly rebound to a new reviewed list',async()=>{
  const f=fixture();f.loseCreate();const p=plan(),w=f.make();await w.executeWrite(p,confirmation(p),signal(),()=>{});
  f.setRevision(['3','2','1','4']);
  const recovery=await w.recover(p,signal());assert.equal(recovery.sourceChanged,true);assert.deepEqual(recovery.sourceIds,['3','2','1','4']);assert.deepEqual(recovery.candidates.map((p:any)=>p.id),['10']);assert.equal(f.calls.length,1);
  const fresh={...p,sourceRevision:'["3","2","1","4"]',songIds:['3','4'],target:{kind:'existing' as const,id:'10'},selectionVersion:'fresh-changed-list'};
  await w.adoptCandidate(p,'10',fresh,signal());await assert.rejects(w.executeWrite(fresh,confirmation(p),signal(),()=>{}));assert.equal(f.calls.length,1);
  const r=await w.executeWrite(fresh,confirmation(fresh),signal(),()=>{});assert.equal(r.status,'complete');assert.deepEqual([...f.tracks],['3','4']);assert.equal(f.calls.length,2);
});

test('UI restored journal belongs only to its account and confirmation never restores',async()=>{
  const {f,c}=controllerFixture();c.prepareWrite();await c.confirmWrite();assert.equal(c.model.state.confirmation,null);
  c.model.setAccount('9');assert.equal(c.model.state.recoveryJournal,null);assert.equal(c.model.state.writeProgress,null);assert.equal(c.model.state.writeReport,null);assert.equal(f.store.load('9'),null);assert.ok(f.store.load('7')!.writeJournal);c.remove();
});
test('every actual create/add sees a durable pending operation and completion persists its readback',async()=>{
  const f=fixture();const write=transport.createWriteApi((path:string)=>async(data:Record<string,unknown>)=>{
    const j=f.store.load('7')!.writeJournal!;
    assert.equal(j.operations![j.operations!.length-1]!.state,'pending');
    assert.equal(j.operations![j.operations!.length-1]!.kind,path==='/api/playlist/create'?'create':'add');
    if(path==='/api/playlist/create')assert.equal(j.creationState,'pending');else assert.equal(j.batches[j.batches.length-1]!.state,'pending');
    return f.factory(path)(data);
  });
  const p=plan(),r=await api.createWriter({read:f.read,write,store:f.store}).executeWrite(p,confirmation(p),signal(),()=>{});
  assert.equal(r.status,'complete');const j=f.store.load('7')!.writeJournal!;assert.deepEqual(j.readbackIds,['1','2','3']);assert.ok(j.operations!.every(op=>op.state==='confirmed'));
});

test('no-candidate unknown create permits a differently named explicit new plan only after fresh final click',async()=>{
  const {f,c}=controllerFixture();f.loseCreate();c.prepareWrite();await c.confirmWrite();f.lists.pop();await c.reviewRecovery();assert.deepEqual(c.model.state.recoveryCandidates,[]);
  c.model.setTarget({kind:'new',name:'明确重新计划',privacy:10});c.prepareWrite();assert.ok(c.model.state.writeReview);assert.equal(f.calls.length,1);
  assert.equal(f.store.load('7')!.writeJournal!.creationState,'uncertain');
  await c.confirmWrite();assert.equal(f.calls.filter(c=>c.path==='/api/playlist/create').length,2);assert.equal(f.calls[1].data.name,'明确重新计划');c.remove();
});

test('lost create recovery resolves omitted list privacy through guarded journaled detail without any new writes',async()=>{
  const f=fixture();f.loseCreate();let detailReads=0;
  const read=async(path:ReadPath,data:Record<string,unknown>)=>{
    if(path==='/api/v6/playlist/detail'&&String(data.id)==='10'){
      detailReads++;
      const operations=f.store.load('7')!.writeJournal!.operations!;
      assert.equal(operations[operations.length-1].kind,path);assert.equal(operations[operations.length-1].state,'pending');
    }
    const value=await f.read(path,data);
    if(path==='/api/user/playlist')return {...value,playlist:f.lists.map(p=>{const {privacy,...listing}=p;return listing;})};
    return value;
  };
  const w=api.createWriter({read,write:transport.createWriteApi(f.factory),store:f.store}),p=plan();
  assert.equal((await w.executeWrite(p,confirmation(p),signal(),()=>{})).status,'uncertain');
  assert.deepEqual((await w.recover(p,signal())).candidates,[{id:'10',name:'合成目标',privacy:10}]);assert.equal(detailReads,1);
  const journal=f.store.load('7')!.writeJournal!;assert.ok(journal.operations!.every(op=>op.state!=='pending'));
  assert.equal(f.calls.filter(c=>c.path==='/api/playlist/create').length,1);assert.equal(f.calls.filter(c=>c.path==='/api/playlist/manipulate/tracks').length,0);
});
test('omitted-privacy recovery excludes public malformed and mismatched candidate details',async()=>{
  for(const override of [{privacy:0},{privacy:null},{id:11},{name:'不同名称'},{creator:{userId:9}},{specialType:5},{subscribed:true},{trackIds:null}]){
    const f=fixture();f.loseCreate();const read=async(path:ReadPath,data:Record<string,unknown>)=>{
      const value:any=await f.read(path,data);
      if(path==='/api/user/playlist')return {...value,playlist:f.lists.map(p=>{const {privacy,...listing}=p;return listing;})};
      if(path==='/api/v6/playlist/detail'&&String(data.id)==='10')return {...value,playlist:{...value.playlist,...override}};
      return value;
    };
    const w=api.createWriter({read,write:transport.createWriteApi(f.factory),store:f.store}),p=plan();await w.executeWrite(p,confirmation(p),signal(),()=>{});
    assert.deepEqual((await w.recover(p,signal())).candidates,[]);assert.equal(f.calls.length,1);
  }
});
test('source reorder at final confirmation clears collection rows/progress/approval but preserves recoverable journal',async()=>{
  const {f,c}=controllerFixture();c.prepareWrite();const taskId=c.model.state.writeReview.taskId;f.setRevision(['3','2','1']);await c.confirmWrite();
  assert.equal(c.model.state.snapshot,null);assert.notEqual(c.model.state.progress.phase,'complete');assert.deepEqual(c.model.preview().ids,[]);
  assert.equal(c.model.state.confirmation,null);assert.equal(c.model.state.writeReview,null);assert.equal(c.model.state.writeProgress,null);assert.equal(c.model.state.writeReport,null);
  assert.match(c.model.state.message,/收藏.*变化/);assert.match(c.model.state.message,/重新读取/);assert.equal(f.calls.length,0);
  assert.equal(f.store.load('7')!.writeJournal!.plan.taskId,taskId);c.prepareWrite();await c.confirmWrite();assert.equal(f.calls.length,0);
  await c.readLibrary();assert.equal(c.model.state.recoveryJournal.plan.taskId,taskId);assert.equal(c.model.state.confirmation,null);c.remove();
});

test('candidate visibility detail fallback preserves account storage and cancellation stops',async()=>{
  for(const cause of ['accountChanged','storage','paused']){
    const f=fixture();f.loseCreate();const abort=new AbortController();
    const read=async(path:ReadPath,data:Record<string,unknown>)=>{
      const value=await f.read(path,data);
      if(path==='/api/user/playlist')return {...value,playlist:f.lists.map(p=>{const {privacy,...listing}=p;return listing;})};
      if(path==='/api/v6/playlist/detail'&&String(data.id)==='10'){
        if(cause==='accountChanged')f.setUid('9');
        if(cause==='storage')f.storage.setItem=()=>{throw Error('quota');};
        if(cause==='paused')abort.abort();
      }
      return value;
    };
    const w=api.createWriter({read,write:transport.createWriteApi(f.factory),store:f.store}),p=plan();await w.executeWrite(p,confirmation(p),signal(),()=>{});
    await assert.rejects(w.recover(p,abort.signal),(error:any)=>error.kind===cause);assert.equal(f.calls.length,1);
  }
});
