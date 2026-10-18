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
type CandidateDimension='genres'|'language'|'artists';
type Candidate={id:string;name:string;count:number};
/** Derived UI statistics only; publication version handles in-place Scanner metadata updates. */
export class FilterCandidateCache {
 private model:PanelModel|null=null;private version=-1;private values:Partial<Record<CandidateDimension,Candidate[]>>={};
 clear():void{this.model=null;this.version=-1;this.values={};}
 get(model:PanelModel,dimension:CandidateDimension):readonly Candidate[]{
  if(this.model!==model||this.version!==model.libraryVersion){this.clear();this.model=model;this.version=model.libraryVersion;}
  return this.values[dimension]??(this.values[dimension]=filterCandidates(model.state.snapshot?.songs??[],dimension));
 }
}
export function renderFilters(doc:Document,model:PanelModel,options:{cache:FilterCandidateCache;pages:Record<string,number>;searches:Record<string,string>;changed:()=>void;artistNames?:Record<string,string>}):HTMLElement{
 const {cache,pages,searches,changed}=options;
 const box=textElement(doc,'section','');box.append(textElement(doc,'h2','筛选条件'),textElement(doc,'p','跨维度同时满足 · 同维度任选其一'));
 const all=textElement(doc,'label','');const check=doc.createElement('input');check.type='checkbox';check.dataset.key='all-songs';check.checked=model.state.filters.allSongs;check.onchange=()=>{model.setFilters({...model.state.filters,allSongs:check.checked});changed();};all.append(check,doc.createTextNode('全部收藏'));box.append(all);
 const groups=textElement(doc,'div','');groups.className='filters';
 for(const [dimension,key,label] of [['genres','genres','曲风'],['language','languages','语种'],['artists','artistIds','歌手']] as const){
  const group=textElement(doc,'details','');group.dataset.dimension=dimension;group.open=searches[`open-${key}`]!=='false';group.append(textElement(doc,'summary',`${label} · ${model.state.filters[key].length||'不限'}`));
  const input=doc.createElement('input');input.type='search';input.dataset.key=`search-${key}`;input.placeholder=`搜索${label}候选`;input.setAttribute('aria-label',`搜索${label}`);input.value=searches[key]??'';group.append(input);
  const choices=textElement(doc,'div','');choices.className='choices';
  const nav=textElement(doc,'div','');nav.className='candidate-pages';const count=textElement(doc,'small','');
  const previous=textElement(doc,'button','上一页'),next=textElement(doc,'button','下一页');previous.dataset.key=`candidates-${dimension}-prev`;next.dataset.key=`candidates-${dimension}-next`;previous.setAttribute('aria-label',`${label}候选上一页`);next.setAttribute('aria-label',`${label}候选下一页`);
  nav.append(count,previous,next);
  function draw(){
   choices.replaceChildren();nav.hidden=!group.open;if(!group.open)return;
   const selected=model.state.filters[key],selectedIds=new Set(selected),query=input.value.toLocaleLowerCase();
   const candidates=cache.get(model,dimension).filter(c=>c.name.toLocaleLowerCase().includes(query)||selectedIds.has(c.id));
   const pageCount=Math.max(1,Math.ceil(candidates.length/50)),page=Math.min(Math.max(0,pages[dimension]??0),pageCount-1);pages[dimension]=page;
   for(const c of candidates.slice(page*50,page*50+50)){
    const row=textElement(doc,'label','');const check=doc.createElement('input');check.type='checkbox';check.dataset.key=`choice-${key}-${c.id}`;check.checked=selectedIds.has(c.id);check.disabled=model.state.filters.allSongs;check.onchange=()=>{model.setFilters({...model.state.filters,[key]:check.checked?[...selected,c.id]:selected.filter(id=>id!==c.id)});changed();};row.append(check,doc.createTextNode(`${c.name} (${c.count})`));choices.append(row);
   }
   if(!candidates.length)choices.append(textElement(doc,'small','没有找到候选项'));
   count.textContent=candidates.length?`${page*50+1}–${Math.min((page+1)*50,candidates.length)} / ${candidates.length}`:'0 项';
   previous.disabled=page===0;next.disabled=page>=pageCount-1;nav.hidden=candidates.length<=50;
  }
  previous.onclick=()=>{if(previous.disabled)return;pages[dimension]--;choices.scrollTop=0;draw();};next.onclick=()=>{if(next.disabled)return;pages[dimension]++;choices.scrollTop=0;draw();};
  input.oninput=()=>{searches[key]=input.value;pages[dimension]=0;choices.scrollTop=0;draw();};
  group.ontoggle=()=>{searches[`open-${key}`]=String(group.open);draw();};draw();group.append(choices,nav);groups.append(group);
 }
 const bpm=textElement(doc,'details','');bpm.open=searches['open-bpm']!=='false';bpm.ontoggle=()=>{searches['open-bpm']=String(bpm.open);};bpm.append(textElement(doc,'summary','BPM · 含边界'));
 for(const [key,label] of [['bpmMin','下限'],['bpmMax','上限']] as const){const row=textElement(doc,'label',label);const input=doc.createElement('input');input.type='number';input.min='0.01';input.step='any';input.dataset.key=key;input.setAttribute('aria-label',`BPM ${label}`);input.value=model.state.filters[key]===null?'':String(model.state.filters[key]);input.disabled=model.state.filters.allSongs;input.oninput=()=>{model.setFilters({...model.state.filters,[key]:input.value===''?null:Number(input.value)});changed();};row.append(input);bpm.append(row);}groups.append(bpm);box.append(groups);
 const error=model.preview().error;if(error){const e=textElement(doc,'p',error);e.className='field-error';e.setAttribute('role','alert');bpm.append(e);}
 const chips=textElement(doc,'div','');chips.className='filter-chips';
 const remove=(label:string,fn:()=>void)=>{const b=textElement(doc,'button',`${label} ×`);b.onclick=()=>{fn();changed();};chips.append(b);};
 const artistNames=model.state.filters.artistIds.length?new Map(cache.get(model,'artists').map(c=>[c.id,c.name])):new Map<string,string>();
 for(const key of ['genres','languages','artistIds'] as const)for(const id of model.state.filters[key])remove(key==='artistIds'?artistNames.get(id)??options.artistNames?.[id]??id:id,()=>model.setFilters({...model.state.filters,[key]:model.state.filters[key].filter(v=>v!==id)}));
 for(const key of ['bpmMin','bpmMax'] as const)if(model.state.filters[key]!==null)remove(`${key==='bpmMin'?'≥':'≤'} ${model.state.filters[key]}`,()=>model.setFilters({...model.state.filters,[key]:null}));
 if(chips.children.length||model.state.filters.allSongs){const clear=textElement(doc,'button','清空条件');clear.onclick=()=>{model.setFilters({genres:[],languages:[],artistIds:[],bpmMin:null,bpmMax:null,allSongs:false});changed();};chips.append(clear);}box.append(chips);return box;
}
