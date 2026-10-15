import type { Field, SongRecord, Source } from './model';

export function normalizeSongId(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('ID 必须是正安全整数，无法保证精度时停止');
    return String(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new Error('ID 必须是正十进制字符串');
  }
  const id = value.trim().replace(/^0+/, '');
  if (!id) throw new Error('ID 必须大于零');
  return id;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function missing<T>(source: Source, reason: string): Field<T> {
  return { value: null, source, status: 'missing', reason };
}
function error<T>(source: Source, reason: string): Field<T> {
  return { value: null, source, status: 'error', reason };
}
function known<T>(value: T, source: Source): Field<T> {
  return { value, source, status: 'known' };
}
const missingMarkers = new Set(['未知', '暂无', '待补充']);
function emptyReason(value: unknown): string | null {
  if (value === undefined) return '字段缺失';
  if (value === null || (typeof value === 'string' && !value.trim())) return '字段为空';
  if (typeof value === 'string' && missingMarkers.has(value.trim())) return '来源标记未知';
  return null;
}

function normalizeGenres(contents: unknown[]): Field<string[]> {
  const source = 'desktopWiki';
  if (!contents.length) return missing(source, '曲风字段缺失');
  const values: string[] = [];
  let reason = '曲风字段为空';
  for (const content of contents) {
    const absent = emptyReason(content);
    if (absent) { reason = `曲风${absent}`; continue; }
    if (typeof content !== 'string') return error(source, '曲风字段结构异常');
    // Only the desktop helper's observed separator is interpreted; full labels stay intact.
    for (const part of content.split('、')) {
      const value = part.trim();
      if (!value) continue;
      if (missingMarkers.has(value)) { reason = '曲风来源标记未知'; continue; }
      values.push(value);
    }
  }
  const genres = [...new Set(values)];
  return genres.length ? known(genres, source) : missing(source, reason);
}
function normalizeBpm(contents: unknown[]): Field<number> {
  const source = 'desktopWiki';
  if (!contents.length) return missing(source, 'BPM 字段缺失');
  let found: number | null = null;
  let reason = 'BPM 字段为空';
  for (const content of contents) {
    const absent = emptyReason(content);
    if (absent) { reason = `BPM ${absent}`; continue; }
    if (typeof content !== 'number' && typeof content !== 'string') {
      return error(source, 'BPM 不是正有限数字');
    }
    // Decimal notation only: no unit suffixes, hex, or partially parseable values.
    if (typeof content === 'string' && !/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(content.trim())) {
      return error(source, 'BPM 不是正有限数字');
    }
    const value = Number(content);
    if (!Number.isFinite(value) || value <= 0) return error(source, 'BPM 不是正有限数字');
    if (found !== null && found !== value) return error(source, 'BPM 来源存在冲突');
    found = value;
  }
  return found === null ? missing(source, reason) : known(found, source);
}
function normalizeLanguage(ugc: unknown): Field<string> {
  if (ugc == null) return missing('none', '语种来源缺失');
  if (!record(ugc) || !record(ugc.data)) return error('ugcSong', '语种响应结构异常');
  const value = ugc.data.language;
  const absent = emptyReason(value);
  if (absent) return missing('ugcSong', `语种${absent}`);
  if (typeof value !== 'string') return error('ugcSong', '语种字段结构异常');
  return known(value.trim(), 'ugcSong');
}

export function normalizeMetadata(metas: unknown, ugc: unknown): Pick<SongRecord, 'genres' | 'bpm' | 'language'> {
  const language = normalizeLanguage(ugc);
  if (metas == null) return { genres: missing('none', '曲风来源缺失'), bpm: missing('none', 'BPM 来源缺失'), language };
  if (!Array.isArray(metas) || metas.some(meta => !record(meta) || typeof meta.title !== 'string')) {
    return { genres: error('desktopWiki', '曲风响应结构异常'), bpm: error('desktopWiki', 'BPM 响应结构异常'), language };
  }
  return {
    genres: normalizeGenres(metas.filter(meta => meta.title.trim() === '曲风').map(meta => meta.content)),
    bpm: normalizeBpm(metas.filter(meta => meta.title.trim() === 'BPM').map(meta => meta.content)),
    language,
  };
}
