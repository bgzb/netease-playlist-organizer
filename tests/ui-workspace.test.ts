import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelController } from '../panel/ui/panel';
import { createScanner } from '../panel/scan/scan';
import { LocalStore } from '../panel/scan/store';
import { ReadError } from '../panel/client/requests';
import { snapshot, memoryStorage } from './fixtures/read';
import { makeSong } from './fixtures/synthetic';
function setup(options:{fail?:'read'|'targets'|'account';wait?:Promise<void>}={}) {
  const calls={reads:0,metadata:0};const s=snapshot(3);const store=new LocalStore(memoryStorage());
  const scanner=createScanner({readLibrary:async()=>s,readUid:async()=>'7',readMetadata:async()=>{calls.metadata++;const {genres,bpm,language}=makeSong('1');return {genres,bpm,language};},store});
  const c=new PanelController({store,scanner,readLibrary:async()=>{calls.reads++;await options.wait;if(options.fail==='read')throw new ReadError('network');return s;},readUid:async()=>options.fail==='account'?'9':'7',readTargets:async()=>{if(options.fail==='targets')throw new ReadError('permission');return [];}});
  return {c,calls};
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
test('workspace mounts only current page; collapse keeps atomic task alive and completes without focus theft',async()=>{
 const {doc,listeners}=testDocument();const {c}=setup();const app=mountOrganizer({document:doc,scope:{},controller:c});const host=doc.body.children[0],root=host.shadowRoot!;
 const action=(key:string)=>{const e=walk(root).find(e=>e.dataset.action===key);assert.ok(e,key);return e;};
 assert.ok(action('prepare'));assert.equal(walk(root).some(n=>n.dataset.page==='filter'),false);
 const operation=c.prepareCollection();action('collapse').onclick!();const focus=doc.activeElement;await operation;await tick();assert.equal(action('workspace').hidden,true);assert.equal(doc.activeElement,focus);assert.match(action('entry').textContent,/完成/);
 app.show();await tick();assert.equal(action('workspace').hidden,false);assert.ok(walk(root).some(n=>n.dataset.page==='filter'));app.remove();assert.equal(listeners.size,0);assert.equal(doc.body.children.length,0);
});
