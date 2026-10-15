import type { WriteJournal, WritePlan } from '../core/model';
import { LocalStore } from '../scan/store';

export const copyJson = <T>(value:T):T => JSON.parse(JSON.stringify(value)) as T;

/** Save with the latest scan, never a checkpoint captured before a network await. */
export function saveJournal(store: LocalStore, journal: WriteJournal, now = Date.now): void {
  journal.updatedAt = now();
  const latest = store.load(journal.plan.uid);
  store.save(journal.plan.uid, {schemaVersion:1, uid:journal.plan.uid,
    scan:latest?.scan ?? null, writeJournal:journal});
}
export function newJournal(plan: WritePlan): WriteJournal {
  return {plan:copyJson(plan), targetId:plan.target.kind==='existing'?plan.target.id:null,
    beforePlaylistIds:[], creationState:'notStarted', batches:[], confirmedIds:[], updatedAt:0,
    operations:[], readbackIds:[]};
}
