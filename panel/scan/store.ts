import {listPresets,savePreset,renamePreset,deletePreset} from './presets';
import type {Filters} from '../core/model';
import type {PersistedState,SongRecord,Field,Source,LibrarySnapshot,WriteJournal,WritePlan,ScanCheckpoint,CacheEntry,PlaylistDescriptor,StoredPlaylistScan,ScanSummary} from '../core/model';
import {id,validateSnapshot} from '../client/library';import {object,ReadError} from '../client/requests';
export type StorageLike=Pick<Storage,'length'|'key'|'getItem'|'setItem'|'removeItem'>;
const PREFIX='ncm-organizer:v1:';
const SCANS='ncm-organizer:v2:';
function obj(v:unknown):Record<string,unknown>{if(!object(v))throw new ReadError('structure');return v;}
function str(v:unknown):string{if(typeof v!=='string')throw new ReadError('structure');return v;}
function number(v:unknown):number{if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw new ReadError('structure');return v;}
function integer(v:unknown):number{const n=number(v);if(!Number.isSafeInteger(n))throw new ReadError('structure');return n;}
function list<T>(v:unknown,read:(v:unknown)=>T):T[]{if(!Array.isArray(v))throw new ReadError('structure');return v.map(read);}
function one<T extends string>(v:unknown,choices:readonly T[]):T{if(typeof v!=='string'||!choices.includes(v as T))throw new ReadError('structure');return v as T;}
function ids(v:unknown):string[]{const a=list(v,id);if(new Set(a).size!==a.length)throw new ReadError('structure');return a;}
function field<T>(v:unknown,read:(v:unknown)=>T):Field<T>{const o=obj(v);const status=one(o.status,['known','missing','error']);const source=one<Source>(o.source,['songDetail','desktopWiki','ugcSong','manual','none']);const value=status==='known'?read(o.value):null;if(status!=='known'&&o.value!==null)throw new ReadError('structure');return {value,status,source,...(o.reason===undefined?{}:{reason:str(o.reason)})};}
function song(v:unknown):SongRecord {const o=obj(v);return {id:id(o.id),name:str(o.name),position:integer(o.position),artists:field(o.artists,v=>list(v,a=>{const o=obj(a);return {id:id(o.id),name:str(o.name)};})),genres:field(o.genres,v=>list(v,str)),bpm:field(o.bpm,v=>{const n=number(v);if(n<=0)throw new ReadError('structure');return n;}),language:field(o.language,str)};}
function descriptor(v:unknown):PlaylistDescriptor {const o=obj(v);return {id:id(o.id),name:str(o.name),creatorUid:id(o.creatorUid)};}
function snapshot(v:unknown,uid:string):LibrarySnapshot {const o=obj(v);const result={uid:id(o.uid),sourcePlaylistId:id(o.sourcePlaylistId),...(o.source===undefined?{}:{source:descriptor(o.source)}),declaredCount:integer(o.declaredCount),ids:ids(o.ids),songs:list(o.songs,song),revision:str(o.revision)};if(result.uid!==uid)throw new ReadError('accountChanged');validateSnapshot(result);return result;}
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
  const completedIds=ids(o.completedIds),sourceIds=new Set(source.ids);if(completedIds.some(id=>!sourceIds.has(id)))throw new ReadError('structure');
  return {snapshot:source,cache,completedIds,phase:one(o.phase,['reading','scanning','pausing','paused','complete','error']),updatedAt:number(o.updatedAt)};
}
function sanitize(value:unknown,uid:string):PersistedState {
  const o=obj(value);if(o.schemaVersion!==1||id(o.uid)!==uid)throw new ReadError('accountChanged');
  return {schemaVersion:1,uid,scan:checkpoint(o.scan,uid),writeJournal:journal(o.writeJournal,uid)};
}
function storedScan(value:unknown,uid:string,pid:string):StoredPlaylistScan {
  const o=obj(value),source=descriptor(o.source),scan=checkpoint(o.checkpoint,uid);
  if(o.schemaVersion!==2||id(o.uid)!==uid||source.id!==pid||!scan||scan.snapshot.sourcePlaylistId!==pid)throw new ReadError('structure');
  if(scan.phase==='complete'&&scan.completedIds.length!==scan.snapshot.ids.length)throw new ReadError('structure');
  const nested=scan.snapshot.source;
  if(nested&&(nested.id!==source.id||nested.name!==source.name||nested.creatorUid!==source.creatorUid))throw new ReadError('structure');
  const allowed=new Set(scan.snapshot.ids);
  if(Object.keys(scan.cache).some(key=>!allowed.has(key)))throw new ReadError('structure');
  return {schemaVersion:2,uid,source,checkpoint:scan,lastCompletedAt:o.lastCompletedAt===null?null:number(o.lastCompletedAt)};
}
export type ScanCacheInfo={source:PlaylistDescriptor;phase:ScanCheckpoint['phase'];processed:number;total:number;updatedAt:number|null;lastCompletedAt:number|null;byteSize:number;invalid:boolean};
export class LocalStore {
  // Cache only the last successfully stored bytes and an encoded, detached journal.
  // A different account, external writer, deletion or corrupt value invalidates the hit.
  private savedJournal: {account:string;raw:string;encoded:string}|undefined;
  constructor(private readonly storage:StorageLike=globalThis.localStorage){}
  private scanKey(uid:string,pid:string):string{return SCANS+id(uid)+':scan:'+id(pid);}
  private envelope(uid:string):Record<string,unknown>|null {
    const account=id(uid),raw=this.storage.getItem(PREFIX+account);
    if(raw===null)return null;
    const o=obj(JSON.parse(raw));
    if(o.schemaVersion!==1||id(o.uid)!==account)throw new ReadError('structure');
    // A damaged scan must not destroy a recoverable journal (or vice versa).
    journal(o.writeJournal,account);
    return o;
  }
  private writeEnvelope(uid:string,value:Record<string,unknown>):void {
    try{this.storage.setItem(PREFIX+id(uid),JSON.stringify(value));this.savedJournal=undefined;}
    catch{throw new ReadError('storage');}
  }
  listPresets(uid:string){return listPresets(this.storage,uid);}
  savePreset(uid:string,name:string,filters:Filters,artistNames:Record<string,string>){return savePreset(this.storage,uid,name,filters,artistNames);}
  renamePreset(uid:string,presetId:string,name:string):void{renamePreset(this.storage,uid,presetId,name);}
  deletePreset(uid:string,presetId:string):void{deletePreset(this.storage,uid,presetId);}
  listScanCaches(uid:string):ScanCacheInfo[]{
    const account=id(uid),prefix=SCANS+account+':scan:',rows:ScanCacheInfo[]=[];
    for(let i=0;i<this.storage.length;i++){
      const key=this.storage.key(i);if(!key?.startsWith(prefix))continue;
      const pid=key.slice(prefix.length);try{if(id(pid)!==pid)continue;}catch{continue;}
      const raw=this.storage.getItem(key);if(raw===null)continue;const byteSize=(key.length+raw.length)*2;
      try{const scan=storedScan(JSON.parse(raw),account,pid),c=scan.checkpoint;rows.push({source:scan.source,phase:c.phase,processed:c.completedIds.length,total:c.snapshot.ids.length,updatedAt:c.updatedAt,lastCompletedAt:scan.lastCompletedAt,byteSize,invalid:false});}
      catch{rows.push({source:{id:pid,name:'无法读取的歌单缓存',creatorUid:account},phase:'error',processed:0,total:0,updatedAt:null,lastCompletedAt:null,byteSize,invalid:true});}
    }
    return rows.sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.source.id.localeCompare(b.source.id));
  }
  deleteScan(uid:string,pid:string):void{
    const account=id(uid),source=id(pid),legacy=this.envelope(account);
    if(legacy?.scan){
      // Only the source identity is needed. A damaged, unrelated checkpoint must
      // neither block an independent cache deletion nor be discarded with it.
      let legacySource:string|null=null;
      try{legacySource=id(obj(obj(legacy.scan).snapshot).sourcePlaylistId);}catch{/* Preserve unidentifiable legacy data. */}
      if(legacySource===source)this.writeEnvelope(account,{schemaVersion:1,uid:account,scan:null,writeJournal:journal(legacy.writeJournal,account)});
    }
    try{this.storage.removeItem(this.scanKey(account,source));if(this.storage.getItem(this.scanKey(account,source))!==null)throw new Error('retained');}catch{throw new ReadError('storage');}
  }
  loadScan(uid:string,pid:string):StoredPlaylistScan|null {
    try{const account=id(uid),source=id(pid),raw=this.storage.getItem(this.scanKey(account,source));return raw===null?null:storedScan(JSON.parse(raw),account,source);}
    catch(error){if(error instanceof ReadError)throw error;throw new ReadError('structure');}
  }
  saveScan(uid:string,pid:string,value:StoredPlaylistScan):void {
    const safe=storedScan(value,id(uid),id(pid));
    try{this.storage.setItem(this.scanKey(uid,pid),JSON.stringify(safe));}catch{throw new ReadError('storage');}
  }
  listScans(uid:string):{items:ScanSummary[];invalidCount:number} {
    const prefix=SCANS+id(uid)+':scan:',items:ScanSummary[]=[];let invalidCount=0;
    for(let i=0;i<this.storage.length;i++){
      const key=this.storage.key(i);if(!key?.startsWith(prefix))continue;
      try{
        const pid=key.slice(prefix.length);if(id(pid)!==pid)throw new ReadError('structure');
        const value=this.loadScan(uid,pid);if(!value)continue;
        const c=value.checkpoint;items.push({source:value.source,phase:c.phase,processed:c.completedIds.length,total:c.snapshot.ids.length,updatedAt:c.updatedAt,lastCompletedAt:value.lastCompletedAt});
      }catch{invalidCount++;}
    }
    return {items:items.sort((a,b)=>b.updatedAt-a.updatedAt),invalidCount};
  }
  saveWriteJournal(uid:string,value:WriteJournal|null):void {
    const account=id(uid),latest=this.envelope(account);
    this.writeEnvelope(account,{schemaVersion:1,uid:account,scan:latest?.scan??null,writeJournal:journal(value,account)});
  }
  migrateLegacyScan(uid:string,verifiedFavoritesId:string):'none'|'migrated'|'alreadyPresent' {
    const account=id(uid),pid=id(verifiedFavoritesId),legacy=this.envelope(account);
    if(!legacy||legacy.scan===null)return 'none';
    const scan=checkpoint(legacy.scan,account);
    if(!scan||scan.snapshot.sourcePlaylistId!==pid)throw new ReadError('structure');
    const prior=this.loadScan(account,pid);
    if(!prior){
      const source:PlaylistDescriptor={id:pid,name:scan.snapshot.source?.name??'我喜欢',creatorUid:account};
      const allowed=new Set(scan.snapshot.ids);
      const cache=Object.fromEntries(Object.entries(scan.cache).filter(([key])=>allowed.has(key)));
      const next=storedScan({schemaVersion:2,uid:account,source,checkpoint:{...scan,cache,snapshot:{...scan.snapshot,source}},lastCompletedAt:scan.phase==='complete'?scan.updatedAt:null},account,pid);
      this.saveScan(account,pid,next);
      const saved=this.loadScan(account,pid);
      if(!saved||JSON.stringify(saved)!==JSON.stringify(next))throw new ReadError('storage');
    }
    const latest=this.envelope(account);
    // Do not clear a newer legacy scan written while storage was being read back.
    if(!latest||JSON.stringify(latest.scan)!==JSON.stringify(legacy.scan))throw new ReadError('storage');
    this.writeEnvelope(account,{schemaVersion:1,uid:account,scan:null,writeJournal:journal(latest.writeJournal,account)});
    return prior?'alreadyPresent':'migrated';
  }
  clearScans(uid:string,scope:{kind:'all'}|{kind:'exceptFavorites';favoritesId:string}):void {
    const account=id(uid),keep=scope.kind==='exceptFavorites'?id(scope.favoritesId):null;
    const legacy=this.envelope(account); // Validate the journal before any mutation.
    if(legacy&&legacy.scan!==null){
      let retain=false;
      if(keep){const s=checkpoint(legacy.scan,account);if(!s)throw new ReadError('structure');retain=s.snapshot.sourcePlaylistId===keep;}
      if(!retain)this.writeEnvelope(account,{schemaVersion:1,uid:account,scan:null,writeJournal:journal(legacy.writeJournal,account)});
    }
    const prefix=SCANS+account+':scan:',keys:string[]=[];
    for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key?.startsWith(prefix)&&(!keep||key!==prefix+keep))keys.push(key);}
    try{for(const key of keys)this.storage.removeItem(key);}catch{throw new ReadError('storage');}
  }
  load(uid:string):PersistedState|null {try{const account=id(uid);const raw=this.storage.getItem(PREFIX+account);return raw===null?null:sanitize(JSON.parse(raw),account);}catch{return null;}}
  // Scan checkpoints need the latest writer journal, not a restored song/cache copy.
  // Always re-read storage; validate the envelope and journal independently of scan data.
  loadWriteJournal(uid:string):Pick<PersistedState,'writeJournal'>|null {
    try {
      const account=id(uid),raw=this.storage.getItem(PREFIX+account);
      if(raw===null)return null;
      if(this.savedJournal?.account===account&&this.savedJournal.raw===raw)
        return {writeJournal:JSON.parse(this.savedJournal.encoded) as WriteJournal|null};
      const value=obj(JSON.parse(raw));
      if(value.schemaVersion!==1||id(value.uid)!==account)return null;
      return {writeJournal:journal(value.writeJournal,account)};
    } catch {return null;}
  }
  save(uid:string,state:PersistedState):void {
    const account=id(uid),safe=sanitize(state,account);
    try {
      const raw=JSON.stringify(safe);
      this.storage.setItem(PREFIX+account,raw);
      this.savedJournal={account,raw,encoded:JSON.stringify(safe.writeJournal)};
    } catch {throw new ReadError('storage');}
  }
  clearOtherAccounts(uid:string):void {
    const keep=PREFIX+id(uid),keys:string[]=[];for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key?.startsWith(PREFIX)&&key!==keep)keys.push(key);}
    try{keys.forEach(key=>this.storage.removeItem(key));}catch{throw new ReadError('storage');}
  }
}
