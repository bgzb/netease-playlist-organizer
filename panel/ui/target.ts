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
export function renderTarget(doc:Document,model:PanelModel,changed:()=>void):HTMLElement{
  const box=textElement(doc,'section','');box.append(textElement(doc,'h2','单一目标歌单'));
  const select=doc.createElement('select');select.dataset.key='target';select.setAttribute('aria-label','选择目标歌单');
  for(const [value,label] of [['','请明确选择一个目标'],['new','新建私密歌单'],...model.state.targets.map(t=>[t.id,`${t.name} · ID ${t.id}`])]){const o=textElement(doc,'option',label) as HTMLOptionElement;o.value=value;select.append(o);}
  select.value=model.state.target?.kind==='new'?'new':model.state.target?.kind==='existing'?model.state.target.id:'';
  select.onchange=()=>{model.setTarget(select.value==='new'?{kind:'new',name:'整理·筛选结果',privacy:10}:select.value?{kind:'existing',id:select.value}:null);changed();};box.append(select);
  if(model.state.target?.kind==='new'){const input=doc.createElement('input');input.dataset.key='target-name';input.setAttribute('aria-label','新私密歌单名称');input.value=model.state.target.name;input.maxLength=100;input.oninput=()=>{model.setTarget({kind:'new',name:input.value,privacy:10});changed();};box.append(input,textElement(doc,'p','新目标默认私密；最终确认后才创建。'));}
  box.append(textElement(doc,'p','仅显示本人创建的普通歌单，排除“我喜欢”、订阅和特殊歌单。相同名称以 ID 区分。'));
  return box;
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

export function renderWriteControls(doc:Document,controller:PanelController):HTMLElement {
  const model=controller.model,state=model.state,box=textElement(doc,'section','');
  box.append(textElement(doc,'h2','写入审阅与恢复'),textElement(doc,'p','真实账号小规模写入尚未验证。原收藏和目标原有内容保留。'));
  const review=textElement(doc,'button','审阅写入清单');review.dataset.key='write-review';
  review.disabled=controller.isBusy||!model.canPrepare();review.onclick=()=>controller.prepareWrite();box.append(review);
  if(state.recoveryJournal){
    const j=state.recoveryJournal;
    const creation={notStarted:'尚未创建',pending:'已发出创建请求，等待核对',confirmed:'创建已核对',uncertain:'创建结果待核对'}[j.creationState];
    box.append(textElement(doc,'p',`本账号保存的清单：${j.plan.songIds.length} 首；来源：我喜欢，写前重新核对内容与顺序；${j.plan.target.kind==='existing'?'目标已明确选择':creation}；目标 ${j.targetId?`ID ${j.targetId}`:'尚待核对'}。恢复后需要重新审阅和最终确认。`));
    const recovery=textElement(doc,'button','恢复核对（只读）');recovery.dataset.key='write-recovery';
    recovery.disabled=controller.isBusy;recovery.onclick=()=>controller.reviewRecovery();box.append(recovery);
  }
  if(state.recoveryCandidates.length){
    box.append(textElement(doc,'p','以下是创建前列表之后新增的本人私密同名候选。请明确选用一个，再重新审阅和确认；不会自动选择或重复创建。'));
    for(const candidate of state.recoveryCandidates){const choose=textElement(doc,'button',`选用 ${candidate.name} · 私密 · ID ${candidate.id}`);
      choose.dataset.key=`recovery-${candidate.id}`;choose.disabled=controller.isBusy;choose.onclick=()=>controller.chooseRecoveryCandidate(candidate.id);box.append(choose);}
  }
  const plan=state.writeReview;
  if(plan){
    const target=plan.target.kind==='existing'?state.targets.find(t=>t.id===(plan.target as {id:string}).id):null;
    const visibility=plan.target.kind==='new'?'私密':target?.visibility==='private'?'私密':target?.visibility==='public'?'公开':'可见性未知（写入前读回检查；保持原有可见性）';
    box.append(textElement(doc,'h3',`最终确认 · ${plan.songIds.length} 首`),
      textElement(doc,'p',`账号 ${plan.uid} · 来源：我喜欢，写前重新核对内容与顺序。目标：${plan.target.kind==='new'?plan.target.name:target?.name??'已有目标'} · ${visibility}${plan.target.kind==='existing'?` · ID ${plan.target.id}`:''}`),
      textElement(doc,'p',`筛选规则：${ruleDescription(model)}。不同维度同时满足，同维度任选其一。人工移除 ${state.removed.size} 首：${[...state.removed].map(id=>state.snapshot?.songs.find(song=>song.id===id)?.name??'歌曲信息待核对').join('、')||'无'}。`));
    const list=textElement(doc,'ol','');
    const songs=new Map(state.snapshot?.songs.map(song=>[song.id,song]));
    for(const id of plan.songIds){const song=songs.get(id),row=textElement(doc,'li',`${song?.name??'歌曲'} · ${(song?.artists.value??[]).map(a=>a.name).join(' / ')} · ID ${id} · ${state.added.has(id)?'人工加入':'筛选入选'}`);row.dataset.songId=id;list.append(row);}
    box.append(list);
    const confirm=textElement(doc,'button',plan.target.kind==='new'?'最终确认：新建私密歌单并添加清单歌曲':'最终确认：向已选歌单添加缺少的歌曲');confirm.dataset.key='write-confirm';
    confirm.disabled=controller.isBusy||plan.selectionVersion!==state.selectionVersion;confirm.onclick=()=>controller.confirmWrite();box.append(confirm);
    const cancel=textElement(doc,'button','取消本次确认');cancel.disabled=controller.isBusy;cancel.onclick=()=>{state.writeReview=null;state.confirmation=null;controller.changed();};box.append(cancel);
  }
  if(state.writeProgress){const p=state.writeProgress;const phase={creating:'正在创建私密歌单',adding:'正在添加歌曲',verifying:'正在读回核对',paused:'已暂停',complete:'核对完成',error:'检查失败'}[p.phase];box.append(textElement(doc,'p',`${phase} · 新增 ${p.added} / 已存在 ${p.alreadyPresent} / 总数 ${p.total} · 目标 ${p.targetId??'待创建'}`));}
  if(state.writeReport){const r=state.writeReport;const status={complete:'核对完成',paused:'已暂停',uncertain:'结果待核对',error:'检查失败'}[r.status];box.append(textElement(doc,'p',`${status} · 新增 ${r.addedIds.length} · 已存在 ${r.alreadyPresentIds.length} · 待核对 ${r.unconfirmedIds.length}${r.errors.length?` · ${r.errors.map(writeReasonText).join('、')}`:''}`));
    if(r.unconfirmedIds.length)box.append(textElement(doc,'p',`待核对 ID：${r.unconfirmedIds.join('、')}`));}
  return box;
}
