import type {LibrarySnapshot,ReadPath,SongRecord,SourceSelection,SourceCatalog,PlaylistDescriptor} from '../core/model';
import {normalizeSongId,normalizeMetadata} from '../core/normalize';
import {businessResponse,object,ReadError,readApi,checkPause} from './requests';
export type ReadApi=(path:ReadPath,data:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>;
export function id(value:unknown):string {try{return normalizeSongId(value);}catch{throw new ReadError('structure');}}
/** Accept only a validated authenticated identity or the explicit guest response. */
export function accountUid(value: unknown): string {
  const response = businessResponse(value);
  if (response.profile === null && response.account === null) throw new ReadError('login');
  const identities: string[] = [];
  for (const [field, key] of [['profile', 'userId'], ['account', 'id']] as const) {
    const record = response[field];
    if (record === undefined || record === null) continue;
    if (!object(record)) throw new ReadError('structure');
    identities.push(id(record[key]));
  }
  if (!identities.length || identities.some(uid => uid !== identities[0])) throw new ReadError('structure');
  return identities[0];
}
function uniqueIds(values:string[]):void {if(new Set(values).size!==values.length)throw new ReadError('structure');}
export function validateSnapshot(snapshot:LibrarySnapshot):void {
  if(!object(snapshot)||id(snapshot.uid)!==snapshot.uid||id(snapshot.sourcePlaylistId)!==snapshot.sourcePlaylistId||!Number.isSafeInteger(snapshot.declaredCount)||snapshot.declaredCount<0||!Array.isArray(snapshot.ids)||!Array.isArray(snapshot.songs))throw new ReadError('structure');
  const ids=snapshot.ids.map(id);uniqueIds(ids);
  if(ids.length!==snapshot.declaredCount||snapshot.songs.length!==ids.length||snapshot.revision!==JSON.stringify(ids))throw new ReadError('structure');
  snapshot.songs.forEach((song,i)=>{if(!object(song)||song.id!==ids[i]||song.position!==i)throw new ReadError('structure');});
  if(snapshot.source!==undefined){const p=snapshot.source;if(!object(p)||p.id!==snapshot.sourcePlaylistId||id(p.creatorUid)!==p.creatorUid||typeof p.name!=='string')throw new ReadError('structure');}
}
function song(raw:unknown,position:number):SongRecord {
  if(!object(raw)||typeof raw.name!=='string'||!Array.isArray(raw.ar))throw new ReadError('structure');
  const artists=new Map<string,{id:string;name:string}>();let missingArtistId=false;
  for(const artist of raw.ar){if(!object(artist)||typeof artist.name!=='string')throw new ReadError('structure');if(artist.id===0){missingArtistId=true;continue;}const artistId=id(artist.id);artists.set(artistId,{id:artistId,name:artist.name});}
  return {id:id(raw.id),name:raw.name,position,artists:missingArtistId?{value:null,source:'songDetail',status:'missing',reason:'歌手列表包含无法识别的 ID，不能完整判断歌手维度'}:artists.size?{value:[...artists.values()],source:'songDetail',status:'known'}:{value:null,source:'songDetail',status:'missing',reason:'歌手字段缺失'},...normalizeMetadata(null,null)};
}
export function createLibraryReader(read:ReadApi=readApi) {
  async function readUid(signal?:AbortSignal): Promise<string> {
    return accountUid(await read('/api/w/nuser/account/get', {},signal));
  }
  async function guard(uid:string,signal?:AbortSignal):Promise<void> {if(await readUid(signal)!==uid)throw new ReadError('accountChanged');checkPause(signal);}
  function descriptor(p:Record<string,unknown>,fallback?:string):PlaylistDescriptor {
    if(!object(p.creator))throw new ReadError('structure');
    const name=typeof p.name==='string'?p.name:fallback;
    if(name===undefined)throw new ReadError('structure');
    return {id:id(p.id),name,creatorUid:id(p.creator.userId)};
  }
  async function directory(uid:string,signal?:AbortSignal):Promise<{catalog:SourceCatalog;favorite:PlaylistDescriptor}> {
    const all=new Map<string,Record<string,unknown>>();
    for(let offset=0;;offset+=1000){
      checkPause(signal);
      const response=businessResponse(await read('/api/user/playlist',{uid,limit:1000,offset},signal));
      if(!Array.isArray(response.playlist))throw new ReadError('structure');
      let added=0;
      for(const p of response.playlist){
        if(!object(p)||!object(p.creator))throw new ReadError('structure');
        const pid=id(p.id);id(p.creator.userId);
        if(!all.has(pid)){all.set(pid,p);added++;}
      }
      if(response.more!==true)break;
      if(!added||offset>=100000)throw new ReadError('structure');
      await guard(uid,signal);
    }
    const owned=[...all.values()].filter(p=>p.specialType===5&&id((p.creator as Record<string,unknown>).userId)===uid);
    if(owned.length!==1)throw new ReadError('structure');
    const favorite=descriptor(owned[0],'我喜欢'),created:PlaylistDescriptor[]=[],collected:PlaylistDescriptor[]=[];
    for(const p of all.values()){
      if(id(p.id)===favorite.id)continue;
      if(p.specialType!==0)continue;
      const d=descriptor(p);
      if(d.creatorUid===uid)created.push(d);
      else if(p.subscribed===true)collected.push(d);
    }
    await guard(uid,signal);
    return {catalog:{uid,favoritesId:favorite.id,created,collected},favorite};
  }
  async function listSources(signal?:AbortSignal):Promise<SourceCatalog>{return (await directory(await readUid(signal),signal)).catalog;}
  async function readLibrary(source:SourceSelection={kind:'favorites'},signal?:AbortSignal):Promise<LibrarySnapshot> {
    const uid=await readUid(signal);
    const favorite=source.kind==='favorites'?(await directory(uid,signal)).favorite:undefined;
    const sourcePlaylistId=favorite?.id??id(source.kind==='playlist'?source.id:undefined);
    await guard(uid,signal);
    const response=businessResponse(await read('/api/v6/playlist/detail',{id:sourcePlaylistId,n:100000,s:0},signal));
    const playlist=response.playlist;
    if(!object(playlist)||id(playlist.id)!==sourcePlaylistId||!Number.isSafeInteger(playlist.trackCount)||Number(playlist.trackCount)<0||!Array.isArray(playlist.trackIds)||!Array.isArray(playlist.tracks))throw new ReadError('structure');
    const sourceInfo=playlist.creator!==undefined?descriptor(playlist,favorite?.name):favorite;
    if(!sourceInfo)throw new ReadError('structure');
    if(favorite&&sourceInfo.creatorUid!==uid)throw new ReadError('permission');
    const ids=playlist.trackIds.map(x=>{if(!object(x))throw new ReadError('structure');return id(x.id);});uniqueIds(ids);
    if(playlist.trackCount!==ids.length)throw new ReadError('structure');
    const allowed=new Set(ids),details=new Map<string,SongRecord>();
    function append(raw:unknown):void {const detail=song(raw,0);if(!allowed.has(detail.id)||details.has(detail.id))throw new ReadError('structure');details.set(detail.id,detail);}
    playlist.tracks.forEach(append);
    const missing=ids.filter(id=>!details.has(id));
    for(let offset=0;offset<missing.length;offset+=200){
      await guard(uid,signal);const batch=missing.slice(offset,offset+200);
      const numeric=batch.map(songId=>{const n=Number(songId);if(!Number.isSafeInteger(n)||n<=0)throw new ReadError('structure');return {id:n};});
      const response=businessResponse(await read('/api/v3/song/detail',{c:JSON.stringify(numeric)},signal));
      if(!Array.isArray(response.songs)||response.songs.length!==batch.length)throw new ReadError('structure');
      const requested=new Set(batch);for(const raw of response.songs){if(!object(raw)||!requested.has(id(raw.id)))throw new ReadError('structure');append(raw);}
    }
    await guard(uid,signal);
    const result={uid,sourcePlaylistId,source:sourceInfo,declaredCount:ids.length,ids,songs:ids.map((id,position)=>({...details.get(id)!,position})),revision:JSON.stringify(ids)};
    validateSnapshot(result);return result;
  }
  return {readUid,readLibrary,listSources};
}
export const readLibrary=():Promise<LibrarySnapshot>=>createLibraryReader().readLibrary();
