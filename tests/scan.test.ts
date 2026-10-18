import test from 'node:test';import assert from 'node:assert/strict';import {createScanner} from '../panel/scan/scan';import {LocalStore} from '../panel/scan/store';import {memoryStorage,snapshot} from './fixtures/read';import {makeSong} from './fixtures/synthetic';import type {Progress} from '../panel/core/model';
const metadata=async()=>{const s=makeSong('1');return {genres:s.genres,bpm:s.bpm,language:s.language};};
function setup(extra:any={}){const storage=memoryStorage();const snap=snapshot(24);const store=new LocalStore(storage);const options={readLibrary:async()=>snap,readUid:async()=>snap.uid,readMetadata:metadata,store,now:()=>1_000_000,...extra};return {storage,snap,store,options,scanner:createScanner(options)};}
test('same-song sources do not share metadata or stored progress',async()=>{
  let current=snapshot(2),calls=0;
  const ctx=setup({readLibrary:async()=>current,readMetadata:async()=>{calls++;return metadata();}});
  await ctx.scanner.scan(current,new AbortController().signal,()=>{});
  current={...snapshot(2),sourcePlaylistId:'9',source:{id:'9',name:'第二来源',creatorUid:'99'}};
  await ctx.scanner.scan(current,new AbortController().signal,()=>{});
  assert.equal(calls,4);assert.equal(ctx.store.loadScan('7','8')?.checkpoint.completedIds.length,2);assert.equal(ctx.store.loadScan('7','9')?.checkpoint.completedIds.length,2);
});
test('source changes publish a fresh collection and reuse surviving metadata',async()=>{
  let current=snapshot(2),calls=0;
  const ctx=setup({readLibrary:async()=>current,readMetadata:async()=>{calls++;return metadata();}});
  await ctx.scanner.scan(current,new AbortController().signal,()=>{});
  const previous=current;current=snapshot(3);let change:unknown;
  const result=await ctx.scanner.scan(previous,new AbortController().signal,(_p:any,p:any)=>{change??=p.change;});
  assert.deepEqual(result.ids,['1','2','3']);assert.equal(calls,3);assert.deepEqual((change as any).addedIds,['3']);
});
test('two workers checkpoint every ten and preserve write journal',async()=>{let active=0,max=0,saves=0;const ctx=setup({readMetadata:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,1));active--;return metadata();}});const original=ctx.storage.setItem;ctx.storage.setItem=(k,v)=>{saves++;original(k,v)};const journal:any={plan:{taskId:'t',uid:'7',sourcePlaylistId:'8',sourceRevision:'["1"]',selectionVersion:'x',songIds:['1'],target:{kind:'new',name:'合成目标',privacy:10}},targetId:null,beforePlaylistIds:[],creationState:'notStarted',batches:[],confirmedIds:[],updatedAt:1};ctx.store.save('7',{schemaVersion:1,uid:'7',scan:null,writeJournal:journal});saves=0;const progress:Progress[]=[];await ctx.scanner.scan(ctx.snap,new AbortController().signal,(p:Progress)=>progress.push(p));assert.equal(max,2);assert.equal(saves,3);assert.equal(progress.at(-1)!.phase,'complete');assert.equal(ctx.store.load('7')!.writeJournal!.plan.taskId,'t');});
test('pause waits for issued reads and schedules no new songs',async()=>{const abort=new AbortController();let calls=0,completed=0;const ctx=setup({readMetadata:async()=>{calls++;abort.abort();await new Promise(r=>setTimeout(r,2));completed++;return metadata();}});await ctx.scanner.scan(ctx.snap,abort.signal,()=>{});assert.ok(calls<=2);assert.equal(calls,completed);assert.equal(ctx.scanner.status.phase,'paused');assert.equal(ctx.store.loadScan('7','8')!.checkpoint.phase,'paused');});
test('account switch stops old scan publication',async()=>{let uid='7',calls=0;const ctx=setup({readUid:async()=>uid,readMetadata:async()=>{calls++;uid='9';return metadata();}});await assert.rejects(()=>ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{}));assert.ok(calls<=2);assert.equal(ctx.scanner.status.phase,'paused');assert.equal(ctx.store.loadScan('9','8'),null);assert.equal(ctx.store.load('7'),null);});
test('resume rereads collection and reports additions removals reorder',async()=>{const ctx=setup();await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});const changed={...snapshot(24),ids:['2','1',...ctx.snap.ids.slice(2),'25'],songs:[{...ctx.snap.songs[1],position:0},{...ctx.snap.songs[0],position:1},...ctx.snap.songs.slice(2),{...makeSong('25'),position:24}],declaredCount:25,revision:JSON.stringify(['2','1',...ctx.snap.ids.slice(2),'25'])};ctx.options.readLibrary=async()=>changed;let change:any;const result=await ctx.scanner.scan(ctx.snap,new AbortController().signal,(_p,p)=>{change??=p.change;});assert.deepEqual(change.addedIds,['25']);assert.deepEqual(change.removedIds,[]);assert.equal(change.reordered,true);assert.deepEqual(result.ids,changed.ids);});
test('TTL missing 24h known 7d error uncached force refresh',async()=>{let now=0,calls=0;const ctx=setup({now:()=>now,readMetadata:async()=>{calls++;return metadata();}});await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(calls,24);now=6*86400000;await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(calls,24);now=8*86400000;await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(calls,48);ctx.scanner.forceRefresh();await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(calls,72);});
test('quota pauses with memory results and explicit volatile continuation',async()=>{const ctx=setup();ctx.storage.setItem=()=>{throw new DOMException('quota','QuotaExceededError')};await assert.rejects(()=>ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{}));assert.equal(ctx.scanner.status.phase,'paused');assert.equal(ctx.scanner.status.persisted,false);assert.ok(ctx.scanner.result!.songs[0].genres.value);ctx.scanner.continueWithoutPersistence();await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(ctx.scanner.status.phase,'complete');assert.equal(ctx.scanner.status.persisted,false);});

