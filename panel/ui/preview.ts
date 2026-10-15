import type { SongRecord } from '../core/model';
import type { PanelModel } from './panel';
export function textElement<K extends keyof HTMLElementTagNameMap>(doc:Pick<Document,'createElement'>,tag:K,text:string):HTMLElementTagNameMap[K]{const e=doc.createElement(tag);e.textContent=text;return e;}
export function pageRows(songs:SongRecord[],page:number):SongRecord[]{return songs.slice(Math.max(0,Math.floor(page))*50,Math.max(0,Math.floor(page))*50+50);}
export function renderPreview(doc:Document,model:PanelModel,pages:Record<string,number>,changed:()=>void):HTMLElement{
  const box=textElement(doc,'section','');const {result,ids,error}=model.preview();
  box.append(textElement(doc,'h2',`结果预览 · 有效入选 ${ids.length} 首`));
  if(error)box.append(textElement(doc,'p',error));
  const selected=new Set(ids);
  for(const [key,label] of [['matched','匹配'],['unknown','无法判断'],['unmatched','不匹配']] as const){
    const rows=result[key];const group=textElement(doc,'section','');group.className='result-group';
    const count=Math.max(1,Math.ceil(rows.length/50));const page=Math.min(pages[key]??0,count-1);pages[key]=page;
    group.append(textElement(doc,'h3',`${label} · ${rows.length} 首 · ${page+1}/${count} 页`));
    const nav=textElement(doc,'div','');for(const [label,delta] of [['上一页',-1],['下一页',1]] as const){const b=textElement(doc,'button',label);b.disabled=page+delta<0||page+delta>=count;b.onclick=()=>{pages[key]=page+delta;changed();};nav.append(b);}group.append(nav);
    for(const song of pageRows(rows,page)){
      const row=textElement(doc,'article','');row.className='song';
      row.append(textElement(doc,'strong',`${song.position+1}. ${song.name}`),textElement(doc,'span',(song.artists.value??[]).map(a=>a.name).join(' / ')||'歌手信息缺失'));
      const marker=model.state.added.has(song.id)?'人工加入':model.state.removed.has(song.id)?'人工移除':selected.has(song.id)?'筛选入选':'未入选';
      row.append(textElement(doc,'small',`${marker} · ${(result.reasons[song.id]??[]).join('；')} · ID ${song.id}`));
      const actions=textElement(doc,'div','');for(const [label,action] of [['人工加入','add'],['人工移除','remove'],['恢复筛选','reset']] as const){const b=textElement(doc,'button',label);b.onclick=()=>{model.manual(song.id,action);changed();};actions.append(b);}row.append(actions);group.append(row);
    }
    box.append(group);
  }
  box.append(textElement(doc,'p','扫描完成且非零入选后，可审阅写入清单。任何筛选、人工选择或目标修改都会撤销确认。'));
  return box;
}
