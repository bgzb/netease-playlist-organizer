import type { WriteJournal, WritePlan } from '../core/model';
import { LocalStore } from '../scan/store';

export const copyJson = <T>(value:T):T => JSON.parse(JSON.stringify(value)) as T;

/** The account journal never rewrites any playlist's scan checkpoint. */
export function saveJournal(store: LocalStore, journal: WriteJournal, now = Date.now): void {
  journal.updatedAt = now();
  store.saveWriteJournal(journal.plan.uid,journal);
}
export function newJournal(plan: WritePlan): WriteJournal {
  return {plan:copyJson(plan), targetId:plan.target.kind==='existing'?plan.target.id:null,
    beforePlaylistIds:[], creationState:'notStarted', batches:[], confirmedIds:[], updatedAt:0,
    operations:[], readbackIds:[]};
}
