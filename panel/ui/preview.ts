import type { SongRecord } from '../core/model';
import type { PanelModel } from './panel';
export function textElement<K extends keyof HTMLElementTagNameMap>(doc:Pick<Document,'createElement'>,tag:K,text:string):HTMLElementTagNameMap[K]{const e=doc.createElement(tag);e.textContent=text;return e;}
export function pageRows(songs:SongRecord[],page:number):SongRecord[]{return songs.slice(Math.max(0,Math.floor(page))*50,Math.max(0,Math.floor(page))*50+50);}
import type {WorkspaceState,ResultGroup} from './workspace-state';
function button(doc:Document,label:string,key:string,fn:()=>void,disabled=false){const b=textElement(doc,'button',label);b.dataset.action=key;b.dataset.key=key;b.disabled=disabled;b.onclick=()=>{if(!b.disabled)fn();};return b;}
export function renderPreview(doc:Document,model:PanelModel,options:{state:WorkspaceState;changed:()=>void}):{element:HTMLElement;update(state:WorkspaceState):void}{
 let state=options.state;const box=textElement(doc,'section','');box.className='results';const {result,error}=model.preview();
 const tabs=textElement(doc,'div','');tabs.className='result-tabs';tabs.setAttribute('role','tablist');
 for(const [key,label] of [['matched','匹配'],['unknown','无法判断'],['unmatched','不匹配']] as const){const b=button(doc,`${label} ${result[key].length}`,`group-${key}`,()=>{state.resultGroup=key;state.detailSongId=null;options.changed();});b.setAttribute('role','tab');b.setAttribute('aria-selected',String(state.resultGroup===key));tabs.append(b);}box.append(tabs);
 const rows=result[state.resultGroup],count=Math.max(1,Math.ceil(rows.length/50));const page=Math.min(state.pages[state.resultGroup],count-1);state.pages[state.resultGroup]=page;
 const intro=textElement(doc,'p',state.resultGroup==='unknown'?'这些歌曲缺少部分维度信息，不会自动入选；你仍可人工加入。':'点击歌曲查看详情，勾选调整本次入选。');intro.className='list-hint';box.append(intro);
 const list=textElement(doc,'div','');list.className='song-list';list.dataset.action='song-list';
 const nodes=new Map<string,{check:HTMLInputElement;marker:HTMLElement}>();
 for(const song of pageRows(rows,page)){
  const row=textElement(doc,'article','');row.className='song';row.dataset.songId=song.id;row.dataset.key=`song-${song.id}`;row.tabIndex=0;row.setAttribute('aria-label',`查看 ${song.name} 详情`);
  const open=()=>{state.detailSongId=song.id;options.changed();};row.onclick=open;row.onkeydown=e=>{if(e.target===row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();open();}};
  const num=textElement(doc,'span',String(song.position+1).padStart(2,'0'));num.className='song-number';const check=doc.createElement('input');check.type='checkbox';check.dataset.key=`select-${song.id}`;check.setAttribute('aria-label',`入选 ${song.name}`);check.onclick=e=>e.stopPropagation();check.onkeydown=e=>e.stopPropagation();check.onchange=()=>{model.manual(song.id,check.checked?'add':'remove');options.changed();};
  const title=textElement(doc,'div','');title.className='song-title';title.append(textElement(doc,'strong',song.name),textElement(doc,'span',(song.artists.value??[]).map(a=>a.name).join(' / ')||'歌手信息缺失'));const marker=textElement(doc,'small','');marker.className='manual-marker';row.append(num,check,title,marker);nodes.set(song.id,{check,marker});list.append(row);
 }
 if(!rows.length){const empty=textElement(doc,'div','');empty.className='empty-state';empty.append(textElement(doc,'h3',error?'先选一个条件，发现新的歌单。':state.resultGroup==='matched'?'暂无匹配歌曲':'当前分组暂无歌曲'),textElement(doc,'p',error??'尝试调整条件，或查看其他结果分组。'),button(doc,'调整条件','adjust-filters',()=>{state.filterPanelOpen=true;options.changed();}));list.append(empty);}box.append(list);
 const pagination=textElement(doc,'div','');pagination.className='pagination';pagination.dataset.action='pagination';pagination.append(textElement(doc,'span',`${rows.length} 首 · ${page+1} / ${count} 页`));
 for(const [label,delta,key] of [['上一页',-1,'page-prev'],['下一页',1,'page-next']] as const)pagination.append(button(doc,label,key,()=>{state.pages[state.resultGroup]=page+delta;state.detailSongId=null;options.changed();},page+delta<0||page+delta>=count));box.append(pagination);
 const drawer=textElement(doc,'aside','');drawer.className='song-detail';drawer.dataset.action='song-detail';drawer.setAttribute('aria-label','歌曲详情');box.append(drawer);let drawn:string|null=null;let selectionVersion='';
 function update(next:WorkspaceState){state=next;const {ids,result}=model.preview(),selected=new Set(ids);for(const [id,n] of nodes){n.check.checked=selected.has(id);n.marker.textContent=model.state.added.has(id)?'人工加入':model.state.removed.has(id)?'人工排除':'';}
  const old=drawn;drawer.hidden=!state.detailSongId;const song=model.state.snapshot?.songs.find(s=>s.id===state.detailSongId);if(!song){drawn=null;if(old){(box.querySelector(`[data-key="song-${old}"]`) as HTMLElement|null)?.focus();}return;}
  if(drawn===song.id&&selectionVersion===model.state.selectionVersion)return;drawn=song.id;selectionVersion=model.state.selectionVersion;drawer.replaceChildren();
  drawer.append(button(doc,'关闭详情 ×','detail-close',()=>{state.detailSongId=null;options.changed();}),textElement(doc,'small','歌曲详情'),textElement(doc,'h2',song.name),textElement(doc,'p',(song.artists.value??[]).map(a=>a.name).join(' / ')||'歌手信息缺失'));
  const sources:Record<string,string>={manual:'已知信息',songDetail:'歌曲资料',desktopWiki:'音乐百科',ugcSong:'歌曲元数据',none:'暂无来源'};
  for(const [key,label] of [['genres','曲风'],['bpm','BPM'],['language','语种']] as const){const f=song[key];const v=f.status==='known'&&f.value!==null?(Array.isArray(f.value)?f.value.join(' / '):String(f.value)):`未知 · ${f.reason??'未提供信息'}`;drawer.append(textElement(doc,'h3',label),textElement(doc,'p',v),textElement(doc,'small',sources[f.source]??'暂无来源'));}
  drawer.append(textElement(doc,'h3','本次入选'),textElement(doc,'p',model.state.added.has(song.id)?'人工加入':model.state.removed.has(song.id)?'人工排除':selected.has(song.id)?'满足筛选条件':'未入选'),textElement(doc,'p',(result.reasons[song.id]??[]).join('；')),textElement(doc,'small',`歌曲 ID ${song.id}`),button(doc,'恢复筛选','manual-reset',()=>{model.manual(song.id,'reset');options.changed();}));
  if(old!==song.id){drawer.tabIndex=-1;drawer.focus();}
 }
 update(state);return {element:box,update};
}
