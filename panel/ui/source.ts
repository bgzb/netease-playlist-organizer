import type {PanelController} from './panel';
import type {PlaylistDescriptor} from '../core/model';
import {textElement} from './preview';

const drafts=new WeakMap<PanelController,{value:string;generation:number}>();
const date=(value:number|null)=>value===null?'暂无':new Date(value).toLocaleString('zh-CN',{hour12:false});

export function renderSource(doc:Document,controller:PanelController,options:{manageCache?:()=>void}={}):HTMLElement {
  const state=controller.model.state,box=textElement(doc,'section','');box.className='source';
  box.append(textElement(doc,'h2','来源歌单'));
  const select=doc.createElement('select');select.dataset.key='source-select';select.setAttribute('aria-label','选择扫描来源歌单');
  const favorite=state.sourceCatalog?.favoritesId??(state.selectedSource.kind==='favorites'?state.snapshot?.sourcePlaylistId:undefined);
  const seen=new Set<string>(favorite?[favorite]:[]);
  const option=textElement(doc,'option','我喜欢（默认）');option.value='favorites';select.append(option);
  const history=new Map(state.history.map(item=>[item.source.id,item]));
  const append=(label:string,sources:PlaylistDescriptor[])=>{
    const group=textElement(doc,'optgroup','');group.label=label;
    for(const source of sources){
      if(seen.has(source.id))continue;seen.add(source.id);
      const cached=history.get(source.id),suffix=cached?` · 缓存 ${cached.processed}/${cached.total}`:'';
      const item=textElement(doc,'option',`${source.name} · ID ${source.id}${suffix}`);item.value=source.id;group.append(item);
    }
    if(group.children.length)select.append(group);
  };
  append('我创建的歌单',state.sourceCatalog?.created??[]);
  append('我收藏的歌单',state.sourceCatalog?.collected??[]);
  append('本地扫描历史',state.history.map(item=>item.source));
  if(state.snapshot?.source&&!seen.has(state.snapshot.sourcePlaylistId))append('当前来源',[state.snapshot.source]);
  const current=state.snapshot?.sourcePlaylistId??(state.selectedSource.kind==='playlist'?state.selectedSource.id:favorite);
  select.value=state.selectedSource.kind==='favorites'||current===favorite?'favorites':current??'favorites';
  const sourceDisabled=!controller.status().readReady||controller.isWriting||state.sourceSwitch==='saving'||(controller.isBusy&&!controller.isScanning);
  select.disabled=sourceDisabled;
  select.onchange=()=>controller.selectSource(select.value==='favorites'?{kind:'favorites'}:{kind:'playlist',id:select.value});
  const selectLabel=textElement(doc,'label','扫描来源');selectLabel.append(select);box.append(selectLabel);
  let draft=drafts.get(controller);
  if(!draft||draft.generation!==state.viewGeneration){draft={value:'',generation:state.viewGeneration};drafts.set(controller,draft);}
  const input=doc.createElement('input');input.type='text';input.dataset.key='source-input';input.placeholder='歌单 ID 或完整分享链接';input.setAttribute('aria-label','歌单 ID 或完整分享链接');input.value=draft.value;input.disabled=sourceDisabled;
  input.oninput=()=>{draft!.value=input.value;};
  const submit=textElement(doc,'button','读取指定歌单');submit.dataset.key='source-submit';submit.disabled=sourceDisabled;
  submit.onclick=()=>controller.submitSource(draft!.value);
  input.onkeydown=event=>{if(event.key==='Enter'&&!sourceDisabled){event.preventDefault();void controller.submitSource(draft!.value);}};
  const refresh=textElement(doc,'button','刷新来源列表');refresh.dataset.key='source-refresh';refresh.disabled=controller.isBusy||!controller.status().readReady;refresh.onclick=()=>controller.refreshSources();
  const actions=textElement(doc,'div','');actions.className='source-actions';actions.append(input,submit,refresh);box.append(actions);
  if(state.sourceSwitch==='saving')box.append(textElement(doc,'p','正在暂停并保存当前歌单，保存成功后切换。'));
  if(state.catalogStatus==='error'){const notice=textElement(doc,'p','来源目录或旧缓存迁移未完成，可刷新重试；已登录时仍可输入歌单 ID。');notice.className='notice';box.append(notice);}
  if(state.historyInvalidCount){const notice=textElement(doc,'p',`${state.historyInvalidCount} 份缓存无法读取；其他歌单缓存可继续使用。可清理后重新扫描。`);notice.className='notice';box.append(notice);}
  if(state.snapshot){
    const source=state.snapshot.source;
    box.append(textElement(doc,'strong',`${source?.name??'当前歌单'} · ID ${state.snapshot.sourcePlaylistId}${source?` · 创建者 ID ${source.creatorUid}`:''}`));
    const freshness=textElement(doc,'p',state.cacheView==='cached'?'本地缓存，尚未核对当前歌单。':'来源内容与顺序已核对；写入前仍会重新检查。');
    if(state.cacheView==='cached')freshness.className='notice';box.append(freshness);
    box.append(textElement(doc,'p',`最近保存：${date(state.cacheUpdatedAt)} · 最近完整扫描：${date(state.lastCompletedAt)}`));
  }
  const cleanup=textElement(doc,'div','');cleanup.className='cache-actions';
  for(const [key,label,scope] of [['cache-clear-others','清除非我喜欢歌单缓存','exceptFavorites'],['cache-clear-all','清除全部扫描缓存','all']] as const){
    const button=textElement(doc,'button',label);button.dataset.key=key;button.disabled=controller.isBusy||!state.uid;button.onclick=()=>controller.clearCache(scope);cleanup.append(button);
  }
  if(options.manageCache){const manage=textElement(doc,'button','管理扫描缓存');manage.dataset.key='cache-manager-open';manage.disabled=controller.isBusy||!state.uid;manage.onclick=()=>{if(!manage.disabled)options.manageCache!();};cleanup.append(manage);}
  box.append(cleanup);return box;
}
