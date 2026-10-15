import assert from 'node:assert/strict';
import type { createScanner } from '../../panel/scan/scan';
import type { LocalStore } from '../../panel/scan/store';
import type { createLibraryReader } from '../../panel/client/library';
import { memoryStorage, libraryProvider } from './read';
import { makeSong } from './synthetic';

type Modules = {createScanner: typeof createScanner; LocalStore: typeof LocalStore; createLibraryReader: typeof createLibraryReader};
// Dependency timings are aggregate operation durations; async stages overlap.
// This isolates scanner/storage overhead, not the real backend or UGC pacing.
export async function runScanBenchmark(modules: Modules, count = 1419, delayMs = 1) {
  const stages = {libraryMs: 0, metadataMs: 0, identityMs: 0, checkpointMs: 0};
  let active = 0, maxConcurrentRequests = 0, metadataReads = 0, checkpointSaves = 0;
  const request = async <T>(operation: () => Promise<T>): Promise<T> => {
    active++;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, active);
    try {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return await operation();
    } finally { active--; }
  };
  const timed = async <T>(stage: keyof typeof stages, operation: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await operation(); } finally { stages[stage] += performance.now() - start; }
  };
  const store = new modules.LocalStore(memoryStorage());
  const load = store.load.bind(store), save = store.save.bind(store);
  store.load = uid => {
    const start = performance.now();
    try { return load(uid); } finally { stages.checkpointMs += performance.now() - start; }
  };
  store.save = (uid, state) => {
    const start = performance.now();
    try { save(uid, state); checkpointSaves++; }
    finally { stages.checkpointMs += performance.now() - start; }
  };
  // Older baseline sources do not have the journal-only accessor.
  if (store.loadWriteJournal) {
    const loadJournal = store.loadWriteJournal.bind(store);
    store.loadWriteJournal = uid => {
      const start = performance.now();
      try { return loadJournal(uid); } finally { stages.checkpointMs += performance.now() - start; }
    };
  }
  const provider = libraryProvider(count);
  const library = modules.createLibraryReader((path, data) => request(() => provider.read(path, data)));
  // Input is caller-owned and prepared outside the timed scan. scan() re-reads it.
  const input = await library.readLibrary();
  maxConcurrentRequests = 0;
  const scanner = modules.createScanner({
    store, now: () => 1_000_000,
    readLibrary: () => timed('libraryMs', () => library.readLibrary()),
    readUid: () => timed('identityMs', () => library.readUid()),
    readMetadata: () => timed('metadataMs', () => request(async () => {
      metadataReads++;
      const song = makeSong('1');
      return {genres: song.genres, bpm: song.bpm, language: song.language};
    })),
  });
  const start = performance.now();
  const output = await scanner.scan(input, new AbortController().signal, () => {});
  const totalMs = performance.now() - start;
  // Validate outside timings, without printing any record or account identifiers.
  assert.equal(scanner.status.phase, 'complete');
  assert.equal(scanner.status.processed, count);
  assert.deepEqual(output.ids, input.ids);
  assert.equal(output.songs.length, count);
  assert.ok(output.songs.every((song, position) => song.position === position && song.genres.status === 'known'
    && song.bpm.status === 'known' && song.language.status === 'known'));
  assert.equal(load(input.uid)?.scan?.completedIds.length, count);
  assert.ok(maxConcurrentRequests <= 2);
  return {totalMs, stages, processed: count, metadataReads, checkpointSaves, maxConcurrentRequests};
}
