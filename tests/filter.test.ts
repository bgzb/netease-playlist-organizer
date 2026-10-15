import test from 'node:test';
import assert from 'node:assert/strict';
import type { Filters } from '../panel/core/model';
import { buildSelectionVersion, filterSongs, resolveSelection, validateFilters } from '../panel/core/filter';
import { makeSong } from './fixtures/synthetic';
const filters = (overrides: Partial<Filters> = {}): Filters => ({ genres: [], languages: [], artistIds: [], bpmMin: null, bpmMax: null, allSongs: false, ...overrides });

test('AND_OR_and_inclusive_bpm', () => {
  const songs = [makeSong('1',{genres:['民谣'],language:'国语',bpm:80}),
    makeSong('2',{genres:['民谣'],language:'国语',bpm:79}),
    makeSong('3',{genres:['摇滚'],language:'国语',bpm:120})];
  const result = filterSongs(songs,{genres:['民谣','摇滚'],languages:['国语'],
    artistIds:[],bpmMin:80,bpmMax:120,allSongs:false});
  assert.deepEqual(result.matched.map(s => s.id), ['1','3']);
  assert.deepEqual(result.unmatched.map(s => s.id), ['2']);
});
test('multi-genre and collaborating artists use OR within AND dimensions', () => {
  const songs = [makeSong('1', { genres: ['摇滚', '流行'], artistIds: ['11', '22'] }),
    makeSong('2', { genres: ['民谣'], artistIds: ['33'] }),
    makeSong('3', { genres: ['流行'], artistIds: ['44'], language: '日语' })];
  const result = filterSongs(songs, filters({genres: ['流行', '民谣'], artistIds: ['22', '33', '44'], languages: ['国语', '粤语']}));
  assert.deepEqual(result.matched.map(s => s.id), ['1', '2']);
  assert.deepEqual(result.unmatched.map(s => s.id), ['3']);
});
test('definite mismatch outranks unknown while unselected missing fields do not restrict', () => {
  const songs = [makeSong('1', { language: null }), makeSong('2', { language: null, genres: ['流行'] })];
  const result = filterSongs(songs, filters({genres: ['民谣'], languages: ['国语']}));
  assert.deepEqual(result.unknown.map(s => s.id), ['1']);
  assert.deepEqual(result.unmatched.map(s => s.id), ['2']);
  assert.ok(result.reasons['1']?.some(reason => reason.includes('语种')));
  assert.ok(result.reasons['2']?.some(reason => reason.includes('曲风')));
  assert.deepEqual(filterSongs(songs, filters({genres: ['民谣']})).matched.map(s => s.id), ['1']);
});
test('all unknown selected dimensions explain their absence', () => {
  const song = makeSong('1', { genres: null, bpm: null, language: null, artistIds: [] });
  song.artists = { value: null, status: 'error', source: 'songDetail', reason: '歌手字段异常' };
  const result = filterSongs([song], filters({genres: ['民谣'], bpmMin: 80, languages: ['国语'], artistIds: ['11']}));
  assert.deepEqual(result.unknown.map(s => s.id), ['1']);
  assert.equal(result.reasons['1']?.length, 4);
});
test('same title distinct IDs survive and repeated IDs use source order', () => {
  const songs = [makeSong('3'), makeSong('1'), makeSong('3'), makeSong('2')];
  assert.deepEqual(filterSongs(songs, filters({genres: ['民谣']})).matched.map(s => s.id), ['3', '1', '2']);
});
test('single-sided BPM includes boundaries', () => {
  const songs = [makeSong('1', { bpm: 80 }), makeSong('2', { bpm: 120 })];
  assert.deepEqual(filterSongs(songs, filters({bpmMin: 120})).matched.map(s => s.id), ['2']);
  assert.deepEqual(filterSongs(songs, filters({bpmMax: 80})).matched.map(s => s.id), ['1']);
});
test('no condition requires explicit all songs and invalid BPM bounds reject', () => {
  assert.throws(() => validateFilters(filters()), /至少|条件/);
  assert.throws(() => filterSongs([], filters()), /至少|条件/);
  for (const bound of [0, -1, NaN, Infinity]) {
    assert.throws(() => validateFilters(filters({bpmMin: bound})), /BPM/);
    assert.throws(() => validateFilters(filters({bpmMax: bound})), /BPM/);
  }
  assert.throws(() => validateFilters(filters({bpmMin: 120, bpmMax: 80})), /BPM/);
  assert.doesNotThrow(() => validateFilters(filters({bpmMin: 80, bpmMax: 80})));
  assert.throws(() => validateFilters(filters({genres: ['  ']})), /至少|条件/);
});
test('explicit all songs ignores selected metadata conditions', () => {
  const songs = [makeSong('1', {genres: null, bpm: null, language: null}), makeSong('2')];
  assert.deepEqual(filterSongs(songs, filters({allSongs: true, genres: ['不命中']})).matched.map(s => s.id), ['1', '2']);
});
test('manual selection cannot import foreign IDs and removal wins source-ordered deduplication', () => {
  const songs = [makeSong('3'), makeSong('1', {genres: ['流行']}), makeSong('2'), makeSong('3')];
  const result = filterSongs(songs, filters({genres: ['民谣']}));
  result.matched.push(makeSong('999'));
  const added = new Set(['1', '2', '999', 'invalid']);
  const removed = new Set(['2']);
  assert.deepEqual(resolveSelection(songs, result, added, removed), ['3', '1']);
  assert.deepEqual([...added], ['1', '2', '999', 'invalid']);
  assert.deepEqual([...removed], ['2']);
});
test('selection version canonicalizes conditions and targets with fixed field order', () => {
  const actual = buildSelectionVersion(filters({genres: ['摇滚', '民谣', '民谣'], artistIds: ['22', '11']}), ['3','1','3'], { privacy: 10, name: '整理·筛选结果', kind: 'new' });
  assert.equal(actual, '{"filters":{"genres":["摇滚","民谣"],"languages":[],"artistIds":["11","22"],"bpmMin":null,"bpmMax":null,"allSongs":false},"ids":["3","1"],"target":{"kind":"new","name":"整理·筛选结果","privacy":10}}');
  assert.equal(actual, buildSelectionVersion(filters({genres: ['民谣', '摇滚'], artistIds: ['11','22','11']}), ['3','1'], {kind: 'new', name: '整理·筛选结果', privacy: 10}));
});
test('selection version changes with conditions, song order, manual choices and target', () => {
  const base = buildSelectionVersion(filters({genres: ['民谣']}), ['1','2'], null);
  const variants = [
    buildSelectionVersion(filters({genres: ['摇滚']}), ['1','2'], null),
    buildSelectionVersion(filters({genres: ['民谣']}), ['2','1'], null),
    buildSelectionVersion(filters({genres: ['民谣']}), ['1'], null),
    buildSelectionVersion(filters({genres: ['民谣']}), ['1','2'], {kind:'existing', id:'99'})];
  for (const value of variants) assert.notEqual(base, value);
  assert.throws(() => buildSelectionVersion(filters({genres: ['民谣']}), ['0'], null), /ID/);
});
test('filtering preserves input records and filters', () => {
  const songs = [makeSong('1'), makeSong('2', {genres: null})];
  const selected = filters({ genres: ['民谣'] });
  const before = JSON.stringify({songs, selected});
  filterSongs(songs, selected);
  assert.equal(JSON.stringify({songs, selected}), before);
});

test('manual selection uses canonical IDs and ignores malformed external IDs', () => {
  const songs = [makeSong('3'), makeSong('1', {genres: ['流行']}), makeSong('2')];
  const result = filterSongs(songs, filters({genres: ['民谣']}));
  assert.deepEqual(resolveSelection(songs, result, new Set(['0001', 'invalid']), new Set(['0002'])), ['3', '1']);
});
