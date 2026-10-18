import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePlaylistSource,PlaylistInputError} from '../panel/client/playlist-source';
import {createLibraryReader} from '../panel/client/library';
import {playlistProvider} from './fixtures/playlist-source';
for(const value of ['007','https://music.163.com/playlist?id=7','https://music.163.com/m/playlist?id=7','https://music.163.com/#/playlist?id=7','分享歌单 https://music.163.com/playlist?id=7 （来自网易云音乐）']) {
  test(`parse canonical playlist source: ${value}`,()=>assert.deepEqual(parsePlaylistSource(value),{kind:'playlist',id:'7'}));
}
for(const value of ['0','-1','1.5','https://music.163.com/song?id=7','https://example.com/playlist?id=7','https://music.163.com.evil.test/playlist?id=7','https://163cn.tv/abc','https://music.163.com/playlist?id=7&id=7','https://music.163.com/playlist?id=7 https://music.163.com/playlist?id=8','https://music.163.com/#//example.com/playlist?id=7','https://music.163.com/playlist?id=8#/playlist?id=7']) {
  test(`reject ambiguous or unsupported source: ${value}`,()=>assert.throws(()=>parsePlaylistSource(value),PlaylistInputError));
}
test('source catalog separates favorites owned and collected sources',async()=>{
  const f=playlistProvider(),reader=createLibraryReader(f.read);
  assert.equal(typeof (reader as any).listSources,'function');
  const c=await (reader as any).listSources();
  assert.equal(c.uid,'7');assert.equal(c.favoritesId,'8');
  assert.deepEqual(c.created.map((x:any)=>x.id),['9']);assert.deepEqual(c.collected.map((x:any)=>x.id),['20']);
});
test('explicit foreign source reads its complete collection without listing owned sources',async()=>{
  const f=playlistProvider();
  const s=await (createLibraryReader(f.read).readLibrary as any)({kind:'playlist',id:'20'});
  assert.equal(s.sourcePlaylistId,'20');assert.equal(s.uid,'7');assert.equal(s.source.creatorUid,'99');
  assert.deepEqual(s.ids,['1','2']);assert.equal(f.calls.some(c=>c.path==='/api/user/playlist'),false);
});
test('foreign source incomplete list is rejected rather than published',async()=>{
  const f=playlistProvider();
  const read:typeof f.read=async(path,data,signal)=>{const r=await f.read(path,data,signal) as any;if(path==='/api/v6/playlist/detail')r.playlist.trackCount=3;return r;};
  await assert.rejects(()=>(createLibraryReader(read).readLibrary as any)({kind:'playlist',id:'20'}));
});
test('source catalog paginates deduplicates entries and detects a repeated full page',async()=>{
  const f=playlistProvider();
  const paged:typeof f.read=async(path,data,signal)=>{
    if(path==='/api/user/playlist')return Number(data.offset)===0?{code:200,more:true,playlist:[f.playlists[0],f.playlists[1]]}:{code:200,more:false,playlist:[f.playlists[1],f.playlists[2]]};
    return f.read(path,data,signal);
  };
  const catalog=await createLibraryReader(paged).listSources();
  assert.deepEqual(catalog.created.map(x=>x.id),['9']);assert.deepEqual(catalog.collected.map(x=>x.id),['20']);
  const repeated:typeof f.read=async(path,data,signal)=>path==='/api/user/playlist'?{code:200,more:true,playlist:f.playlists}:f.read(path,data,signal);
  await assert.rejects(()=>createLibraryReader(repeated).listSources());
});
test('empty accessible source is a complete zero-song library and identity change revokes a read',async()=>{
  const f=playlistProvider();
  const empty:typeof f.read=async(path,data,signal)=>{
    const r=await f.read(path,data,signal) as any;
    if(path==='/api/v6/playlist/detail'){r.playlist.trackCount=0;r.playlist.trackIds=[];r.playlist.tracks=[];}
    return r;
  };
  const s=await createLibraryReader(empty).readLibrary({kind:'playlist',id:'20'});assert.deepEqual(s.ids,[]);assert.equal(s.declaredCount,0);
  const switched:typeof f.read=async(path,data,signal)=>{const r=await f.read(path,data,signal);if(path==='/api/v6/playlist/detail')f.setUid('10');return r;};
  await assert.rejects(()=>createLibraryReader(switched).readLibrary({kind:'playlist',id:'20'}),(error:any)=>error.kind==='accountChanged');
});
