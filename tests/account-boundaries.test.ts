import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryReader } from '../panel/client/library';
import { ReadError } from '../panel/client/requests';
import { createWriter } from '../panel/write/writer';
import { MetadataReadError } from '../panel/client/metadata';
import { createScanner } from '../panel/scan/scan';
import { LocalStore } from '../panel/scan/store';
import { PanelController } from '../panel/ui/panel';
import { memoryStorage, snapshot } from './fixtures/read';
import type { LibrarySnapshot } from '../panel/core/model';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const guest = { code: 200, profile: null, account: null };
const metadata = (s: LibrarySnapshot) => {
  const { genres, bpm, language } = s.songs[0];
  return { genres, bpm, language };
};
async function fixture() {
  let account: unknown = { code: 200, profile: { userId: 7 } };
  let current = snapshot(2);
  let readGate: Promise<LibrarySnapshot> | undefined;
  let metadataGate: Promise<ReturnType<typeof metadata>> | undefined;
  const started = deferred<void>();
  const storage = memoryStorage(), store = new LocalStore(storage);
  let writes = 0;
  const read = async (path: string, data: Record<string, unknown>) => {
    if (path === '/api/w/nuser/account/get') return account;
    if (path === '/api/v6/playlist/detail') return { code: 200, playlist: {
      id: data.id, creator: { userId: current.uid }, specialType: 5,
      trackCount: current.ids.length, trackIds: current.ids.map(id => ({ id })),
    } };
    if (path === '/api/user/playlist') return { code: 200, playlist: [], more: false };
    throw Error('Unexpected synthetic route');
  };
  const reader = createLibraryReader(read);
  const scanner = createScanner({ readLibrary: async () => readGate ?? current,
    readUid: reader.readUid, readMetadata: async () => {
      started.resolve(); return metadataGate ?? metadata(current);
    }, store });
  const writer = createWriter({ read, store, write: async () => { writes++; throw Error('Unauthorized write'); } });
  const controller = new PanelController({listSources:async()=>({uid:'7',favoritesId:'8',created:[],collected:[]}), readLibrary: async () => current, readUid: reader.readUid,
    readTargets: async () => [], scanner, store, writer });
  controller.model.setLibrary(current);
  controller.model.setProgress({ phase: 'complete', processed: 2, total: 2 }, true);
  controller.model.setFilters({ ...controller.model.state.filters, allSongs: true });
  controller.model.manual('1', 'add');
  controller.model.setTarget({ kind: 'new', name: '合成账号隔离测试', privacy: 10 });
  store.save('7', { schemaVersion: 1, uid: '7', scan: {
    snapshot: current, completedIds: [], cache: {}, phase: 'paused', updatedAt: 1,
  }, writeJournal: null });
  await controller.prepareWrite();
  return { controller, scanner, store, storage, reader, writer, started,
    writes: () => writes, setAccount: (value: unknown) => { account = value; },
    setCurrent: (s: LibrarySnapshot) => { current = s; },
    setReadGate: (gate: Promise<LibrarySnapshot> | undefined) => { readGate = gate; },
    setMetadataGate: (gate: Promise<ReturnType<typeof metadata>>) => { metadataGate = gate; } };
}
function assertRevoked(c: PanelController) {
  const s = c.model.state;
  assert.equal(s.uid, null); assert.equal(s.snapshot, null);
  assert.equal(s.target, null); assert.deepEqual(s.targets, []);
  assert.deepEqual(s.filters, { genres: [], languages: [], artistIds: [], bpmMin: null, bpmMax: null, allSongs: false });
  assert.equal(s.added.size, 0); assert.equal(s.removed.size, 0);
  assert.equal(s.writeReview, null); assert.equal(s.confirmation, null);
  assert.equal(s.recoveryJournal, null); assert.deepEqual(s.recoveryCandidates, []);
  assert.equal(s.writeProgress, null); assert.equal(s.writeReport, null);
  assert.equal(c.model.canPrepare(), false);
}

test('explicit guest null/null is login loss in both library and writer account guards', async () => {
  const f = await fixture(); f.setAccount(guest);
  await assert.rejects(f.reader.readUid(), (e: unknown) => e instanceof ReadError && e.kind === 'login');
  const plan = f.controller.model.state.writeReview!;
  await assert.rejects(f.writer.recover(plan, new AbortController().signal),
    (e: unknown) => e instanceof ReadError && e.kind === 'login');
  assert.equal(f.writes(), 0);
});

