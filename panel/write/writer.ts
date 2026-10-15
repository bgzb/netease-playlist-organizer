import type { WritePlan, WriteConfirmation, WriteJournal, WriteProgress, WriteReport } from '../core/model';
import type { ReadApi } from '../client/library';
import { accountUid, id } from '../client/library';
import { businessResponse, object, ReadError, checkPause, type WriteApi } from '../client/requests';
import { LocalStore } from '../scan/store';
import { newJournal, saveJournal, copyJson } from './journal';
export type RecoveryCandidate = {id:string; name:string; privacy:10};
export type WriterDependencies = {read:ReadApi; write:WriteApi; store:LocalStore; now?:()=>number};
export type Writer = ReturnType<typeof createWriter>;

function validatePlan(plan:WritePlan):void {
  if (!object(plan) || typeof plan.taskId!=='string' || !plan.taskId || id(plan.uid)!==plan.uid
    || id(plan.sourcePlaylistId)!==plan.sourcePlaylistId || typeof plan.selectionVersion!=='string'
    || !plan.selectionVersion || !Array.isArray(plan.songIds) || plan.songIds.length===0
    || plan.songIds.some(value=>id(value)!==value) || new Set(plan.songIds).size!==plan.songIds.length
    || typeof plan.sourceRevision!=='string' || !object(plan.target)) throw new ReadError('structure');
  let source:unknown;
  try { source=JSON.parse(plan.sourceRevision); } catch { throw new ReadError('structure'); }
  if (!Array.isArray(source) || source.some(value=>id(value)!==value)
    || new Set(source).size!==source.length || plan.songIds.some(value=>!source.includes(value))) throw new ReadError('structure');
  if (plan.target.kind==='existing') {
    if(id(plan.target.id)!==plan.target.id || plan.target.id===plan.sourcePlaylistId) throw new ReadError('permission');
  } else if (plan.target.kind!=='new' || plan.target.privacy!==10 || typeof plan.target.name!=='string'
    || !plan.target.name.trim() || plan.target.name.length>100) throw new ReadError('permission');
}
function confirmed(plan:WritePlan,confirmation:WriteConfirmation|null):boolean {
  return !!confirmation && confirmation.uid===plan.uid && confirmation.sourceRevision===plan.sourceRevision
    && confirmation.selectionVersion===plan.selectionVersion && confirmation.targetKey===JSON.stringify(plan.target)
    && Number.isFinite(confirmation.confirmedAt) && confirmation.confirmedAt>0;
}
export function createWriter(deps:WriterDependencies) {
  let running=false;
  const save=(journal:WriteJournal)=>saveJournal(deps.store,journal,deps.now);
  function load(plan:WritePlan):WriteJournal {
    const previous=deps.store.load(plan.uid)?.writeJournal;
    if(previous?.plan.taskId===plan.taskId) {
      if(JSON.stringify(previous.plan)!==JSON.stringify(plan))throw new ReadError('permission');
      return previous;
    }
    if(previous && (previous.creationState==='pending'||previous.creationState==='uncertain'
      || previous.batches.some(b=>b.state!=='confirmed')))throw new ReadError('permission');
    return newJournal(plan);
  }
  async function network<T>(journal:WriteJournal,kind:string,signal:AbortSignal,operation:()=>Promise<T>):Promise<T> {
    checkPause(signal);
    const entry:{kind:string;state:'pending'|'confirmed'|'error'}={kind,state:'pending'};
    (journal.operations??=[]).push(entry);save(journal);
    let value:T;
    try { value=await operation(); } catch(error) {entry.state='error';save(journal);throw error;}
    // A issued request may succeed after cancellation: always account for its response.
    entry.state='confirmed';save(journal);return value;
  }
  const read=(j:WriteJournal,path:Parameters<ReadApi>[0],data:Record<string,unknown>,signal:AbortSignal)=>
    network(j,path,signal,async()=>businessResponse(await deps.read(path,data,signal)));
  async function guard(j: WriteJournal, signal: AbortSignal): Promise<void> {
    const response = await read(j, '/api/w/nuser/account/get', {}, signal);
    if (accountUid(response) !== j.plan.uid) throw new ReadError('accountChanged');
    checkPause(signal);
  }
  async function playlist(j:WriteJournal,pid:string,signal:AbortSignal,source=false):Promise<{raw:Record<string,unknown>;ids:string[]}> {
    const response=await read(j,'/api/v6/playlist/detail',{id:pid,n:100000,s:0},signal),p=response.playlist;
    if(!object(p)||id(p.id)!==pid||!object(p.creator)||id(p.creator.userId)!==j.plan.uid
      || (source?p.specialType!==5:p.specialType!==0||p.subscribed===true)
      || !Array.isArray(p.trackIds)||!Number.isSafeInteger(p.trackCount))throw new ReadError('permission');
    const ids=p.trackIds.map(value=>{if(!object(value))throw new ReadError('structure');return id(value.id);});
    if(ids.length!==p.trackCount||new Set(ids).size!==ids.length)throw new ReadError('structure');
    return {raw:p,ids};
  }
  async function list(j:WriteJournal,signal:AbortSignal):Promise<Record<string,unknown>[]> {
    const results:Record<string,unknown>[]=[];
    for(let offset=0;;offset+=1000){
      await guard(j,signal);
      const response=await read(j,'/api/user/playlist',{uid:j.plan.uid,limit:1000,offset},signal);
      if(!Array.isArray(response.playlist))throw new ReadError('structure');
      for(const item of response.playlist){if(!object(item)||!object(item.creator))throw new ReadError('structure');id(item.id);id(item.creator.userId);results.push(item);}
      if(response.more!==true)break;
      if(!response.playlist.length||offset>=100000)throw new ReadError('structure');
    }
    return results;
  }
  async function readback(j:WriteJournal,signal:AbortSignal):Promise<string[]> {
    await guard(j,signal);
    const result=await playlist(j,j.targetId!,signal);
    await guard(j,signal);
    j.readbackIds=result.ids;
    j.confirmedIds=j.plan.songIds.filter(value=>result.ids.includes(value));
    for(const batch of j.batches)batch.state=batch.ids.every(value=>result.ids.includes(value))?'confirmed':'uncertain';
    save(j);return result.ids;
  }
  async function candidates(j:WriteJournal,signal:AbortSignal):Promise<RecoveryCandidate[]> {
    if(j.plan.target.kind!=='new')return [];
    const name=j.plan.target.name;
    const playlists=await list(j,signal);
    await guard(j,signal);
    const eligible=playlists.filter(p=>!j.beforePlaylistIds.includes(id(p.id)) && p.name===name
      && id((p.creator as Record<string,unknown>).userId)===j.plan.uid
      && p.specialType===0 && p.subscribed!==true && id(p.id)!==j.plan.sourcePlaylistId);
    const result:RecoveryCandidate[]=[];
    for(const candidate of eligible){
      const candidateId=id(candidate.id);
      let privateTarget=candidate.privacy===10;
      if(candidate.privacy!==0&&candidate.privacy!==10){
        await guard(j,signal);
        try {
          // Unknown list visibility is resolved through the same durable network
          // boundary and ownership/ordinary/source checks as target readback.
          const detail=await playlist(j,candidateId,signal);
          privateTarget=detail.raw.name===name && detail.raw.privacy===10;
        }catch(error){
          // Invalid/forbidden candidates are excluded; account, storage, pause,
          // rate-limit and unknown business failures must still stop recovery.
          if(!(error instanceof ReadError)||!['permission','structure'].includes(error.kind))throw error;
          privateTarget=false;
        }
        await guard(j,signal);
      }
      if(privateTarget)result.push({id:candidateId,name,privacy:10});
    }
    return result;
  }
  async function recover(plan:WritePlan,signal:AbortSignal):Promise<{candidates:RecoveryCandidate[];presentIds:string[];sourceIds:string[];sourceChanged:boolean}> {
    validatePlan(plan);const journal=load(plan);
    await guard(journal,signal);
    const source=await playlist(journal,plan.sourcePlaylistId,signal,true);
    const sourceChanged=JSON.stringify(source.ids)!==plan.sourceRevision;
    await guard(journal,signal);
    if(!journal.targetId && ['pending','uncertain'].includes(journal.creationState)) {
      journal.creationState='uncertain';save(journal);
      return {candidates:await candidates(journal,signal),presentIds:[],sourceIds:source.ids,sourceChanged};
    }
    return {candidates:[],presentIds:journal.targetId?await readback(journal,signal):[],sourceIds:source.ids,sourceChanged};
  }
  async function adoptCandidate(plan:WritePlan,candidateId:string,nextPlan:WritePlan,signal:AbortSignal):Promise<void> {
    validatePlan(nextPlan);
    if(nextPlan.target.kind!=='existing'||nextPlan.target.id!==candidateId||nextPlan.taskId!==plan.taskId
      || nextPlan.uid!==plan.uid||nextPlan.sourcePlaylistId!==plan.sourcePlaylistId)throw new ReadError('permission');
    if(!(await recover(plan,signal)).candidates.some(p=>p.id===candidateId))throw new ReadError('permission');
    // recover persisted additional observations: reload before continuing this transaction.
    const journal=load(plan);
    await guard(journal,signal);
    const source=await playlist(journal,plan.sourcePlaylistId,signal,true);
    if(JSON.stringify(source.ids)!==nextPlan.sourceRevision)throw new ReadError('collectionChanged');
    const p=await playlist(journal,candidateId,signal);
    if(p.raw.privacy!==10||p.raw.name!==(plan.target.kind==='new'?plan.target.name:null))throw new ReadError('permission');
    await guard(journal,signal);
    journal.plan=copyJson(nextPlan);journal.targetId=candidateId;journal.creationState='confirmed';save(journal);
  }
  async function executeWrite(plan:WritePlan,confirmation:WriteConfirmation|null,signal:AbortSignal,onProgress:(p:WriteProgress)=>void):Promise<WriteReport> {
    plan=copyJson(plan);
    if(!confirmed(plan,confirmation))throw new ReadError('permission');
    if(running)throw new ReadError('permission');
    running=true;
    let journal:WriteJournal|undefined;
    const addedIds:string[]=[],alreadyPresentIds:string[]=[];
    const report=(status:WriteReport['status'],errors:string[]=[]):WriteReport=>({taskId:plan.taskId,targetId:journal?.targetId??null,status,
      addedIds,alreadyPresentIds,unconfirmedIds:plan.songIds.filter(value=>!addedIds.includes(value)&&!alreadyPresentIds.includes(value)),errors});
    const progress=(phase:WriteProgress['phase'])=>onProgress({phase,total:plan.songIds.length,added:addedIds.length,alreadyPresent:alreadyPresentIds.length,failed:0,targetId:journal?.targetId??null});
    try {
      validatePlan(plan);
      journal=load(plan);save(journal);
      await guard(journal,signal);
      const source=await playlist(journal,plan.sourcePlaylistId,signal,true);
      if(JSON.stringify(source.ids)!==plan.sourceRevision)throw new ReadError('collectionChanged');
      if(!journal.targetId){
        if(journal.creationState!=='notStarted'){journal.creationState='uncertain';save(journal);progress('paused');return report('uncertain',['creationUncertain']);}
        const before=await list(journal,signal);
        if(before.some(p=>p.name===(plan.target as {name:string}).name))throw new ReadError('permission');
        journal.beforePlaylistIds=before.map(p=>id(p.id));save(journal);
        await guard(journal,signal);checkPause(signal);
        journal.creationState='pending';save(journal);progress('creating');
        try {
          const response=await network(journal,'create',signal,()=>deps.write('/api/playlist/create',{name:(plan.target as {name:string}).name,privacy:10,type:'NORMAL'},signal));
          if(!object(response.playlist))throw new ReadError('structure');
          journal.targetId=id(response.playlist.id);journal.creationState='confirmed';save(journal);
        }catch(error){journal.creationState='uncertain';save(journal);if(error instanceof ReadError&&error.kind==='storage')throw error;progress('paused');
          if(error instanceof ReadError&&['rateLimit','login','permission'].includes(error.kind))return report('paused',[error.kind]);
          return report('uncertain',['creationUncertain']);}
      }
      const target=await playlist(journal,journal.targetId,signal);
      if(journal.targetId===plan.sourcePlaylistId || plan.target.kind==='new'&&(target.raw.privacy!==10||target.raw.name!==plan.target.name))throw new ReadError('permission');
      await guard(journal,signal);
      let present=await readback(journal,signal);
      alreadyPresentIds.push(...plan.songIds.filter(value=>present.includes(value)));
      const missing=plan.songIds.filter(value=>!present.includes(value));
      for(let offset=0;offset<missing.length;offset+=50){
        await guard(journal,signal);checkPause(signal);
        const ids=missing.slice(offset,offset+50),batch:WriteJournal['batches'][number]={ids,state:'pending'};
        journal.batches.push(batch);save(journal);progress('adding');
        let writeError:unknown;
        try {await network(journal,'add',signal,()=>deps.write('/api/playlist/manipulate/tracks',{op:'add',pid:journal!.targetId!,trackIds:JSON.stringify(ids),imme:'true'},signal));}
        catch(error){writeError=error;batch.state='uncertain';save(journal);if(error instanceof ReadError&&error.kind==='storage')throw error;}
        // Never schedule another add after a cancelled/changed identity request.
        batch.state='uncertain';save(journal);
        await guard(journal,signal);progress('verifying');present=await readback(journal,signal);
        addedIds.push(...ids.filter(value=>present.includes(value)));
        if(writeError instanceof ReadError&&writeError.kind==='rateLimit'){progress('paused');return report('paused',['rateLimit']);}
        if(writeError||ids.some(value=>!present.includes(value))){progress('paused');return report('uncertain',['addUncertain']);}
      }
      progress('complete');return report('complete');
    } catch(error) {
      const kind=error instanceof ReadError?error.kind:'network';
      const paused=['paused','accountChanged','collectionChanged','storage','rateLimit','login'].includes(kind);
      progress(paused?'paused':'error');return report(paused?'paused':'error',[kind]);
    } finally {running=false;}
  }
  return {executeWrite,recover,adoptCandidate};
}
