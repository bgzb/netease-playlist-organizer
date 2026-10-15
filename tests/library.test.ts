import test from 'node:test';import assert from 'node:assert/strict';
import {createLibraryReader} from '../panel/client/library';import {createMetadataReader} from '../panel/client/metadata';
import {ReadError} from '../panel/client/requests';import {libraryProvider,paths} from './fixtures/read';import type {ReadPath} from '../panel/core/model';
test('readLibraryCompletesTruncatedDetails',async()=>{const p=libraryProvider();const result=await createLibraryReader(p.read).readLibrary();assert.equal(result.ids.length,1419);assert.equal(result.songs.length,1419);assert.equal(new Set(result.songs.map((s:any)=>s.id)).size,1419);assert.deepEqual(p.detailBatchSizes,[200,200,19]);assert.equal(result.songs[0].artists.value!.length,2);assert.deepEqual(p.called.filter(p=>!Object.values(paths).includes(p as any)),[]);});
for(const mode of ['duplicate','count','unsafe','wrongDetail','wrongOwner'])test(`library rejects ${mode}`,async()=>{const p=libraryProvider(3);const read=async(path:ReadPath,data:Record<string,unknown>)=>{const r=await p.read(path,data) as any;if(path===paths.playlist){if(mode==='duplicate')r.playlist.trackIds[1]={id:1};if(mode==='count')r.playlist.trackCount=4;if(mode==='unsafe')r.playlist.trackIds[0]={id:Number.MAX_SAFE_INTEGER+1};if(mode==='wrongDetail')r.playlist.tracks[0].id=99;}if(mode==='wrongOwner'&&path===paths.list)r.playlist[0].creator.userId=9;return r;};await assert.rejects(()=>createLibraryReader(read).readLibrary());});
test('metadata keeps exact labels and independently marks unknown language',async()=>{let calls=0;const reader=createMetadataReader(async()=>({code:200,data:{language:'未知'}}),async()=>{calls++;return {metas:[{title:'曲风',content:'另类/独立、 摇滚-日系摇滚'},{title:'BPM',content:'123.5'}]};});const m=await reader.readMetadata('1');assert.deepEqual(m.genres.value,['另类/独立','摇滚-日系摇滚']);assert.equal(m.bpm.value,123.5);assert.equal(m.language.status,'missing');assert.equal(calls,1);});
test('shape mismatch suspends only affected metadata dimension',async()=>{let wiki=0,ugc=0;const reader=createMetadataReader(async()=>{ugc++;return {code:200,data:{language:'日语'}};},async()=>{wiki++;return {metas:'bad'} as any;});const a=await reader.readMetadata('1'),b=await reader.readMetadata('2');assert.equal(a.genres.status,'error');assert.equal(b.genres.status,'error');assert.equal(b.language.value,'日语');assert.equal(wiki,1);assert.equal(ugc,2);});

test('invalid BPM suspends only BPM while genres continue to update',async()=>{let calls=0;const reader=createMetadataReader(async()=>({code:200,data:{language:'国语'}}),async()=>({metas:[{title:'曲风',content:++calls===1?'摇滚':'民谣'},{title:'BPM',content:'invalid'}]}));assert.equal((await reader.readMetadata('1')).bpm.status,'error');const next=await reader.readMetadata('2');assert.equal(next.bpm.status,'error');assert.deepEqual(next.genres.value,['民谣']);});
test('malformed wiki object is a structure error with language retained',async()=>{const reader=createMetadataReader(async()=>({code:200,data:{language:'国语'}}),async()=>({wrong:true} as any));const m=await reader.readMetadata('1');assert.equal(m.genres.status,'error');assert.equal(m.bpm.status,'error');assert.equal(m.language.value,'国语');});
test('unavailable UGC response does not become unknown or suppress wiki',async()=>{const reader=createMetadataReader(async()=>({wrong:true}),async()=>({metas:[{title:'BPM',content:'100'}]}));const m=await reader.readMetadata('1');assert.equal(m.language.status,'error');assert.equal(m.bpm.value,100);});
test('missing metadata is definitive and not retried',async()=>{let wiki=0,ugc=0;const reader=createMetadataReader(async()=>{ugc++;return {code:200,data:{language:'暂无'}}},async()=>{wiki++;return null});const m=await reader.readMetadata('1');assert.equal(m.genres.status,'missing');assert.equal(m.bpm.status,'missing');assert.equal(m.language.status,'missing');assert.equal(wiki,1);assert.equal(ugc,1);});

test('exhausted metadata network failure carries field error rather than unknown',async()=>{const reader=createMetadataReader(async()=>{throw new ReadError('network')},async()=>({metas:[{title:'BPM',content:'100'}]}));await assert.rejects(()=>reader.readMetadata('1'),(e:any)=>{assert.equal(e.kind,'network');assert.equal(e.metadata.language.status,'error');assert.equal(e.metadata.bpm.value,100);return true;});});
test('explicit metadata reset probes a previously suspended dimension',async()=>{let invalid=true;const reader=createMetadataReader(async()=>({code:200,data:{language:'国语'}}),async()=>({metas:[{title:'BPM',content:invalid?'bad':'100'}]}));assert.equal((await reader.readMetadata('1')).bpm.status,'error');invalid=false;reader.resetErrors();assert.equal((await reader.readMetadata('1')).bpm.value,100);});