test('account parser validates both identity shapes and rejects malformed or conflicting IDs', async () => {
  for (const response of [{ code: 200 }, { code: 200, profile: {} },
    { code: 200, profile: { userId: 7 }, account: { id: 9 } },
    { code: 200, profile: { userId: 7 }, account: 'bad' },
    { code: 200, profile: { userId: 0 }, account: { id: 7 } }]) {
    const reader = createLibraryReader(async () => response);
    await assert.rejects(reader.readUid(), (e: unknown) => e instanceof ReadError && e.kind === 'structure');
  }
  for (const response of [{ code: 200, profile: { userId: 7 } }, { code: 200, account: { id: '7' } },
    { code: 200, profile: null, account: { id: 7 } },
    { code: 200, profile: { userId: 7 }, account: { id: '7' } }]) {
    assert.equal(await createLibraryReader(async () => response).readUid(), '7');
  }
});

for (const boundary of ['idle', 'confirm', 'recovery'] as const) {
  test(`guest ${boundary} revokes all exposed approval state and preserves original durable data`, async () => {
    const f = await fixture(), before = f.store.load('7')!;
    f.setAccount(guest);
    if (boundary === 'idle') await f.controller.checkAccount();
    if (boundary === 'confirm') await f.controller.confirmWrite();
    if (boundary === 'recovery') await f.controller.reviewRecovery();
    assertRevoked(f.controller);
    assert.deepEqual(f.store.load('7')!.scan, before.scan);
    assert.deepEqual(f.store.load('7')!.writeJournal!.plan, before.writeJournal!.plan);
    assert.equal(f.store.load('7')!.writeJournal!.creationState, 'notStarted');
    assert.equal(f.writes(), 0);
    f.controller.remove();
  });
}

test('guest after issued metadata clears exposure and cannot overwrite old account checkpoint', async () => {
  const f = await fixture(), gate = deferred<ReturnType<typeof metadata>>();
  f.setMetadataGate(gate.promise);
  const before = f.store.load('7');
  const pending = f.controller.scan(); await f.started.promise;
  f.setAccount(guest); gate.resolve(metadata(snapshot(2))); await pending;
  assertRevoked(f.controller); assert.equal(f.scanner.result, null);
  assert.deepEqual(f.store.load('7'), before); assert.equal(f.writes(), 0);
  f.controller.remove();
});

test('guest to a new account cannot recover the old account journal, and old login may revalidate it', async () => {
  const f = await fixture(); const old = f.store.load('7')!;
  f.setAccount(guest); await f.controller.checkAccount(); assertRevoked(f.controller);
  const next = snapshot(2,'9','10');
  f.setCurrent(next); f.setAccount({ code: 200, profile: { userId: 9 } });
  await f.controller.readLibrary(); await f.controller.reviewRecovery();
  assert.equal(f.controller.model.state.uid, '9');
  assert.equal(f.controller.model.state.recoveryJournal, null);
  assert.equal(f.controller.model.state.writeReview, null);
  assert.equal(f.store.load('9'), null); assert.deepEqual(f.store.load('7'), old);
  f.setCurrent(snapshot(2)); f.setAccount({ code: 200, profile: { userId: 7 } });
  await f.controller.readLibrary(); await f.controller.reviewRecovery();
  assert.equal((f.controller.model.state.recoveryJournal as import('../panel/core/model').WriteJournal | null)?.plan.uid, '7');
  assert.equal(f.controller.model.state.confirmation, null); assert.equal(f.writes(), 0);
  f.controller.remove();
});

