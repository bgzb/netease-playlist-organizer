import test from 'node:test';
import assert from 'node:assert/strict';
import { runScanBenchmark } from './fixtures/scan-benchmark';
import { createScanner } from '../panel/scan/scan';
import { LocalStore } from '../panel/scan/store';
import { createLibraryReader } from '../panel/client/library';

test('synthetic benchmark verifies full scan and emits aggregate measurements only', async () => {
  const result = await runScanBenchmark({createScanner, LocalStore, createLibraryReader}, 24, 1);
  assert.equal(result.processed, 24);
  assert.equal(result.metadataReads, 24);
  assert.equal(result.checkpointSaves, 3);
  assert.ok(result.maxConcurrentRequests <= 2);
  assert.ok(result.totalMs > 0);
  for (const value of Object.values(result.stages)) assert.ok(value >= 0);
  assert.equal(/合成|songIds|sourcePlaylistId|"uid"|"songs"/.test(JSON.stringify(result)), false);
});
