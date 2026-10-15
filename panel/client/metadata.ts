import type { SongRecord, CapabilityReport } from '../core/model';
import { normalizeMetadata } from '../core/normalize';
import { discoverClient } from './capabilities';
import type { ReadApi } from './library';
import { id } from './library';
import { businessResponse, object, ReadError, checkPause } from './requests';

type Metadata = Pick<SongRecord, 'genres' | 'bpm' | 'language'>;

export class MetadataReadError extends ReadError {
  constructor(error: ReadError, readonly metadata: Metadata) {
    super(error.kind, error.code);
  }
}

export class MetadataPausedError extends ReadError {
  constructor(readonly partial: Partial<Metadata>) {
    super('paused');
  }
}

function requestFailure(error: unknown, metas: unknown, field: 'wiki' | 'language'): MetadataReadError {
  const safe = error instanceof ReadError ? error : new ReadError('network');
  const metadata = normalizeMetadata(metas, null);
  const failed = { value: null, status: 'error' as const, reason: `请求失败：${safe.kind}` };
  if (field === 'wiki') {
    metadata.genres = { ...failed, source: 'desktopWiki' };
    metadata.bpm = { ...failed, source: 'desktopWiki' };
  } else {
    metadata.language = { ...failed, source: 'ugcSong' };
  }
  return new MetadataReadError(safe, metadata);
}

export function createMetadataReader(read: ReadApi, wiki: NonNullable<CapabilityReport['desktopWiki']>) {
  const suspended = new Set<keyof Metadata>();

  function reconcile<T extends Partial<Metadata>>(metadata: T, detectMalformed = true): T {
    for (const field of ['genres', 'bpm', 'language'] as const) {
      const value = metadata[field];
      if (!value) continue;
      if (detectMalformed && value.status === 'error') suspended.add(field);
      if (suspended.has(field)) {
        Object.assign(metadata, { [field]: {
          value: null, status: 'error', source: field === 'language' ? 'ugcSong' : 'desktopWiki',
          reason: '来源结构失配，该维度已暂停；可强制更新重新检测',
        } });
      }
    }
    return metadata;
  }

  async function readMetadata(songId: string, signal?: AbortSignal): Promise<Metadata> {
    id(songId);
    let metas: unknown = null, ugc: unknown = null;
    const partial: Partial<Metadata> = {};

    const failure = (error: unknown, field: 'wiki' | 'language'): never => {
      if (signal?.aborted || (error instanceof ReadError && error.kind === 'paused')) {
        throw new MetadataPausedError(reconcile(partial));
      }
      const failed = requestFailure(error, metas, field);
      // Transport failures remain retryable; only response normalization suspends dimensions.
      reconcile(failed.metadata, false);
      throw failed;
    };

    if (!(suspended.has('genres') && suspended.has('bpm'))) {
      try {
        checkPause(signal);
        const value: unknown = await wiki(songId, signal);
        if (value === null) metas = null;
        else if (object(value) && Array.isArray(value.metas)) metas = value.metas;
        else throw new ReadError('structure');
        const normalized = normalizeMetadata(metas, null);
        Object.assign(partial, reconcile({ genres: normalized.genres, bpm: normalized.bpm }));
      } catch (error) {
        if (!(error instanceof ReadError) || error.kind !== 'structure') failure(error, 'wiki');
        suspended.add('genres');
        suspended.add('bpm');
        const malformed = normalizeMetadata({}, null);
        Object.assign(partial, reconcile({ genres: malformed.genres, bpm: malformed.bpm }));
      }
    }
    if (!suspended.has('language')) {
      try {
        checkPause(signal);
        ugc = businessResponse(await read('/api/rep/ugc/song/get', { songId }, signal));
      } catch (error) {
        if (!(error instanceof ReadError) || error.kind !== 'structure') failure(error, 'language');
        suspended.add('language');
      }
    }
    return reconcile(normalizeMetadata(metas, ugc));
  }
  return { readMetadata, resetErrors: () => suspended.clear() };
}

let defaultReader: ReturnType<typeof createMetadataReader> | undefined;
export function resetMetadataErrors(): void { defaultReader?.resetErrors(); }

export async function readMetadata(songId: string, signal?: AbortSignal): Promise<Metadata> {
  const report = discoverClient();
  if (!report.read || !report.desktopWiki) throw new ReadError('structure');
  if (!defaultReader) defaultReader = createMetadataReader(report.read, report.desktopWiki);
  return defaultReader.readMetadata(songId, signal);
}
