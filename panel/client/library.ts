import type {LibrarySnapshot,ReadPath,SongRecord} from '../core/model';
import {normalizeSongId,normalizeMetadata} from '../core/normalize';
import {businessResponse,object,ReadError,readApi} from './requests';
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
}
function song(raw:unknown,position:number):SongRecord {
  if(!object(raw)||typeof raw.name!=='string'||!Array.isArray(raw.ar))throw new ReadError('structure');
  const artists=new Map<string,{id:string;name:string}>();let missingArtistId=false;
  for(const artist of raw.ar){if(!object(artist)||typeof artist.name!=='string')throw new ReadError('structure');if(artist.id===0){missingArtistId=true;continue;}const artistId=id(artist.id);artists.set(artistId,{id:artistId,name:artist.name});}
  return {id:id(raw.id),name:raw.name,position,artists:missingArtistId?{value:null,source:'songDetail',status:'missing',reason:'歌手列表包含无法识别的 ID，不能完整判断歌手维度'}:artists.size?{value:[...artists.values()],source:'songDetail',status:'known'}:{value:null,source:'songDetail',status:'missing',reason:'歌手字段缺失'},...normalizeMetadata(null,null)};
}
export function createLibraryReader(read:ReadApi=readApi) {
  async function readUid(): Promise<string> {
    return accountUid(await read('/api/w/nuser/account/get', {}));
  }
  async function guard(uid:string):Promise<void> {if(await readUid()!==uid)throw new ReadError('accountChanged');}
  async function readLibrary():Promise<LibrarySnapshot> {
    const uid=await readUid();const owned:Record<string,unknown>[]=[];
    for(let offset=0;;offset+=1000){
      const response=businessResponse(await read('/api/user/playlist',{uid,limit:1000,offset}));
      if(!Array.isArray(response.playlist))throw new ReadError('structure');
      for(const p of response.playlist){if(!object(p))throw new ReadError('structure');if(p.specialType===5&&object(p.creator)&&id(p.creator.userId)===uid)owned.push(p);}
      if(response.more!==true)break;
      if(!response.playlist.length||offset>=100000)throw new ReadError('structure');
      await guard(uid);
    }
    if(owned.length!==1)throw new ReadError('structure');const sourcePlaylistId=id(owned[0].id);await guard(uid);
    const response=businessResponse(await read('/api/v6/playlist/detail',{id:sourcePlaylistId,n:100000,s:0}));
    const playlist=response.playlist;
    if(!object(playlist)||id(playlist.id)!==sourcePlaylistId||!Number.isSafeInteger(playlist.trackCount)||Number(playlist.trackCount)<0||!Array.isArray(playlist.trackIds)||!Array.isArray(playlist.tracks))throw new ReadError('structure');
    const ids=playlist.trackIds.map(x=>{if(!object(x))throw new ReadError('structure');return id(x.id);});uniqueIds(ids);
    if(playlist.trackCount!==ids.length)throw new ReadError('structure');
    const allowed=new Set(ids),details=new Map<string,SongRecord>();
    function append(raw:unknown):void {const detail=song(raw,0);if(!allowed.has(detail.id)||details.has(detail.id))throw new ReadError('structure');details.set(detail.id,detail);}
    playlist.tracks.forEach(append);
    const missing=ids.filter(id=>!details.has(id));
    for(let offset=0;offset<missing.length;offset+=200){
      await guard(uid);const batch=missing.slice(offset,offset+200);
      const numeric=batch.map(songId=>{const n=Number(songId);if(!Number.isSafeInteger(n)||n<=0)throw new ReadError('structure');return {id:n};});
      const response=businessResponse(await read('/api/v3/song/detail',{c:JSON.stringify(numeric)}));
      if(!Array.isArray(response.songs)||response.songs.length!==batch.length)throw new ReadError('structure');
      const requested=new Set(batch);for(const raw of response.songs){if(!object(raw)||!requested.has(id(raw.id)))throw new ReadError('structure');append(raw);}
    }
    await guard(uid);
    const result={uid,sourcePlaylistId,declaredCount:ids.length,ids,songs:ids.map((id,position)=>({...details.get(id)!,position})),revision:JSON.stringify(ids)};
    validateSnapshot(result);return result;
  }
  return {readUid,readLibrary};
}
export const readLibrary=():Promise<LibrarySnapshot>=>createLibraryReader().readLibrary();