test('every publication during delayed new-account scan remains scoped to the new account and source', async () => {
  const f = await fixture(); await f.controller.scan();
  assert.equal(f.scanner.result?.uid, '7');
  const before = f.store.load('7');
  const next = snapshot(2,'9','10');
  f.setCurrent(next); f.setAccount({ code: 200, profile: { userId: 9 } });
  await f.controller.readLibrary();
  f.controller.model.setFilters({ ...f.controller.model.state.filters, allSongs: true });
  f.controller.model.manual('1', 'add');
  const gate = deferred<LibrarySnapshot>(); f.setReadGate(gate.promise);
  const observed: { uid: string | null; snapshotUid: string | null; source: string | null }[] = [];
  f.controller.subscribe(() => { const s = f.controller.model.state;
    observed.push({ uid: s.uid, snapshotUid: s.snapshot?.uid ?? null, source: s.snapshot?.sourcePlaylistId ?? null }); });
  const pending = f.controller.scan();
  const readingResult = f.scanner.result;
  gate.resolve(next); await pending;
  assert.equal(readingResult, null, 'first reading publication cannot expose a prior scanner result');
  assert.ok(observed.length > 3);
  assert.ok(observed.every(s => s.uid === '9' && s.snapshotUid === '9' && s.source === '10'), JSON.stringify(observed));
  assert.equal(f.controller.model.state.filters.allSongs, true);
  assert.equal(f.controller.model.state.added.has('1'), true);
  assert.deepEqual(f.store.load('7'), before); assert.equal(f.store.loadScan('9','10')!.checkpoint.snapshot.uid, '9');
  assert.equal(f.store.loadWriteJournal('9')?.writeJournal??null, null); assert.equal(f.writes(), 0);
  f.controller.remove();
});

for (const boundary of ['identity', 'metadata'] as const) test(`observed ${boundary} guest loss dominates an earlier peer network failure`, async () => {
  const s = snapshot(2), store = new LocalStore(memoryStorage());
  const before = { schemaVersion: 1 as const, uid: '7', scan: {
    snapshot: s, completedIds: [] as string[], cache: {}, phase: 'paused' as const, updatedAt: 1,
  }, writeJournal: null };
  store.save('7', before);
  const first = deferred<ReturnType<typeof metadata>>(), second = deferred<ReturnType<typeof metadata>>();
  const peerStarted = deferred<void>(), firstFailed = deferred<void>();
  let guestObserved = false, guestNow = false;
  const readUid = async () => {
    if (guestNow && boundary === 'identity') { guestObserved = true; throw new ReadError('login'); }
    return '7';
  };
  const scanner = createScanner({ readLibrary: async () => s, readUid, store,
    readMetadata: async id => {
      if (id === '1') { await first.promise; throw new ReadError('network'); }
      peerStarted.resolve();
      const result = await second.promise;
      if (boundary === 'metadata') { guestObserved = true; throw new MetadataReadError(new ReadError('login'), result); }
      return result;
    } });
  const c = new PanelController({listSources:async()=>({uid:'7',favoritesId:'8',created:[],collected:[]}), readLibrary: async () => s, readUid, readTargets: async () => [], scanner, store });
  c.model.setLibrary(s);
  const afterGuest: (string | null)[] = [];
  c.subscribe(() => {
    if (c.model.state.progress.phase === 'pausing') firstFailed.resolve();
    if (guestObserved) afterGuest.push(c.model.state.uid);
  });
  const run = c.scan(); await peerStarted.promise;
  first.resolve(metadata(s)); await firstFailed.promise;
  guestNow = true; second.resolve(metadata(s)); await run;
  assertRevoked(c); assert.equal(scanner.result, null);
  assert.ok(afterGuest.every(uid => uid === null));
  assert.deepEqual(store.load('7'), before);
  // There is no writer dependency or write-capable route in this fixture.
  assert.equal(c.isWriting, false);
  c.remove();
});

test('controller ignores wrong account, source and generation publications even from the current scanner', async () => {
  const f = await fixture(), next = snapshot(2,'9','10');
  f.setCurrent(next); f.setAccount({ code: 200, profile: { userId: 9 } });
  await f.controller.readLibrary();
  const scan = f.scanner.scan.bind(f.scanner);
  f.scanner.scan = (input, signal, onProgress) => scan(input, signal, (progress, publication) => {
    onProgress(progress, { ...publication, result: snapshot(2) });
    onProgress(progress, { ...publication, result: { ...next, sourcePlaylistId: '999' } });
    onProgress(progress, { generation: publication.generation - 1, result: {
      ...next, songs: next.songs.map(song => ({ ...song, name: 'STALE_GENERATION' })),
    } });
    onProgress(progress, publication);
  });
  const observed: string[] = [];
  f.controller.subscribe(() => {
    const s = f.controller.model.state;
    observed.push(`${s.uid}/${s.snapshot?.sourcePlaylistId}/${s.snapshot?.songs[0].name}`);
  });
  await f.controller.scan();
  assert.ok(observed.length > 3);
  assert.ok(observed.every(row => row.startsWith('9/10/') && !row.includes('STALE_GENERATION')), JSON.stringify(observed));
  assert.equal(f.controller.model.state.progress.phase, 'complete');
  assert.equal(f.writes(), 0); assert.equal(f.store.loadWriteJournal('9')?.writeJournal??null, null);
  assert.equal(f.store.load('7')!.writeJournal!.plan.uid, '7');
  f.controller.remove();
});

