import {renderPresets} from './presets';
import {renderCacheManager} from './cache-manager';
import {coverage,type PanelController} from './panel';
import {renderSource} from './source';
import {canEnterPage,type WorkspaceState,type WorkspacePage} from './workspace-state';
import {textElement,renderPreview} from './preview';
import {renderFilters,FilterCandidateCache} from './filters';
import {createPlaylistNavigator,validPlaylistId} from './navigation';
import {renderTarget,renderWriteControls} from './target';
export function actionButton(doc:Document,label:string,key:string,action:()=>unknown,disabled=false):HTMLButtonElement{
 const b=textElement(doc,'button',label);b.dataset.action=key;b.dataset.key=key;b.disabled=disabled;b.onclick=()=>{if(!b.disabled)void action();};return b;
}
const phaseText:Record<string,string>={reading:'正在读取收藏',scanning:'正在扫描元数据',pausing:'正在暂停',paused:'已暂停',complete:'准备完成',error:'准备遇到问题'};
export const duration=(ms:number)=>ms<60000?`${Math.floor(ms/1000)} 秒`:`${Math.floor(ms/60000)} 分 ${Math.floor(ms/1000)%60} 秒`;
export function createWorkspaceView(doc:Document,root:HTMLElement,controller:PanelController,options:{openPlaylist?:(id:string)=>boolean}={}):{update(state:WorkspaceState):void;dispose():void}{
 let cacheManagerOpen=false;let cacheAccount:string|null=null;
 let prepareView:{update():void}|null=null;let prepareOperationId=0;let renderedContext:string|null=null;
 let state:WorkspaceState;let signature='';let filterIdentity='';let lastFilters='';let previewView:ReturnType<typeof renderPreview>|null=null;let disposed=false;let targetMode:'new'|'existing'|null=null;let reviewPage=0;let reviewTask:string|null=null;let viewContext:string|null=null;const searches:Record<string,string>={};const candidatePages:Record<string,number>={};const candidateCache=new FilterCandidateCache();
 const nav=textElement(doc,'nav','');nav.className='stages';nav.setAttribute('aria-label','整理阶段');
 const body=textElement(doc,'main','');body.className='workspace-body';
 const footer=textElement(doc,'footer','');footer.className='workspace-footer';
 root.append(nav,body,footer);
 const changed=()=>controller.changed();const navigatePlaylist=options.openPlaylist??createPlaylistNavigator(doc);
 const findKey=(key:string):HTMLElement|null=>{const visit=(node:Element):HTMLElement|null=>{if((node as HTMLElement).dataset?.key===key)return node as HTMLElement;for(const child of Array.from(node.children)){const match=visit(child);if(match)return match;}return null;};return visit(root);};
 const focusHeading=()=>{const title=body.querySelector('h2');if(title){title.tabIndex=-1;title.focus();}};
 function go(page:WorkspacePage){if(!canEnterPage(page,controller))return;if(page==='filter'){controller.model.state.writeReview=null;controller.model.state.confirmation=null;}state.page=page;state.recoveryMode=false;state.detailSongId=null;state.filterPanelOpen=false;changed();}
 function recovery(){if(!controller.model.state.recoveryJournal||controller.isBusy)return;state.recoveryMode=true;state.page='write';state.detailSongId=null;changed();}
 function prepare(){
  const box=textElement(doc,'section','');box.className='prepare-page';
  const hero=textElement(doc,'div','');hero.className='hero';
  const eyebrow=textElement(doc,'span','YOUR COLLECTION, RECOMPOSED');
  const title=textElement(doc,'h2','');
  hero.append(eyebrow,title,textElement(doc,'p','读取收藏并准备筛选数据，用曲风、语种、歌手与节奏，整理属于你的歌单。'));
  const sourceRegion=textElement(doc,'div','');let sourceSignature='';
  const status=textElement(doc,'section','');status.className='scan-status';
  const phase=textElement(doc,'h3',''),bar=doc.createElement('progress'),count=textElement(doc,'p','');
  const metrics=textElement(doc,'div','');metrics.className='metrics';metrics.dataset.action='scan-metrics';
  const empty=textElement(doc,'p','收藏中暂无歌曲');
  const message=textElement(doc,'p','');message.className='notice';
  const details=textElement(doc,'details','');details.dataset.action='prepare-details';details.append(textElement(doc,'summary','查看准备详情'));
  const rates=new Map<string,HTMLElement>();
  for(const [key,label] of [['artists','歌手'],['genres','曲风'],['bpm','BPM'],['language','语种']] as const){const node=textElement(doc,'p','');rates.set(key,node);details.append(node);}
  const persistence=textElement(doc,'p','');details.append(persistence);
  const suspended=new Map<string,HTMLElement>();
  for(const [key,label] of [['genres','曲风'],['bpm','BPM'],['language','语种']] as const){const node=textElement(doc,'p',`${label}来源暂不可用，可在更多中强制更新。`);suspended.set(key,node);details.append(node);}
  const journal=textElement(doc,'p','保留了一份写入日志，可通过“查看写入日志”显式恢复核对。');details.append(journal);
  status.append(phase,bar,count,metrics,empty,message,details);box.append(hero,sourceRegion,status);body.append(box);
  const pause=actionButton(doc,'暂停准备','pause',()=>controller.pause());
  const retry=actionButton(doc,'重试保存并继续','retry-storage',()=>controller.retryPersistence());
  const pageOnly=actionButton(doc,'仅本页继续','page-only',()=>{if(controller.continuePageOnly())return controller.scan();});
  const start=actionButton(doc,'开始整理','prepare',()=>{const s=controller.model.state;return s.snapshot&&s.progress.phase!=='complete'&&!controller.needsPreparation?controller.scan():controller.prepareCollection();});start.className='primary';
  const filter=actionButton(doc,'前往筛选','to-filter',()=>go('filter'));
  const saved=actionButton(doc,'查看写入日志','open-recovery',recovery);
  footer.append(pause,retry,pageOnly,start,filter,saved);
  const text=(node:HTMLElement,value:string)=>{if(node.textContent!==value)node.textContent=value;};
  const button=(node:HTMLButtonElement,visible:boolean,disabled=false)=>{node.hidden=!visible;node.disabled=!visible||disabled;};
  prepareView={update(){
   const s=controller.model.state,p=s.progress,busy=controller.isBusy,hasProgress=!!s.snapshot||busy;
   const sourceKey=JSON.stringify([s.uid,s.sourceCatalog,s.catalogStatus,s.history,s.historyInvalidCount,s.selectedSource,s.snapshot?.source,s.cacheView,s.cacheUpdatedAt,s.lastCompletedAt,s.sourceSwitch,busy,controller.isScanning,s.viewGeneration,cacheManagerOpen,controller.savedToolsVersion,controller.managementNotice]);
   if(sourceKey!==sourceSignature){sourceRegion.replaceChildren(renderSource(doc,controller,{manageCache:()=>{cacheManagerOpen=true;sourceSignature='';changed();}}));if(cacheManagerOpen)sourceRegion.append(renderCacheManager(doc,controller,()=>{cacheManagerOpen=false;sourceSignature='';changed();}));sourceSignature=sourceKey;}
   const resuming=busy&&p.phase==='paused'&&!controller.isPausing;
   text(title,s.snapshot?'让喜欢的音乐，各得其所。':'从喜欢，找到新的共鸣。');
   text(phase,busy?(controller.needsPreparation?'正在读取并核对收藏':resuming?'正在核对收藏':phaseText[p.phase]??'正在准备'):s.snapshot?phaseText[p.phase]:'准备你的音乐收藏');
   bar.hidden=!hasProgress;count.hidden=!hasProgress;metrics.hidden=!hasProgress;
   const reading=p.phase==='reading'||busy&&controller.needsPreparation||resuming;
   bar.max=Math.max(1,p.total);if(reading)bar.removeAttribute('value');else bar.value=p.processed;
   text(count,reading?(s.snapshot?`已读取 ${p.total.toLocaleString()} 首，正在核对收藏与目标信息`:'正在读取收藏与目标信息'):p.total?`${p.processed.toLocaleString()} / ${p.total.toLocaleString()} 首 · ${Math.floor(p.processed/p.total*100)}%`:p.phase==='complete'?'没有需要扫描的歌曲':'正在核对收藏与目标信息');
   empty.hidden=busy||s.snapshot?.ids.length!==0;text(message,s.message);
   const current=coverage(s.snapshot?.songs??[]);
   for(const [key,label] of [['artists','歌手'],['genres','曲风'],['bpm','BPM'],['language','语种']] as const)text(rates.get(key)!,`${label}覆盖率 ${Math.round(current[key]*100)}%`);
   text(persistence,s.persisted?'扫描检查点已保存，继续时会重新核对账号与收藏。':'进度仅保留在本次页面；未保存的进度不能跨重启恢复。');
   for(const key of ['genres','bpm','language'] as const)suspended.get(key)!.hidden=!s.snapshot?.songs.some(song=>song[key].reason?.includes('维度已暂停'));
   journal.hidden=!s.recoveryJournal;
   const storage=!busy&&!!s.snapshot&&p.phase==='paused'&&controller.storageBlocked&&!controller.needsPreparation;
   text(pause,controller.isPausing?'正在暂停…':'暂停准备');button(pause,busy,controller.isPausing);
   button(retry,storage);button(pageOnly,storage);button(start,!busy&&!storage,!controller.status().readReady);
   text(start,controller.needsPreparation?'重新准备':s.snapshot&&p.phase!=='complete'?'继续准备':'开始整理');
   button(filter,!busy&&!storage&&p.phase==='complete'&&!!s.snapshot?.ids.length);button(saved,!busy&&!!s.recoveryJournal);
   prepareOperationId=controller.uiOperation?.id??0;
  }};
  prepareView.update();
 }
 function render(){
  const s=controller.model.state;previewView=null;prepareView=null;nav.replaceChildren();body.replaceChildren();footer.replaceChildren();
  for(const [i,page,label] of [[1,'prepare','准备收藏'],[2,'filter','筛选歌曲'],[3,'write','写入歌单'],[4,'result','整理结果']] as const){const b=actionButton(doc,`${i}  ${label}`,`nav-${page}`,()=>go(page),!canEnterPage(page,controller));b.setAttribute('aria-current',state.page===page?'step':'false');if(b.disabled)b.title=page==='result'?'完成写入并读回核对后可查看':'请先完成准备，并选择有效歌曲';nav.append(b);}
  body.dataset.page=state.page;renderedContext=state.contextKey;
  if(state.page==='prepare')prepare();
  if(state.page==='filter'){
   const toggle=actionButton(doc,'筛选条件','toggle-filters',()=>{state.filterPanelOpen=!state.filterPanelOpen;changed();});toggle.className='filter-toggle';toggle.setAttribute('aria-expanded',String(state.filterPanelOpen));body.append(toggle);
   const layout=textElement(doc,'div','');layout.className='filter-layout';layout.dataset.filters=String(state.filterPanelOpen);
   const filterContent=renderFilters(doc,controller.model,{artistNames:controller.presetArtistNames,searches,pages:candidatePages,cache:candidateCache,changed:()=>{state.pages={matched:0,unknown:0,unmatched:0};state.detailSongId=null;changed();}});const sidebar=textElement(doc,'section','');sidebar.className='filter-sidebar';const close=actionButton(doc,'完成筛选 ×','close-filters',()=>{state.filterPanelOpen=false;changed();});close.className='filter-close';sidebar.append(close,renderPresets(doc,controller),filterContent);
   previewView=renderPreview(doc,controller.model,{state,changed});layout.append(sidebar,previewView.element);body.append(layout);
   const summary=textElement(doc,'div','');summary.className='selection-summary';summary.dataset.action='selection-summary';footer.append(summary);if(s.recoveryJournal)footer.append(actionButton(doc,'恢复写入','open-recovery',recovery));const next=actionButton(doc,'下一步：选择歌单','to-write',()=>go('write'),!canEnterPage('write',controller));next.className='primary';footer.append(next);
  }
  if(state.page==='write'){
   const needsRecovery=!!s.writeReport&&s.writeReport.status!=='complete'||!!s.recoveryJournal&&(['pending','uncertain'].includes(s.recoveryJournal.creationState)||s.recoveryJournal.batches.some(b=>b.state!=='confirmed'));
   const targets=textElement(doc,'section','');
   if(!controller.isBusy&&!s.writeReview){targets.append(textElement(doc,'h2','把这次的共鸣，放进歌单。'),textElement(doc,'p','新建一个私密空间，或继续丰富已有的收藏。'));const editing=textElement(doc,'fieldset','');editing.disabled=controller.isBusy;targetMode=s.target?.kind??targetMode;editing.append(renderTarget(doc,controller.model,{changed,mode:targetMode,setMode:mode=>{targetMode=mode;}}));targets.append(editing);}
   if(s.writeReview?.taskId!==reviewTask){reviewPage=0;reviewTask=s.writeReview?.taskId??null;}
   const back=actionButton(doc,'返回筛选','back-filter',()=>go('filter'),!canEnterPage('filter',controller));footer.append(back);const controls=renderWriteControls(doc,controller,{footer,page:reviewPage,setPage:page=>{reviewPage=page;signature='';changed();}});
   if(controller.writeNotice){const notice=textElement(doc,'p',controller.writeNotice);notice.className='recovery-notice';notice.setAttribute('role','alert');body.append(notice);}
   if(needsRecovery)body.append(controls,targets);else body.append(targets,controls);
   if(controller.isBusy)footer.append(actionButton(doc,controller.isPausing?'正在暂停…':'暂停写入','pause-write',()=>controller.pause(),controller.isPausing));
   if(controller.isBusy||s.recoveryReviewed){const notice=textElement(doc,'p',s.message);notice.className='notice';body.append(notice);}
  }
  if(state.page==='result'){
   const r=s.writeReport!;const box=textElement(doc,'section','');box.className='result-page';box.append(textElement(doc,'span','✓'),textElement(doc,'h2','整理完成，已读回核对。'),textElement(doc,'p',`目标歌单 ${s.targets.find(t=>t.id===r.targetId)?.name??(s.recoveryJournal?.plan.target.kind==='new'?s.recoveryJournal.plan.target.name:r.targetId)}`),textElement(doc,'strong',`实际新增 ${r.addedIds.length} 首`),textElement(doc,'p',`已存在 ${r.alreadyPresentIds.length} 首 · 清单总数 ${r.addedIds.length+r.alreadyPresentIds.length} 首`));
   const resultContext=state.contextKey,feedback=textElement(doc,'p','');feedback.className='recovery-notice';feedback.dataset.action='open-target-feedback';feedback.setAttribute('role','status');feedback.hidden=true;body.append(feedback,box);
   const open=actionButton(doc,'打开目标歌单','open-target',()=>{
    const latest=controller.model.state.writeReport;
    if(!canEnterPage('result',controller)||state.contextKey!==resultContext||!latest||latest.taskId!==r.taskId||latest.targetId!==r.targetId||!validPlaylistId(latest.targetId))return;
    let opened=false;try{opened=navigatePlaylist(latest.targetId);}catch{/* Host navigation is optional; never display raw errors. */}
    if(opened){state.collapsed=true;state.moreMenuOpen=false;changed();}
    else {feedback.hidden=false;feedback.textContent='当前客户端暂时无法打开，请在网易云中按目标名称查找该歌单。';feedback.scrollIntoView?.({block:'nearest'});}
   },!validPlaylistId(r.targetId));footer.append(open);
   footer.append(actionButton(doc,'返回筛选','back-filter',()=>go('filter')));const finish=actionButton(doc,'结束整理','finish',()=>{const targets=s.targets;controller.model.clearSelection();s.targets=targets;s.message='本次整理已结束，准备数据与写入日志已保留。';Object.assign(s,{writeReview:null,confirmation:null,writeProgress:null,writeReport:null});state.page='filter';state.collapsed=false;state.resultGroup='matched';state.filterPanelOpen=false;state.moreMenuOpen=false;state.recoveryMode=false;state.detailSongId=null;state.pages={matched:0,unknown:0,unmatched:0};changed();});finish.className='primary';footer.append(finish);
  }
 }
 function updateMetrics(){const metrics=body.querySelector('[data-action="scan-metrics"]');if(!metrics)return;const m=controller.scanMetrics;metrics.textContent=`本次用时 ${duration(m.elapsedMs)}  ·  ${m.ratePerMinute===null?'速度正在估算':`${Math.round(m.ratePerMinute)} 首/分钟`}  ·  ${m.remainingMs===null?'剩余时间暂不可估算':m.remainingMs===0?'准备完成':`预计剩余约 ${duration(m.remainingMs)}`}`;}
 function update(next:WorkspaceState){
  if(disposed)return;state=next;if(cacheAccount!==controller.model.state.uid){cacheManagerOpen=false;cacheAccount=controller.model.state.uid;}const contextChanged=viewContext!==state.contextKey;if(contextChanged){candidateCache.clear();for(const key of Object.keys(candidatePages))delete candidatePages[key];for(const key of Object.keys(searches))delete searches[key];viewContext=state.contextKey;targetMode=null;reviewPage=0;reviewTask=null;}if(state.collapsed)return;const s=controller.model.state;
  const filters=JSON.stringify(s.filters);if(lastFilters&&filters!==lastFilters){state.pages={matched:0,unknown:0,unmatched:0};state.detailSongId=null;}lastFilters=filters;
  const filterKey=JSON.stringify([state.contextKey,controller.model.libraryVersion,filters,state.resultGroup,state.pages,state.filterPanelOpen,controller.savedToolsVersion,controller.isBusy,controller.managementNotice]);
  const key=JSON.stringify([state.page,state.contextKey,state.resultGroup,state.pages,state.detailSongId,state.filterPanelOpen,s.selectionVersion,s.progress,s.message,s.writeReview,s.writeProgress,s.writeReport,s.recoveryCandidates,controller.writeNotice,controller.isBusy,controller.savedToolsVersion,cacheManagerOpen,controller.managementNotice]);
  const filterStable=state.page==='filter'&&body.dataset.page==='filter'&&filterIdentity===filterKey&&previewView;
  const prepareStable=state.page==='prepare'&&body.dataset.page==='prepare'&&prepareView&&(renderedContext===state.contextKey||controller.uiOperation?.id===prepareOperationId&&controller.uiOperation?.kind==='prepare'&&controller.uiOperation?.status==='running'&&!controller.needsAttention);
  if(key!==signature&&prepareStable){prepareView?.update();signature=key;renderedContext=state.contextKey;for(const page of ['prepare','filter','write','result'] as const){const b=findKey(`nav-${page}`) as HTMLButtonElement|null;if(b){b.disabled=!canEnterPage(page,controller);b.title=b.disabled?(page==='result'?'完成写入并读回核对后可查看':'请先完成准备，并选择有效歌曲'):'';}}}
  else if(key!==signature&&!filterStable){const oldPage=body.dataset.page;const scroll=body.scrollTop;const focused=(root.getRootNode?.() as ShadowRoot)?.activeElement as HTMLInputElement|null;const focusKey=focused?.dataset.key;const caret=focused?.selectionStart;signature=key;render();filterIdentity=filterKey;body.scrollTop=oldPage===state.page?scroll:0;if(oldPage!==state.page)focusHeading();else if(focusKey){const input=findKey(focusKey) as HTMLInputElement|null;if(input){input.focus();if(caret!=null&&['search','text'].includes(input.type))input.setSelectionRange(caret,caret);}else focusHeading();}}
  if(state.page==='filter'){
   previewView?.update(state);const summary=footer.querySelector('[data-action="selection-summary"]');if(summary){summary.replaceChildren(textElement(doc,'strong',`总入选 ${controller.model.preview().ids.length} 首`),textElement(doc,'small',`人工加入 ${s.added.size} · 排除 ${s.removed.size}`));}
   const next=footer.querySelector('[data-key="to-write"]') as HTMLButtonElement|null;if(next)next.disabled=!canEnterPage('write',controller);
   const navWrite=nav.querySelector('[data-key="nav-write"]') as HTMLButtonElement|null;if(navWrite)navWrite.disabled=!canEnterPage('write',controller);
  }
  updateMetrics();
 }
 return {update,dispose(){disposed=true;candidateCache.clear();nav.remove();body.remove();footer.remove();}};
}
