import styles from './styles.css';
import { discoverClient } from '../client/capabilities';
import { createLibraryReader } from '../client/library';
import { createMetadataReader } from '../client/metadata';
import { checkPause, ReadError } from '../client/requests';
import { createScanner } from '../scan/scan';
import { LocalStore, type StorageLike } from '../scan/store';
import { PanelController, type OrganizerStatus, type PanelDependencies } from './panel';
import {createWorkspaceState,reconcileWorkspace} from './workspace-state';
import {createWorkspaceView,actionButton} from './workspace';
import {resolveAmbientTheme,applyAmbientTheme} from './theme';
import { textElement } from './preview';
import { createWriter } from '../write/writer';
import { readTargets } from './target';
export type OrganizerInstance={show():void;remove():void;status():OrganizerStatus};
type Scope={__ncmOrganizerV1?:OrganizerInstance};
declare global { interface Window { __ncmOrganizerV1?:OrganizerInstance; } }
function createController():PanelController{
  const report=discoverClient();
  const storage:StorageLike={get length(){return globalThis.localStorage.length;},key:i=>globalThis.localStorage.key(i),getItem:k=>globalThis.localStorage.getItem(k),setItem:(k,v)=>globalThis.localStorage.setItem(k,v),removeItem:k=>globalThis.localStorage.removeItem(k)};
  const store=new LocalStore(storage);
  if(!report.supported||!report.read||!report.desktopWiki){
    const fail=async():Promise<never>=>{throw new ReadError('structure');};
    const scanner=createScanner({readLibrary:fail,readUid:fail,readMetadata:fail,store});
    const controller=new PanelController({readLibrary:fail,readUid:fail,readTargets:fail,scanner,store},false);
    controller.model.state.message='当前客户端能力缺失或候选不唯一，已停止读取。支持版本：Mac 3.1.1 / build 3019。';return controller;
  }
  const read=report.read;let operationSignal:AbortSignal|undefined;
  const library=createLibraryReader((path,data,signal)=>{checkPause(signal??operationSignal);return read(path,data,signal??operationSignal);});
  const identity=createLibraryReader(read);
  const metadata=createMetadataReader(read,report.desktopWiki);
  const scanner=createScanner({readLibrary:library.readLibrary,readUid:identity.readUid,readMetadata:metadata.readMetadata,resetMetadataErrors:metadata.resetErrors,store});
  const deps:PanelDependencies={readLibrary:async signal=>{operationSignal=signal;return library.readLibrary();},readUid:signal=>createLibraryReader((path,data)=>read(path,data,signal)).readUid(),readTargets:(uid,sourceId,signal)=>readTargets(read,uid,sourceId,signal),scanner,store,...(report.write?{writer:createWriter({read,write:report.write,store})}:{}),setSignal:signal=>{operationSignal=signal;}};
  return new PanelController(deps);
}
export function mountOrganizer(options:{document?:Document;scope?:Scope;controller?:PanelController}={}):OrganizerInstance{
  const doc=options.document??document,scope=options.scope??window;
  const existing=scope.__ncmOrganizerV1;if(existing?.status().installed){existing.show();return existing;}
  const controller=options.controller??createController();let state=createWorkspaceState();let removed=false;let renderTimer:ReturnType<typeof setTimeout>|undefined;let toastTimer:ReturnType<typeof setTimeout>|undefined;let announced=0;
  const host=doc.createElement('div');host.id='ncm-organizer-v1-root';applyAmbientTheme(host,resolveAmbientTheme(doc));
  // Safe fallback keeps native navigation and playback reachable; only owned rectangles intercept clicks.
  const topbar=doc.querySelector('header, [class*="topbar"], [class*="TopBar"]');
  const bottom=topbar?.getBoundingClientRect().bottom;if(bottom&&bottom>0&&bottom<160)host.style.setProperty('--safe-top',`${bottom+8}px`);
  const shadow=host.attachShadow({mode:'open'});shadow.append(textElement(doc,'style',styles));
  const entry=actionButton(doc,'歌单整理','entry',()=>instance.show());entry.className='entry';entry.setAttribute('aria-expanded','true');
  const panel=textElement(doc,'section','');panel.className='panel';panel.dataset.action='workspace';panel.setAttribute('role','region');panel.setAttribute('aria-label','歌单整理工作区');
  const header=textElement(doc,'header','');header.className='workspace-header';const brand=textElement(doc,'div','');brand.append(textElement(doc,'small','PLAYLIST ORGANIZER'),textElement(doc,'h1','歌单整理'));
  const controls=textElement(doc,'div','');controls.className='header-actions';
  const menu=textElement(doc,'div','');menu.className='more-menu';menu.hidden=true;
  const more=actionButton(doc,'更多 ···','more',()=>{state.moreMenuOpen=!state.moreMenuOpen;menu.hidden=!state.moreMenuOpen;more.setAttribute('aria-expanded',String(state.moreMenuOpen));});more.setAttribute('aria-expanded','false');
  const collapse=()=>{state.collapsed=true;render();};
  controls.append(more,actionButton(doc,'收起 ↗','collapse',collapse));header.append(brand,controls);panel.append(header);const view=createWorkspaceView(doc,panel,controller);
  const confirmMaintenance=(text:string,fn:()=>unknown)=>{if(doc.defaultView?.confirm?.(text))void fn();};
  menu.append(actionButton(doc,'重新读取收藏','reread',()=>controller.prepareCollection()),actionButton(doc,'强制更新元数据','refresh',()=>controller.forceRefresh()),actionButton(doc,'清理扫描缓存','clear-cache',()=>confirmMaintenance('清理本账号扫描缓存？写入日志会保留。',()=>controller.clearCache())),actionButton(doc,'移除工具','remove',()=>confirmMaintenance('移除整理工具？正在发出的请求仍可能完成。',()=>instance.remove())));panel.append(menu);
  const toast=textElement(doc,'div','');toast.className='toast';toast.hidden=true;toast.setAttribute('role','status');shadow.append(entry,panel,toast);(doc.body??doc.documentElement).append(host);
  function render(){if(removed)return;const previousContext=state.contextKey;state=reconcileWorkspace(state,controller);const opNow=controller.uiOperation;const contextChanged=previousContext!==state.contextKey;if(contextChanged||opNow?.status==='running'){toast.hidden=true;if(toastTimer!==undefined){clearTimeout(toastTimer);toastTimer=undefined;}if(contextChanged&&previousContext!==null)announced=Math.max(announced,(opNow?.id??0)-(opNow?.status==='running'?1:0));}panel.hidden=state.collapsed;more.setAttribute('aria-expanded',String(state.moreMenuOpen&&!state.collapsed));menu.hidden=!state.moreMenuOpen||state.collapsed;entry.setAttribute('aria-expanded',String(!state.collapsed));const s=controller.model.state,op=controller.uiOperation;
    const issue=controller.needsAttention||op&&(op.status==='failed'||op.status==='paused')||s.writeReport&&s.writeReport.status!=='complete';
    const label=controller.isBusy?controller.operationKind==='write'?'正在写入核对':s.progress.phase==='reading'?'正在读取':s.progress.phase==='pausing'?'正在暂停':`扫描 ${s.progress.total?Math.floor(s.progress.processed/s.progress.total*100):0}%`:issue?'需处理':state.page==='result'||s.progress.phase==='complete'?'已完成':'开始整理';entry.textContent=`歌单整理 · ${label}`;entry.dataset.status=issue?'attention':controller.isBusy?'busy':'ready';
    for(const b of Array.from(menu.children) as HTMLButtonElement[])b.disabled=controller.isBusy&&b.dataset.action!=='remove';
    if(op&&op.status!=='running'&&op.id>announced){announced=op.id;toast.textContent=op.status==='succeeded'?'准备或核对已完成，展开查看':op.status==='paused'?'任务已暂停，展开继续或核对':'需要处理，展开查看原因';toast.hidden=false;if(toastTimer)clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true;},4000);}
    view.update(state);
  }
  let lastBusy=controller.isBusy;
  const unsubscribe=controller.subscribe(()=>{const immediate=!controller.isBusy||controller.isBusy!==lastBusy;lastBusy=controller.isBusy;if(immediate){if(renderTimer!==undefined){clearTimeout(renderTimer);renderTimer=undefined;}render();return;}if(renderTimer!==undefined)return;renderTimer=setTimeout(()=>{renderTimer=undefined;render();},250);});
  const metricsTimer=setInterval(()=>{if(!state.collapsed&&state.page==='prepare')view.update(state);},1000);
  const accountTimer=setInterval(()=>{void controller.checkAccount();},15000);
  const onVisibility=()=>{if(doc.visibilityState==='visible')void controller.checkAccount();};
  const onKey=(event:KeyboardEvent)=>{if(event.key!=='Escape'||state.collapsed)return;const path=event.composedPath?.()??[];if(!path.includes(host)&&!path.includes(panel))return;if(state.moreMenuOpen){state.moreMenuOpen=false;more.focus();}else if(state.detailSongId){state.detailSongId=null;controller.changed();}else if(state.filterPanelOpen){state.filterPanelOpen=false;controller.changed();}else state.collapsed=true;render();};
  const onUnload=()=>instance.remove();doc.defaultView?.addEventListener('beforeunload',onUnload);doc.addEventListener('visibilitychange',onVisibility);doc.addEventListener('keydown',onKey);
  const instance:OrganizerInstance={show(){if(removed)return;applyAmbientTheme(host,resolveAmbientTheme(doc));state.collapsed=false;render();void controller.checkAccount();},remove(){if(removed)return;removed=true;controller.remove();doc.defaultView?.removeEventListener('beforeunload',onUnload);unsubscribe();clearInterval(accountTimer);clearInterval(metricsTimer);if(renderTimer!==undefined)clearTimeout(renderTimer);if(toastTimer!==undefined)clearTimeout(toastTimer);doc.removeEventListener('visibilitychange',onVisibility);doc.removeEventListener('keydown',onKey);view.dispose();entry.onclick=null;host.remove();if(scope.__ncmOrganizerV1===instance)delete scope.__ncmOrganizerV1;},status:()=>controller.status()};
  scope.__ncmOrganizerV1=instance;render();return instance;
}
if(typeof window!=='undefined'&&typeof document!=='undefined')mountOrganizer();
