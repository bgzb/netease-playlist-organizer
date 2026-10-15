import type { Field, SongRecord } from '../../panel/core/model';

type Overrides = { genres?: string[] | null; bpm?: number | null;
  language?: string | null; artistIds?: string[] };
function field<T>(value: T | null): Field<T> {
  return value === null ? { value, source: 'none', status: 'missing', reason: '合成字段缺失' }
    : { value, source: 'manual', status: 'known' };
}
export function makeSong(id: string, overrides: Overrides = {}): SongRecord {
  return { id, name: '合成歌曲', position: Number(id),
    artists: field([...new Set(overrides.artistIds ?? ['11'])]
      .map(id => ({ id, name: `合成歌手 ${id}` }))),
    genres: field(overrides.genres === undefined ? ['民谣'] : overrides.genres),
    bpm: field(overrides.bpm === undefined ? 100 : overrides.bpm),
    language: field(overrides.language === undefined ? '国语' : overrides.language) };
}
