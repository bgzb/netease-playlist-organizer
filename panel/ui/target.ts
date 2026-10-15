import type { ReadApi } from '../client/library';
import { id } from '../client/library';
import { businessResponse, checkPause, object, ReadError } from '../client/requests';
import type { PanelController, PanelModel } from './panel';
import { textElement } from './preview';
export type TargetOption={id:string;name:string;visibility?:'private'|'public'|'unknown'};
export async function readTargets(read:ReadApi,uid:string,sourceId:string,signal?:AbortSignal):Promise<TargetOption[]> {
  const targets=new Map<string,TargetOption>();
  for(let offset=0;;offset+=1000){
    checkPause(signal);const response=businessResponse(await read('/api/user/playlist',{uid,limit:1000,offset},signal));
    if(!Array.isArray(response.playlist))throw new ReadError('structure');
    for(const p of response.playlist){
      if(!object(p)||!object(p.creator))throw new ReadError('structure');
      if(p.specialType!==0||p.subscribed===true||id(p.creator.userId)!==uid||id(p.id)===sourceId)continue;
      if(typeof p.name!=='string')throw new ReadError('structure');
      let privacy=p.privacy;
      if(privacy!==0&&privacy!==10){
        const detail=businessResponse(await read('/api/v6/playlist/detail',{id:id(p.id),n:0,s:0},signal)).playlist;
        if(!object(detail)||id(detail.id)!==id(p.id)||!object(detail.creator)
          ||id(detail.creator.userId)!==uid||detail.specialType!==0||detail.subscribed===true)throw new ReadError('permission');
        privacy=detail.privacy;
      }
      if(privacy!==0&&privacy!==10)throw new ReadError('structure');
      targets.set(id(p.id),{id:id(p.id),name:p.name,visibility:privacy===10?'private':'public'});
    }
    if(response.more!==true)break;if(!response.playlist.length||offset>=100000)throw new ReadError('structure');
  }
  return [...targets.values()];
}
function action(doc:Document,label:string,key:string,fn:()=>unknown,disabled=false){const b=textElement(doc,'button',label);b.dataset.key=key;b.dataset.action=key;b.disabled=disabled;b.onclick=()=>{if(!b.disabled)return fn();};return b;}
export function renderTarget(doc:Document,model:PanelModel,options:{changed:()=>void;mode:'new'|'existing'|null;setMode:(mode:'new'|'existing')=>void}):HTMLElement{
 const box=textElement(doc,'section','');box.className='target-picker';const modes=textElement(doc,'div','');modes.className='target-modes';
 for(const [key,label,description] of [['new','新建私密歌单','为这份共鸣，留一个新位置'],['existing','已有歌单','添加到你的可写歌单']] as const){const b=action(doc,label,`target-${key}`,()=>{options.setMode(key);model.setTarget(key==='new'?{kind:'new',name:'整理·筛选结果',privacy:10}:null);options.changed();});b.setAttribute('aria-pressed',String(options.mode===key));b.append(textElement(doc,'small',description));modes.append(b);}box.append(modes);
 if(options.mode==='new'&&model.state.target?.kind==='new'){const label=textElement(doc,'label','歌单名称');const input=doc.createElement('input');input.dataset.key='target-name';input.type='text';input.setAttribute('aria-label','新私密歌单名称');input.value=model.state.target.name;input.maxLength=100;input.oninput=()=>{model.setTarget({kind:'new',name:input.value,privacy:10});options.changed();};label.append(input);box.append(label,textElement(doc,'p','私密 · 最终确认后才会创建歌单。'));}
 if(options.mode==='existing'){
  const targets=textElement(doc,'div','');targets.className='target-options';targets.setAttribute('aria-label','已有可写歌单');for(const t of model.state.targets){const b=action(doc,t.name,`target-${t.id}`,()=>{model.chooseExisting(t.id);options.changed();});b.setAttribute('aria-pressed',String(model.state.target?.kind==='existing'&&model.state.target.id===t.id));b.append(textElement(doc,'small',`${t.visibility==='private'?'私密':t.visibility==='public'?'公开':'可见性待核对'} · ID ${t.id}`));targets.append(b);}if(!model.state.targets.length)targets.append(textElement(doc,'p','暂无本人可写普通歌单，可以新建私密歌单。'));box.append(targets);
 }return box;
}

