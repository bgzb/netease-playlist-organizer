import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelController } from '../panel/ui/panel';
import { createScanner } from '../panel/scan/scan';
import { LocalStore } from '../panel/scan/store';
import { ReadError } from '../panel/client/requests';
import { snapshot, memoryStorage } from './fixtures/read';
import { makeSong } from './fixtures/synthetic';
import {createWriter} from '../panel/write/writer';
function setup(options:{fail?:'read'|'targets'|'account';wait?:Promise<void>;count?:number;writing?:boolean;uncertain?:boolean;writeWait?:Promise<void>}={}) {
  const calls={reads:0,metadata:0};const s=snapshot(options.count??3);const store=new LocalStore(memoryStorage());
  const scanner=createScanner({readLibrary:async()=>s,readUid:async()=>'7',readMetadata:async()=>{calls.metadata++;const {genres,bpm,language}=makeSong('1');return {genres,bpm,language};},store});
  const writes:{path:string;data:any}[]=[];const tracks=new Set<string>();const lists=[{id:8,name:'来源',specialType:5,privacy:10,creator:{userId:7}},{id:9,name:'已有目标',specialType:0,privacy:0,subscribed:false,creator:{userId:7}}];
  const writer=options.writing?createWriter({store,read:async(path,data)=>{if(path==='/api/w/nuser/account/get')return {code:200,profile:{userId:7}};if(path==='/api/user/playlist')return {code:200,more:false,playlist:lists};if(path==='/api/v6/playlist/detail'){const ids=String(data.id)==='8'?s.ids:[...tracks];return {code:200,playlist:{...lists.find(p=>String(p.id)===String(data.id)),trackCount:ids.length,trackIds:ids.map(id=>({id:Number(id)}))}};}throw Error(path);},write:async(path,data)=>{writes.push({path,data});await options.writeWait;if(path==='/api/playlist/create'){lists.push({id:10,name:String(data.name),specialType:0,privacy:10,subscribed:false,creator:{userId:7}});if(options.uncertain)throw new ReadError('network');return {code:200,playlist:{id:10}};}for(const id of JSON.parse(String(data.trackIds)))tracks.add(String(id));return {code:200};}}):undefined;
  const c=new PanelController({store,scanner,writer,readLibrary:async()=>{calls.reads++;await options.wait;if(options.fail==='read')throw new ReadError('network');return s;},readUid:async()=>options.fail==='account'?'9':'7',readTargets:async()=>{if(options.fail==='targets')throw new ReadError('permission');return [];}});
  return {c,calls,writes,store};
}
test('atomic prepare locks immediately, reads once and scans automatically',async()=>{
 const {c,calls}=setup();const first=(c as any).prepareCollection();assert.equal(c.isBusy,true);assert.equal((c as any).operationKind,'prepare');await (c as any).prepareCollection();await first;
 assert.equal(calls.reads,1);assert.equal(calls.metadata,3);assert.equal(c.model.state.progress.phase,'complete');assert.equal((c as any).operationKind,'idle');assert.equal((c as any).uiOperation.status,'succeeded');c.remove();
});
for(const fail of ['read','targets','account'] as const)test(`prepare ${fail} failure never dispatches metadata`,async()=>{const {c,calls}=setup({fail});await (c as any).prepareCollection();assert.equal(calls.metadata,0);assert.equal((c as any).uiOperation.status,'failed');c.remove();});
for(const action of ['pause','remove'] as const)test(`prepare ${action} during reading prevents subsequent scan`,async()=>{let done!:()=>void;const {c,calls}=setup({wait:new Promise<void>(r=>done=r)});const running=(c as any).prepareCollection();c[action]();done();await running;assert.equal(calls.metadata,0);});
import {createWorkspaceState,canEnterPage,reconcileWorkspace} from '../panel/ui/workspace-state';
test('page gates require complete data and nonzero valid selection, without requiring target',async()=>{const {c}=setup();assert.equal(canEnterPage('filter',c),false);assert.equal(canEnterPage('write',c),false);await c.prepareCollection();assert.equal(canEnterPage('filter',c),true);assert.equal(canEnterPage('write',c),false);c.model.setFilters({...c.model.state.filters,allSongs:true});assert.equal(c.model.state.target,null);assert.equal(canEnterPage('write',c),true);assert.equal(canEnterPage('result',c),false);c.remove();});
test('completion consumed once, collapsed stays hidden and account reset discards old event',async()=>{const {c}=setup();let state=createWorkspaceState();const running=c.prepareCollection();state=reconcileWorkspace({...state,collapsed:true},c);await running;state=reconcileWorkspace(state,c);assert.equal(state.page,'filter');assert.equal(state.collapsed,true);state=reconcileWorkspace({...state,page:'prepare'},c);assert.equal(state.page,'prepare');c.model.setAccount('9');state=reconcileWorkspace({...state,detailSongId:'1'},c);assert.equal(state.page,'prepare');assert.equal(state.detailSongId,null);c.remove();});
test('uncertain and read-only recovery reports never unlock successful result',()=>{const {c}=setup();c.model.setLibrary(snapshot());c.model.state.writeReport={taskId:'x',targetId:'10',status:'uncertain',addedIds:[],alreadyPresentIds:[],unconfirmedIds:['1'],errors:[]};assert.equal(canEnterPage('result',c),false);c.model.state.writeReport.status='complete';assert.equal(canEnterPage('result',c),false);c.model.state.writeReport.unconfirmedIds=[];assert.equal(canEnterPage('result',c),true);c.remove();});
import {testDocument,walk} from './fixtures/dom';
import {mountOrganizer} from '../panel/ui/entry';
const tick=()=>new Promise(r=>setTimeout(r,280));
test('workspace mounts only current page; collapse keeps atomic task alive and completes without focus theft',async(t)=>{
 const {doc,listeners}=testDocument();const {c}=setup();const app=mountOrganizer({document:doc,scope:{},controller:c});t.after(()=>app.remove());const host=doc.body.children[0],root=host.shadowRoot!;
 const action=(key:string)=>{const e=walk(root).find(e=>e.dataset.action===key);assert.ok(e,key);return e;};
 assert.ok(action('prepare'));assert.equal(walk(root).some(n=>n.dataset.page==='filter'),false);
 const operation=c.prepareCollection();action('collapse').onclick!();const focus=doc.activeElement;await operation;await tick();assert.equal(action('workspace').hidden,true);assert.equal(doc.activeElement,focus);assert.match(action('entry').textContent,/完成/);
 app.show();await tick();assert.equal(action('workspace').hidden,false);assert.ok(walk(root).some(n=>n.dataset.page==='filter'));app.remove();assert.equal(listeners.size,0);assert.equal(doc.body.children.length,0);
});

