import test from 'node:test';
import assert from 'node:assert/strict';
import {PanelController} from '../panel/ui/panel';
import {createScanner} from '../panel/scan/scan';
import {LocalStore} from '../panel/scan/store';
import {memoryStorage,snapshot} from './fixtures/read';
import {makeSong} from './fixtures/synthetic';
import {createWriter} from '../panel/write/writer';
import type {SourceSelection,SourceCatalog,StoredPlaylistScan} from '../panel/core/model';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function fixture(){
  const storage=memoryStorage(),store=new LocalStore(storage),started=deferred(),gate=deferred();
  let delay=false,uid='7',calls=0,bReads=0,catalogFailure=false,readFailure=false;
  const catalog:SourceCatalog={uid:'7',favoritesId:'8',created:[{id:'9',name:'自己',creatorUid:'7'}],collected:[{id:'20',name:'他人',creatorUid:'99'}]};
  const readLibrary=async(source:SourceSelection)=>{const pid=source.kind==='favorites'?'8':source.id;if(pid==='9')bReads++;if(readFailure)throw Error('network');return snapshot(2,uid,pid);};
  const listSources=async()=>{if(catalogFailure)throw Error('network');return {...catalog,uid};};
  const scanner=createScanner({readLibrary:id=>readLibrary({kind:'playlist',id}),readUid:async()=>uid,readMetadata:async()=>{calls++;started.resolve();if(delay)await gate.promise;const {genres,bpm,language}=makeSong('1');return {genres,bpm,language};},store});
  const writer=createWriter({store,read:async()=>({code:200,profile:{userId:uid}}),write:async()=>{throw Error('unexpected synthetic write');}});
  const controller=new PanelController({readLibrary,listSources,readUid:async()=>uid,readTargets:async()=>[],scanner,store,writer});
  const save=(pid='8')=>{const s=snapshot(2,'7',pid);const value:StoredPlaylistScan={schemaVersion:2,uid:'7',source:s.source!,checkpoint:{snapshot:s,cache:{},completedIds:['1','2'],phase:'complete',updatedAt:100},lastCompletedAt:100};store.saveScan('7',pid,value);};
  return {controller,scanner,store,storage,started,gate,save,delay:()=>delay=true,calls:()=>calls,bReads:()=>bReads,setUid:(v:string)=>uid=v,failCatalog:()=>catalogFailure=true,failReads:()=>readFailure=true,allowReads:()=>readFailure=false};
}
test('initialization restores favorites cache without starting metadata and same source preserves choices',async()=>{
  const f=fixture();f.save();assert.equal(typeof f.controller.initialize,'function');
  await f.controller.initialize();assert.equal(f.calls(),0);assert.equal(f.controller.model.state.snapshot?.sourcePlaylistId,'8');
  f.controller.model.setFilters({...f.controller.model.state.filters,allSongs:true});
  await f.controller.selectSource({kind:'playlist',id:'008'});assert.equal(f.controller.model.state.filters.allSongs,true);
});
test('switch waits for persisted pause before reading a second source',async()=>{
  const f=fixture();assert.equal(typeof f.controller.initialize,'function');await f.controller.initialize();
  f.delay();const scan=f.controller.scan();await f.started.promise;
  const change=f.controller.selectSource({kind:'playlist',id:'9'});
  assert.equal(f.bReads(),0);assert.equal(f.controller.model.state.snapshot?.sourcePlaylistId,'8');
  f.gate.resolve();await Promise.all([scan,change]);
  assert.equal(f.store.loadScan('7','8')?.checkpoint.phase,'paused');assert.equal(f.controller.model.state.snapshot?.sourcePlaylistId,'9');
  assert.equal(f.controller.model.state.filters.allSongs,false);
});
test('failed pause save stays on original source and explicit retry saves before switching',async()=>{
  const f=fixture();assert.equal(typeof f.controller.initialize,'function');await f.controller.initialize();
  const write=f.storage.setItem;f.delay();const scan=f.controller.scan();await f.started.promise;
  f.storage.setItem=()=>{throw Error('full');};const change=f.controller.selectSource({kind:'playlist',id:'9'});f.gate.resolve();await Promise.all([scan,change]);
  assert.equal(f.controller.model.state.snapshot?.sourcePlaylistId,'8');assert.equal(f.bReads(),0);assert.equal(f.controller.model.state.persisted,false);
  f.storage.setItem=write;await f.controller.selectSource({kind:'playlist',id:'9'});
  assert.equal(f.controller.model.state.snapshot?.sourcePlaylistId,'9');assert.equal(f.store.loadScan('7','8')?.checkpoint.phase,'paused');
});
test('selecting a cached source does not scan and clearing other sources preserves favorites',async()=>{
  const f=fixture();f.save();f.save('9');assert.equal(typeof f.controller.initialize,'function');await f.controller.initialize();
  await f.controller.selectSource({kind:'playlist',id:'9'});assert.equal(f.calls(),0);assert.equal(f.controller.model.state.progress.phase,'complete');
  await f.controller.clearCache('exceptFavorites');assert.ok(f.store.loadScan('7','8'));assert.equal(f.store.loadScan('7','9'),null);assert.equal(f.controller.model.state.snapshot,null);
});
test('catalog failure cannot delete favorite caches and does not block manual IDs',async()=>{
  const f=fixture();f.save();f.save('9');assert.equal(typeof f.controller.initialize,'function');await f.controller.initialize();f.failCatalog();
  await f.controller.clearCache('exceptFavorites');assert.ok(f.store.loadScan('7','8'));assert.ok(f.store.loadScan('7','9'));
  await f.controller.submitSource('20');assert.equal(f.controller.model.state.snapshot?.sourcePlaylistId,'20');
});
test('identity loss while pausing never switches or revives old account results',async()=>{
  const f=fixture();assert.equal(typeof f.controller.initialize,'function');await f.controller.initialize();f.delay();
  const scan=f.controller.scan();await f.started.promise;const change=f.controller.selectSource({kind:'playlist',id:'9'});f.setUid('10');f.gate.resolve();await Promise.all([scan,change]);
  assert.equal(f.controller.model.state.snapshot,null);assert.equal(f.controller.model.state.uid,null);assert.equal(f.bReads(),0);assert.equal(f.store.loadScan('10','8'),null);
});
test('removing the panel while waiting for pause does not activate the requested source',async()=>{
  const f=fixture();await f.controller.initialize();f.delay();
  const scan=f.controller.scan();await f.started.promise;const change=f.controller.selectSource({kind:'playlist',id:'9'});
  f.controller.remove();f.gate.resolve();await Promise.all([scan,change]);
  assert.equal(f.bReads(),0);assert.equal(f.controller.status().installed,false);
});
test('page-only continuation works before any scan and never persists that source',async()=>{
  const f=fixture();await f.controller.initialize();assert.doesNotThrow(()=>f.controller.continuePageOnly());
  await f.controller.scan();assert.equal(f.controller.model.state.progress.phase,'complete');assert.equal(f.controller.model.state.persisted,false);assert.equal(f.store.loadScan('7','8'),null);
});
test('page-only continuation targets a fresh selected source rather than the previous scan',async()=>{
  const f=fixture();await f.controller.initialize();f.delay();const scan=f.controller.scan();await f.started.promise;
  f.controller.pause();f.gate.resolve();await scan;
  const first=f.storage.getItem('ncm-organizer:v2:7:scan:8');await f.controller.selectSource({kind:'playlist',id:'9'});
  f.controller.continuePageOnly();await f.controller.scan();assert.equal(f.store.loadScan('7','9'),null);assert.equal(f.controller.model.state.persisted,false);assert.equal(f.storage.getItem('ncm-organizer:v2:7:scan:8'),first);
});
test('failed reread cannot hide dirty checkpoints from the switch save gate',async()=>{
  const f=fixture();await f.controller.initialize();f.storage.setItem=()=>{throw Error('full');};await f.controller.scan();
  f.failReads();await f.controller.scan();assert.equal(f.scanner.result,null);
  await f.controller.selectSource({kind:'playlist',id:'9'});
  assert.equal(f.controller.model.state.snapshot?.sourcePlaylistId,'8');assert.equal(f.bReads(),0);assert.equal(f.controller.model.state.persisted,false);
});
test('write recovery cannot bypass saving the current dirty source',async()=>{
  const f=fixture();await f.controller.initialize();await f.controller.selectSource({kind:'playlist',id:'9'});
  f.store.saveWriteJournal('7',{plan:{taskId:'recover',uid:'7',sourcePlaylistId:'8',sourceRevision:'["1","2"]',selectionVersion:'old',songIds:['1'],target:{kind:'existing',id:'10'}},targetId:'10',beforePlaylistIds:[],creationState:'confirmed',batches:[],confirmedIds:[],updatedAt:1});
  f.storage.setItem=()=>{throw Error('full');};await f.controller.scan();await f.controller.reviewRecovery();
  assert.equal(f.controller.model.state.snapshot?.sourcePlaylistId,'9');assert.equal(f.controller.model.state.persisted,false);
});
test('quota failure restores genuine v1 favorites without a descriptor or new network read',async()=>{
  const f=fixture(),s=snapshot(2);delete s.source;
  s.songs[0].genres={status:'known',source:'desktopWiki',value:['旧标签']};
  f.store.save('7',{schemaVersion:1,uid:'7',scan:{snapshot:s,cache:{},completedIds:['1','2'],phase:'complete',updatedAt:100},writeJournal:null});
  const raw=f.storage.getItem('ncm-organizer:v1:7');f.storage.setItem=()=>{throw Error('full');};f.failReads();await f.controller.initialize();
  assert.equal(f.controller.model.state.snapshot?.sourcePlaylistId,'8');assert.deepEqual(f.controller.model.state.snapshot?.songs[0].genres.value,['旧标签']);assert.equal(f.controller.model.state.cacheView,'cached');assert.equal(f.controller.model.state.catalogStatus,'error');assert.equal(f.storage.getItem('ncm-organizer:v1:7'),raw);
});

test('failed force refresh stays bound to its source instead of invalidating the next cache',async()=>{
 const f=fixture();await f.controller.initialize();await f.controller.selectSource({kind:'playlist',id:'9'});await f.controller.scan();
 await f.controller.selectSource({kind:'playlist',id:'8'});await f.controller.scan();f.failReads();await f.controller.readLibrary();await f.controller.forceRefresh();
 f.allowReads();await f.controller.selectSource({kind:'playlist',id:'9'});const before=f.calls();await f.controller.scan();assert.equal(f.calls(),before);
});