export function writeReasonText(reason:string):string {
  const labels:Record<string,string>={creationUncertain:'创建结果待核对',addUncertain:'添加结果待核对',
    rateLimit:'请求受限，请稍后恢复',accountChanged:'账号已变化',collectionChanged:'收藏已变化',
    storage:'日志保存失败',paused:'已手动暂停',login:'登录状态失效',permission:'无权限或目标检查未通过',
    structure:'返回数据检查未通过',network:'网络请求未完成',business:'服务端未确认成功'};
  return labels[reason]??'请求或数据检查未通过';
}

function ruleDescription(model:PanelModel):string {
  const {filters,snapshot}=model.state;
  if(filters.allSongs)return '全部收藏';
  const names=new Map(snapshot?.songs.flatMap(song=>song.artists.value??[]).map(artist=>[artist.id,artist.name]));
  const rules:string[]=[];
  if(filters.genres.length)rules.push(`曲风：${filters.genres.join('或')}`);
  if(filters.languages.length)rules.push(`语种：${filters.languages.join('或')}`);
  if(filters.artistIds.length)rules.push(`歌手：${filters.artistIds.map(id=>names.get(id)??'歌手信息待核对').join('或')}`);
  if(filters.bpmMin!==null||filters.bpmMax!==null)rules.push(`BPM：${filters.bpmMin!==null&&filters.bpmMax!==null?`${filters.bpmMin}–${filters.bpmMax}（含边界）`:filters.bpmMin!==null?`不低于 ${filters.bpmMin}`:`不高于 ${filters.bpmMax}`}`);
  return rules.join('；')||'未设置筛选条件';
}

