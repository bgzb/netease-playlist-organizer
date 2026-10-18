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

function record(pid='8',uid='7') {
  const source={id:pid,name:`歌单 ${pid}`,creatorUid:uid};const s={...snapshot(2,uid,pid),source};
  return {schemaVersion:2 as const,uid,source,checkpoint:{snapshot:s,completedIds:[] as string[],cache:{},phase:'paused' as const,updatedAt:100},lastCompletedAt:null};
}
test('independent scans survive same-song source changes and reject mismatched envelopes',()=>{
  const storage=memoryStorage(),store:any=new LocalStore(storage);
  assert.equal(typeof store.saveScan,'function');
  store.saveScan('7','8',record());store.saveScan('7','9',record('9'));
  assert.equal(store.loadScan('7','8').source.id,'8');assert.equal(store.loadScan('7','9').source.id,'9');
  assert.equal(store.loadScan('10','8'),null);assert.equal(store.listScans('7').items.length,2);
  assert.throws(()=>store.saveScan('7','9',record()));
  storage.setItem('ncm-organizer:v2:7:scan:8',JSON.stringify({...record(),uid:'10'}));
  assert.throws(()=>store.loadScan('7','8'));assert.equal(store.listScans('7').invalidCount,1);
});
test('legacy migration verifies favorites and preserves the current journal',()=>{
  const storage=memoryStorage(),store:any=new LocalStore(storage);store.save('7',state());
  assert.equal(typeof store.migrateLegacyScan,'function');
  assert.throws(()=>store.migrateLegacyScan('7','9'));
  assert.equal(store.migrateLegacyScan('7','8'),'migrated');
  assert.equal(store.load('7').scan,null);assert.equal(store.loadScan('7','8').checkpoint.snapshot.ids.length,2);
  assert.equal(store.migrateLegacyScan('7','8'),'none');
});
test('failed migration is retryable and never overwrites a valid newer v2 scan',()=>{
  const storage=memoryStorage(),store:any=new LocalStore(storage);store.save('7',state());
  assert.equal(typeof store.migrateLegacyScan,'function');
  const write=storage.setItem;let calls=0;
  storage.setItem=(key,value)=>{if(++calls===2)throw Error('full');write(key,value);};
  assert.throws(()=>store.migrateLegacyScan('7','8'));assert.ok(store.load('7').scan);
  storage.setItem=write;
  const newer=record();newer.checkpoint.updatedAt=500;store.saveScan('7','8',newer);
  assert.equal(store.migrateLegacyScan('7','8'),'alreadyPresent');assert.equal(store.loadScan('7','8').checkpoint.updatedAt,500);
});
test('tiered scan clearing preserves favorites journals and unrelated accounts',()=>{
  const storage=memoryStorage(),store:any=new LocalStore(storage);
  assert.equal(typeof store.clearScans,'function');
  for(const [uid,pid] of [['7','8'],['7','9'],['10','8']])store.saveScan(uid,pid,record(pid,uid));
  store.save('7',state());storage.setItem('unrelated','keep');
  store.clearScans('7',{kind:'exceptFavorites',favoritesId:'8'});
  assert.ok(store.loadScan('7','8'));assert.equal(store.loadScan('7','9'),null);assert.ok(store.load('7').scan);
  store.clearScans('7',{kind:'all'});
  assert.equal(store.listScans('7').items.length,0);assert.equal(store.load('7').scan,null);
  assert.ok(store.loadScan('10','8'));assert.equal(storage.getItem('unrelated'),'keep');
});
test('corrupt scan does not hide valid journal and corrupt journal bytes survive mutation attempts',()=>{
  const storage=memoryStorage(),store:any=new LocalStore(storage);
  assert.equal(typeof store.saveWriteJournal,'function');
  storage.setItem('ncm-organizer:v1:7',JSON.stringify({schemaVersion:1,uid:'7',scan:{bad:true},writeJournal:null}));
  store.saveWriteJournal('7',null);assert.deepEqual(JSON.parse(storage.getItem('ncm-organizer:v1:7')!).scan,{bad:true});
  const raw=JSON.stringify({schemaVersion:1,uid:'7',scan:state().scan,writeJournal:{bad:true}});storage.setItem('ncm-organizer:v1:7',raw);
  assert.throws(()=>store.saveWriteJournal('7',null));assert.throws(()=>store.migrateLegacyScan('7','8'));assert.throws(()=>store.clearScans('7',{kind:'all'}));
  assert.equal(storage.getItem('ncm-organizer:v1:7'),raw);
});
test('partial deletion reports failure and allows retry without touching other account scans',()=>{
  const storage=memoryStorage(),store=new LocalStore(storage);
  store.saveScan('7','8',record());store.saveScan('7','9',record('9'));store.saveScan('10','8',record('8','10'));
  const remove=storage.removeItem;let calls=0;
  storage.removeItem=key=>{if(++calls===2)throw Error('blocked');remove(key);};
  assert.throws(()=>store.clearScans('7',{kind:'all'}));
  assert.equal(store.listScans('7').items.length,1);assert.ok(store.loadScan('10','8'));
  storage.removeItem=remove;store.clearScans('7',{kind:'all'});assert.equal(store.listScans('7').items.length,0);
});
test('migration readback failure leaves legacy bytes recoverable and log-only updates leave v2 untouched',()=>{
  const storage=memoryStorage(),store=new LocalStore(storage);store.save('7',state());
  const raw=storage.getItem('ncm-organizer:v1:7'),read=storage.getItem;let scans=0;
  storage.getItem=key=>{if(key==='ncm-organizer:v2:7:scan:8'&&++scans===2)throw Error('blocked');return read(key);};
  assert.throws(()=>store.migrateLegacyScan('7','8'));assert.equal(read('ncm-organizer:v1:7'),raw);
  storage.getItem=read;store.migrateLegacyScan('7','8');
  const bytes=read('ncm-organizer:v2:7:scan:8');
  const j:NonNullable<PersistedState['writeJournal']>={plan:{taskId:'latest',uid:'7',sourcePlaylistId:'8',sourceRevision:'["1","2"]',selectionVersion:'x',songIds:['1'],target:{kind:'existing',id:'10'}},targetId:'10',beforePlaylistIds:[],creationState:'confirmed',batches:[],confirmedIds:[],updatedAt:1};
  store.saveWriteJournal('7',j);assert.equal(store.loadWriteJournal('7')!.writeJournal!.plan.taskId,'latest');
  store.clearScans('7',{kind:'exceptFavorites',favoritesId:'8'});
  assert.equal(read('ncm-organizer:v2:7:scan:8'),bytes);assert.equal(store.loadWriteJournal('7')!.writeJournal!.plan.taskId,'latest');
});
test('clear all removes malformed scan keys as well as valid records',()=>{
  const storage=memoryStorage(),store=new LocalStore(storage);
  storage.setItem('ncm-organizer:v2:7:scan:null','broken');
  assert.equal(store.listScans('7').invalidCount,1);
  store.clearScans('7',{kind:'all'});
  assert.equal(store.listScans('7').invalidCount,0);assert.equal(storage.length,0);
});
test('a completed v2 cache cannot restore unfinished progress as complete',()=>{
  const storage=memoryStorage(),store=new LocalStore(storage),value={...record(),checkpoint:{...record().checkpoint,phase:'complete' as const}};
  assert.throws(()=>store.saveScan('7','8',value));
});
