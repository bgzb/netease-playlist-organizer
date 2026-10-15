import {coverage,type PanelController} from './panel';
import {canEnterPage,type WorkspaceState,type WorkspacePage} from './workspace-state';
import {textElement,renderPreview} from './preview';
import {renderFilters} from './filters';
import {renderTarget,renderWriteControls} from './target';
export function actionButton(doc:Document,label:string,key:string,action:()=>unknown,disabled=false):HTMLButtonElement{
 const b=textElement(doc,'button',label);b.dataset.action=key;b.dataset.key=key;b.disabled=disabled;b.onclick=()=>{if(!b.disabled)void action();};return b;
}
const phaseText:Record<string,string>={reading:'正在读取收藏',scanning:'正在扫描元数据',pausing:'正在暂停',paused:'已暂停',complete:'准备完成',error:'准备遇到问题'};
export const duration=(ms:number)=>ms<60000?`${Math.floor(ms/1000)} 秒`:`${Math.floor(ms/60000)} 分 ${Math.floor(ms/1000)%60} 秒`;
export function createWorkspaceView(doc:Document,root:HTMLElement,controller:PanelController):{update(state:WorkspaceState):void;dispose():void}{
 let state:WorkspaceState;let signature='';let filterIdentity='';let lastFilters='';let previewView:ReturnType<typeof renderPreview>|null=null;let disposed=false;const searches:Record<string,string>={};
 const nav=textElement(doc,'nav','');nav.className='stages';nav.setAttribute('aria-label','整理阶段');
 const body=textElement(doc,'main','');body.className='workspace-body';
 const footer=textElement(doc,'footer','');footer.className='workspace-footer';
 root.append(nav,body,footer);
 const changed=()=>controller.changed();
 function go(page:WorkspacePage){if(!canEnterPage(page,controller))return;if(page==='filter'){controller.model.state.writeReview=null;controller.model.state.confirmation=null;}state.page=page;state.detailSongId=null;state.filterPanelOpen=false;changed();}
 function prepare(){const s=controller.model.state;const box=textElement(doc,'section','');box.className='prepare-page';
  const hero=textElement(doc,'div','');hero.className='hero';hero.append(textElement(doc,'span','YOUR COLLECTION, RECOMPOSED'),textElement(doc,'h2',s.snapshot?'让喜欢的音乐，各得其所。':'从喜欢，找到新的共鸣。'),textElement(doc,'p','读取收藏并准备筛选数据，用曲风、语种、歌手与节奏，整理属于你的歌单。'));box.append(hero);
  const status=textElement(doc,'section','');status.className='scan-status';status.append(textElement(doc,'h3',controller.isBusy?phaseText[s.progress.phase]??'正在准备':s.snapshot?phaseText[s.progress.phase]:'准备你的音乐收藏'));
  if(s.snapshot||controller.isBusy){const p=s.progress;const bar=doc.createElement('progress');bar.max=Math.max(1,p.total);if(p.phase!=='reading')bar.value=p.processed;status.append(bar,textElement(doc,'p',p.total?`${p.processed.toLocaleString()} / ${p.total.toLocaleString()} 首${p.phase==='reading'?'':` · ${Math.floor(p.processed/p.total*100)}%`}`:'正在核对收藏与目标信息'));const metrics=textElement(doc,'div','');metrics.className='metrics';metrics.dataset.action='scan-metrics';status.append(metrics);}
  if(!controller.isBusy&&s.snapshot?.ids.length===0)status.append(textElement(doc,'p','收藏中暂无歌曲'));
  const message=textElement(doc,'p',s.message);message.className='notice';status.append(message);
  const details=textElement(doc,'details','');details.append(textElement(doc,'summary','查看准备详情'));
  const rates=coverage(s.snapshot?.songs??[]);for(const [k,label] of [['artists','歌手'],['genres','曲风'],['bpm','BPM'],['language','语种']] as const)details.append(textElement(doc,'p',`${label}覆盖率 ${Math.round(rates[k]*100)}%`));
  details.append(textElement(doc,'p',s.persisted?'扫描检查点已保存，继续时会重新核对账号与收藏。':'进度仅保留在本次页面；未保存的进度不能跨重启恢复。'));
  for(const [key,label] of [['genres','曲风'],['bpm','BPM'],['language','语种']] as const)if(s.snapshot?.songs.some(song=>song[key].reason?.includes('维度已暂停')))details.append(textElement(doc,'p',`${label}来源暂不可用，可在更多中强制更新。`));
  if(s.recoveryJournal)details.append(textElement(doc,'p','保留了一份写入日志。请先完成准备，再到写入页显式恢复核对。'));status.append(details);box.append(status);body.append(box);
  if(controller.isBusy)footer.append(actionButton(doc,s.progress.phase==='pausing'?'正在暂停…':'暂停准备','pause',()=>controller.pause(),s.progress.phase==='pausing'));
  else if(s.snapshot&&s.progress.phase==='paused'&&!s.persisted){footer.append(actionButton(doc,'重试保存并继续','retry-storage',()=>controller.retryPersistence()),actionButton(doc,'仅本页继续','page-only',()=>{controller.continuePageOnly();return controller.scan();}));}
  else {const b=actionButton(doc,s.snapshot&&s.progress.phase!=='complete'?'继续准备':'开始整理','prepare',()=>s.snapshot&&s.progress.phase!=='complete'?controller.scan():controller.prepareCollection(),!controller.status().readReady);b.className='primary';footer.append(b);if(s.progress.phase==='complete'&&s.snapshot?.ids.length)footer.append(actionButton(doc,'前往筛选','to-filter',()=>go('filter')));}
 }
 function render(){
  const s=controller.model.state;previewView=null;nav.replaceChildren();body.replaceChildren();footer.replaceChildren();
  for(const [i,page,label] of [[1,'prepare','准备收藏'],[2,'filter','筛选歌曲'],[3,'write','写入歌单'],[4,'result','整理结果']] as const){const b=actionButton(doc,`${i}  ${label}`,`nav-${page}`,()=>go(page),!canEnterPage(page,controller));b.setAttribute('aria-current',state.page===page?'step':'false');if(b.disabled)b.title=page==='result'?'完成写入并读回核对后可查看':'请先完成准备，并选择有效歌曲';nav.append(b);}
  body.dataset.page=state.page;
  if(state.page==='prepare')prepare();
  if(state.page==='filter'){
   const toggle=actionButton(doc,'筛选条件','toggle-filters',()=>{state.filterPanelOpen=!state.filterPanelOpen;changed();});toggle.className='filter-toggle';toggle.setAttribute('aria-expanded',String(state.filterPanelOpen));body.append(toggle);
   const layout=textElement(doc,'div','');layout.className='filter-layout';layout.dataset.filters=String(state.filterPanelOpen);
   const sidebar=renderFilters(doc,controller.model,searches,()=>{state.pages={matched:0,unknown:0,unmatched:0};state.detailSongId=null;changed();});sidebar.className='filter-sidebar';const close=actionButton(doc,'完成筛选 ×','close-filters',()=>{state.filterPanelOpen=false;changed();});close.className='filter-close';sidebar.append(close);
   previewView=renderPreview(doc,controller.model,{state,changed});layout.append(sidebar,previewView.element);body.append(layout);
   const summary=textElement(doc,'div','');summary.className='selection-summary';summary.dataset.action='selection-summary';footer.append(summary);const next=actionButton(doc,'下一步：选择歌单','to-write',()=>go('write'),!canEnterPage('write',controller));next.className='primary';footer.append(next);
  }
  if(state.page==='write'){
   const heading=textElement(doc,'h2','选择一个歌单，安放这次的共鸣。');body.append(heading,textElement(doc,'p',s.message));const editing=textElement(doc,'fieldset','');editing.disabled=controller.isBusy;editing.append(renderTarget(doc,controller.model,changed));body.append(editing,renderWriteControls(doc,controller));footer.append(actionButton(doc,'返回筛选','back-filter',()=>go('filter'),controller.isBusy));if(controller.isBusy)footer.append(actionButton(doc,'暂停写入','pause-write',()=>controller.pause()));
  }
  if(state.page==='result'){
   const r=s.writeReport!;const box=textElement(doc,'section','');box.className='result-page';box.append(textElement(doc,'span','✓'),textElement(doc,'h2','整理完成，已读回核对。'),textElement(doc,'p',`目标歌单 ${s.targets.find(t=>t.id===r.targetId)?.name??(s.recoveryJournal?.plan.target.kind==='new'?s.recoveryJournal.plan.target.name:r.targetId)}`),textElement(doc,'strong',`实际新增 ${r.addedIds.length} 首`),textElement(doc,'p',`已存在 ${r.alreadyPresentIds.length} 首 · 清单总数 ${r.addedIds.length+r.alreadyPresentIds.length} 首`));body.append(box);
   footer.append(actionButton(doc,'返回筛选','back-filter',()=>go('filter')));const finish=actionButton(doc,'结束整理','finish',()=>{controller.model.clearSelection();Object.assign(s,{writeReview:null,confirmation:null,writeProgress:null,writeReport:null});state.page='prepare';state.collapsed=true;state.detailSongId=null;state.pages={matched:0,unknown:0,unmatched:0};changed();});finish.className='primary';footer.append(finish);
  }
 }
 function updateMetrics(){const metrics=body.querySelector('[data-action="scan-metrics"]');if(!metrics)return;const m=controller.scanMetrics;metrics.textContent=`本次用时 ${duration(m.elapsedMs)}  ·  ${m.ratePerMinute===null?'速度正在估算':`${Math.round(m.ratePerMinute)} 首/分钟`}  ·  ${m.remainingMs===null?'剩余时间暂不可估算':m.remainingMs===0?'准备完成':`预计剩余约 ${duration(m.remainingMs)}`}`;}
 function update(next:WorkspaceState){
  if(disposed)return;state=next;if(state.collapsed)return;const s=controller.model.state;
  const filters=JSON.stringify(s.filters);if(lastFilters&&filters!==lastFilters){state.pages={matched:0,unknown:0,unmatched:0};state.detailSongId=null;}lastFilters=filters;
  const filterKey=JSON.stringify([state.contextKey,filters,state.resultGroup,state.pages,state.filterPanelOpen]);
  const key=JSON.stringify([state.page,state.contextKey,state.resultGroup,state.pages,state.detailSongId,state.filterPanelOpen,s.selectionVersion,s.progress,s.message,s.writeReview,s.writeProgress,s.writeReport,s.recoveryCandidates,controller.isBusy]);
  const filterStable=state.page==='filter'&&body.dataset.page==='filter'&&filterIdentity===filterKey&&previewView;
  if(key!==signature&&!filterStable){const oldPage=body.dataset.page;const scroll=body.scrollTop;const focused=(root.getRootNode?.() as ShadowRoot)?.activeElement as HTMLInputElement|null;const focusKey=focused?.dataset.key;const caret=focused?.selectionStart;signature=key;render();filterIdentity=filterKey;body.scrollTop=oldPage===state.page?scroll:0;if(focusKey){const input=root.querySelector(`[data-key="${focusKey}"]`) as HTMLInputElement|null;input?.focus();if(caret!=null&&['search','text'].includes(input?.type??''))input?.setSelectionRange(caret,caret);}else if(oldPage!==state.page){const title=body.querySelector('h2');if(title){title.tabIndex=-1;title.focus();}}}
  if(state.page==='filter'){
   previewView?.update(state);const summary=footer.querySelector('[data-action="selection-summary"]');if(summary){summary.replaceChildren(textElement(doc,'strong',`总入选 ${controller.model.preview().ids.length} 首`),textElement(doc,'small',`人工加入 ${s.added.size} · 排除 ${s.removed.size}`));}
   const next=footer.querySelector('[data-key="to-write"]') as HTMLButtonElement|null;if(next)next.disabled=!canEnterPage('write',controller);
   const navWrite=nav.querySelector('[data-key="nav-write"]') as HTMLButtonElement|null;if(navWrite)navWrite.disabled=!canEnterPage('write',controller);
  }
  updateMetrics();
 }
 return {update,dispose(){disposed=true;nav.remove();body.remove();footer.remove();}};
}