for (const loss of ['guest', 'accountChanged', 'storage'] as const) {
  test(`final error checkpoint ${loss} preserves identity-loss precedence and durable isolation`, async () => {
    const s = snapshot(1), storage = memoryStorage(), store = new LocalStore(storage);
    store.save('7', { schemaVersion: 1, uid: '7', scan: {
      snapshot: s, completedIds: [], cache: {}, phase: 'paused', updatedAt: 1,
    }, writeJournal: null });
    let checks = 0, lossObserved = false, writes = 0;
    const reader = createLibraryReader(async () => {
      checks++;
      if (checks < 4) return { code: 200, profile: { userId: 7 } };
      if (loss === 'storage') {
        storage.setItem = () => { throw Error('synthetic quota'); };
        return { code: 200, profile: { userId: 7 } };
      }
      lossObserved = true;
      return loss === 'guest' ? guest : { code: 200, profile: { userId: 9 } };
    });
    const scanner = createScanner({ readLibrary: async () => s, readUid: reader.readUid, store,
      readMetadata: async () => { throw new MetadataReadError(new ReadError('network'), metadata(s)); } });
    const writer = createWriter({ store, read: async () => guest,
      write: async () => { writes++; throw Error('Unauthorized synthetic write'); } });
    const c = new PanelController({listSources:async()=>({uid:'7',favoritesId:'8',created:[],collected:[]}), readLibrary: async () => s, readUid: reader.readUid,
      readTargets: async () => [], scanner, store, writer });
    c.model.setLibrary(s);
    c.model.setProgress({ phase: 'complete', processed: 1, total: 1 }, true);
    c.model.setFilters({ ...c.model.state.filters, allSongs: true });
    c.model.manual('1', 'add');
    c.model.setTarget({ kind: 'new', name: '合成最终检查点', privacy: 10 });
    await c.prepareWrite();checks=0;
    const plan = c.model.state.writeReview!;
    assert.ok(plan);
    c.model.state.confirmation = { uid: plan.uid, sourceRevision: plan.sourceRevision,
      sourcePlaylistId:plan.sourcePlaylistId, selectionVersion: plan.selectionVersion, targetKey: JSON.stringify(plan.target), confirmedAt: 1 };
    const durable = store.load('7');
    const exposure = () => {
      const state = c.model.state;
      return structuredClone({ uid: state.uid, snapshot: state.snapshot, target: state.target,
        targets: state.targets, filters: state.filters, added: [...state.added], removed: [...state.removed],
        review: state.writeReview, token: state.confirmation, recovery: state.recoveryJournal,
        candidates: state.recoveryCandidates, writeProgress: state.writeProgress, report: state.writeReport });
    };
    const publications: ReturnType<typeof exposure>[] = [];
    c.subscribe(() => { if (lossObserved) publications.push(exposure()); });
    await c.scan();
    assert.equal(checks, 4, 'login loss must occur specifically in the error-path checkpoint guard');
    assert.equal(writes, 0);
    assert.deepEqual(store.load('7'), durable);
    assert.equal(store.load('9'), null);
    assert.equal(scanner.status.phase, 'paused');
    assert.equal(scanner.status.persisted, false);
    if (loss === 'storage') {
      assert.equal(c.model.state.uid, '7');
      assert.equal(c.model.state.snapshot?.uid, '7');
      assert.notEqual(scanner.result, null);
      assert.match(c.model.state.message, /网络/);
      assert.doesNotMatch(c.model.state.message, /登录失效/);
    } else {
      assertRevoked(c);
      assert.equal(scanner.result, null);
      // Check the boundary and later publications, not only the final state.
      c.changed(); await Promise.resolve(); c.changed();
      assert.ok(publications.length >= 3);
      const revoked = { uid: null, snapshot: null, target: null, targets: [],
        filters: { genres: [], languages: [], artistIds: [], bpmMin: null, bpmMax: null, allSongs: false },
        added: [], removed: [], review: null, token: null, recovery: null, candidates: [], writeProgress: null, report: null };
      for (const publication of publications) assert.deepEqual(publication, revoked);
    }
    c.remove();
  });
}