test('volatile metadata cannot be reused by another account',async()=>{let current=snapshot(24),calls=0;const ctx=setup({readLibrary:async()=>current,readUid:async()=>current.uid,readMetadata:async()=>{calls++;return metadata();}});ctx.storage.setItem=()=>{throw new DOMException('quota','QuotaExceededError')};await assert.rejects(()=>ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{}));ctx.scanner.continueWithoutPersistence();await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});const oldCalls=calls;ctx.storage.setItem=(key,value)=>{ctx.storage.data.set(key,value);};current=snapshot(24,'9');await ctx.scanner.scan(current,new AbortController().signal,()=>{});assert.equal(ctx.scanner.status.persisted,true);assert.equal(calls-oldCalls,24);});
test('a writer-cleared journal stays cleared during scanning',async()=>{const ctx=setup();let calls=0;const journal:any={plan:{taskId:'t',uid:'7',sourcePlaylistId:'8',sourceRevision:'[]',selectionVersion:'x',songIds:[],target:{kind:'existing',id:'10'}},targetId:'10',beforePlaylistIds:[],creationState:'confirmed',batches:[],confirmedIds:[],updatedAt:0};ctx.store.save('7',{schemaVersion:1,uid:'7',scan:null,writeJournal:journal});ctx.options.readMetadata=async()=>{if(++calls===15){const state=ctx.store.load('7')!;state.writeJournal=null;ctx.store.save('7',state);}return metadata();};await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(ctx.store.load('7')!.writeJournal,null);});
test('account switch clears exposed old result',async()=>{let uid='7';const ctx=setup({readUid:async()=>uid,readMetadata:async()=>{uid='9';return metadata();}});await assert.rejects(()=>ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{}));assert.equal(ctx.scanner.result,null);});
test('missing metadata expires at 24 hours and error fields are immediately reread',async()=>{let now=0,calls=0;const ctx=setup({now:()=>now,readMetadata:async()=>{calls++;const m=await metadata();return {...m,language:{value:null,source:'ugcSong',status:'missing'}};}});await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});now=23*3600000;await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(calls,24);now=24*3600000;await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(calls,48);ctx.options.readMetadata=async()=>{calls++;const m=await metadata();return {...m,language:{value:null,source:'ugcSong',status:'error'}} as any;};ctx.scanner.forceRefresh();await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});const before=calls;await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(calls-before,24);});
test('collection diff reports removed songs and invalidates cached preview',async()=>{const ctx=setup();ctx.options.readLibrary=async()=>({...snapshot(23),ids:ctx.snap.ids.slice(1),songs:ctx.snap.songs.slice(1).map((s,i)=>({...s,position:i})),revision:JSON.stringify(ctx.snap.ids.slice(1))});let change:any;await ctx.scanner.scan(ctx.snap,new AbortController().signal,(_p,p)=>{change??=p.change;});assert.deepEqual(change.removedIds,['1']);assert.deepEqual(change.addedIds,[]);});

test('retrying persistence retains valid in-memory metadata',async()=>{let calls=0;const ctx=setup({readMetadata:async()=>{calls++;return metadata();}});const original=ctx.storage.setItem;ctx.storage.setItem=()=>{throw new DOMException('quota','QuotaExceededError')};await assert.rejects(()=>ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{}));const processed=ctx.scanner.status.processed;ctx.storage.setItem=original;ctx.scanner.retryPersistence();await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(calls,24);assert.ok(processed>=10);assert.equal(ctx.scanner.status.persisted,true);assert.equal(ctx.store.loadScan('7','8')!.checkpoint.completedIds.length,24);});