test('203 songs paginate display only, checkbox keeps DOM/scroll/detail, filter edits reset page',async(t)=>{
 const {doc}=testDocument(),{c}=setup({count:203});const app=mountOrganizer({document:doc,scope:{},controller:c});t.after(()=>app.remove());await c.prepareCollection();c.model.setFilters({...c.model.state.filters,allSongs:true});c.changed();
 const root=doc.body.children[0].shadowRoot!;const find=(key:string)=>{const e=walk(root).find(n=>n.dataset.action===key);assert.ok(e,key);return e;};const rows=()=>walk(root).filter(n=>n.className==='song');
 assert.equal(rows().length,50);assert.match(root.textContent,/总入选 203 首/);assert.equal(find('to-write').disabled,false);
 find('page-next').onclick!();assert.equal(rows()[0].dataset.songId,'51');rows()[0].onclick!();assert.match(find('song-detail').textContent,/合成歌曲/);const checkbox=walk(rows()[0]).find(n=>n.type==='checkbox')!;const list=find('song-list');list.scrollTop=120;checkbox.checked=false;checkbox.onchange!();assert.equal(c.model.preview().ids.length,202);assert.equal(find('song-list'),list);assert.equal(list.scrollTop,120);assert.equal(walk(rows()[0]).find(n=>n.type==='checkbox'),checkbox);assert.equal(find('song-detail').hidden,false);
 find('page-next').onclick!();find('page-next').onclick!();find('page-next').onclick!();assert.equal(rows().length,3);find('page-prev').onclick!();find('page-prev').onclick!();find('page-prev').onclick!();find('page-prev').onclick!();assert.equal(c.model.preview().ids.includes('51'),false);
 find('page-next').onclick!();const all=walk(root).find(n=>n.dataset.key==='all-songs')!;all.checked=false;all.onchange!();assert.equal(find('pagination').textContent.includes('1 /'),true);
});

