import type { PanelController } from './panel';
export type WorkspacePage='prepare'|'filter'|'write'|'result';
export type ResultGroup='matched'|'unknown'|'unmatched';
export type WorkspaceState={page:WorkspacePage;collapsed:boolean;resultGroup:ResultGroup;pages:Record<ResultGroup,number>;detailSongId:string|null;filterPanelOpen:boolean;moreMenuOpen:boolean;contextKey:string|null;handledOperationId:number;recoveryMode:boolean};
export const createWorkspaceState=():WorkspaceState=>({page:'prepare',collapsed:false,resultGroup:'matched',pages:{matched:0,unknown:0,unmatched:0},detailSongId:null,filterPanelOpen:false,moreMenuOpen:false,contextKey:null,handledOperationId:0,recoveryMode:false});
export function canEnterPage(page:WorkspacePage,c:PanelController):boolean{
 const s=c.model.state;
 if(page==='prepare')return !c.isWriting&&!(c.isBusy&&c.operationKind==='write');
 if(page==='result')return !!s.writeReport&&s.writeReport.status==='complete'&&s.writeReport.unconfirmedIds.length===0&&s.writeReport.errors.length===0&&!c.isBusy;
 if(page==='write'&&(c.isWriting||c.isBusy&&c.operationKind==='write'))return !!s.snapshot;
 if(c.isBusy&&(c.operationKind==='source'||c.operationKind==='maintenance')&&s.snapshot&&s.progress.phase==='complete')return page==='filter'||page==='write';
 if(c.isBusy||!s.snapshot||s.progress.phase!=='complete')return false;
 if(page==='filter')return true;
 const p=c.model.preview();return p.ids.length>0&&!p.error;
}
export function reconcileWorkspace(state:WorkspaceState,c:PanelController):WorkspaceState{
 const s=c.model.state,op=c.uiOperation;
 const key=s.snapshot?JSON.stringify([s.uid,s.snapshot.sourcePlaylistId,s.snapshot.revision]):s.uid;
 let next={...state,pages:{...state.pages}};
 if(key!==state.contextKey){
   const pendingRecovery=op?.kind==='recovery'&&op.id>state.handledOperationId&&!!s.snapshot&&s.recoveryJournal?.plan.uid===s.uid;
   next={...createWorkspaceState(),collapsed:state.collapsed,contextKey:key,handledOperationId:pendingRecovery||state.contextKey===null&&key!==null&&op?.kind==='prepare'?state.handledOperationId:op?.id??state.handledOperationId};
   // A context acquired by a running prepare may consume its completion later.
   if(op?.status==='running')next.handledOperationId=op.id-1;
 }
 if(op&&op.status!=='running'&&op.id>next.handledOperationId){
   next.handledOperationId=op.id;
   if(op.status==='succeeded'&&(op.kind==='prepare'||op.kind==='scan')&&canEnterPage('filter',c))next.page='filter';
   if(op.status==='succeeded'&&op.kind==='write'&&canEnterPage('result',c))next.page='result';
   if(op.status==='succeeded'&&op.kind==='recovery'&&s.recoveryReviewed&&s.snapshot&&s.recoveryJournal?.plan.uid===s.uid){next.page='write';next.recoveryMode=true;}
 }
 const explicitRecovery=next.page==='write'&&(next.recoveryMode||c.isBusy&&c.operationKind==='recovery')&&s.recoveryJournal?.plan.uid===s.uid&&(!c.isBusy||c.operationKind==='recovery'||c.operationKind==='write');
 if(explicitRecovery)next.recoveryMode=true;
 if(!explicitRecovery&&!canEnterPage(next.page,c))next.page=c.isWriting&&s.snapshot?'write':'prepare';
 return next;
}
