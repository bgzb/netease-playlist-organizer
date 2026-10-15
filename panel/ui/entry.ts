import styles from './styles.css';
import { discoverClient } from '../client/capabilities';
import { createLibraryReader } from '../client/library';
import { createMetadataReader } from '../client/metadata';
import { checkPause, ReadError } from '../client/requests';
import { createScanner } from '../scan/scan';
import { LocalStore, type StorageLike } from '../scan/store';
import { PanelController, coverage, type OrganizerStatus, type PanelDependencies } from './panel';
import { renderFilters } from './filters';
import { renderPreview, textElement } from './preview';
import { createWriter } from '../write/writer';
import { readTargets, renderTarget, renderWriteControls } from './target';
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
  const doc=options.document??document;const scope=options.scope??window;
  const existing=scope.__ncmOrganizerV1;if(existing?.status().installed){existing.show();return existing;}
  const controller=options.controller??createController();
  const host=doc.createElement('div');host.id='ncm-organizer-v1-root';
  const topbar=doc.querySelector('header, [class*="topbar"], [class*="TopBar"]');
  if(topbar){const bottom=topbar.getBoundingClientRect().bottom;if(bottom>0&&bottom<160){host.style.top=`${bottom+8}px`;host.style.setProperty('--entry-top',`${bottom+8}px`);}}
  const shadow=host.attachShadow({mode:'open'});shadow.append(textElement(doc,'style',styles));
  const entry=textElement(doc,'button','歌单整理');entry.className='entry';entry.setAttribute('aria-expanded','true');
  const panel=textElement(doc,'div','');panel.className='panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','歌单整理筛选与写入');
  shadow.append(entry,panel);(doc.body??doc.documentElement).append(host);
  const searches:Record<string,string>={};const pages:Record<string,number>={};let renderTimer:ReturnType<typeof setTimeout>|undefined;let removed=false;
  function render():void{
    if(removed)return;
    const focused=shadow.activeElement as HTMLInputElement|null;const focusKey=focused?.dataset.key;
    const caret=focused&&['text','search'].includes(focused.type)?focused.selectionStart:null;
    const oldScroll=panel.scrollTop;
    panel.replaceChildren();
    const header=textElement(doc,'header','');header.append(textElement(doc,'h1','歌单整理'));
    const close=textElement(doc,'button','收起');close.onclick=()=>{panel.hidden=true;entry.setAttribute('aria-expanded','false');};
    const remove=textElement(doc,'button','移除工具');remove.onclick=()=>instance.remove();header.append(close,remove);panel.append(header,textElement(doc,'p','完整收藏 · 四维筛选 · 单目标预览'));
    const state=controller.model.state;const status=textElement(doc,'section','');status.className='status';status.setAttribute('aria-live','polite');
    const phases:Record<string,string>={reading:'读取完整收藏',scanning:'扫描元数据',pausing:'正在暂停',paused:'已暂停',complete:'扫描完成',error:'读取失败'};
    status.append(textElement(doc,'strong',`${phases[state.progress.phase]} · ${state.progress.processed}/${state.progress.total}`),textElement(doc,'p',state.message));
    const bar=doc.createElement('progress');bar.max=Math.max(1,state.progress.total);bar.value=state.progress.processed;status.append(bar);
    const rates=coverage(state.snapshot?.songs??[]);const ratesBox=textElement(doc,'div','');ratesBox.className='coverage';
    for(const [field,label] of [['artists','歌手'],['genres','曲风'],['bpm','BPM'],['language','语种']] as const){ratesBox.append(textElement(doc,'span',`${label}覆盖率 ${(rates[field]*100).toFixed(1)}%`));}
    status.append(ratesBox,textElement(doc,'p',state.persisted?'当前扫描检查点已保存；恢复仍会重新校验账号和收藏。':'persisted=false · 当前进度未保存，不能保证跨重启恢复。'));
    const suspended=(['genres','bpm','language'] as const).filter(field=>state.snapshot?.songs.some(song=>song[field].status==='error'&&song[field].reason?.includes('维度已暂停')));
    if(suspended.length){const names={genres:'曲风',bpm:'BPM',language:'语种'};const notice=textElement(doc,'p',`来源结构失配，已暂停维度：${suspended.map(f=>names[f]).join('、')}。可强制更新重新检测。`);notice.className='notice';status.append(notice);}panel.append(status);
    const actions=textElement(doc,'div','');actions.className='actions';
    const ready=controller.status().readReady,busy=controller.isBusy;
    const buttons:[string,()=>unknown,boolean][]=[['重新读取完整收藏',()=>controller.readLibrary(),busy||!ready],['开始 / 继续扫描',()=>controller.scan(),busy||!state.snapshot||!ready],['暂停',()=>controller.pause(),!busy],['强制更新 / 重置维度',()=>controller.forceRefresh(),busy||!state.snapshot||!ready],['重试存储并恢复',()=>controller.retryPersistence(),busy||!state.snapshot||state.persisted||!ready],['仅本页继续',()=>{controller.continuePageOnly();void controller.scan();},busy||!state.snapshot||state.persisted||state.progress.phase!=='paused'||!ready],['清理工具扫描缓存',()=>controller.clearCache(),busy||!state.uid]];
    for(const [label,action,disabled] of buttons){const button=textElement(doc,'button',label);button.disabled=disabled;button.onclick=()=>{void action();};actions.append(button);}panel.append(actions);
    const changed=()=>{controller.changed();render();};
    const editing=textElement(doc,'fieldset','');editing.disabled=controller.isWriting;
    editing.append(renderFilters(doc,controller.model,searches,changed),renderTarget(doc,controller.model,changed),renderPreview(doc,controller.model,pages,changed));
    panel.append(editing,renderWriteControls(doc,controller));
    panel.scrollTop=oldScroll;
    if(focusKey){const input=shadow.querySelector(`[data-key="${focusKey}"]`) as HTMLInputElement|null;input?.focus();if(caret!==null&&input&&['text','search'].includes(input.type))input.setSelectionRange(caret,caret);}
  }
  const unsubscribe=controller.subscribe(()=>{if(renderTimer!==undefined)return;renderTimer=setTimeout(()=>{renderTimer=undefined;render();},100);});
  const accountTimer=setInterval(()=>{void controller.checkAccount();},15000);
  const onVisibility=()=>{if(doc.visibilityState==='visible')void controller.checkAccount();};
  const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){panel.hidden=true;entry.setAttribute('aria-expanded','false');}};
  const onUnload=()=>controller.remove();
  doc.defaultView?.addEventListener('beforeunload',onUnload);
  doc.addEventListener('visibilitychange',onVisibility);doc.addEventListener('keydown',onKey);
  const instance:OrganizerInstance={show(){if(removed)return;panel.hidden=false;entry.setAttribute('aria-expanded','true');render();void controller.checkAccount();},remove(){if(removed)return;removed=true;controller.remove();doc.defaultView?.removeEventListener('beforeunload',onUnload);unsubscribe();clearInterval(accountTimer);if(renderTimer!==undefined)clearTimeout(renderTimer);doc.removeEventListener('visibilitychange',onVisibility);doc.removeEventListener('keydown',onKey);entry.onclick=null;host.remove();if(scope.__ncmOrganizerV1===instance)delete scope.__ncmOrganizerV1;},status:()=>controller.status()};
  scope.__ncmOrganizerV1=instance;entry.onclick=()=>instance.show();render();return instance;
}
if(typeof window!=='undefined'&&typeof document!=='undefined')mountOrganizer();
