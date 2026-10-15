import type { Filters, FilterResult, LibrarySnapshot, Progress, SongRecord, WriteConfirmation, WritePlan, WriteJournal, WriteProgress, WriteReport } from '../core/model';
import { buildSelectionVersion, filterSongs, resolveSelection } from '../core/filter';
import { validateSnapshot } from '../client/library';
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
};
const emptyFilters = (): Filters => ({ genres: [], languages: [], artistIds: [], bpmMin: null, bpmMax: null, allSongs: false });
const emptyResult = (): FilterResult => ({ matched: [], unknown: [], unmatched: [], reasons: {} });
export class PanelModel {
  private revision = 0;
  constructor(private readonly selectionChanged:()=>void=()=>{}){}
  state: PanelState = {recoveryReviewed:false,writeReview:null,writeProgress:null,writeReport:null,recoveryJournal:null,recoveryCandidates:[], uid: null, snapshot: null, progress: {phase:'paused',processed:0,total:0}, filters:emptyFilters(), added:new Set(),removed:new Set(),target:null,targets:[],selectionVersion:'0',confirmation:null,persisted:false,message:'请读取完整收藏，再开始元数据扫描。' };
  private invalidate(): void {
    this.state.confirmation = null;
    this.state.writeReview=null;
    this.selectionChanged();
    this.state.selectionVersion = JSON.stringify({ selection:buildSelectionVersion(this.state.filters,this.preview().ids,this.state.target), edits:++this.revision });
  }
  clearSelection(): void { this.state.filters=emptyFilters(); this.state.added.clear();this.state.removed.clear();this.state.target=null;this.state.targets=[];this.invalidate(); }
  clearLibrary(): void { this.state.writeProgress=null;this.state.recoveryReviewed=false;this.state.recoveryJournal=null;this.state.recoveryCandidates=[];this.state.writeReport=null;this.state.snapshot=null;this.state.progress={phase:'paused',processed:0,total:0};this.state.persisted=false;this.clearSelection(); }
  setAccount(uid: string | null): void { if(uid!==this.state.uid){this.clearLibrary();this.state.uid=uid;} }
  setLibrary(snapshot: LibrarySnapshot): void {
    validateSnapshot(snapshot);
    const old=this.state.snapshot;
    this.setAccount(snapshot.uid);
    if(old && (old.revision!==snapshot.revision||old.sourcePlaylistId!==snapshot.sourcePlaylistId))this.clearSelection();
    this.state.snapshot=snapshot;this.invalidate();
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
export type PanelDependencies={now?:()=>number;readLibrary:(signal:AbortSignal)=>Promise<LibrarySnapshot>;readUid:(signal?:AbortSignal)=>Promise<string>;readTargets:(uid:string,sourceId:string,signal:AbortSignal)=>Promise<TargetOption[]>;scanner:Scanner;store:LocalStore;writer?:Writer;setSignal?:(signal:AbortSignal|undefined)=>void};
export type UiOperation = { id:number; kind:'prepare'|'scan'|'write'|'recovery'; status:'running'|'succeeded'|'paused'|'failed' };
export class PanelController {
  readonly progressMeter=new ScanProgressMeter();
  private now():number{return this.deps.now?.()??performance.now();}
  get scanMetrics(){return this.progressMeter.snapshot(this.now());}
  private operationSequence=0;
  private notification:UiOperation|null=null;
  get uiOperation():Readonly<UiOperation>|null{return this.notification;}
  get operationKind():'idle'|UiOperation['kind']{return this.busy?this.notification?.kind??'idle':'idle';}
  readonly model=new PanelModel(()=>{if(this.writing)this.operation?.abort();});
  private writing=false;
  private operation:AbortController|null=null;
  private alive=true;
  private busy=false;
  private checking=false;
  private monitor:AbortController|null=null;
  private monitorGeneration = 0;
  private listeners=new Set<()=>void>();
  constructor(private readonly deps:PanelDependencies,private readonly readReady=true){}
  subscribe(fn:()=>void):()=>void{this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
  changed():void{if(this.alive)this.listeners.forEach(fn=>fn());}
  get isBusy():boolean{return this.busy;}
  get isWriting():boolean{return this.writing;}
  private error(error:unknown):void{
    if(error instanceof CollectionChangedError){this.model.clearLibrary();this.model.state.message=`收藏已变化：新增 ${error.addedIds.length} 首（${error.addedIds.join('、')||'无'}），移除 ${error.removedIds.length} 首（${error.removedIds.join('、')||'无'}），顺序变化：${error.reordered?'是':'否'}。请重新读取并检查预览。`;}
    else if(error instanceof ReadError&&error.kind==='collectionChanged'){this.model.clearLibrary();this.model.state.message='收藏已变化，旧预览和写入状态已清空。请重新读取完整收藏、扫描并重新检查预览；保存的写入日志仍保留。';}
    else if(error instanceof ReadError&&['accountChanged','login'].includes(error.kind)){this.model.setAccount(null);this.model.state.message='账号已变化或登录失效，旧选择已清空。请重新读取收藏。';}
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

  private async run(work: (signal: AbortSignal) => Promise<void>, kind:UiOperation['kind']='recovery'): Promise<void> {
    if (!this.alive || this.busy || !this.readReady) return;
    // A foreground read/scan owns publication from here onward, even if an old
    // client request ignores cancellation and eventually settles.
    this.invalidateMonitor();
    this.busy = true;
    if(kind==='prepare')this.progressMeter.start(this.now());
    if(kind==='scan')this.progressMeter.resume(this.now());
    this.notification={id:++this.operationSequence,kind,status:'running'};
    let failed=false;
    const operation = new AbortController();
    this.operation = operation;
    this.deps.setSignal?.(operation.signal);
    this.changed();
    try {
      await work(operation.signal);
    } catch (error) {
      failed=true;
      if (this.alive) this.error(error);
    } finally {
      if (this.operation === operation) {
        this.operation = null;
        this.deps.setSignal?.(undefined);
      }
      if(kind==='prepare'||kind==='scan')this.progressMeter.pause(this.now());
      if(!this.model.state.snapshot)this.progressMeter.reset();
      this.busy = false;
      const complete=kind==='write'?this.model.state.writeReport?.status==='complete'&&!this.model.state.writeReport.unconfirmedIds.length:(kind==='prepare'||kind==='scan')&&this.model.state.progress.phase==='complete';
      this.notification={id:this.operationSequence,kind,status:failed?'failed':complete?'succeeded':operation.signal.aborted||kind==='prepare'||kind==='scan'||kind==='write'?'paused':'succeeded'};
      this.changed();
    }
  }
  async prepareCollection():Promise<void>{
    await this.run(async signal=>{
      await this.readCollection(signal);
      if(!this.alive||signal.aborted||!this.model.state.snapshot)return;
      await this.scanCollection(signal);
    },'prepare');
  }
  async readLibrary():Promise<void>{await this.run(signal=>this.readCollection(signal),'prepare');}
  private async readCollection(signal:AbortSignal):Promise<void>{
      this.model.clearLibrary();
      this.model.state.progress.phase='reading';
      this.model.state.message='正在重新读取完整收藏，请等待来源和顺序核对。';
      this.changed();
      const snapshot=await this.deps.readLibrary(signal);
      if(!this.alive||signal.aborted)return;
      this.model.setLibrary(snapshot);
      this.model.setProgress({phase:'paused',processed:0,total:snapshot.ids.length},false);
      this.model.state.message=`完整收藏已读取：${snapshot.ids.length} 首。开始或继续全量元数据扫描。`;
      this.changed();
      const targets=await this.deps.readTargets(snapshot.uid,snapshot.sourcePlaylistId,signal);
      if(!this.alive||signal.aborted)return;
      if(await this.deps.readUid(signal)!==snapshot.uid)throw new ReadError('accountChanged');
      if(!this.alive||signal.aborted)return;
      this.model.setTargets(targets);
      this.model.state.recoveryJournal=this.deps.store.load(snapshot.uid)?.writeJournal??null;
  }
  async scan(): Promise<void> {
    if (!this.model.state.snapshot) return;
    await this.run(signal=>this.scanCollection(signal),'scan');
  }
  private async scanCollection(signal:AbortSignal):Promise<void>{
      const snapshot = this.model.state.snapshot!;
      const scanner = this.deps.scanner;
      const generation = scanner.generation + 1;
      const ownsOperation = () => this.alive && this.operation?.signal === signal
        && scanner.generation === generation && this.model.state.uid === snapshot.uid
        && this.model.state.snapshot?.sourcePlaylistId === snapshot.sourcePlaylistId
        && this.model.state.snapshot?.revision === snapshot.revision;
      const belongs = (result: LibrarySnapshot) => result.uid === snapshot.uid
        && result.sourcePlaylistId === snapshot.sourcePlaylistId && result.revision === snapshot.revision;
      this.model.state.confirmation = null;
      this.model.state.writeReview = null;
      this.model.state.message = '正在扫描元数据，可暂停后继续。';
      this.changed();
      try {
        const result = await scanner.scan(snapshot, signal, (progress, publication) => {
          if (!ownsOperation() || publication.generation !== generation) return;
          if (publication.result) {
            if (!belongs(publication.result)) return;
            this.model.setLibrary(publication.result);
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
        this.model.state.message = scanner.status.phase === 'complete'
          ? '全量元数据扫描完成。请筛选、审阅清单后明确确认写入。' : '扫描已暂停，可以继续。';
      } catch (error) {
        if (ownsOperation()) this.model.setProgress(scanner.status, scanner.status.persisted);
        throw error;
      }
  }
  prepareWrite():void {
    if(this.busy||!this.alive||!this.deps.writer||!this.model.canPrepare())return;
    const s=this.model.state,snapshot=s.snapshot!,ids=this.model.preview().ids;
    const old=this.deps.store.load(snapshot.uid)?.writeJournal;
    const same=old && old.plan.sourceRevision===snapshot.revision
      && old.plan.sourcePlaylistId===snapshot.sourcePlaylistId
      && JSON.stringify(old.plan.songIds)===JSON.stringify(ids)
      && JSON.stringify(old.plan.target)===JSON.stringify(s.target);
    const replanned=old && s.recoveryReviewed && old.targetId===null && old.creationState==='uncertain'
      && old.plan.target.kind==='new' && s.target?.kind==='new' && s.target.name!==old.plan.target.name;
    const rebound=old && s.recoveryReviewed && old.targetId!==null
      && s.target?.kind==='existing' && s.target.id===old.targetId;
    const plan:WritePlan={taskId:same||rebound?old!.plan.taskId:`write-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      uid:snapshot.uid,sourcePlaylistId:snapshot.sourcePlaylistId,sourceRevision:snapshot.revision,
      selectionVersion:s.selectionVersion,songIds:[...ids],target:copyJson(s.target!)};
    try {
      if(old && !same && !rebound && !replanned && (old.creationState==='pending'||old.creationState==='uncertain'||old.batches.some(b=>b.state!=='confirmed'))){
        s.message='存在待核对写入任务，请先恢复核对；明确选用候选，或审阅不同名称的新计划。';this.changed();return;
      }
      const journal=same||rebound?old!:newJournal(plan);
      // New final confirmation binds the reviewed list; an old confirmation is never restored.
      journal.plan=copyJson(plan);
      journal.review={filters:copyJson(s.filters),addedIds:[...s.added],removedIds:[...s.removed]};
      // A cancelled review must retain the prior unknown-create journal.
      if(!replanned)saveJournal(this.deps.store,journal);
      if(!replanned)s.recoveryJournal=journal;s.confirmation=null;s.writeReview=plan;
      s.message='请审阅完整清单、人工选择和目标可见性，然后点击最终确认。';
    }catch(error){this.error(error);}
    this.changed();
  }
  async confirmWrite():Promise<void> {
    const plan=this.model.state.writeReview;
    if(!plan||!this.deps.writer||this.busy||plan.selectionVersion!==this.model.state.selectionVersion
      ||plan.sourceRevision!==this.model.state.snapshot?.revision||plan.uid!==this.model.state.uid)return;
    const confirmation:WriteConfirmation={uid:plan.uid,sourceRevision:plan.sourceRevision,
      selectionVersion:plan.selectionVersion,targetKey:JSON.stringify(plan.target),confirmedAt:Date.now()};
    this.model.state.confirmation=confirmation;
    await this.run(async signal=>{
      this.writing=true;
      this.model.state.message='正在写入并逐批读回核对；可暂停，已经发出的请求可能完成。';
      try {
        const old=this.deps.store.load(plan.uid)?.writeJournal;
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
        this.model.state.recoveryJournal=this.deps.store.load(plan.uid)?.writeJournal??null;
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
    const journal=this.model.state.uid?this.deps.store.load(this.model.state.uid)?.writeJournal:null;
    if(!journal||!this.deps.writer)return;
    await this.run(async signal=>{
      const result=await this.deps.writer!.recover(journal.plan,signal);
      if(!this.alive||signal.aborted)return;
      const snapshot=this.model.state.snapshot;
      if(!snapshot||snapshot.uid!==journal.plan.uid||snapshot.revision!==JSON.stringify(result.sourceIds))throw new ReadError('collectionChanged');
      const scan=this.deps.store.load(snapshot.uid)?.scan;
      if(scan?.phase==='complete'&&scan.snapshot.revision===snapshot.revision){this.model.setLibrary(scan.snapshot);this.model.setProgress({phase:'complete',processed:scan.completedIds.length,total:scan.snapshot.ids.length},true);}
      this.model.clearSelection();
      if(journal.review){this.model.setFilters(journal.review.filters);for(const id of journal.review.addedIds)this.model.manual(id,'add');for(const id of journal.review.removedIds)this.model.manual(id,'remove');}
      else {this.model.setFilters({...this.model.state.filters,allSongs:true});for(const id of snapshot.ids)if(!journal.plan.songIds.includes(id))this.model.manual(id,'remove');}
      const targets=await this.deps.readTargets(snapshot.uid,snapshot.sourcePlaylistId,signal);
      if(await this.deps.readUid(signal)!==snapshot.uid)throw new ReadError('accountChanged');
      if(!this.alive||signal.aborted)return;
      this.model.setTargets(targets);
      this.model.setTarget(journal.targetId?{kind:'existing',id:journal.targetId}:journal.plan.target);
      this.model.state.recoveryJournal=this.deps.store.load(snapshot.uid)?.writeJournal??journal;
      this.model.state.recoveryCandidates=result.candidates;
      this.model.state.recoveryReviewed=true;
      const previous=JSON.parse(journal.plan.sourceRevision) as string[];
      const added=result.sourceIds.filter(id=>!previous.includes(id)),removed=previous.filter(id=>!result.sourceIds.includes(id));
      const common=new Set(result.sourceIds.filter(id=>previous.includes(id)));
      const reordered=JSON.stringify(previous.filter(id=>common.has(id)))!==JSON.stringify(result.sourceIds.filter(id=>common.has(id)));
      this.model.state.message=`恢复核对：账号 ${snapshot.uid}；来源：我喜欢（写前重新核对内容与顺序），${result.sourceChanged?`收藏变化：新增 ${added.length} 首（${added.join('、')||'无'}）、移除 ${removed.length} 首（${removed.join('、')||'无'}）、顺序变化 ${reordered?'是':'否'}，请重新预览确认`:'内容与顺序已核对'}；原清单 ${journal.plan.songIds.length} 首；目标读回已存在 ${result.presentIds.filter(id=>journal.plan.songIds.includes(id)).length} 首。规则和人工选择已恢复，请重新检查当前预览。${result.candidates.length?'创建结果不确定，请明确选用一个新出现的本人私密同名候选。':'必须重新审阅和最终确认。'}`;
    });
  }
  async chooseRecoveryCandidate(candidateId:string):Promise<void> {
    const journal=this.model.state.recoveryJournal;
    if(!journal||!this.deps.writer||!this.model.state.recoveryCandidates.some(p=>p.id===candidateId))return;
    await this.run(async signal=>{
      this.model.chooseExisting(candidateId);
      const snapshot=this.model.state.snapshot!;
      const nextPlan:WritePlan={...journal.plan,sourceRevision:snapshot.revision,songIds:this.model.preview().ids,
        target:{kind:'existing',id:candidateId},selectionVersion:this.model.state.selectionVersion};
      await this.deps.writer!.adoptCandidate(journal.plan,candidateId,nextPlan,signal);
      if(!this.alive||signal.aborted)return;
      this.model.state.recoveryJournal=this.deps.store.load(journal.plan.uid)?.writeJournal??null;
      this.model.state.recoveryCandidates=[];
      this.model.state.message='已明确选用候选目标；尚未添加歌曲。请重新审阅完整清单并最终确认。';
    });
  }
  pause():void{if(this.operation){this.progressMeter.pause(this.now());this.model.state.progress.phase='pausing';this.model.state.message='正在暂停，等待已发出的请求收尾。';this.operation.abort();this.changed();}}
  async forceRefresh():Promise<void>{if(this.busy||!this.model.state.snapshot)return;this.deps.scanner.forceRefresh();this.model.state.confirmation=null;await this.scan();}
  async retryPersistence():Promise<void>{if(this.busy)return;this.deps.scanner.retryPersistence();await this.scan();}
  continuePageOnly():void{if(this.busy)return;this.deps.scanner.continueWithoutPersistence();this.model.state.persisted=false;this.model.state.message='已明确选择仅本页继续；关闭页面后无法恢复未保存进度。';this.changed();}
  async clearCache():Promise<void>{if(this.busy||!this.model.state.uid)return;const uid=this.model.state.uid;try{const latest=this.deps.store.load(uid);this.deps.store.save(uid,{schemaVersion:1,uid,scan:null,writeJournal:latest?.writeJournal??null});this.deps.scanner.forceRefresh();this.deps.scanner.retryPersistence();this.model.clearLibrary();this.model.state.message='已清理当前账号的工具扫描缓存；写入任务日志保留。请重新读取。';}catch(e){this.error(e);}this.changed();}
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
