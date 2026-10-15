import type { SongRecord } from '../core/model';
import type { PanelModel } from './panel';
import { textElement } from './preview';
export function filterCandidates(songs:SongRecord[],dimension:'genres'|'language'|'artists'):{id:string;name:string;count:number}[]{
  const map=new Map<string,{id:string;name:string;count:number}>();
  for(const song of songs){const field=song[dimension];if(field.status!=='known'||field.value===null)continue;
    const values=dimension==='artists'?song.artists.value!.map(a=>({id:a.id,name:a.name})):dimension==='genres'?song.genres.value!.map(name=>({id:name,name})):[{id:song.language.value!,name:song.language.value!}];
    for(const v of new Map(values.map(v=>[v.id,v])).values()){const old=map.get(v.id);if(old)old.count++;else map.set(v.id,{...v,count:1});}
  }
  return [...map.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id));
}
export function renderFilters(doc:Document,model:PanelModel,searches:Record<string,string>,changed:()=>void):HTMLElement{
  const box=textElement(doc,'section','');box.append(textElement(doc,'h2','四维筛选'),textElement(doc,'p','维度之间同时满足，同一维度多选满足任一项；曲风仅匹配明确的完整标签。'));
  const all=textElement(doc,'label','');const check=doc.createElement('input');check.type='checkbox';check.checked=model.state.filters.allSongs;check.onchange=()=>{model.setFilters({...model.state.filters,allSongs:check.checked});changed();};all.append(check,doc.createTextNode('明确选择全部收藏（忽略四维条件）'));box.append(all);
  const groups=textElement(doc,'div','');groups.className='filters';
  for(const [dimension,key,label] of [['genres','genres','曲风'],['language','languages','语种'],['artists','artistIds','歌手']] as const){
    const group=textElement(doc,'fieldset','');group.append(textElement(doc,'legend',label));
    const input=doc.createElement('input');input.type='search';input.dataset.key=`search-${key}`;input.placeholder=`搜索${label}`;input.setAttribute('aria-label',`搜索${label}`);input.value=searches[key]??'';input.oninput=()=>{searches[key]=input.value;changed();};group.append(input);
    const choices=textElement(doc,'div','');choices.className='choices';
    const selected=model.state.filters[key];
    for(const c of filterCandidates(model.state.snapshot?.songs??[],dimension).filter(c=>c.name.toLocaleLowerCase().includes(input.value.toLocaleLowerCase())||selected.includes(c.id))){
      const row=textElement(doc,'label','');const check=doc.createElement('input');check.type='checkbox';check.checked=selected.includes(c.id);check.disabled=model.state.filters.allSongs;check.onchange=()=>{model.setFilters({...model.state.filters,[key]:check.checked?[...selected,c.id]:selected.filter(id=>id!==c.id)});changed();};row.append(check,doc.createTextNode(`${c.name}（${c.count} 首）`));choices.append(row);
    }group.append(choices);groups.append(group);
  }
  const bpm=textElement(doc,'fieldset','');bpm.append(textElement(doc,'legend','BPM（含边界）'));
  for(const [key,label] of [['bpmMin','下限'],['bpmMax','上限']] as const){const row=textElement(doc,'label',label);const input=doc.createElement('input');input.type='number';input.min='0.01';input.step='any';input.dataset.key=key;input.setAttribute('aria-label',`BPM ${label}`);input.value=model.state.filters[key]===null?'':String(model.state.filters[key]);input.disabled=model.state.filters.allSongs;input.oninput=()=>{model.setFilters({...model.state.filters,[key]:input.value===''?null:Number(input.value)});changed();};row.append(input);bpm.append(row);}groups.append(bpm);box.append(groups);return box;
}
