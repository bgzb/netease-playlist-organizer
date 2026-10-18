import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalStore} from '../panel/scan/store';
import {createScanner} from '../panel/scan/scan';
import {PanelController} from '../panel/ui/panel';
import {memoryStorage,snapshot} from './fixtures/read';
import {makeSong} from './fixtures/synthetic';
import type {StoredPlaylistScan,Filters} from '../panel/core/model';
const filters:Filters={genres:['摇滚'],languages:['日语'],artistIds:['123'],bpmMin:80,bpmMax:120,allSongs:false};
function setup(){
 const storage=memoryStorage(),store=new LocalStore(storage);let uid='7';
 const scanner=createScanner({store,readLibrary:async pid=>snapshot(2,uid,pid),readUid:async()=>uid,readMetadata:async()=>{const {genres,bpm,language}=makeSong('1');return {genres,bpm,language};}});
 const c=new PanelController({store,scanner,readUid:async()=>uid,readLibrary:async source=>snapshot(2,uid,source.kind==='favorites'?'8':source.id),listSources:async()=>({uid,favoritesId:'8',created:[],collected:[]}),readTargets:async()=>[]});
 const save=(pid:string,account='7')=>{const s=snapshot(2,account,pid);const v:StoredPlaylistScan={schemaVersion:2,uid:account,source:s.source!,checkpoint:{snapshot:s,cache:{},completedIds:s.ids,phase:'complete',updatedAt:100},lastCompletedAt:100};store.saveScan(account,pid,v);};
 return {storage,store,c,scanner,save,setUid:(value:string)=>uid=value};
}
test('presets survive reload, isolate accounts and detach saved filters',()=>{
 const f=setup(),s=f.store as any;assert.equal(typeof s.savePreset,'function');
 const input=structuredClone(filters),p=s.savePreset('7','日语摇滚',input,{'123':'歌手甲'});input.genres.push('民谣');
 const reloaded=new LocalStore(f.storage) as any;assert.deepEqual(reloaded.listPresets('7')[0].filters,filters);assert.deepEqual(reloaded.listPresets('9'),[]);
 const copy=reloaded.listPresets('7');copy[0].filters.genres.push('污染');assert.deepEqual(reloaded.listPresets('7')[0].filters.genres,['摇滚']);assert.equal(p.name,'日语摇滚');
});
test('preset rename and delete address stable ids, refuse duplicate names and preserve other presets',()=>{
 const {store}=setup(),s=store as any;assert.equal(typeof s.savePreset,'function');
 const a=s.savePreset('7','方案甲',filters,{}),b=s.savePreset('7','方案乙',filters,{});
 assert.throws(()=>s.savePreset('7',' 方案甲 ',filters,{}));assert.throws(()=>s.renamePreset('7',a.id,'方案乙'));
 s.renamePreset('7',a.id,'方案丙');assert.equal(s.listPresets('7').find((p:any)=>p.id===a.id).name,'方案丙');
 s.deletePreset('7',a.id);assert.deepEqual(s.listPresets('7').map((p:any)=>p.id),[b.id]);
});
test('invalid conditions and failed writes cannot replace saved presets',()=>{
 const f=setup(),s=f.store as any;assert.equal(typeof s.savePreset,'function');s.savePreset('7','已有',filters,{});
 assert.throws(()=>s.savePreset('7',' ',filters,{}));assert.throws(()=>s.savePreset('7','反向BPM',{...filters,bpmMin:200,bpmMax:100},{}));
 f.storage.setItem=()=>{throw Error('quota');};assert.throws(()=>s.renamePreset('7',s.listPresets('7')[0].id,'改名'));assert.equal(s.listPresets('7')[0].name,'已有');
});
test('cache inventory reports size and can delete a damaged record without touching another account',()=>{
 const f=setup(),s=f.store as any;f.save('8');f.save('9','10');f.storage.setItem('ncm-organizer:v2:7:scan:20','broken');assert.equal(typeof s.listScanCaches,'function');
 const rows=s.listScanCaches('7');assert.equal(rows.length,2);assert.ok(rows.find((r:any)=>r.source.id==='8').byteSize>0);assert.equal(rows.find((r:any)=>r.source.id==='20').invalid,true);
 s.deleteScan('7','20');assert.equal(f.storage.getItem('ncm-organizer:v2:7:scan:20'),null);assert.ok(f.store.loadScan('10','9'));assert.ok(f.store.loadScan('7','8'));
});
test('individual deletion also clears matching legacy scan while preserving the recovery journal and presets',()=>{
 const f=setup(),s=f.store as any;assert.equal(typeof s.savePreset,'function');f.save('8');const scan=f.store.loadScan('7','8')!.checkpoint;
 const journal={plan:{taskId:'recovery',uid:'7',sourcePlaylistId:'8',sourceRevision:'old',selectionVersion:'old',songIds:['1'],target:{kind:'existing' as const,id:'10'}},targetId:'10',beforePlaylistIds:[],creationState:'confirmed' as const,batches:[],confirmedIds:[],updatedAt:1};
 f.store.save('7',{schemaVersion:1,uid:'7',scan,writeJournal:journal});s.savePreset('7','保留方案',filters,{});s.deleteScan('7','8');
 assert.equal(f.store.load('7')!.scan,null);assert.deepEqual(f.store.loadWriteJournal('7')!.writeJournal,journal);assert.equal(s.listPresets('7').length,1);assert.equal(f.store.loadScan('7','8'),null);
});
test('applying a preset replaces manual choices, invalidates review, and keeps conditions absent from the current playlist',async t=>{
 const f=setup(),c=f.c as any;t.after(()=>f.c.remove());await c.initialize();await c.scan();assert.equal(typeof c.savePreset,'function');
 f.c.model.setFilters(filters);await c.savePreset('日语摇滚');const preset=c.presetCatalog().items[0];
 f.c.model.setFilters({...filters,allSongs:true});f.c.model.manual('1','remove');f.c.model.state.confirmation={} as any;f.c.model.state.writeReview={} as any;
 assert.equal(c.applyPreset(preset.id),true);assert.deepEqual(f.c.model.state.filters,filters);assert.equal(f.c.model.state.added.size,0);assert.equal(f.c.model.state.removed.size,0);assert.equal(f.c.model.state.writeReview,null);assert.equal(f.c.model.state.confirmation,null);assert.equal(f.c.model.preview().ids.length,0);
});
test('account change during preset mutation cannot write the previous accounts preferences',async t=>{
 const f=setup(),c=f.c as any;t.after(()=>f.c.remove());await c.initialize();assert.equal(typeof c.savePreset,'function');f.c.model.setFilters(filters);f.setUid('9');await c.savePreset('不得保存');
 assert.deepEqual((f.store as any).listPresets('7'),[]);assert.deepEqual((f.store as any).listPresets('9'),[]);assert.equal(f.c.model.state.uid,null);
});
test('deleting active cache resets data and scanner memory but preserves the recovery entry',async t=>{
 const f=setup(),c=f.c as any;t.after(()=>f.c.remove());await c.initialize();await c.scan();f.save('20');assert.equal(typeof c.deleteScanCache,'function');
 f.store.saveWriteJournal('7',{plan:{taskId:'recover',uid:'7',sourcePlaylistId:'8',sourceRevision:'old',selectionVersion:'old',songIds:['1'],target:{kind:'existing',id:'10'}},targetId:'10',beforePlaylistIds:[],creationState:'confirmed',batches:[],confirmedIds:[],updatedAt:1});
 await c.deleteScanCache('8');assert.equal(f.c.model.state.snapshot,null);assert.equal(f.store.loadScan('7','8'),null);assert.ok(f.store.loadScan('7','20'));assert.ok(f.c.model.state.recoveryJournal);assert.equal(f.scanner.hasUnsavedResult('7','8'),false);
});
test('failed individual deletion preserves the visible cached source',async t=>{
 const f=setup(),c=f.c as any;t.after(()=>f.c.remove());f.save('8');await c.initialize();assert.equal(typeof c.deleteScanCache,'function');f.storage.removeItem=()=>{throw Error('denied');};await c.deleteScanCache('8');assert.ok(f.c.model.state.snapshot);assert.ok(f.store.loadScan('7','8'));assert.match(c.managementNotice,/未|失败/);
});
import {mountOrganizer} from '../panel/ui/entry';
import {testDocument,walk} from './fixtures/dom';
const settle=()=>new Promise(r=>setTimeout(r,0));
test('mounted preset controls persist a name, cancel manual reset, apply, rename and delete',async t=>{
 const f=setup(),{doc}=testDocument();let consent=false;doc.defaultView={confirm:()=>consent,addEventListener(){},removeEventListener(){}};
 const app=mountOrganizer({document:doc,scope:{},controller:f.c});t.after(()=>app.remove());await f.c.initialize();await f.c.prepareCollection();
 const root=doc.body.children[0].shadowRoot!,key=(k:string)=>walk(root).find(n=>n.dataset.key===k)!;
 assert.ok(key('preset-name'));f.c.model.setFilters(filters);f.c.changed();key('preset-name').value='我的日摇';key('preset-name').oninput!();key('preset-save').onclick!();await settle();
 const preset=(f.store as any).listPresets('7')[0];assert.equal(preset.name,'我的日摇');
 key('preset-select').value=preset.id;key('preset-select').onchange!();f.c.model.manual('1','remove');f.c.changed();key('preset-apply').onclick!();assert.equal(f.c.model.state.removed.size,1);
 consent=true;key('preset-apply').onclick!();assert.equal(f.c.model.state.removed.size,0);assert.deepEqual(f.c.model.state.filters.artistIds,['123']);
 key('preset-name').value='改名方案';key('preset-name').oninput!();key('preset-rename').onclick!();await settle();assert.equal((f.store as any).listPresets('7')[0].name,'改名方案');
 key('preset-delete').onclick!();await settle();assert.equal((f.store as any).listPresets('7').length,0);
});
test('mounted cache manager lists sources, cancels deletion and deletes only the confirmed row',async t=>{
 const f=setup();f.save('8');f.save('20');const {doc}=testDocument();let consent=false;doc.defaultView={confirm:()=>consent,addEventListener(){},removeEventListener(){}};
 const app=mountOrganizer({document:doc,scope:{},controller:f.c});t.after(()=>app.remove());await f.c.initialize();const root=doc.body.children[0].shadowRoot!,key=(k:string)=>walk(root).find(n=>n.dataset.key===k)!;
 assert.ok(key('cache-manager-open'));key('cache-manager-open').onclick!();assert.ok(key('cache-delete-20'));assert.match(root.textContent,/估算|约/);
 key('cache-delete-20').onclick!();await settle();assert.ok(f.store.loadScan('7','20'));
 consent=true;key('cache-delete-20').onclick!();await settle();assert.equal(f.store.loadScan('7','20'),null);assert.ok(f.store.loadScan('7','8'));assert.equal(f.c.model.state.snapshot?.sourcePlaylistId,'8');assert.equal(key('cache-delete-20'),undefined);
});
test('tiered cache cleanup preserves all saved filter presets',async t=>{
 const f=setup();t.after(()=>f.c.remove());await f.c.initialize();f.c.model.setFilters(filters);await f.c.savePreset('保留条件');f.save('8');f.save('20');await f.c.clearCache('exceptFavorites');assert.equal(f.store.listPresets('7').length,1);assert.ok(f.store.loadScan('7','8'));await f.c.clearCache('all');assert.equal(f.store.listPresets('7').length,1);assert.equal(f.store.loadScan('7','8'),null);
});
test('damaged preset storage is reported without overwriting it on save',async t=>{
 const f=setup();t.after(()=>f.c.remove());await f.c.initialize();f.c.model.setFilters(filters);await f.c.savePreset('原方案');const key=Array.from({length:f.storage.length},(_,i)=>f.storage.key(i)).find(k=>k?.startsWith('ncm-organizer:presets:'))!;f.storage.setItem(key,'broken');assert.ok(f.c.presetCatalog().error);await f.c.savePreset('新方案');assert.equal(f.storage.getItem(key),'broken');assert.match(f.c.managementNotice!,/无法读取/);
});
test('cache deletion refuses a changed account before touching storage',async t=>{
 const f=setup();t.after(()=>f.c.remove());f.save('8');await f.c.initialize();f.setUid('9');await f.c.deleteScanCache('8');assert.ok(f.store.loadScan('7','8'));assert.equal(f.c.model.state.uid,null);
});
test('preset artist labels remain readable after applying to a different source',async t=>{
 const f=setup(),{doc}=testDocument(),app=mountOrganizer({document:doc,scope:{},controller:f.c});t.after(()=>app.remove());await f.c.initialize();await f.c.scan();
 f.c.model.state.snapshot!.songs[0].artists={value:[{id:'123',name:'歌手甲'}],status:'known',source:'songDetail'};f.c.model.setFilters(filters);await f.c.savePreset('歌手方案');const preset=f.c.presetCatalog().items[0];
 await f.c.selectSource({kind:'playlist',id:'20'});await f.c.scan();f.c.applyPreset(preset.id);const root=doc.body.children[0].shadowRoot!;assert.match(root.textContent,/歌手甲 ×/);assert.equal(f.c.model.preview().ids.length,0);
});
test('presets can be saved in client contexts without secure-context crypto APIs',()=>{
 const f=setup(),descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});
 try{const saved=f.store.savePreset('7','客户端方案',filters,{});assert.equal(f.store.listPresets('7')[0].id,saved.id);}
 finally{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else Reflect.deleteProperty(globalThis,'crypto');}
});
test('unrelated damaged legacy scan cannot block deleting an independent v2 cache',()=>{
 const f=setup();f.save('20');f.storage.setItem('ncm-organizer:v1:7',JSON.stringify({schemaVersion:1,uid:'7',scan:{snapshot:{sourcePlaylistId:'99'},phase:'broken'},writeJournal:null}));const before=f.storage.getItem('ncm-organizer:v1:7');
 f.store.deleteScan('7','20');assert.equal(f.store.loadScan('7','20'),null);assert.equal(f.storage.getItem('ncm-organizer:v1:7'),before);
});
test('matching damaged legacy scan is cleared without losing its valid recovery journal',()=>{
 const f=setup();f.save('8');const recovery={plan:{taskId:'recover',uid:'7',sourcePlaylistId:'8',sourceRevision:'old',selectionVersion:'old',songIds:['1'],target:{kind:'existing' as const,id:'10'}},targetId:'10',beforePlaylistIds:[],creationState:'confirmed' as const,batches:[],confirmedIds:[],updatedAt:1};
 f.storage.setItem('ncm-organizer:v1:7',JSON.stringify({schemaVersion:1,uid:'7',scan:{snapshot:{sourcePlaylistId:'8'},phase:'broken'},writeJournal:recovery}));f.store.deleteScan('7','8');assert.equal(f.store.loadScan('7','8'),null);assert.deepEqual(f.store.loadWriteJournal('7')!.writeJournal,recovery);assert.equal(f.store.load('7')!.scan,null);
});
