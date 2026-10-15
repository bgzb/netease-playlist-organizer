import type { LibrarySnapshot, Progress, SongRecord, CacheEntry, PersistedState } from '../core/model';
import { createLibraryReader, validateSnapshot } from '../client/library';
import { readMetadata, resetMetadataErrors, MetadataReadError, MetadataPausedError } from '../client/metadata';
import { ReadError } from '../client/requests';
import { LocalStore } from './store';

type Metadata = Pick<SongRecord, 'genres' | 'bpm' | 'language'>;
export type ScanOptions = {
  readLibrary: () => Promise<LibrarySnapshot>;
  readUid: () => Promise<string>;
  readMetadata: (id: string, signal?: AbortSignal) => Promise<Metadata>;
  store: LocalStore;
  now?: () => number;
  resetMetadataErrors?: () => void;
};

export class CollectionChangedError extends ReadError {
  readonly addedIds: string[];
  readonly removedIds: string[];
  readonly reordered: boolean;

  constructor(readonly current: LibrarySnapshot, previous: LibrarySnapshot) {
    super('collectionChanged');
    this.addedIds = current.ids.filter(id => !previous.ids.includes(id));
    this.removedIds = previous.ids.filter(id => !current.ids.includes(id));
    const common = new Set(current.ids.filter(id => previous.ids.includes(id)));
    this.reordered = JSON.stringify(current.ids.filter(id => common.has(id)))
      !== JSON.stringify(previous.ids.filter(id => common.has(id)));
  }
}

export type ScanPublication = { generation: number; result: LibrarySnapshot | null };

export class Scanner {
  status: Progress & { persisted: boolean } = { phase: 'paused', processed: 0, total: 0, persisted: false };
  result: LibrarySnapshot | null = null;
  private sequence = 0;
  get generation(): number { return this.sequence; }
  private force = false;
  private volatile = false;
  private running = false;
  private memoryCache: Record<string, CacheEntry> | undefined;
  private memoryUid: string | undefined;

  constructor(private readonly options: ScanOptions) {}

  forceRefresh(): void {
    this.force = true;
    this.options.resetMetadataErrors?.();
  }

  continueWithoutPersistence(): void {
    if (this.status.phase !== 'paused') throw new ReadError('paused');
    this.volatile = true;
    this.status.persisted = false;
  }

  retryPersistence(): void { this.volatile = false; }

