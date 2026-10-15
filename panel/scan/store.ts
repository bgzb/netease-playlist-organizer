import type {PersistedState,SongRecord,Field,Source,LibrarySnapshot,WriteJournal,WritePlan,ScanCheckpoint,CacheEntry} from '../core/model';
import {id,validateSnapshot} from '../client/library';import {object,ReadError} from '../client/requests';
export type StorageLike=Pick<Storage,'length'|'key'|'getItem'|'setItem'|'removeItem'>;
const PREFIX='ncm-organizer:v1:';
function obj(v:unknown):Record<string,unknown>{if(!object(v))throw new ReadError('structure');return v;}
function str(v:unknown):string{if(typeof v!=='string')throw new ReadError('structure');return v;}
function number(v:unknown):number{if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw new ReadError('structure');return v;}
function integer(v:unknown):number{const n=number(v);if(!Number.isSafeInteger(n))throw new ReadError('structure');return n;}
function list<T>(v:unknown,read:(v:unknown)=>T):T[]{if(!Array.isArray(v))throw new ReadError('structure');return v.map(read);}
function one<T extends string>(v:unknown,choices:readonly T[]):T{if(typeof v!=='string'||!choices.includes(v as T))throw new ReadError('structure');return v as T;}
function ids(v:unknown):string[]{const a=list(v,id);if(new Set(a).size!==a.length)throw new ReadError('structure');return a;}
function field<T>(v:unknown,read:(v:unknown)=>T):Field<T>{const o=obj(v);const status=one(o.status,['known','missing','error']);const source=one<Source>(o.source,['songDetail','desktopWiki','ugcSong','manual','none']);const value=status==='known'?read(o.value):null;if(status!=='known'&&o.value!==null)throw new ReadError('structure');return {value,status,source,...(o.reason===undefined?{}:{reason:str(o.reason)})};}
function song(v:unknown):SongRecord {const o=obj(v);return {id:id(o.id),name:str(o.name),position:integer(o.position),artists:field(o.artists,v=>list(v,a=>{const o=obj(a);return {id:id(o.id),name:str(o.name)};})),genres:field(o.genres,v=>list(v,str)),bpm:field(o.bpm,v=>{const n=number(v);if(n<=0)throw new ReadError('structure');return n;}),language:field(o.language,str)};}
function snapshot(v:unknown,uid:string):LibrarySnapshot {const o=obj(v);const result={uid:id(o.uid),sourcePlaylistId:id(o.sourcePlaylistId),declaredCount:integer(o.declaredCount),ids:ids(o.ids),songs:list(o.songs,song),revision:str(o.revision)};if(result.uid!==uid)throw new ReadError('accountChanged');validateSnapshot(result);return result;}
function target(v:unknown):WritePlan['target'] {const o=obj(v);if(o.kind==='existing')return {kind:'existing',id:id(o.id)};if(o.kind==='new'&&o.privacy===10)return {kind:'new',name:str(o.name),privacy:10};throw new ReadError('structure');}
function review(v:unknown):NonNullable<WriteJournal['review']> {
  const o=obj(v),f=obj(o.filters);
  if(typeof f.allSongs!=='boolean')throw new ReadError('structure');
  return {filters:{genres:list(f.genres,str),languages:list(f.languages,str),artistIds:ids(f.artistIds),
    bpmMin:f.bpmMin===null?null:number(f.bpmMin),bpmMax:f.bpmMax===null?null:number(f.bpmMax),allSongs:f.allSongs},
    addedIds:ids(o.addedIds),removedIds:ids(o.removedIds)};
}
function journal(v:unknown,uid:string):WriteJournal|null {
  if(v===null)return null;const o=obj(v),p=obj(o.plan);
  const plan:WritePlan={taskId:str(p.taskId),uid:id(p.uid),sourcePlaylistId:id(p.sourcePlaylistId),sourceRevision:str(p.sourceRevision),selectionVersion:str(p.selectionVersion),songIds:ids(p.songIds),target:target(p.target)};
  if(plan.uid!==uid)throw new ReadError('accountChanged');
  return {plan,targetId:o.targetId===null?null:id(o.targetId),beforePlaylistIds:ids(o.beforePlaylistIds),creationState:one(o.creationState,['notStarted','pending','confirmed','uncertain']),batches:list(o.batches,v=>{const o=obj(v);return {ids:ids(o.ids),state:one(o.state,['pending','confirmed','uncertain'])};}),confirmedIds:ids(o.confirmedIds),updatedAt:number(o.updatedAt),...(o.review===undefined?{}:{review:review(o.review)}),...(o.readbackIds===undefined?{}:{readbackIds:ids(o.readbackIds)}),...(o.operations===undefined?{}:{operations:list(o.operations,v=>{const x=obj(v);return {kind:str(x.kind),state:one(x.state,['pending','confirmed','error'])};})})};
}
function checkpoint(v:unknown,uid:string):ScanCheckpoint|null {
  if(v===null)return null;const o=obj(v),source=snapshot(o.snapshot,uid),cache:Record<string,CacheEntry>={};
  for(const [key,value] of Object.entries(obj(o.cache))){const entry=obj(value),record=song(entry.song),times=obj(entry.updatedAt);if(id(key)!==record.id)throw new ReadError('structure');cache[key]={song:record,updatedAt:{genres:number(times.genres),bpm:number(times.bpm),language:number(times.language)}};}
  const completedIds=ids(o.completedIds);if(completedIds.some(id=>!source.ids.includes(id)))throw new ReadError('structure');
  return {snapshot:source,cache,completedIds,phase:one(o.phase,['reading','scanning','pausing','paused','complete','error']),updatedAt:number(o.updatedAt)};
}
function sanitize(value:unknown,uid:string):PersistedState {
  const o=obj(value);if(o.schemaVersion!==1||id(o.uid)!==uid)throw new ReadError('accountChanged');
  return {schemaVersion:1,uid,scan:checkpoint(o.scan,uid),writeJournal:journal(o.writeJournal,uid)};
}
export class LocalStore {
  constructor(private readonly storage:StorageLike=globalThis.localStorage){}
  load(uid:string):PersistedState|null {try{const account=id(uid);const raw=this.storage.getItem(PREFIX+account);return raw===null?null:sanitize(JSON.parse(raw),account);}catch{return null;}}
  save(uid:string,state:PersistedState):void {
    const account=id(uid),safe=sanitize(state,account);
    try{this.storage.setItem(PREFIX+account,JSON.stringify(safe));}catch{throw new ReadError('storage');}
  }
  clearOtherAccounts(uid:string):void {
    const keep=PREFIX+id(uid),keys:string[]=[];for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key?.startsWith(PREFIX)&&key!==keep)keys.push(key);}
    try{keys.forEach(key=>this.storage.removeItem(key));}catch{throw new ReadError('storage');}
  }
}