export function renderWriteControls(doc:Document,controller:PanelController,options:{footer:HTMLElement;page:number;setPage:(page:number)=>void}):HTMLElement {
 const model=controller.model,state=model.state,box=textElement(doc,'section','');box.className='write-controls';const busy=controller.isBusy;
 if(!busy&&!state.writeReview){const review=action(doc,'审阅写入清单','write-review',()=>controller.prepareWrite(),!model.canPrepare());review.className='primary';options.footer.append(review);if(!model.canPrepare())box.append(textElement(doc,'p','明确选择目标歌单后，审阅完整清单。'));}
 if(state.recoveryJournal){const j=state.recoveryJournal;const unresolved=j.creationState==='pending'||j.creationState==='uncertain'||j.batches.some(b=>b.state!=='confirmed');
  const area=textElement(doc,unresolved?'section':'details','');area.className=unresolved?'recovery-notice':'recovery-history';
  if(!unresolved)area.append(textElement(doc,'summary','已保存的写入日志'));
  const creation={notStarted:'尚未创建',pending:'创建请求待核对',confirmed:'目标已核对',uncertain:'创建结果待核对'}[j.creationState];
  area.append(textElement(doc,'h3',unresolved?'有一份写入清单等待核对':'已保留写入日志'),textElement(doc,'p',`${j.plan.songIds.length} 首 · ${j.plan.target.kind==='existing'?'已有目标':creation} · ${j.targetId?`目标 ID ${j.targetId}`:'不会自动重复创建'}`),action(doc,'恢复核对（只读）','write-recovery',()=>controller.reviewRecovery(),busy));box.append(area);
 }
 if(state.recoveryCandidates.length){box.append(textElement(doc,'p','请明确选用一个私密同名候选，再重新审阅。不会自动选择或重复创建。'));for(const candidate of state.recoveryCandidates)box.append(action(doc,`选用 ${candidate.name} · 私密 · ID ${candidate.id}`,`recovery-${candidate.id}`,()=>controller.chooseRecoveryCandidate(candidate.id),busy));}
 const plan=state.writeReview;
 if(plan&&!busy){const target=plan.target.kind==='existing'?state.targets.find(t=>t.id===(plan.target as {id:string}).id):null;
  const visibility=plan.target.kind==='new'?'私密':target?.visibility==='private'?'私密':target?.visibility==='public'?'公开':'可见性待核对';
  const summary=textElement(doc,'section','');summary.className='review-summary';summary.append(textElement(doc,'h2',`最后确认 · ${plan.songIds.length} 首`),textElement(doc,'p',`账号 ${plan.uid} · 来源：我喜欢，写前核对内容与顺序`),textElement(doc,'strong',`${plan.target.kind==='new'?plan.target.name:target?.name??'已有目标'} · ${visibility}${plan.target.kind==='existing'?` · ID ${plan.target.id}`:''}`),textElement(doc,'p',`规则：${ruleDescription(model)} · 人工加入 ${state.added.size} · 人工排除 ${state.removed.size}`));box.append(summary);
  const page=Math.min(options.page,Math.max(0,Math.ceil(plan.songIds.length/50)-1));const list=textElement(doc,'ol','');list.className='review-list';list.start=page*50+1;const songs=new Map(state.snapshot?.songs.map(s=>[s.id,s]));
  for(const id of plan.songIds.slice(page*50,page*50+50)){const song=songs.get(id),row=textElement(doc,'li','');row.dataset.reviewSongId=id;row.dataset.songId=id;row.append(textElement(doc,'strong',song?.name??'歌曲'),textElement(doc,'span',(song?.artists.value??[]).map(a=>a.name).join(' / ')),textElement(doc,'small',state.added.has(id)?'人工加入':'筛选入选'));list.append(row);}box.append(list);
  const pages=Math.max(1,Math.ceil(plan.songIds.length/50)),nav=textElement(doc,'div','');nav.className='pagination';nav.append(textElement(doc,'span',`完整清单 · ${page+1} / ${pages} 页`),action(doc,'上一页','review-prev',()=>options.setPage(page-1),page===0),action(doc,'下一页','review-next',()=>options.setPage(page+1),page>=pages-1));box.append(nav);
  const confirm=action(doc,plan.target.kind==='new'?`确认新建并添加 ${plan.songIds.length} 首`:'确认向已选歌单添加','write-confirm',()=>controller.confirmWrite(),plan.selectionVersion!==state.selectionVersion);confirm.className='primary';options.footer.append(action(doc,'取消本次审阅','cancel-review',()=>{state.writeReview=null;state.confirmation=null;controller.changed();}),confirm);
 }
 if(busy&&!state.writeProgress)box.append(textElement(doc,'h2','正在检查写入条件…'));
 if(state.writeProgress&&(busy||state.writeReport?.status!=='complete')){const p=state.writeProgress;const phase={creating:'正在创建私密歌单',adding:'正在添加歌曲',verifying:'正在读回核对',paused:'已暂停',complete:'读回核对完成',error:'检查失败'}[p.phase];const area=textElement(doc,'div','');area.className='writing-status';area.append(textElement(doc,'h2',phase),textElement(doc,'strong',`${p.added+p.alreadyPresent} / ${p.total}`),textElement(doc,'p',`已新增 ${p.added} 首 · 已存在 ${p.alreadyPresent} 首`),textElement(doc,'p','可以收起继续使用网易云。暂停后，已发出的请求仍可能完成。'));if(p.phase!=='creating'){const bar=doc.createElement('progress');bar.max=Math.max(1,p.total);bar.value=p.added+p.alreadyPresent;area.append(bar);}box.append(area);}
 if(state.writeReport&&state.writeReport.status!=='complete'){const r=state.writeReport;const area=textElement(doc,'div','');area.className='recovery-notice';area.setAttribute('role','status');area.append(textElement(doc,'h3',r.status==='uncertain'?'写入结果待核对':r.status==='paused'?'写入已暂停':'写入检查失败'),textElement(doc,'p',`新增 ${r.addedIds.length} · 已存在 ${r.alreadyPresentIds.length} · 待核对 ${r.unconfirmedIds.length}`),textElement(doc,'p',r.errors.map(writeReasonText).join('、')));box.append(area);}
 return box;
}
