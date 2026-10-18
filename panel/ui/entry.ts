import styles from './styles.css';
import { discoverClient } from '../client/capabilities';
import { createLibraryReader } from '../client/library';
import { createMetadataReader } from '../client/metadata';
import { checkPause, ReadError } from '../client/requests';
import { createScanner } from '../scan/scan';
import { LocalStore, type StorageLike } from '../scan/store';
import { PanelController, type OrganizerStatus, type PanelDependencies } from './panel';
import {createWorkspaceState,reconcileWorkspace,canEnterPage,type WorkspaceState} from './workspace-state';
import {createWorkspaceView,actionButton} from './workspace';
import {resolveAmbientTheme,applyAmbientTheme} from './theme';
import {createPlaylistNavigator} from './navigation';
import { textElement } from './preview';
import { createWriter } from '../write/writer';
import { readTargets } from './target';
export type OrganizerInstance={show():void;remove():void;status():OrganizerStatus};
type Scope={__ncmOrganizerV1?:OrganizerInstance};
declare global { interface Window { __ncmOrganizerV1?:OrganizerInstance; } }
function entryLabel(state:WorkspaceState,controller:PanelController):string {
  const s=controller.model.state,op=controller.uiOperation;
  if(controller.isBusy){
    if(controller.isPausing)return '正在暂停';
    if(controller.operationKind==='source')return '正在读取来源';
    if(controller.operationKind==='maintenance')return '正在管理本地数据';
    if(controller.operationKind==='write')return '正在写入核对';
    if(controller.operationKind==='recovery')return '正在恢复核对';
    if(s.progress.phase==='reading'||controller.needsPreparation)return '正在读取核对';
    return s.progress.total?`扫描 ${Math.floor(s.progress.processed/s.progress.total*100)}%`:'正在扫描';
  }
  if(controller.needsAttention||controller.writeNotice)return '需处理';
  if(s.writeReview)return '等待确认';
  if(s.writeReport&&s.writeReport.status!=='complete')return s.writeReport.status==='paused'?'写入已暂停':s.writeReport.status==='uncertain'?'等待核对':'需处理';
  if(op?.status==='failed')return '需处理';
  if(op?.status==='paused')return '已暂停';
  if(state.page==='result'&&canEnterPage('result',controller))return '整理完成';
  if(state.page==='write')return state.recoveryMode?'等待核对':'选择歌单';
  if(s.snapshot&&s.progress.phase==='complete')return s.snapshot.ids.length?'筛选就绪':'收藏为空';
  return '开始整理';
}
function operationNotice(controller:PanelController):string {
  const op=controller.uiOperation,s=controller.model.state;
  if(!op)return '';
  if(op.kind==='maintenance')return controller.managementNotice??'本地数据操作未完成，请重试。';
  if(op.status==='succeeded'){
    if(op.kind==='source')return '来源已载入，可继续扫描或筛选';
    if(op.kind==='write')return canEnterPage('result',controller)?'歌单整理完成，已读回核对':'写入仍需核对，请查看详情';
    if(op.kind==='recovery')return '恢复核对完成，请重新审阅清单';
    return s.snapshot?.ids.length?'收藏准备完成，可以筛选歌曲':'收藏中暂无歌曲';
  }
  if(controller.needsAttention)return '账号已变化或登录失效，请重新准备';
  if(op.status==='paused')return op.kind==='write'?'写入已暂停，请核对后继续':'准备已暂停，可以稍后继续';
  if(op.kind==='write')return s.writeReport?.status==='uncertain'?'写入结果待核对，请查看详情':'写入未完成，请查看原因';
  return op.kind==='recovery'?'恢复核对未完成，请查看原因':'准备未完成，请查看原因';
}
function createController():PanelController{
  const report=discoverClient();
  const storage:StorageLike={get length(){return globalThis.localStorage.length;},key:i=>globalThis.localStorage.key(i),getItem:k=>globalThis.localStorage.getItem(k),setItem:(k,v)=>globalThis.localStorage.setItem(k,v),removeItem:k=>globalThis.localStorage.removeItem(k)};
  const store=new LocalStore(storage);
  if(!report.supported||!report.read||!report.desktopWiki){
    const fail=async():Promise<never>=>{throw new ReadError('structure');};
    const scanner=createScanner({readLibrary:fail,readUid:fail,readMetadata:fail,store});
    const controller=new PanelController({readLibrary:fail,listSources:fail,readUid:fail,readTargets:fail,scanner,store},false);
    controller.model.state.message='当前客户端能力缺失或候选不唯一，已停止读取。支持版本：Mac 3.1.1 / build 3019。';return controller;
  }
  const read=report.read;let operationSignal:AbortSignal|undefined;
  const library=createLibraryReader((path,data,signal)=>{checkPause(signal??operationSignal);return read(path,data,signal??operationSignal);});
  const identity=createLibraryReader(read);
  const metadata=createMetadataReader(read,report.desktopWiki);
  const scanner=createScanner({readLibrary:(id,signal)=>library.readLibrary({kind:'playlist',id},signal),readUid:identity.readUid,readMetadata:metadata.readMetadata,resetMetadataErrors:metadata.resetErrors,store});
  const deps:PanelDependencies={readLibrary:async (source,signal)=>{operationSignal=signal;return library.readLibrary(source,signal);},listSources:signal=>library.listSources(signal),readUid:signal=>createLibraryReader((path,data)=>read(path,data,signal)).readUid(),readTargets:(uid,sourceId,signal)=>readTargets(read,uid,sourceId,signal),scanner,store,...(report.write?{writer:createWriter({read,write:report.write,store})}:{}),setSignal:signal=>{operationSignal=signal;}};
  return new PanelController(deps);
}
export function mountOrganizer(options:{document?:Document;scope?:Scope;controller?:PanelController;openPlaylist?:(id:string)=>boolean}={}):OrganizerInstance{
  const doc=options.document??document,scope=options.scope??window;
  const existing=scope.__ncmOrganizerV1;if(existing?.status().installed){existing.show();return existing;}
  const controller=options.controller??createController();let state=createWorkspaceState();let removed=false;let renderTimer:ReturnType<typeof setTimeout>|undefined;let toastTimer:ReturnType<typeof setTimeout>|undefined;let announced=0;
  const host=doc.createElement('div');host.id='ncm-organizer-v1-root';applyAmbientTheme(host,resolveAmbientTheme(doc));
  // Safe fallback keeps native navigation and playback reachable; only owned rectangles intercept clicks.
  const topbar=doc.querySelector('header, [class*="topbar"], [class*="TopBar"]');
  const bottom=topbar?.getBoundingClientRect().bottom;if(bottom&&bottom>0&&bottom<160)host.style.setProperty('--safe-top',`${bottom+8}px`);
  const shadow=host.attachShadow({mode:'open'});shadow.append(textElement(doc,'style',styles));
  const entry=actionButton(doc,'','entry',()=>{instance.show();panel.focus();});entry.className='entry';entry.setAttribute('aria-expanded','true');
  const entryIcon=textElement(doc,'span','♫');entryIcon.className='entry-icon';entryIcon.setAttribute('aria-hidden','true');
  const entryCopy=textElement(doc,'span','');entryCopy.className='entry-copy';
  const entryTitle=textElement(doc,'strong','歌单整理'),entryStatus=textElement(doc,'span','');entryStatus.className='entry-status';entryCopy.append(entryTitle,entryStatus);entry.append(entryIcon,entryCopy);
  const panel=textElement(doc,'section','');panel.className='panel';panel.dataset.action='workspace';panel.setAttribute('role','region');panel.setAttribute('aria-label','歌单整理工作区');panel.tabIndex=-1;
  // The host's document hotkeys see the shadow host instead of the input and
  // cancel Backspace/Space. Stop bubbling after local controls handle the key;
  // leave browser editing, selection, IME and workspace Escape behavior intact.
  const onEditorKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.isComposing)return;const target=event.target as HTMLElement|null;if(target&&(['INPUT','TEXTAREA','SELECT'].includes(target.tagName.toUpperCase())||target.isContentEditable))event.stopPropagation();};
  panel.onkeydown=onEditorKey;panel.onkeypress=onEditorKey;panel.onkeyup=onEditorKey;
  const header=textElement(doc,'header','');header.className='workspace-header';const brand=textElement(doc,'div','');brand.append(textElement(doc,'small','PLAYLIST ORGANIZER'),textElement(doc,'h1','歌单整理'));
  const controls=textElement(doc,'div','');controls.className='header-actions';
  const menu=textElement(doc,'div','');menu.className='more-menu';menu.hidden=true;
  const more=actionButton(doc,'更多 ···','more',()=>{state.moreMenuOpen=!state.moreMenuOpen;menu.hidden=!state.moreMenuOpen;more.setAttribute('aria-expanded',String(state.moreMenuOpen));});more.setAttribute('aria-expanded','false');
  const collapse=()=>{state.collapsed=true;render();entry.focus();};
  controls.append(more,actionButton(doc,'收起 ↗','collapse',collapse));header.append(brand,controls);panel.append(header);const view=createWorkspaceView(doc,panel,controller,{openPlaylist:options.openPlaylist??createPlaylistNavigator(doc)});
  const confirmMaintenance=(text:string,fn:()=>unknown)=>{if(doc.defaultView?.confirm?.(text))void fn();};
  menu.append(actionButton(doc,'重新读取收藏','reread',()=>controller.prepareCollection()),actionButton(doc,'强制更新元数据','refresh',()=>controller.forceRefresh()),actionButton(doc,'清理扫描缓存','clear-cache',()=>confirmMaintenance('清理本账号扫描缓存？写入日志会保留。',()=>controller.clearCache())),actionButton(doc,'移除工具','remove',()=>confirmMaintenance('移除整理工具？正在发出的请求仍可能完成。',()=>instance.remove())));panel.append(menu);
  const toast=textElement(doc,'div','');toast.className='toast';toast.hidden=true;toast.setAttribute('role','status');shadow.append(entry,panel,toast);(doc.body??doc.documentElement).append(host);
  function render(){if(removed)return;const previousContext=state.contextKey;state=reconcileWorkspace(state,controller);const opNow=controller.uiOperation;const contextChanged=previousContext!==state.contextKey;if(contextChanged||opNow?.status==='running'){toast.hidden=true;if(toastTimer!==undefined){clearTimeout(toastTimer);toastTimer=undefined;}if(contextChanged&&previousContext!==null)announced=Math.max(announced,(opNow?.id??0)-(opNow?.status==='running'?1:0));}panel.hidden=state.collapsed;more.setAttribute('aria-expanded',String(state.moreMenuOpen&&!state.collapsed));menu.hidden=!state.moreMenuOpen||state.collapsed;entry.setAttribute('aria-expanded',String(!state.collapsed));const s=controller.model.state,op=controller.uiOperation;
    const issue=controller.needsAttention||op&&(op.status==='failed'||op.status==='paused')||s.writeReport&&s.writeReport.status!=='complete';
    const label=entryLabel(state,controller);entryStatus.textContent=label;entry.hidden=!state.collapsed;entry.setAttribute('aria-label',`打开歌单整理，${label}`);entry.dataset.status=issue?'attention':controller.isBusy?'busy':'ready';
    for(const b of Array.from(menu.children) as HTMLButtonElement[])b.disabled=controller.isBusy&&b.dataset.action!=='remove';
    if(op&&op.status!=='running'&&op.id>announced){announced=op.id;toast.textContent=operationNotice(controller);toast.hidden=false;if(toastTimer)clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true;},4000);}
    view.update(state);
  }
  let lastBusy=controller.isBusy,lastPausing=controller.isPausing;
  const unsubscribe=controller.subscribe(()=>{const immediate=!controller.isBusy||controller.isBusy!==lastBusy||controller.isPausing!==lastPausing;lastBusy=controller.isBusy;lastPausing=controller.isPausing;if(immediate){if(renderTimer!==undefined){clearTimeout(renderTimer);renderTimer=undefined;}render();return;}if(renderTimer!==undefined)return;renderTimer=setTimeout(()=>{renderTimer=undefined;render();},250);});
  const metricsTimer=setInterval(()=>{if(!state.collapsed&&state.page==='prepare')view.update(state);},1000);
  const accountTimer=setInterval(()=>{void controller.checkAccount();},15000);
  const onVisibility=()=>{if(doc.visibilityState==='visible')void controller.checkAccount();};
  const onKey=(event:KeyboardEvent)=>{if(event.key!=='Escape'||state.collapsed)return;const path=event.composedPath?.()??[];if(!path.includes(host)&&!path.includes(panel))return;if(state.moreMenuOpen){state.moreMenuOpen=false;more.focus();}else if(state.detailSongId){state.detailSongId=null;controller.changed();}else if(state.filterPanelOpen){state.filterPanelOpen=false;controller.changed();}else state.collapsed=true;render();if(state.collapsed)entry.focus();};
  const onUnload=()=>instance.remove();doc.defaultView?.addEventListener('beforeunload',onUnload);doc.addEventListener('visibilitychange',onVisibility);doc.addEventListener('keydown',onKey);
  const instance:OrganizerInstance={show(){if(removed)return;if(state.collapsed)applyAmbientTheme(host,resolveAmbientTheme(doc));state.collapsed=false;render();void controller.checkAccount();},remove(){if(removed)return;removed=true;controller.remove();doc.defaultView?.removeEventListener('beforeunload',onUnload);unsubscribe();clearInterval(accountTimer);clearInterval(metricsTimer);if(renderTimer!==undefined)clearTimeout(renderTimer);if(toastTimer!==undefined)clearTimeout(toastTimer);doc.removeEventListener('visibilitychange',onVisibility);doc.removeEventListener('keydown',onKey);view.dispose();panel.onkeydown=null;panel.onkeypress=null;panel.onkeyup=null;entry.onclick=null;host.remove();if(scope.__ncmOrganizerV1===instance)delete scope.__ncmOrganizerV1;},status:()=>controller.status()};
  scope.__ncmOrganizerV1=instance;render();if(!options.controller)void controller.initialize();return instance;
}
if(typeof window!=='undefined'&&typeof document!=='undefined')mountOrganizer();
