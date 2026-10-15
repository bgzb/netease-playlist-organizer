import test from 'node:test';import assert from 'node:assert/strict';import {LocalStore} from '../panel/scan/store';import {memoryStorage,snapshot} from './fixtures/read';import type {PersistedState} from '../panel/core/model';
export function state(uid='7'):PersistedState{return {schemaVersion:1,uid,scan:{snapshot:snapshot(2,uid),completedIds:[],cache:{},phase:'paused',updatedAt:100},writeJournal:null};}
test('account store rejects foreign checkpoint and strips unrelated properties',()=>{const storage=memoryStorage();const store=new LocalStore(storage);store.save('7',{...state(),secret:'never'} as any);assert.equal(store.load('8'),null);assert.equal(storage.getItem('ncm-organizer:v1:7')!.includes('never'),false);assert.throws(()=>store.save('8',state()));const bad=state();bad.scan!.snapshot.uid='8';storage.setItem('ncm-organizer:v1:7',JSON.stringify(bad));assert.equal(store.load('7'),null);});
test('quota failure leaves previous saved checkpoint intact',()=>{const storage=memoryStorage();const store=new LocalStore(storage);store.save('7',state());storage.setItem=()=>{throw new DOMException('quota','QuotaExceededError')};assert.throws(()=>store.save('7',state()));assert.equal(store.load('7')!.scan!.snapshot.ids.length,2);});
test('cleanup removes only this tool other accounts',()=>{const storage=memoryStorage();const store=new LocalStore(storage);store.save('7',state());store.save('8',state('8'));storage.setItem('other','keep');store.clearOtherAccounts('7');assert.equal(store.load('8'),null);assert.ok(store.load('7'));assert.equal(storage.getItem('other'),'keep');});

test('normalized account IDs always address the canonical account key',()=>{const storage=memoryStorage();const store=new LocalStore(storage);store.save('007',state());assert.ok(store.load('7'));assert.ok(store.load('007'));assert.equal(storage.getItem('ncm-organizer:v1:007'),null);});
test('malformed caches and foreign write journals cannot be restored',()=>{const storage=memoryStorage();const store=new LocalStore(storage);const wrong=state() as any;wrong.scan.cache={'1':{song:{...wrong.scan.snapshot.songs[0],id:'2'},updatedAt:{genres:1,bpm:1,language:1}}};storage.setItem('ncm-organizer:v1:7',JSON.stringify(wrong));assert.equal(store.load('7'),null);});

test('large completed checkpoint restores every song and rejects foreign or duplicate completed IDs',()=>{
  const storage=memoryStorage();const store=new LocalStore(storage);
  const large:PersistedState={schemaVersion:1,uid:'7',scan:{snapshot:snapshot(1419),completedIds:Array.from({length:1419},(_,i)=>String(i+1)),cache:{},phase:'complete',updatedAt:100},writeJournal:null};
  store.save('7',large);
  assert.equal(store.load('7')!.scan!.completedIds.length,1419);
  for(const completedIds of [['1','1420'],['1','1']]){
    const invalid={...large,scan:{...large.scan!,completedIds}};
    assert.throws(()=>store.save('7',invalid));
    storage.setItem('ncm-organizer:v1:7',JSON.stringify(invalid));
    assert.equal(store.load('7'),null);
  }
});

test('journal-only read validates account and latest journal without restoring scan data',()=>{
  const storage=memoryStorage();const store=new LocalStore(storage);
  const journal:any={plan:{taskId:'latest',uid:'7',sourcePlaylistId:'8',sourceRevision:'[]',selectionVersion:'x',songIds:[],target:{kind:'existing',id:'10'}},targetId:'10',beforePlaylistIds:[],creationState:'confirmed',batches:[],confirmedIds:[],updatedAt:1};
  store.save('7',{...state(),writeJournal:journal});
  assert.equal(store.loadWriteJournal('007')!.writeJournal!.plan.taskId,'latest');
  const returned=store.loadWriteJournal('7')!.writeJournal!;returned.plan.taskId='changed';
  assert.equal(store.loadWriteJournal('7')!.writeJournal!.plan.taskId,'latest');
  store.save('7',state());
  assert.equal(store.loadWriteJournal('7')!.writeJournal,null);
  for(const value of [null, {schemaVersion:2,uid:'7',writeJournal:journal},
    {schemaVersion:1,uid:'8',writeJournal:journal},
    {schemaVersion:1,uid:'7',writeJournal:{...journal,plan:{...journal.plan,uid:'8'}}}]){
    storage.setItem('ncm-organizer:v1:7',JSON.stringify(value));
    assert.equal(store.loadWriteJournal('7'),null);
  }
  // A damaged scan is never restored through this narrowly scoped accessor.
  storage.setItem('ncm-organizer:v1:7',JSON.stringify({schemaVersion:1,uid:'7',scan:{bad:true},writeJournal:journal,secret:'discard'}));
  assert.equal(store.load('7'),null);
  assert.equal(store.loadWriteJournal('7')!.writeJournal!.plan.taskId,'latest');
});

test('journal fast path notices another store write, deletion, corruption and failed save',()=>{
  const storage=memoryStorage();const first=new LocalStore(storage),second=new LocalStore(storage);
  const journal:any={plan:{taskId:'one',uid:'7',sourcePlaylistId:'8',sourceRevision:'[]',selectionVersion:'x',songIds:[],target:{kind:'existing',id:'10'}},targetId:'10',beforePlaylistIds:[],creationState:'confirmed',batches:[],confirmedIds:[],updatedAt:1};
  first.save('7',{...state(),writeJournal:journal});
  journal.plan.taskId='mutated-input';
  assert.equal(first.loadWriteJournal('7')!.writeJournal!.plan.taskId,'one');
  second.save('7',{...state(),writeJournal:journal});
  assert.equal(first.loadWriteJournal('7')!.writeJournal!.plan.taskId,'mutated-input');
  second.save('7',state());
  assert.equal(first.loadWriteJournal('7')!.writeJournal,null);
  storage.removeItem('ncm-organizer:v1:7');
  assert.equal(first.loadWriteJournal('7'),null);
  storage.setItem('ncm-organizer:v1:7','broken');
  assert.equal(first.loadWriteJournal('7'),null);
  first.save('7',state());
  storage.setItem=()=>{throw new Error('full');};
  assert.throws(()=>first.save('7',{...state(),writeJournal:journal}));
  assert.equal(first.loadWriteJournal('7')!.writeJournal,null);
});