test('new-signal resume finishes interrupted metadata and preserves partial checkpoint and journal', async () => {
  const abort = new AbortController();
  let firstWiki = true, ugc = 0;
  const {createMetadataReader} = await import('../panel/client/metadata');
  const reader = createMetadataReader(async () => {
    ugc++;
    return {code: 200, data: {language: '日语'}};
  }, async () => {
    if (firstWiki) { firstWiki = false; abort.abort(); }
    return {metas: [{title: '曲风', content: '摇滚'}, {title: 'BPM', content: '123'}]};
  });
  const ctx = setup({readMetadata: reader.readMetadata});
  const journal: any = {plan: {taskId: 'keep', uid: '7', sourcePlaylistId: '8', sourceRevision: '[]', selectionVersion: 'x', songIds: [], target: {kind: 'existing', id: '10'}}, targetId: '10', beforePlaylistIds: [], creationState: 'confirmed', batches: [], confirmedIds: [], updatedAt: 0};
  ctx.store.save('7', {schemaVersion: 1, uid: '7', scan: null, writeJournal: journal});
  await ctx.scanner.scan(ctx.snap, abort.signal, () => {});
  assert.equal(ctx.scanner.status.phase, 'paused');
  assert.equal(ugc, 0);
  const saved = ctx.store.loadScan('7','8')!.checkpoint;
  assert.equal(saved.snapshot.songs[0].bpm.value, 123);
  assert.equal(saved.completedIds.includes('1'), false);
  assert.equal(ctx.store.loadWriteJournal('7')!.writeJournal!.plan.taskId, 'keep');
  await ctx.scanner.scan(ctx.snap, new AbortController().signal, () => {});
  assert.equal(ctx.scanner.status.phase, 'complete');
  assert.equal(ugc, 24);
  assert.equal(ctx.scanner.result!.songs[0].bpm.value, 123);
  assert.equal(ctx.scanner.result!.songs[0].language.value, '日语');
  assert.equal(ctx.store.load('7')!.writeJournal!.plan.taskId, 'keep');
});
test('retry save stores the final paused progress and cleanup discards reusable memory',async()=>{
  const ctx=setup();const original=ctx.storage.setItem;
  ctx.storage.setItem=()=>{throw Error('full');};
  await assert.rejects(()=>ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{}));
  ctx.storage.setItem=original;
  await ctx.scanner.persistCurrent();
  const saved=ctx.store.loadScan('7','8')!.checkpoint;
  assert.equal(saved.phase,'paused');assert.equal(saved.completedIds.length,ctx.scanner.status.processed);
  ctx.store.clearScans('7',{kind:'all'});ctx.scanner.discardCaches('7',{kind:'all'});
  let calls=0;ctx.options.readMetadata=async()=>{calls++;return metadata();};
  await ctx.scanner.scan(ctx.snap,new AbortController().signal,()=>{});assert.equal(calls,24);
});
test('failed completion save cannot invent a durable completed-scan timestamp',async()=>{
  let now=1000;const current=snapshot(2),ctx=setup({now:()=>now,readLibrary:async()=>current}),write=ctx.storage.setItem;
  ctx.storage.setItem=()=>{throw Error('full');};await assert.rejects(()=>ctx.scanner.scan(current,new AbortController().signal,()=>{}));
  ctx.storage.setItem=write;await ctx.scanner.persistCurrent();
  assert.equal(ctx.store.loadScan('7','8')!.checkpoint.phase,'paused');assert.equal(ctx.store.loadScan('7','8')!.lastCompletedAt,null);
  now=2000;await ctx.scanner.scan(current,new AbortController().signal,()=>{});assert.equal(ctx.store.loadScan('7','8')!.lastCompletedAt,2000);
});

test('scanner checkpoints suspended partial BPM and resumes errors until explicit force refresh', async () => {
  const abort = new AbortController();
  let calls = 0;
  const {createMetadataReader} = await import('../panel/client/metadata');
  const reader = createMetadataReader(async () => ({code: 200, data: {language: '国语'}}), async () => {
    calls++;
    if (calls === 2) abort.abort();
    return {metas: [{title: '曲风', content: '摇滚'}, {title: 'BPM', content: calls === 1 ? 'bad' : '123'}]};
  });
  await reader.readMetadata('99');
  const ctx = setup({readMetadata: reader.readMetadata, resetMetadataErrors: reader.resetErrors});
  await ctx.scanner.scan(ctx.snap, abort.signal, () => {});
  assert.equal(ctx.scanner.result!.songs[0].bpm.status, 'error');
  assert.equal(ctx.store.loadScan('7','8')!.checkpoint.snapshot.songs[0].bpm.status, 'error');
  await ctx.scanner.scan(ctx.snap, new AbortController().signal, () => {});
  assert.equal(ctx.scanner.result!.songs[0].bpm.status, 'error');
  ctx.scanner.forceRefresh();
  await ctx.scanner.scan(ctx.snap, new AbortController().signal, () => {});
  assert.equal(ctx.scanner.result!.songs[0].bpm.value, 123);
});