test('complete plan spans203 songs; final click alone writes, repeat guard and fresh review clear prior result',async(t)=>{
 const {c,writes}=setup({count:203,writing:true});await c.prepareCollection();c.model.setFilters({...c.model.state.filters,allSongs:true});const {doc}=testDocument();const app=mountOrganizer({document:doc,scope:{},controller:c});t.after(()=>app.remove());const root=doc.body.children[0].shadowRoot!;
 const a=(key:string)=>{const n=walk(root).find(e=>e.dataset.action===key||e.dataset.key===key);assert.ok(n,key);return n;};a('nav-filter').onclick!();a('to-write').onclick!();assert.equal(a('write-review').disabled,true);a('target-new').onclick!();a('write-review').onclick!();assert.equal(c.model.state.writeReview!.songIds.length,203);assert.equal(walk(root).filter(n=>n.dataset.reviewSongId).length,50);a('review-next').onclick!();assert.equal(walk(root).find(n=>n.dataset.reviewSongId)?.dataset.reviewSongId,'51');assert.equal(writes.length,0);
 const pending=c.confirmWrite();await c.confirmWrite();await pending;assert.equal(c.model.state.writeReport?.status,'complete');assert.equal(writes.filter(w=>w.path==='/api/playlist/create').length,1);assert.ok(walk(root).some(n=>n.dataset.page==='result'));
 a('back-filter').onclick!();assert.equal(c.model.preview().ids.length,203);assert.equal(c.model.state.writeReview,null);a('to-write').onclick!();a('write-review').onclick!();assert.equal(c.model.state.writeReport,null);assert.equal(c.model.state.writeProgress,null);
});
test('unknown creation stays in write page and journal survives a fresh instance',async(t)=>{
 const {c,writes,store}=setup({writing:true,uncertain:true});const {doc}=testDocument();const app=mountOrganizer({document:doc,scope:{},controller:c});t.after(()=>app.remove());await c.prepareCollection();c.model.setFilters({...c.model.state.filters,allSongs:true});c.changed();const root=doc.body.children[0].shadowRoot!;const a=(key:string)=>walk(root).find(n=>n.dataset.action===key||n.dataset.key===key)!;
 a('to-write').onclick!();a('target-new').onclick!();a('write-review').onclick!();await c.confirmWrite();assert.equal(c.model.state.writeReport?.status,'uncertain');assert.ok(walk(root).some(n=>n.dataset.page==='write'));assert.equal(a('nav-result').disabled,true);assert.equal(writes.length,1);assert.equal(store.load('7')!.writeJournal!.creationState,'uncertain');app.remove();const fresh=new (c.model.constructor as any)();assert.equal(fresh.state.filters.allSongs,false);assert.equal(store.load('7')!.writeJournal!.creationState,'uncertain');
});
test('pausing an issued write preserves completed scan and returns idle only after settling',async(t)=>{
 let finish!:()=>void;const {c}=setup({writing:true,writeWait:new Promise<void>(r=>finish=r)});t.after(()=>c.remove());await c.prepareCollection();c.model.setFilters({...c.model.state.filters,allSongs:true});c.model.setTarget({kind:'new',name:'暂停测试',privacy:10});c.prepareWrite();const run=c.confirmWrite();await new Promise(r=>setTimeout(r,0));c.pause();assert.equal(c.model.state.progress.phase,'complete');finish();await run;assert.equal(c.isBusy,false);assert.equal(canEnterPage('filter',c),true);
});
