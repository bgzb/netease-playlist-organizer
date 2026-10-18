import {PresetError,type FilterPreset} from '../scan/presets';
import type { Filters, FilterResult, LibrarySnapshot, Progress, SongRecord, WriteConfirmation, WritePlan, WriteJournal, WriteProgress, WriteReport,SourceSelection,SourceCatalog,ScanSummary,StoredPlaylistScan } from '../core/model';
import { buildSelectionVersion, filterSongs, resolveSelection } from '../core/filter';
import { validateSnapshot,id } from '../client/library';
import {parsePlaylistSource,PlaylistInputError} from '../client/playlist-source';
import { ReadError } from '../client/requests';
import { CollectionChangedError, type Scanner } from '../scan/scan';
import type { LocalStore } from '../scan/store';
import type { Writer, RecoveryCandidate } from '../write/writer';
import { newJournal, saveJournal, copyJson } from '../write/journal';
import { ScanProgressMeter } from './progress';
import { ADAPTER_VERSION } from '../client/capabilities';
import { writeReasonText, type TargetOption } from './target';
export { readTargets } from './target';
export { filterCandidates } from './filters';
export { pageRows, textElement } from './preview';
export type PanelState = {
  uid: string | null; snapshot: LibrarySnapshot | null; progress: Progress;
  filters: Filters; added: Set<string>; removed: Set<string>; target: WritePlan['target'] | null;
  targets: TargetOption[]; selectionVersion: string; confirmation: WriteConfirmation | null;
  persisted: boolean; message: string;
  writeReview:WritePlan|null; writeProgress:WriteProgress|null; writeReport:WriteReport|null;
  recoveryJournal:WriteJournal|null; recoveryCandidates:RecoveryCandidate[]; recoveryReviewed:boolean;
  selectedSource:SourceSelection;sourceCatalog:SourceCatalog|null;catalogStatus:'idle'|'loading'|'ready'|'error';
  history:ScanSummary[];historyInvalidCount:number;sourceSwitch:'idle'|'saving'|'error';
  cacheView:'none'|'cached'|'verified';cacheUpdatedAt:number|null;lastCompletedAt:number|null;
  verifiedSource:{uid:string;playlistId:string;revision:string;generation:number}|null;viewGeneration:number;
};
const emptyFilters = (): Filters => ({ genres: [], languages: [], artistIds: [], bpmMin: null, bpmMax: null, allSongs: false });
const emptyResult = (): FilterResult => ({ matched: [], unknown: [], unmatched: [], reasons: {} });
export class PanelModel {
  private revision = 0;
  private libraryRevision=0;
  get libraryVersion():number{return this.libraryRevision;}
  constructor(private readonly selectionChanged:()=>void=()=>{}){}
  state: PanelState = {selectedSource:{kind:'favorites'},sourceCatalog:null,catalogStatus:'idle',history:[],historyInvalidCount:0,sourceSwitch:'idle',cacheView:'none',cacheUpdatedAt:null,lastCompletedAt:null,verifiedSource:null,viewGeneration:0,recoveryReviewed:false,writeReview:null,writeProgress:null,writeReport:null,recoveryJournal:null,recoveryCandidates:[], uid: null, snapshot: null, progress: {phase:'paused',processed:0,total:0}, filters:emptyFilters(), added:new Set(),removed:new Set(),target:null,targets:[],selectionVersion:'0',confirmation:null,persisted:false,message:'请选择来源歌单，读取完整列表后开始扫描。' };
  private invalidate(): void {
    this.state.confirmation = null;
    this.state.writeReview=null;
    this.selectionChanged();
    this.state.selectionVersion = JSON.stringify({ selection:buildSelectionVersion(this.state.filters,this.preview().ids,this.state.target), edits:++this.revision });
  }
  clearSelection(): void { this.state.filters=emptyFilters(); this.state.added.clear();this.state.removed.clear();this.state.target=null;this.state.targets=[];this.invalidate(); }
  clearLibrary(): void { this.libraryRevision++; this.state.verifiedSource=null;this.state.cacheView='none';this.state.cacheUpdatedAt=null;this.state.lastCompletedAt=null;this.state.viewGeneration++;this.state.writeProgress=null;this.state.recoveryReviewed=false;this.state.recoveryJournal=null;this.state.recoveryCandidates=[];this.state.writeReport=null;this.state.snapshot=null;this.state.progress={phase:'paused',processed:0,total:0};this.state.persisted=false;this.clearSelection(); }
  setAccount(uid: string | null): void { if(uid!==this.state.uid){this.clearLibrary();this.state.uid=uid;this.state.selectedSource={kind:'favorites'};this.state.sourceCatalog=null;this.state.catalogStatus='idle';this.state.history=[];this.state.historyInvalidCount=0;this.state.sourceSwitch='idle';} }
  setLibrary(snapshot: LibrarySnapshot): void {
    validateSnapshot(snapshot);
    const old=this.state.snapshot;
    this.setAccount(snapshot.uid);
    if(old && (old.revision!==snapshot.revision||old.sourcePlaylistId!==snapshot.sourcePlaylistId)){this.clearSelection();this.state.verifiedSource=null;this.state.viewGeneration++;}
    this.state.snapshot=snapshot;this.libraryRevision++;this.invalidate();
  }
  setProgress(progress:Progress,persisted:boolean):void{this.state.progress={...progress};this.state.persisted=persisted;}
  setFilters(filters:Filters):void{this.state.filters={...filters,genres:[...filters.genres],languages:[...filters.languages],artistIds:[...filters.artistIds]};this.invalidate();}
  manual(id:string,action:'add'|'remove'|'reset'):void{
    if(!this.state.snapshot?.ids.includes(id))return;
    this.state.added.delete(id);this.state.removed.delete(id);
    if(action==='add')this.state.added.add(id);if(action==='remove')this.state.removed.add(id);this.invalidate();
  }
  setTarget(target:WritePlan['target']|null):void {
    if(target?.kind==='existing'&&!this.state.targets.some(t=>t.id===target.id))throw new Error('请明确选择本人创建的普通歌单');
    this.state.target=target;this.invalidate();
  }
  setTargets(targets:TargetOption[]):void{this.state.targets=targets;if(this.state.target?.kind==='existing'&&!targets.some(t=>t.id===(this.state.target as {id:string}).id))this.setTarget(null);}
  chooseExisting(id:string):void{this.setTarget({kind:'existing',id});}
  preview():{result:FilterResult;ids:string[];error:string|null}{
    if(!this.state.snapshot)return {result:emptyResult(),ids:[],error:null};
    try{const result=filterSongs(this.state.snapshot.songs,this.state.filters);return {result,ids:resolveSelection(this.state.snapshot.songs,result,this.state.added,this.state.removed),error:null};}
    catch(error){return {result:emptyResult(),ids:[],error:error instanceof Error?error.message:'筛选条件无效'};}
  }
  canPrepare():boolean{return this.state.progress.phase==='complete'&&this.preview().ids.length>0&&this.state.target!==null&&(this.state.target.kind==='existing'||this.state.target.name.trim().length>0)&&this.preview().error===null;}
}
export type OrganizerStatus={installed:boolean;adapterVersion:string;readReady:boolean;writeVerification:'unverified'|'verified';scan?:{phase:string;processed:number;total:number;coverage:{artists:number;genres:number;bpm:number;language:number}}};
export function coverage(songs:SongRecord[]):{artists:number;genres:number;bpm:number;language:number} {
  const result={artists:0,genres:0,bpm:0,language:0};
  for(const field of ['artists','genres','bpm','language'] as const) result[field]=songs.length?songs.filter(s=>s[field].status==='known'&&s[field].value!==null).length/songs.length:0;
  return result;
}
export type PanelDependencies={now?:()=>number;readLibrary:(source:SourceSelection,signal:AbortSignal)=>Promise<LibrarySnapshot>;listSources:(signal:AbortSignal)=>Promise<SourceCatalog>;readUid:(signal?:AbortSignal)=>Promise<string>;readTargets:(uid:string,sourceId:string,signal:AbortSignal)=>Promise<TargetOption[]>;scanner:Scanner;store:LocalStore;writer?:Writer;setSignal?:(signal:AbortSignal|undefined)=>void};
export type UiOperation = { id:number; kind:'prepare'|'scan'|'write'|'recovery'|'source'|'maintenance'; status:'running'|'succeeded'|'paused'|'failed' };
export class PanelController {
  private toolsRevision=0;
  private toolsNotice:{uid:string;text:string}|null=null;
  private appliedArtists:{uid:string;names:Record<string,string>}|null=null;
  get savedToolsVersion():number{return this.toolsRevision;}
  get managementNotice():string|null{return this.toolsNotice?.uid===this.model.state.uid?this.toolsNotice.text:null;}
  get presetArtistNames():Record<string,string>{return this.appliedArtists?.uid===this.model.state.uid?this.appliedArtists.names:{};}
  presetCatalog():{items:FilterPreset[];error:string|null}{
    const uid=this.model.state.uid;if(!uid)return {items:[],error:null};
    try{return {items:this.deps.store.listPresets(uid),error:null};}catch{return {items:[],error:'筛选方案无法读取，原数据已保留。'};}
  }
  cacheInventory(){
    const uid=this.model.state.uid;if(!uid)return {items:[],error:null};
    try{return {items:this.deps.store.listScanCaches(uid),error:null};}catch{return {items:[],error:'缓存列表读取失败，请重试。'};}
  }
  private async manageLocal(action:(uid:string)=>void,success:string):Promise<void>{
    const uid=this.model.state.uid;if(!uid||this.isBusy)return;
    this.toolsNotice=null;
    await this.run(async signal=>{await this.guard(uid,signal);action(uid);this.toolsRevision++;this.toolsNotice={uid,text:success};},'maintenance');
  }
  async savePreset(name:string):Promise<void>{
    const filters=copyJson(this.model.state.filters),names={...this.presetArtistNames};
    for(const song of this.model.state.snapshot?.songs??[])for(const artist of song.artists.value??[])if(filters.artistIds.includes(artist.id))names[artist.id]=artist.name;
    await this.manageLocal(uid=>{this.deps.store.savePreset(uid,name,filters,names);},'筛选方案已保存，可在本账号的其他歌单套用。');
  }
  async renamePreset(presetId:string,name:string):Promise<void>{await this.manageLocal(uid=>this.deps.store.renamePreset(uid,presetId,name),'方案已重命名。');}
  async deletePreset(presetId:string):Promise<void>{await this.manageLocal(uid=>this.deps.store.deletePreset(uid,presetId),'方案已删除。');}
  applyPreset(presetId:string):boolean{
    const uid=this.model.state.uid;if(!uid||this.isBusy||!this.model.state.snapshot)return false;
    const item=this.presetCatalog().items.find(p=>p.id===presetId);if(!item)return false;
    this.model.state.added.clear();this.model.state.removed.clear();this.model.setFilters(item.filters);
    this.appliedArtists={uid,names:{...item.artistNames}};this.toolsRevision++;this.toolsNotice={uid,text:'方案已套用，人工选歌已重置；无匹配项的条件仍保留。'};this.changed();return true;
  }
  async deleteScanCache(pid:string):Promise<void>{
    await this.manageLocal(uid=>{
      this.deps.store.deleteScan(uid,pid);this.deps.scanner.discardSource(uid,pid);
      if(this.model.state.snapshot?.sourcePlaylistId===pid)this.model.clearLibrary();
      this.refreshHistory();
    },'该歌单扫描缓存已删除；筛选方案、写入日志和真实歌单保留。');
  }
  readonly progressMeter=new ScanProgressMeter();
  private now():number{return this.deps.now?.()??performance.now();}
  get scanMetrics(){return this.progressMeter.snapshot(this.now());}
  private operationSequence=0;
  private notification:UiOperation|null=null;
  get uiOperation():Readonly<UiOperation>|null{return this.notification;}
  get operationKind():'idle'|UiOperation['kind']{return this.busy?this.notification?.kind??'idle':'idle';}
  readonly model=new PanelModel(()=>{this.reviewNotice=null;if(this.writing)this.operation?.abort();});
  private writing=false;
  private preparationIncomplete=false;
  private failureKind:string|null=null;
  private accountAttention=false;
  private reviewNotice:string|null=null;
  get needsPreparation():boolean{return this.preparationIncomplete;}
  get storageBlocked():boolean{return this.failureKind==='storage';}
  get needsAttention():boolean{return this.accountAttention;}
  get writeNotice():string|null{return this.reviewNotice;}
  private pausing=false;
  get isPausing():boolean{return this.pausing;}
  private operation:AbortController|null=null;
  private alive=true;
  private busy=false;
  private checking=false;
  private monitor:AbortController|null=null;
  private monitorGeneration = 0;
  private listeners=new Set<()=>void>();
  private initialized=false;
  private scanning=false;
  private scanTask:Promise<void>|null=null;
  private operationGeneration=0;
  constructor(private readonly deps:PanelDependencies,private readonly readReady=true){}
  subscribe(fn:()=>void):()=>void{this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
  changed():void{if(this.alive)this.listeners.forEach(fn=>fn());}
  get isBusy():boolean{return this.busy||this.model.state.sourceSwitch==='saving';}
  get isScanning():boolean{return this.scanning;}
  get isWriting():boolean{return this.writing;}
  private error(error:unknown):void{
    this.failureKind=error instanceof ReadError?error.kind:'network';
    this.model.state.verifiedSource=null;
    if(this.model.state.snapshot)this.model.state.cacheView='cached';
    if(error instanceof CollectionChangedError){this.model.clearLibrary();this.model.state.message=`收藏已变化：新增 ${error.addedIds.length} 首（${error.addedIds.join('、')||'无'}），移除 ${error.removedIds.length} 首（${error.removedIds.join('、')||'无'}），顺序变化：${error.reordered?'是':'否'}。请重新读取并检查预览。`;}
    else if(error instanceof ReadError&&error.kind==='collectionChanged'){this.model.clearLibrary();this.model.state.message='收藏已变化，旧预览和写入状态已清空。请重新读取完整收藏、扫描并重新检查预览；保存的写入日志仍保留。';}
    else if(error instanceof ReadError&&['accountChanged','login'].includes(error.kind)){this.accountAttention=true;this.progressMeter.reset();this.model.setAccount(null);this.model.state.message='账号已变化或登录失效，旧选择已清空。请重新读取收藏。';}
    else {const kind=error instanceof ReadError?error.kind:'network';const messages:Record<string,string>={storage:'存储失败：结果仅在本页可见，暂停跨重启恢复。可重试存储、清理工具缓存或明确仅本页继续。',paused:'已暂停；可以继续扫描。',permission:'无读取权限，已暂停。',rateLimit:'请求受限，已暂停。请稍后手动恢复。',structure:'数据完整性或来源结构检查失败，已暂停。请重新读取。',network:'网络读取失败，已暂停。',business:'业务读取失败，已暂停。'};this.model.state.message=messages[kind]??'读取已暂停。';}
    // Only the typed numeric business code is safe to display; never use raw error messages/options.
    if(error instanceof ReadError&&typeof error.code==='number'&&Number.isFinite(error.code))this.model.state.message+=`（错误码 ${error.code}）`;
  }
  private invalidateMonitor(): void {
    this.monitorGeneration++;
    const monitor = this.monitor;
    this.monitor = null;
    this.checking = false;
    monitor?.abort();
  }

  private async run(work: (signal: AbortSignal) => Promise<void>, kind:UiOperation['kind']='source'): Promise<void> {
    if (!this.alive || this.isBusy || !this.readReady) return;
    // A foreground read/scan owns publication from here onward, even if an old
    // client request ignores cancellation and eventually settles.
    this.invalidateMonitor();
    this.busy = true;
    this.pausing=false;
    this.failureKind=null;
    if(kind==='prepare'){this.progressMeter.start(this.now());this.model.state.progress.phase='reading';this.model.state.message='正在读取并核对完整收藏。';}
    if(kind==='scan'){if(this.model.state.progress.phase==='complete')this.progressMeter.start(this.now());else this.progressMeter.resume(this.now());}
    if(kind==='write')this.model.state.message='正在写入并逐批读回核对；已发出的请求可能完成。';
    this.notification={id:++this.operationSequence,kind,status:'running'};
    let failed=false;
    this.operationGeneration++;
    const operation = new AbortController();
    this.operation = operation;
    this.deps.setSignal?.(operation.signal);
    this.changed();
    try {
      await work(operation.signal);
    } catch (error) {
      failed=true;
      if (this.alive){
        if(kind==='maintenance'&&!(error instanceof ReadError&&['accountChanged','login','paused'].includes(error.kind))){
          this.toolsNotice={uid:this.model.state.uid??'',text:error instanceof PresetError?error.message:'本地数据操作未完成，已保留可用数据，请重试。'};
        }else this.error(error);
      }
    } finally {
      if (this.operation === operation) {
        this.operation = null;
        this.deps.setSignal?.(undefined);
      }
      if(kind==='prepare'||kind==='scan')this.progressMeter.pause(this.now());
      if(!this.model.state.snapshot)this.progressMeter.reset();
      this.busy = false;
      this.pausing=false;
      if(operation.signal.aborted&&this.model.state.progress.phase==='pausing')this.model.state.progress.phase='paused';
      const complete=kind==='write'?this.model.state.writeReport?.status==='complete'&&!this.model.state.writeReport.unconfirmedIds.length:(kind==='prepare'||kind==='scan')&&this.model.state.progress.phase==='complete';
      this.notification={id:this.operationSequence,kind,status:failed||kind==='write'&&['error','uncertain'].includes(this.model.state.writeReport?.status??'')?'failed':complete?'succeeded':operation.signal.aborted||kind==='prepare'||kind==='scan'||kind==='write'?'paused':'succeeded'};
      this.changed();
    }
  }
  private refreshHistory():void {
    const uid=this.model.state.uid;if(!uid)return;
    const history=this.deps.store.listScans(uid);this.model.state.history=history.items;this.model.state.historyInvalidCount=history.invalidCount;
    this.model.state.recoveryJournal=this.deps.store.loadWriteJournal(uid)?.writeJournal??null;
  }
  private async guard(uid:string,signal:AbortSignal):Promise<void> {
    if(await this.deps.readUid(signal)!==uid)throw new ReadError('accountChanged');
    if(!this.alive||signal.aborted)throw new ReadError('paused');
  }
  private markVerified(snapshot:LibrarySnapshot):void {
    this.model.state.verifiedSource={uid:snapshot.uid,playlistId:snapshot.sourcePlaylistId,revision:snapshot.revision,generation:this.operationGeneration};
    this.model.state.cacheView='verified';
  }
  private restoreCache(record:StoredPlaylistScan):void {
    this.model.setLibrary(record.checkpoint.snapshot);
    const c=record.checkpoint;
    this.model.setProgress({phase:c.phase==='complete'?'complete':'paused',processed:c.completedIds.length,total:c.snapshot.ids.length},true);
    this.model.state.cacheView='cached';this.model.state.verifiedSource=null;
    this.model.state.cacheUpdatedAt=c.updatedAt;this.model.state.lastCompletedAt=record.lastCompletedAt;
    this.model.state.message='已载入本地缓存，尚未核对当前歌单。可手动继续扫描或强制刷新。';
  }
  private async loadCatalog(signal:AbortSignal):Promise<void> {
    const uid=this.model.state.uid;if(!uid)throw new ReadError('login');
    this.model.state.catalogStatus='loading';this.changed();
    try {
      const catalog=await this.deps.listSources(signal);await this.guard(uid,signal);
      if(catalog.uid!==uid)throw new ReadError('accountChanged');
      id(catalog.favoritesId);this.model.state.sourceCatalog=catalog;this.model.state.catalogStatus='ready';
      this.deps.store.migrateLegacyScan(uid,catalog.favoritesId);
      this.refreshHistory();
    }catch(error){this.model.state.catalogStatus='error';throw error;}
  }
  async initialize():Promise<void> {
    if(this.initialized||!this.alive||!this.readReady)return;this.initialized=true;
    await this.run(async signal=>{
      const uid=await this.deps.readUid(signal);if(!this.alive||signal.aborted)return;
      this.model.setAccount(uid);this.model.state.selectedSource={kind:'favorites'};
      this.refreshHistory();
      try{await this.loadCatalog(signal);}catch(error){
        if(error instanceof ReadError&&['login','accountChanged','paused'].includes(error.kind))throw error;
        this.error(error);this.model.state.message='来源目录或旧缓存迁移未完成，可刷新来源列表或手动输入歌单 ID。'+this.model.state.message;
        if(!this.model.state.sourceCatalog)return;
      }
      await this.activateSource({kind:'favorites'},signal,false);
    });
  }
  async refreshSources():Promise<void> {
    await this.run(async signal=>{
      const uid=await this.deps.readUid(signal);if(!this.alive||signal.aborted)return;
      if(this.model.state.uid&&this.model.state.uid!==uid)throw new ReadError('accountChanged');
      this.model.setAccount(uid);await this.loadCatalog(signal);
      if(this.model.state.selectedSource.kind==='favorites'&&this.model.state.snapshot?.sourcePlaylistId!==this.model.state.sourceCatalog!.favoritesId)
        await this.activateSource({kind:'favorites'},signal,true);
      else this.model.state.message='来源列表已更新，未启动扫描。';
    });
  }
  private async readFresh(source:SourceSelection,signal:AbortSignal,expectedUid?:string):Promise<boolean> {
    this.preparationIncomplete=true;this.accountAttention=false;this.reviewNotice=null;
    const previous=this.model.state.snapshot,progress={...this.model.state.progress},persisted=this.model.state.persisted;
    this.model.state.verifiedSource=null;
    if(previous)this.model.state.cacheView='cached';else this.model.state.progress.phase='reading';
    this.model.state.message='正在核对来源歌单的完整内容与顺序。';this.changed();
    const fresh=await this.deps.readLibrary(source,signal);validateSnapshot(fresh);
    await this.guard(fresh.uid,signal);
    if(expectedUid&&fresh.uid!==expectedUid)throw new ReadError('accountChanged');
    if(source.kind==='playlist'&&fresh.sourcePlaylistId!==id(source.id))throw new ReadError('structure');
    const same=previous?.uid===fresh.uid&&previous.sourcePlaylistId===fresh.sourcePlaylistId&&previous.revision===fresh.revision;
    const next=same?{...fresh,songs:fresh.songs.map((song,i)=>({...song,genres:previous.songs[i].genres,bpm:previous.songs[i].bpm,language:previous.songs[i].language}))}:fresh;
    this.model.setLibrary(next);this.model.state.selectedSource=source;
    this.model.setProgress(same?progress:{phase:'paused',processed:0,total:fresh.ids.length},same?persisted:false);
    this.markVerified(next);
    const targets=await this.deps.readTargets(fresh.uid,fresh.sourcePlaylistId,signal);await this.guard(fresh.uid,signal);
    this.model.setTargets(targets);this.refreshHistory();this.preparationIncomplete=false;
    this.model.state.message=same?'来源内容与顺序已核对，已有筛选和扫描结果保留。':`来源已读取：${fresh.ids.length} 首。请开始扫描元数据。`;
    return !!same;
  }
  private async activateSource(source:SourceSelection,signal:AbortSignal,reset:boolean):Promise<void> {
    const uid=this.model.state.uid;if(!uid)throw new ReadError('login');await this.guard(uid,signal);
    if(reset){this.model.clearLibrary();this.progressMeter.reset();}this.model.state.selectedSource=source;
    const pid=source.kind==='playlist'?id(source.id):this.model.state.sourceCatalog?.favoritesId;
    let record:StoredPlaylistScan|null=null;
    if(pid){
      try{record=this.deps.store.loadScan(uid,pid);}catch(error){this.error(error);this.model.state.message='该歌单缓存损坏，请清理后重新读取。';return;}
      // A failed v1 migration must leave its valid favorite checkpoint visible.
      if(!record&&source.kind==='favorites'){
        const legacy=this.deps.store.load(uid)?.scan;
        if(legacy?.snapshot.sourcePlaylistId===pid){
          const source=legacy.snapshot.source??{id:pid,name:'我喜欢',creatorUid:uid};
          record={schemaVersion:2,uid,source,checkpoint:{...legacy,snapshot:{...legacy.snapshot,source}},lastCompletedAt:legacy.phase==='complete'?legacy.updatedAt:null};
        }
      }
    }
    if(record){
      this.restoreCache(record);this.model.state.selectedSource=source;
      const targets=await this.deps.readTargets(uid,record.source.id,signal);await this.guard(uid,signal);this.model.setTargets(targets);this.refreshHistory();this.preparationIncomplete=false;
    }else await this.readFresh(source,signal,uid);
  }
  async submitSource(input:string):Promise<void> {
    try{await this.selectSource(parsePlaylistSource(input));}
    catch(error){if(error instanceof PlaylistInputError){this.model.state.message=error.message;this.changed();}else throw error;}
  }
  private async saveCurrentSource():Promise<void> {
    const snapshot=this.model.state.snapshot;if(!snapshot)return;
    if(this.deps.scanner.hasUnsavedResult(snapshot.uid,snapshot.sourcePlaylistId)){
      await this.deps.scanner.persistCurrent(snapshot.uid,snapshot.sourcePlaylistId);
      if(!this.alive)throw new ReadError('paused');
      if(this.model.state.uid!==snapshot.uid||this.model.state.snapshot?.sourcePlaylistId!==snapshot.sourcePlaylistId)throw new ReadError('accountChanged');
      const saved=this.deps.store.loadScan(snapshot.uid,snapshot.sourcePlaylistId);
      this.model.state.persisted=saved?.checkpoint.snapshot.revision===this.model.state.snapshot.revision;
    }
  }
  async selectSource(input:SourceSelection):Promise<void> {
    if(!this.alive||!this.readReady||this.writing||this.model.state.sourceSwitch==='saving')return;
    const source:SourceSelection=input.kind==='playlist'?{kind:'playlist',id:id(input.id)}:{kind:'favorites'};
    const state=this.model.state,uid=state.uid;
    const pid=source.kind==='playlist'?source.id:state.sourceCatalog?.favoritesId;
    if(pid&&pid===state.snapshot?.sourcePlaylistId)return;
    if(this.busy&&!this.scanning)return;
    this.invalidateMonitor();
    state.sourceSwitch='saving';this.changed();
    try {
      if(this.scanning){this.pause();await this.scanTask;}
      if(!this.alive)return;
      if(!uid||state.uid!==uid){state.sourceSwitch='idle';return;}
      await this.saveCurrentSource();
      if(await this.deps.readUid()!==uid)throw new ReadError('accountChanged');
      if(!this.alive)return;
      state.sourceSwitch='idle';
      await this.run(signal=>this.activateSource(source,signal,true));
    }catch(error){if(this.alive){this.error(error);state.sourceSwitch=state.uid?'error':'idle';this.changed();}}
  }
  async readLibrary():Promise<void>{await this.run(signal=>this.readCollection(signal),'prepare');}
  async prepareCollection():Promise<void>{
    const task=this.run(async signal=>{
      await this.readCollection(signal);
      if(!this.alive||signal.aborted||!this.model.state.snapshot)return;
      await this.scanCollection(signal);
    },'prepare');
    this.scanTask=task;try{await task;}finally{if(this.scanTask===task)this.scanTask=null;}
  }
  private async readCollection(signal:AbortSignal):Promise<void>{
    this.preparationIncomplete=true;this.accountAttention=false;this.reviewNotice=null;
    const uid=await this.deps.readUid(signal);if(!this.alive||signal.aborted)return;
    this.model.setAccount(uid);
    await this.readFresh(this.model.state.selectedSource,signal,uid);
    this.preparationIncomplete=false;
  }
  async scan():Promise<void>{
    if(!this.model.state.snapshot)return;
    if(this.preparationIncomplete){await this.prepareCollection();return;}
    const task=this.run(signal=>this.scanCollection(signal),'scan');
    this.scanTask=task;try{await task;}finally{if(this.scanTask===task)this.scanTask=null;}
  }
  private async scanCollection(signal:AbortSignal):Promise<void>{
      this.scanning=true;
      const snapshot = this.model.state.snapshot!;
      const scanner = this.deps.scanner;
      const generation = scanner.generation + 1;
      let revision=snapshot.revision,changeMessage='';
      const ownsOperation = () => this.alive && this.operation?.signal === signal
        && scanner.generation === generation && this.model.state.uid === snapshot.uid
        && this.model.state.snapshot?.sourcePlaylistId === snapshot.sourcePlaylistId
        && this.model.state.snapshot?.revision === revision;
      const belongs = (result: LibrarySnapshot) => result.uid === snapshot.uid
        && result.sourcePlaylistId === snapshot.sourcePlaylistId && result.revision === revision;
      this.model.state.confirmation = null;
      this.model.state.writeReview = null;
      this.model.state.message = '正在扫描元数据，可暂停后继续。';
      this.changed();
      try {
        const result = await scanner.scan(snapshot, signal, (progress, publication) => {
          if (!ownsOperation() || publication.generation !== generation) return;
          if (publication.result) {
            if(publication.change&&publication.result.uid===snapshot.uid&&publication.result.sourcePlaylistId===snapshot.sourcePlaylistId){
              revision=publication.result.revision;
              changeMessage=`来源变化：新增 ${publication.change.addedIds.length} 首，移除 ${publication.change.removedIds.length} 首，顺序变化 ${publication.change.reordered?'是':'否'}。旧选择已清空。`;
            }
            if (!belongs(publication.result)) return;
            this.model.setLibrary(publication.result);this.markVerified(publication.result);
          }
          this.model.setProgress(progress, scanner.status.persisted);
          this.progressMeter.observe(progress,this.now());
          this.changed();
        });
        if (!ownsOperation()) return;
        if (!belongs(result)) throw new ReadError('accountChanged');
        this.model.setLibrary(result);
        this.model.setProgress(scanner.status, scanner.status.persisted);
        this.progressMeter.observe(scanner.status,this.now());
        this.markVerified(result);this.refreshHistory();
        const saved=this.deps.store.loadScan(result.uid,result.sourcePlaylistId);
        this.model.state.cacheUpdatedAt=saved?.checkpoint.updatedAt??null;this.model.state.lastCompletedAt=saved?.lastCompletedAt??null;
        if(changeMessage){const targets=await this.deps.readTargets(result.uid,result.sourcePlaylistId,signal);await this.guard(result.uid,signal);this.model.setTargets(targets);}
        this.model.state.message = changeMessage+(scanner.status.phase === 'complete'
          ? '全量元数据扫描完成。请筛选、审阅清单后明确确认写入。' : '扫描已暂停，可以继续。');
      } catch (error) {
        if (ownsOperation()) this.model.setProgress(scanner.status, scanner.status.persisted);
        throw error;
      }finally{this.scanning=false;}
  }
  async prepareWrite():Promise<void> {
    if(this.isBusy||!this.alive||!this.deps.writer||!this.model.canPrepare())return;
    const old=this.model.state.snapshot!,verified=this.model.state.verifiedSource;
    if(!verified||verified.uid!==old.uid||verified.playlistId!==old.sourcePlaylistId||verified.revision!==old.revision){
      let same=false;await this.run(async signal=>{same=await this.readFresh({kind:'playlist',id:old.sourcePlaylistId},signal,old.uid);});
      if(!same||!this.model.state.verifiedSource){this.model.state.message+=' 来源变化或核对未完成，请重新扫描并检查预览。';this.changed();return;}
    }
    this.prepareVerifiedWrite();
  }
  private prepareVerifiedWrite():void {
    if(this.busy||!this.alive||!this.deps.writer||!this.model.canPrepare())return;
    const s=this.model.state,snapshot=s.snapshot!,ids=this.model.preview().ids;
    const old=this.deps.store.loadWriteJournal(snapshot.uid)?.writeJournal;
    const same=old && old.plan.sourceRevision===snapshot.revision
      && old.plan.sourcePlaylistId===snapshot.sourcePlaylistId
      && JSON.stringify(old.plan.songIds)===JSON.stringify(ids)
      && JSON.stringify(old.plan.target)===JSON.stringify(s.target);
    const replanned=old && old.plan.sourcePlaylistId===snapshot.sourcePlaylistId && s.recoveryReviewed && old.targetId===null && old.creationState==='uncertain'
      && old.plan.target.kind==='new' && s.target?.kind==='new' && s.target.name!==old.plan.target.name;
    const rebound=old && old.plan.sourcePlaylistId===snapshot.sourcePlaylistId && s.recoveryReviewed && old.targetId!==null
      && s.target?.kind==='existing' && s.target.id===old.targetId;
    const plan:WritePlan={taskId:same||rebound?old!.plan.taskId:`write-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      uid:snapshot.uid,sourcePlaylistId:snapshot.sourcePlaylistId,sourceRevision:snapshot.revision,
      selectionVersion:s.selectionVersion,songIds:[...ids],target:copyJson(s.target!)};
    try {
      if(old && !same && !rebound && !replanned && (old.creationState==='pending'||old.creationState==='uncertain'||old.batches.some(b=>b.state!=='confirmed'))){
        s.message='存在待核对写入任务，请先恢复核对；明确选用候选，或审阅不同名称的新计划。';this.reviewNotice=s.message;this.changed();return;
      }
      const journal=same||rebound?old!:newJournal(plan);
      // New final confirmation binds the reviewed list; an old confirmation is never restored.
      journal.plan=copyJson(plan);
      journal.review={filters:copyJson(s.filters),addedIds:[...s.added],removedIds:[...s.removed]};
      // A cancelled review must retain the prior unknown-create journal.
      if(!replanned)saveJournal(this.deps.store,journal);
      if(!replanned)s.recoveryJournal=journal;s.confirmation=null;s.writeReview=plan;s.writeReport=null;s.writeProgress=null;
      this.reviewNotice=null;s.message='请审阅完整清单、人工选择和目标可见性，然后点击最终确认。';
    }catch(error){this.error(error);this.reviewNotice=s.message;}
    this.changed();
  }
  async confirmWrite():Promise<void> {
    const plan=this.model.state.writeReview;
    if(!plan||!this.deps.writer||this.isBusy||plan.selectionVersion!==this.model.state.selectionVersion
      ||plan.sourceRevision!==this.model.state.snapshot?.revision||plan.sourcePlaylistId!==this.model.state.snapshot?.sourcePlaylistId||plan.uid!==this.model.state.uid)return;
    const confirmation:WriteConfirmation={uid:plan.uid,sourcePlaylistId:plan.sourcePlaylistId,sourceRevision:plan.sourceRevision,
      selectionVersion:plan.selectionVersion,targetKey:JSON.stringify(plan.target),confirmedAt:Date.now()};
    this.model.state.confirmation=confirmation;
    await this.run(async signal=>{
      this.writing=true;
      this.model.state.message='正在写入并逐批读回核对；可暂停，已经发出的请求可能完成。';
      try {
        const old=this.deps.store.loadWriteJournal(plan.uid)?.writeJournal;
        if(old?.plan.taskId!==plan.taskId){
          const journal=newJournal(plan);
          journal.review={filters:copyJson(this.model.state.filters),addedIds:[...this.model.state.added],removedIds:[...this.model.state.removed]};
          saveJournal(this.deps.store,journal);
        }
        const report=await this.deps.writer!.executeWrite(plan,confirmation,signal,progress=>{
          if(this.alive){this.model.state.writeProgress=progress;this.changed();}
        });
        if(!this.alive)return;
        this.model.state.writeReport=report;this.model.state.confirmation=null;this.model.state.writeReview=null;
        this.model.state.recoveryJournal=this.deps.store.loadWriteJournal(plan.uid)?.writeJournal??null;
        if(report.errors.includes('collectionChanged')){
          this.error(new ReadError('collectionChanged'));
          return;
        }
        if(report.errors.includes('accountChanged')||report.errors.includes('login'))this.model.setAccount(null);
        const label={complete:'写入读回核对完成',paused:'写入已暂停',uncertain:'写入结果待核对',error:'写入检查失败'}[report.status];
        this.model.state.message=`${label}：新增 ${report.addedIds.length}，已存在 ${report.alreadyPresentIds.length}，待核对 ${report.unconfirmedIds.length}。${report.errors.length?`原因：${report.errors.map(writeReasonText).join('、')}。`:''}恢复时需重新审阅和确认。`;
      }finally{this.writing=false;}
    },'write');
  }
  async reviewRecovery():Promise<void> {
    const journal=this.model.state.uid?this.deps.store.loadWriteJournal(this.model.state.uid)?.writeJournal:null;
    if(!journal||!this.deps.writer)return;
    await this.run(async signal=>{
      if(this.model.state.snapshot?.sourcePlaylistId!==journal.plan.sourcePlaylistId){
        await this.saveCurrentSource();await this.guard(journal.plan.uid,signal);
        await this.activateSource({kind:'playlist',id:journal.plan.sourcePlaylistId},signal,true);
      }
      await this.readFresh({kind:'playlist',id:journal.plan.sourcePlaylistId},signal,journal.plan.uid);
      const result=await this.deps.writer!.recover(journal.plan,signal);
      if(!this.alive||signal.aborted)return;
      const snapshot=this.model.state.snapshot;
      if(!snapshot||snapshot.uid!==journal.plan.uid||snapshot.sourcePlaylistId!==journal.plan.sourcePlaylistId||snapshot.revision!==JSON.stringify(result.sourceIds))throw new ReadError('collectionChanged');
      const scan=this.deps.store.loadScan(snapshot.uid,snapshot.sourcePlaylistId)?.checkpoint;
      if(scan?.phase==='complete'&&scan.snapshot.revision===snapshot.revision){this.model.setLibrary(scan.snapshot);this.model.setProgress({phase:'complete',processed:scan.completedIds.length,total:scan.snapshot.ids.length},true);}
      this.model.clearSelection();
      if(journal.review){this.model.setFilters(journal.review.filters);for(const id of journal.review.addedIds)this.model.manual(id,'add');for(const id of journal.review.removedIds)this.model.manual(id,'remove');}
      else {this.model.setFilters({...this.model.state.filters,allSongs:true});for(const id of snapshot.ids)if(!journal.plan.songIds.includes(id))this.model.manual(id,'remove');}
      const targets=await this.deps.readTargets(snapshot.uid,snapshot.sourcePlaylistId,signal);
      if(await this.deps.readUid(signal)!==snapshot.uid)throw new ReadError('accountChanged');
      if(!this.alive||signal.aborted)return;
      this.model.setTargets(targets);
      this.model.setTarget(journal.targetId?{kind:'existing',id:journal.targetId}:journal.plan.target);
      this.model.state.recoveryJournal=this.deps.store.loadWriteJournal(snapshot.uid)?.writeJournal??journal;
      this.model.state.recoveryCandidates=result.candidates;
      this.model.state.recoveryReviewed=true;
      const previous=JSON.parse(journal.plan.sourceRevision) as string[];
      const added=result.sourceIds.filter(id=>!previous.includes(id)),removed=previous.filter(id=>!result.sourceIds.includes(id));
      const common=new Set(result.sourceIds.filter(id=>previous.includes(id)));
      const reordered=JSON.stringify(previous.filter(id=>common.has(id)))!==JSON.stringify(result.sourceIds.filter(id=>common.has(id)));
      this.model.state.message=`恢复核对：账号 ${snapshot.uid}；来源：${snapshot.source?.name??'歌单'}（ID ${snapshot.sourcePlaylistId}，写前重新核对内容与顺序），${result.sourceChanged?`收藏变化：新增 ${added.length} 首（${added.join('、')||'无'}）、移除 ${removed.length} 首（${removed.join('、')||'无'}）、顺序变化 ${reordered?'是':'否'}，请重新预览确认`:'内容与顺序已核对'}；原清单 ${journal.plan.songIds.length} 首；目标读回已存在 ${result.presentIds.filter(id=>journal.plan.songIds.includes(id)).length} 首。规则和人工选择已恢复，请重新检查当前预览。${result.candidates.length?'创建结果不确定，请明确选用一个新出现的本人私密同名候选。':'必须重新审阅和最终确认。'}`;
    },'recovery');
  }
  async chooseRecoveryCandidate(candidateId:string):Promise<void> {
    const journal=this.model.state.recoveryJournal;
    if(!journal||!this.deps.writer||!this.model.state.recoveryCandidates.some(p=>p.id===candidateId))return;
    await this.run(async signal=>{
      this.model.chooseExisting(candidateId);
      const snapshot=this.model.state.snapshot!;
      if(!snapshot||snapshot.uid!==journal.plan.uid||snapshot.sourcePlaylistId!==journal.plan.sourcePlaylistId)throw new ReadError('permission');
      const nextPlan:WritePlan={...journal.plan,sourceRevision:snapshot.revision,songIds:this.model.preview().ids,
        target:{kind:'existing',id:candidateId},selectionVersion:this.model.state.selectionVersion};
      await this.deps.writer!.adoptCandidate(journal.plan,candidateId,nextPlan,signal);
      if(!this.alive||signal.aborted)return;
      this.model.state.recoveryJournal=this.deps.store.loadWriteJournal(journal.plan.uid)?.writeJournal??null;
      this.model.state.recoveryCandidates=[];
      this.model.state.message='已明确选用候选目标；尚未添加歌曲。请重新审阅完整清单并最终确认。';
    },'recovery');
  }
  pause():void{if(this.operation&&!this.pausing){this.pausing=true;this.progressMeter.pause(this.now());if(this.operationKind==='prepare'||this.operationKind==='scan')this.model.state.progress.phase='pausing';this.model.state.message='正在暂停，等待已发出的请求收尾。';this.operation.abort();this.changed();}}
  async forceRefresh():Promise<void>{const snapshot=this.model.state.snapshot;if(this.isBusy||!snapshot)return;this.deps.scanner.forceRefresh(snapshot.uid,snapshot.sourcePlaylistId);this.model.state.confirmation=null;await this.scan();}
  async retryPersistence():Promise<void>{const snapshot=this.model.state.snapshot;if(this.isBusy||!snapshot)return;this.deps.scanner.retryPersistence(snapshot.uid,snapshot.sourcePlaylistId);await this.scan();}
  continuePageOnly():boolean{
    const snapshot=this.model.state.snapshot;if(this.isBusy||this.preparationIncomplete||!snapshot||this.model.state.progress.phase!=='paused')return false;
    try{this.deps.scanner.continueWithoutPersistence(snapshot.uid,snapshot.sourcePlaylistId);this.model.state.persisted=false;this.model.state.message='已明确选择仅本页继续；关闭页面后无法恢复未保存进度。';this.changed();return true;}
    catch(error){this.error(error);this.changed();return false;}
  }
  async clearCache(kind:'all'|'exceptFavorites'='all'):Promise<void> {
    const uid=this.model.state.uid;if(this.isBusy||!uid)return;
    await this.run(async signal=>{
      await this.guard(uid,signal);
      let scope:{kind:'all'}|{kind:'exceptFavorites';favoritesId:string}={kind:'all'};
      if(kind==='exceptFavorites'){
        const catalog=await this.deps.listSources(signal);await this.guard(uid,signal);
        if(catalog.uid!==uid)throw new ReadError('accountChanged');
        scope={kind:'exceptFavorites',favoritesId:id(catalog.favoritesId)};this.model.state.sourceCatalog=catalog;
      }
      let failure:unknown;
      try{this.deps.store.clearScans(uid,scope);}catch(error){failure=error;}
      this.deps.scanner.discardCaches(uid,scope);
      const current=this.model.state.snapshot;
      if(current&&(scope.kind==='all'||current.sourcePlaylistId!==scope.favoritesId)){
        const remaining=this.deps.store.loadScan(uid,current.sourcePlaylistId);
        this.model.clearLibrary();if(remaining)this.restoreCache(remaining);
      }
      this.refreshHistory();
      if(failure){this.error(failure);this.model.state.message='清理未全部完成，请重试。'+this.model.state.message;}
      else this.model.state.message=kind==='all'?'已清除当前账号全部扫描缓存；写入恢复日志保留。':'已清除非我喜欢歌单的扫描缓存；我喜欢和写入恢复日志保留。';
    });
  }
  async checkAccount(): Promise<void> {
    if (!this.alive || !this.model.state.uid || this.checking || this.busy) return;
    this.checking = true;
    const uid = this.model.state.uid;
    const generation = this.monitorGeneration;
    const monitor = new AbortController();
    this.monitor = monitor;
    const ownsObservation = () => this.alive && !this.busy && !monitor.signal.aborted
      && this.monitor === monitor && this.monitorGeneration === generation
      && this.model.state.uid === uid;
    try {
      const current = await this.deps.readUid(monitor.signal);
      if (!ownsObservation()) return;
      if (current !== uid) {
        this.accountAttention=true;
        this.model.setAccount(current);
        this.progressMeter.reset();
        this.model.state.message = '账号已切换，旧预览和选择已清空。请重新读取。';
        this.changed();
      }
    } catch (error) {
      if (!ownsObservation()) return;
      this.error(error);
      this.changed();
    } finally {
      // Never release the checking flag or monitor owned by a newer generation.
      if (this.monitor === monitor && this.monitorGeneration === generation) {
        this.monitor = null;
        this.checking = false;
      }
    }
  }
  status():OrganizerStatus{const s=this.model.state;return {installed:this.alive,adapterVersion:ADAPTER_VERSION,readReady:this.readReady&&this.alive,writeVerification:'unverified',...(s.snapshot?{scan:{phase:s.progress.phase,processed:s.progress.processed,total:s.progress.total,coverage:coverage(s.snapshot.songs)}}:{})};}
  remove(): void {
    this.alive = false;
    this.pause();
    this.invalidateMonitor();
    this.listeners.clear();
  }
}