test('aborting in-flight wiki preserves partial fields without starting UGC', async () => {
  const abort = new AbortController();
  let ugc = 0;
  const reader = createMetadataReader(async () => {
    ugc++;
    return {code: 200, data: {language: '国语'}};
  }, async () => {
    abort.abort();
    await new Promise(resolve => setImmediate(resolve));
    return {metas: [{title: 'BPM', content: '123'}]};
  });
  await assert.rejects(() => reader.readMetadata('1', abort.signal), (e: any) => {
    assert.equal(e.kind, 'paused');
    assert.equal(e.partial.bpm.value, 123);
    return true;
  });
  assert.equal(ugc, 0);
});

test('paused partial cannot clear pre-suspended BPM without an explicit reset', async () => {
  const abort = new AbortController();
  let calls = 0;
  const reader = createMetadataReader(async () => ({code: 200, data: {language: '国语'}}), async () => {
    calls++;
    if (calls === 2) abort.abort();
    return {metas: [{title: '曲风', content: '摇滚'}, {title: 'BPM', content: calls === 1 ? 'bad' : '123'}]};
  });
  assert.equal((await reader.readMetadata('1')).bpm.status, 'error');
  await assert.rejects(() => reader.readMetadata('2', abort.signal), (error: any) => {
    assert.equal(error.kind, 'paused');
    assert.equal(error.partial.bpm.status, 'error');
    assert.equal(error.partial.bpm.value, null);
    assert.deepEqual(error.partial.genres.value, ['摇滚']);
    return true;
  });
  reader.resetErrors();
  assert.equal((await reader.readMetadata('2', new AbortController().signal)).bpm.value, 123);
});

test('new malformed wiki fields discovered during pause remain suspended until reset', async () => {
  const abort = new AbortController();
  let first = true;
  const reader = createMetadataReader(async () => ({code: 200, data: {language: '国语'}}), async () => {
    const malformed = first;
    if (first) { first = false; abort.abort(); }
    return {metas: [{title: '曲风', content: '摇滚'}, {title: 'BPM', content: malformed ? 'bad' : '123'}]};
  });
  await assert.rejects(() => reader.readMetadata('1', abort.signal), (error: any) => {
    assert.equal(error.partial.bpm.status, 'error');
    return true;
  });
  assert.equal((await reader.readMetadata('1', new AbortController().signal)).bpm.status, 'error');
  reader.resetErrors();
  assert.equal((await reader.readMetadata('1', new AbortController().signal)).bpm.value, 123);
});

test('malformed wiki container during pause exposes suspended fields and requires reset', async () => {
  const abort = new AbortController();
  let first = true;
  const reader = createMetadataReader(async () => ({code: 200, data: {language: '国语'}}), async () => {
    if (first) { first = false; abort.abort(); return {metas: 'bad'} as any; }
    return {metas: [{title: '曲风', content: '摇滚'}, {title: 'BPM', content: '123'}]};
  });
  await assert.rejects(() => reader.readMetadata('1', abort.signal), (error: any) => {
    assert.equal(error.partial.genres.status, 'error');
    assert.equal(error.partial.bpm.status, 'error');
    return true;
  });
  assert.equal((await reader.readMetadata('1', new AbortController().signal)).bpm.status, 'error');
  reader.resetErrors();
  assert.equal((await reader.readMetadata('1', new AbortController().signal)).bpm.value, 123);
});


test('thirteen numeric zero artist sentinels preserve complete songs and mark mixed artists unknown',async()=>{
  const p=libraryProvider(30);
  const read=async(path:ReadPath,data:Record<string,unknown>)=>{const r=await p.read(path,data) as any;if(path===paths.playlist)r.playlist.tracks.forEach((song:any,i:number)=>{if(i<13)song.ar=i===12?[{id:11,name:'合成有效歌手'},{id:0,name:'合成无ID歌手'}]:[{id:0,name:'合成无ID歌手'}];});return r;};
  const result=await createLibraryReader(read).readLibrary();
  assert.equal(result.ids.length,30);assert.equal(result.songs.length,30);assert.deepEqual(result.ids,Array.from({length:30},(_,i)=>String(i+1)));
  assert.equal(result.songs.filter(s=>s.artists.status==='missing').length,13);
  for(const song of result.songs.slice(0,13)){assert.equal(song.artists.value,null);assert.match(song.artists.reason!,/ID/);assert.equal(song.bpm.status,'missing');}
  assert.equal(result.songs[13].artists.status,'known');assert.equal(result.songs[12].position,12);
});
for(const bad of [-1,0.1,'0',null,Number.MAX_SAFE_INTEGER+1])test(`artist malformed ID remains structural failure: ${bad}`,async()=>{
  const p=libraryProvider(2);const read=async(path:ReadPath,data:Record<string,unknown>)=>{const r=await p.read(path,data) as any;if(path===paths.playlist)r.playlist.tracks[0].ar=[{id:bad,name:'合成歌手'}];return r;};
  await assert.rejects(()=>createLibraryReader(read).readLibrary(),(e:any)=>e.kind==='structure');
});
