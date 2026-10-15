import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMetadata, normalizeSongId } from '../panel/core/normalize';

test('IDs preserve decimal precision and canonicalize leading zeros', () => {
  assert.equal(normalizeSongId(42), '42');
  assert.equal(normalizeSongId(' 00042 '), '42');
  assert.equal(normalizeSongId('900719925474099312345'), '900719925474099312345');
});
test('unsafe numeric or nonpositive/nondecimal IDs stop normalization', () => {
  for (const id of [9007199254740992, 0, -1, 1.2, NaN, Infinity,
    '', '0', '00', '-1', '1e3', '12.0', null, undefined, {}, true]) {
    assert.throws(() => normalizeSongId(id), /ID/);
  }
});
test('metadata retains explicit labels and splits only the observed delimiter', () => {
  const result = normalizeMetadata([
    { title: '曲风', content: ' 另类/独立、流行、摇滚-日系摇滚、流行 ' },
    { title: '曲风', content: ' 流行、二次元-游戏音乐 ' },
    { title: 'BPM', content: ' 80.5 ' },
  ], { data: { language: ' 纯音乐 ' } });
  assert.deepEqual(result.genres, { value: ['另类/独立', '流行', '摇滚-日系摇滚', '二次元-游戏音乐'],
    source: 'desktopWiki', status: 'known' });
  assert.deepEqual(result.bpm, { value: 80.5, source: 'desktopWiki', status: 'known' });
  assert.deepEqual(result.language, { value: '纯音乐', source: 'ugcSong', status: 'known' });
});
test('unknown, empty, absent and nonnumeric values retain distinct safe reasons', () => {
  const absent = normalizeMetadata([], { data: {} });
  const empty = normalizeMetadata([{ title: 'BPM', content: '' }], { data: { language: null } });
  const unknown = normalizeMetadata([{ title: 'BPM', content: '未知' }], { data: { language: '未知' } });
  const invalid = normalizeMetadata([{ title: 'BPM', content: '80 BPM' }], { data: { language: 42 } });
  assert.equal(absent.bpm.status, 'missing');
  assert.equal(empty.bpm.status, 'missing');
  assert.equal(unknown.bpm.status, 'missing');
  assert.equal(invalid.bpm.status, 'error');
  assert.equal(new Set([absent.bpm.reason, empty.bpm.reason, unknown.bpm.reason, invalid.bpm.reason]).size, 4);
  assert.equal(empty.language.value, null);
  assert.equal(unknown.language.value, null);
  assert.equal(invalid.language.status, 'error');
  for (const value of [absent.bpm, empty.bpm, unknown.bpm, invalid.bpm]) assert.ok(value.reason);
});
test('nonpositive/nonfinite and conflicting BPM never become known', () => {
  for (const content of ['0', '-1', 'Infinity', 'NaN', '1e9999', true, 0]) {
    const result = normalizeMetadata([{ title: 'BPM', content }], { data: { language: '国语' } });
    assert.equal(result.bpm.status, 'error');
    assert.equal(result.bpm.value, null);
  }
  const conflict = normalizeMetadata([{ title: 'BPM', content: '80' }, { title: 'BPM', content: '120' }], null);
  assert.equal(conflict.bpm.status, 'error');
});
test('unverified fallback fields never infer instrumental language or BPM', () => {
  const result = normalizeMetadata([], { data: { language: '未知', instrumental: true, bpm: 120 }, language: '纯音乐' });
  assert.equal(result.language.value, null);
  assert.equal(result.bpm.value, null);
  assert.equal(result.genres.value, null);
});
test('missing markers remain missing in all metadata fields', () => {
  for (const content of ['未知', '暂无', '待补充']) {
    const result = normalizeMetadata([{ title: '曲风', content }, { title: 'BPM', content }], { data: { language: content } });
    assert.equal(result.genres.status, 'missing');
    assert.equal(result.bpm.status, 'missing');
    assert.equal(result.language.status, 'missing');
  }
});
test('malformed source structures produce safe field errors', () => {
  for (const metas of [{ secret: 'DO_NOT_ECHO' }, [null], [{ content: '民谣' }]]) {
    const result = normalizeMetadata(metas, { data: { language: '国语' } });
    assert.equal(result.genres.status, 'error');
    assert.equal(result.bpm.status, 'error');
    assert.ok(!JSON.stringify(result).includes('DO_NOT_ECHO'));
    assert.equal(result.language.value, '国语');
  }
  assert.equal(normalizeMetadata([], { data: 'DO_NOT_ECHO' }).language.status, 'error');
});
