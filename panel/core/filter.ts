import type { Field, Filters, FilterResult, SongRecord, WritePlan } from './model';
import { normalizeSongId } from './normalize';

function labels(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}
function canonicalFilters(filters: Filters): Filters {
  return { genres: labels(filters.genres), languages: labels(filters.languages),
    artistIds: [...new Set(filters.artistIds.map(normalizeSongId))].sort(),
    bpmMin: filters.bpmMin, bpmMax: filters.bpmMax, allSongs: filters.allSongs };
}
export function validateFilters(filters: Filters): void {
  const selected = canonicalFilters(filters);
  for (const bound of [selected.bpmMin, selected.bpmMax]) {
    if (bound !== null && (typeof bound !== 'number' || !Number.isFinite(bound) || bound <= 0)) {
      throw new Error('BPM 范围必须为正有限数字');
    }
  }
  if (selected.bpmMin !== null && selected.bpmMax !== null && selected.bpmMin > selected.bpmMax) {
    throw new Error('BPM 下限不能高于上限');
  }
  if (!selected.allSongs && !selected.genres.length && !selected.languages.length &&
      !selected.artistIds.length && selected.bpmMin === null && selected.bpmMax === null) {
    throw new Error('请至少选择一个筛选条件，或明确选择全部收藏');
  }
}

type Decision = { state: 'matched' | 'unknown' | 'unmatched'; reason: string };
function decide<T>(field: Field<T>, label: string, matches: (value: T) => boolean): Decision {
  if (field.status !== 'known' || field.value === null) {
    return { state: 'unknown', reason: `${label}：${field.reason ?? '信息缺失'}` };
  }
  const state = matches(field.value) ? 'matched' : 'unmatched';
  return { state, reason: `${label}：${state === 'matched' ? '符合条件' : '不符合条件'}` };
}
export function filterSongs(songs: SongRecord[], filters: Filters): FilterResult {
  validateFilters(filters);
  const selected = canonicalFilters(filters);
  const result: FilterResult = { matched: [], unknown: [], unmatched: [], reasons: {} };
  const seen = new Set<string>();
  for (const song of songs) {
    const id = normalizeSongId(song.id);
    if (seen.has(id)) continue;
    seen.add(id);
    if (selected.allSongs) {
      result.matched.push(song);
      result.reasons[id] = ['全部收藏'];
      continue;
    }
    const decisions: Decision[] = [];
    if (selected.genres.length) decisions.push(decide(song.genres, '曲风', values => values.some(value => selected.genres.includes(value))));
    if (selected.languages.length) decisions.push(decide(song.language, '语种', value => selected.languages.includes(value)));
    if (selected.artistIds.length) decisions.push(decide(song.artists, '歌手', values => values.some(value => selected.artistIds.includes(normalizeSongId(value.id)))));
    if (selected.bpmMin !== null || selected.bpmMax !== null) {
      if (song.bpm.status === 'known' && song.bpm.value !== null && (!Number.isFinite(song.bpm.value) || song.bpm.value <= 0)) {
        decisions.push({ state: 'unknown', reason: 'BPM：不是正有限数字' });
      } else decisions.push(decide(song.bpm, 'BPM', value =>
        (selected.bpmMin === null || value >= selected.bpmMin) && (selected.bpmMax === null || value <= selected.bpmMax)));
    }
    const state = decisions.some(value => value.state === 'unmatched') ? 'unmatched'
      : decisions.some(value => value.state === 'unknown') ? 'unknown' : 'matched';
    result[state].push(song);
    result.reasons[id] = decisions.map(value => value.reason);
  }
  return result;
}

export function resolveSelection(songs: SongRecord[], result: FilterResult, added: Set<string>, removed: Set<string>): string[] {
  const wanted = new Set(result.matched.map(song => normalizeSongId(song.id)));
  const canonicalManualIds = (values: Set<string>): Set<string> => {
    const ids = new Set<string>();
    for (const value of values) {
      try { ids.add(normalizeSongId(value)); } catch { /* Outside IDs cannot enter the source selection. */ }
    }
    return ids;
  };
  for (const id of canonicalManualIds(added)) wanted.add(id);
  const excluded = canonicalManualIds(removed);
  const output: string[] = [];
  const seen = new Set<string>();
  for (const song of songs) {
    const id = normalizeSongId(song.id);
    if (!seen.has(id) && wanted.has(id) && !excluded.has(id)) output.push(id);
    seen.add(id);
  }
  return output;
}

export function buildSelectionVersion(filters: Filters, ids: string[], target: WritePlan['target'] | null): string {
  const normalizedTarget = target === null ? null : target.kind === 'new'
    ? { kind: 'new', name: target.name, privacy: target.privacy }
    : { kind: 'existing', id: normalizeSongId(target.id) };
  return JSON.stringify({ filters: canonicalFilters(filters),
    ids: [...new Set(ids.map(normalizeSongId))], target: normalizedTarget });
}