  async scan(input: LibrarySnapshot, signal: AbortSignal, onProgress: (p: Progress, publication: ScanPublication) => void): Promise<LibrarySnapshot> {
    if (this.running) throw new ReadError('paused');
    this.running = true;
    const generation = ++this.sequence;
    this.result = null;
    let validated = false;
    let identityFailure: ReadError | undefined;
    let failure: unknown, stopped = false, processed = 0, issued = 0;
    let state: PersistedState | null = null;
    let cache: Record<string, CacheEntry> = {};
    const completed = new Set<string>();
    let snapshot = input;
    const now = this.options.now ?? Date.now;

    const publish = (phase: Progress['phase']) => {
      if (identityFailure) return;
      this.status = { phase, processed, total: snapshot.ids.length, persisted: this.status.persisted };
      onProgress({ phase, processed, total: snapshot.ids.length }, { generation, result: this.result });
    };
    // Identity validation remains an independent fresh read even at a pause checkpoint.
    // It must verify account ownership before publishing/persisting issued request results.
    const guard = async () => {
      if (identityFailure) throw identityFailure;
      try {
        const uid = await this.options.readUid();
        if (identityFailure) throw identityFailure;
        if (uid !== input.uid) throw new ReadError('accountChanged');
      } catch (error) {
        if (error instanceof ReadError && ['login', 'accountChanged'].includes(error.kind)) {
          identityFailure = error;
          this.result = null;
        }
        throw error;
      }
    };
    const save = async (phase: Progress['phase']) => {
      if (this.volatile) {
        this.status.persisted = false;
        return;
      }
      await guard();
      // Reload only the journal so a newer writer checkpoint cannot be overwritten by a scan.
      const latest = this.options.store.load(input.uid);
      const next: PersistedState = {
        schemaVersion: 1, uid: input.uid,
        scan: { snapshot, completedIds: [...completed], cache, phase, updatedAt: now() },
        writeJournal: latest ? latest.writeJournal : state?.writeJournal ?? null,
      };
      try {
        this.options.store.save(input.uid, next);
        state = next;
        this.status.persisted = true;
      } catch (error) {
        this.status.persisted = false;
        throw error;
      }
    };

    try {
      validateSnapshot(input);
      this.status.persisted = false;
      publish('reading');
      const fresh = await this.options.readLibrary();
      validateSnapshot(fresh);
      await guard();
      if (fresh.uid !== input.uid) throw new ReadError('accountChanged');
      if (fresh.sourcePlaylistId !== input.sourcePlaylistId || fresh.revision !== input.revision) {
        throw new CollectionChangedError(fresh, input);
      }
      snapshot = { ...fresh, songs: fresh.songs.map(song => ({ ...song })) };
      validated = true;
      this.result = snapshot;
      state = this.options.store.load(input.uid);
      cache = { ...state?.scan?.cache };
      if (this.memoryCache && this.memoryUid === input.uid) cache = { ...cache, ...this.memoryCache };

      const prior = state?.scan;
      if (prior?.snapshot.revision === snapshot.revision && prior.snapshot.sourcePlaylistId === snapshot.sourcePlaylistId) {
        // Partial pause results stay visible while their sources are rechecked on resume.
        // They are not completed cache hits, and never skip an unfinished metadata operation.
        snapshot.songs.forEach((song, index) => {
          if (!prior.completedIds.includes(song.id)) {
            const previous = prior.snapshot.songs[index];
            song.genres = previous.genres;
            song.bpm = previous.bpm;
            song.language = previous.language;
          }
        });
      }
      for (const song of snapshot.songs) {
        const entry = cache[song.id];
        if (this.force || !entry) continue;
        let all = true;
        for (const field of ['genres', 'bpm', 'language'] as const) {
          const value = entry.song[field];
          const age = now() - entry.updatedAt[field];
          const ttl = value.status === 'known' ? 7 * 86400000 : 86400000;
          if (value.status !== 'error' && age >= 0 && age < ttl) Object.assign(song, { [field]: value });
          else all = false;
        }
        if (all) {
          completed.add(song.id);
          processed++;
        }
      }
      const pending = snapshot.songs.filter(song => !completed.has(song.id));
      publish('scanning');
      const abort = () => { stopped = true; publish('pausing'); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();

      try {
        const worker = async () => {
          while (!stopped && !signal.aborted) {
            const song = pending[issued++];
            if (!song) return;
            try {
              await guard();
              if (stopped || signal.aborted) return;
              const metadata = await this.options.readMetadata(song.id, signal);
              await guard();
              Object.assign(song, metadata);
              completed.add(song.id);
              processed++;
              const updatedAt = { genres: now(), bpm: now(), language: now() };
              for (const field of ['genres', 'bpm', 'language'] as const) {
                if (metadata[field].status === 'error') updatedAt[field] = 0;
              }
              cache[song.id] = { song: { ...song }, updatedAt };
              this.memoryCache = cache;
              this.memoryUid = input.uid;
              publish(stopped || signal.aborted ? 'pausing' : 'scanning');
              if (processed % 10 === 0 && !stopped) await save('scanning');
            } catch (cause) {
              let error = cause;
              if (cause instanceof ReadError && ['login', 'accountChanged'].includes(cause.kind)) {
                // An issued metadata request can itself establish login loss. A later
                // successful identity read cannot resurrect this scan generation.
                identityFailure = cause;
                this.result = null;
              } else if (cause instanceof MetadataPausedError || cause instanceof MetadataReadError) {
                try {
                  await guard();
                  Object.assign(song, cause instanceof MetadataPausedError ? cause.partial : cause.metadata);
                } catch (guardError) {
                  error = guardError;
                }
              }
              stopped = true;
              if (!(error instanceof MetadataPausedError)) failure ??= error;
              if (error instanceof ReadError && ['login', 'accountChanged'].includes(error.kind)) {
                this.result = null;
              } else {
                publish('pausing');
              }
            }
          }
        };
        await Promise.all([worker(), worker()]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
      if (identityFailure) throw identityFailure;
      if (failure) throw failure;
      const phase = stopped || signal.aborted ? 'paused' : 'complete';
      await save(phase);
      publish(phase);
      if (phase === 'complete') this.force = false;
      return snapshot;
    } catch (error) {
      const identityLost = error instanceof ReadError && ['login', 'accountChanged'].includes(error.kind);
      this.result = !validated || identityLost || error instanceof ReadError && error.kind === 'collectionChanged'
        ? null : snapshot;
      // Let the controller revoke account-owned state before its next publication.
      if (identityLost) this.status = { phase: 'paused', processed, total: snapshot.ids.length, persisted: false };
      else publish('paused');
      if (validated && error instanceof ReadError && !['login', 'accountChanged', 'storage', 'collectionChanged'].includes(error.kind)) {
        try { await save('paused'); }
        catch { this.status.persisted = false; }
      }
      // The error-checkpoint guard can establish identity loss after the earlier
      // worker-error precedence check. Never replace it with the original error.
      if (identityFailure) {
        this.result = null;
        this.status = { ...this.status, phase: 'paused', persisted: false };
        throw identityFailure;
      }
      throw error;
    } finally {
      this.running = false;
    }
  }
}

export const createScanner = (options: ScanOptions) => new Scanner(options);
let defaultScanner: Scanner | undefined;
export function scan(snapshot: LibrarySnapshot, signal: AbortSignal, onProgress: (p: Progress) => void): Promise<LibrarySnapshot> {
  if (!defaultScanner) {
    const library = createLibraryReader();
    defaultScanner = createScanner({ ...library, readMetadata, resetMetadataErrors, store: new LocalStore() });
  }
  return defaultScanner.scan(snapshot, signal, onProgress);
}
