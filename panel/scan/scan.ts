import type { LibrarySnapshot, Progress, SongRecord, CacheEntry, StoredPlaylistScan } from '../core/model';
import { createLibraryReader, validateSnapshot,id } from '../client/library';
import { readMetadata, resetMetadataErrors, MetadataReadError, MetadataPausedError } from '../client/metadata';
import { ReadError } from '../client/requests';
import { LocalStore } from './store';

type Metadata = Pick<SongRecord, 'genres' | 'bpm' | 'language'>;
export type ScanOptions = {
  readLibrary: (sourceId:string,signal?:AbortSignal) => Promise<LibrarySnapshot>;
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

export type ScanPublication = { generation: number; result: LibrarySnapshot | null; change?:{addedIds:string[];removedIds:string[];reordered:boolean} };
type Memory = {cache:Record<string,CacheEntry>;last:StoredPlaylistScan|null;force:boolean;volatile:boolean;dirty:boolean};

export class Scanner {
  status: Progress & { persisted: boolean } = { phase: 'paused', processed: 0, total: 0, persisted: false };
  result: LibrarySnapshot | null = null;
  private sequence = 0;
  get generation(): number { return this.sequence; }
  private forceNext = false;
  private running = false;
  private memories=new Map<string,Memory>();
  private activeKey:string|undefined;

  constructor(private readonly options: ScanOptions) {}

  forceRefresh(uid?:string,pid?:string): void {
    if((uid===undefined)!==(pid===undefined))throw new ReadError('structure');
    const key=uid!==undefined&&pid!==undefined?id(uid)+':'+id(pid):this.activeKey;
    if(key){const memory=this.memories.get(key)??{cache:{},last:null,force:false,volatile:false,dirty:false};memory.force=true;this.memories.set(key,memory);}
    else this.forceNext = true;
    this.options.resetMetadataErrors?.();
  }

  continueWithoutPersistence(uid?:string,pid?:string): void {
    if(this.running||(!uid&&this.status.phase!=='paused'))throw new ReadError('paused');
    if((uid===undefined)!==(pid===undefined))throw new ReadError('structure');
    const key=uid!==undefined&&pid!==undefined?id(uid)+':'+id(pid):this.activeKey;
    if(!key)throw new ReadError('paused');
    const memory=this.memories.get(key)??{cache:{},last:null,force:false,volatile:false,dirty:false};
    this.memories.set(key,memory);
    if(key!==this.activeKey){this.result=null;this.status={phase:'paused',processed:0,total:0,persisted:false};}
    this.activeKey=key;
    memory.volatile = true;
    this.status.persisted = false;
  }

  retryPersistence(uid?:string,pid?:string): void { const key=uid!==undefined&&pid!==undefined?id(uid)+':'+id(pid):this.activeKey;const memory=key?this.memories.get(key):undefined;if(memory)memory.volatile=false; }

  discardCaches(uid:string,scope:{kind:'all'}|{kind:'exceptFavorites';favoritesId:string}):void {
    if(this.running)throw new ReadError('paused');
    for(const [key,m] of this.memories){if(key.startsWith(uid+':')&&(scope.kind==='all'||key!==uid+':'+scope.favoritesId)){this.memories.delete(key);if(this.activeKey===key){this.activeKey=undefined;this.result=null;this.status={phase:'paused',processed:0,total:0,persisted:false};}}}
    this.forceNext=false;
  }

  hasUnsavedResult(uid:string,pid:string):boolean {
    const memory=this.memories.get(id(uid)+':'+id(pid));return !!(memory?.last&&memory.dirty);
  }

  async persistCurrent(uid?:string,pid?:string):Promise<void> {
    const key=uid!==undefined&&pid!==undefined?id(uid)+':'+id(pid):this.activeKey;
    const memory=key?this.memories.get(key):undefined,record=memory?.last;
    if(this.running||!record)throw new ReadError('paused');
    const generation=this.sequence;
    if(await this.options.readUid()!==record.uid){this.result=null;throw new ReadError('accountChanged');}
    if(this.running||generation!==this.sequence)throw new ReadError('paused');
    const saved=record.checkpoint.phase==='complete'?{...record,lastCompletedAt:(this.options.now??Date.now)()}:record;
    this.options.store.saveScan(record.uid,record.source.id,saved);
    memory!.last=saved;memory!.volatile=false;memory!.dirty=false;if(key===this.activeKey)this.status.persisted=true;
  }

  async scan(input: LibrarySnapshot, signal: AbortSignal, onProgress: (p: Progress, publication: ScanPublication) => void): Promise<LibrarySnapshot> {
    if (this.running) throw new ReadError('paused');
    this.running = true;
    const generation = ++this.sequence;
    this.result = null;
    let validated = false;
    let identityFailure: ReadError | undefined;
    let failure: unknown, stopped = false, processed = 0, issued = 0;
    let state: StoredPlaylistScan | null = null;
    let cache: Record<string, CacheEntry> = {};
    const completed = new Set<string>();
    let snapshot = input;
    const now = this.options.now ?? Date.now;
    const key=input.uid+':'+input.sourcePlaylistId;
    const memory=this.memories.get(key)??{cache:{},last:null,force:false,volatile:false,dirty:false};
    this.memories.set(key,memory);this.activeKey=key;
    if(this.forceNext){memory.force=true;this.forceNext=false;}
    let change:ScanPublication['change'];

    const publish = (phase: Progress['phase']) => {
      if (identityFailure) return;
      this.status = { phase, processed, total: snapshot.ids.length, persisted: this.status.persisted };
      onProgress({ phase, processed, total: snapshot.ids.length }, { generation, result: this.result,...(change?{change}: {}) });
      change=undefined;
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
    const remember = (phase:Progress['phase']):StoredPlaylistScan => {
      if(!snapshot.source)throw new ReadError('structure');
      const next:StoredPlaylistScan={schemaVersion:2,uid:input.uid,source:snapshot.source,
        checkpoint:{snapshot,completedIds:[...completed],cache,phase,updatedAt:now()},
        lastCompletedAt:state?.lastCompletedAt??memory.last?.lastCompletedAt??null};
      memory.last=next;memory.cache=cache;memory.dirty=true;
      return next;
    };
    const save = async (phase: Progress['phase']) => {
      const next=remember(phase);
      if (memory.volatile) {
        this.status.persisted = false;
        return;
      }
      await guard();
      try {
        const saved=phase==='complete'?{...next,lastCompletedAt:now()}:next;
        this.options.store.saveScan(input.uid,input.sourcePlaylistId,saved);
        memory.last=saved;
        memory.dirty=false;
        state = saved;
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
      const fresh = await this.options.readLibrary(input.sourcePlaylistId,signal);
      validateSnapshot(fresh);
      await guard();
      if (fresh.uid !== input.uid) throw new ReadError('accountChanged');
      if (fresh.sourcePlaylistId !== input.sourcePlaylistId)throw new ReadError('structure');
      if(fresh.revision!==input.revision){const delta=new CollectionChangedError(fresh,input);change={addedIds:delta.addedIds,removedIds:delta.removedIds,reordered:delta.reordered};}
      if(!fresh.source)throw new ReadError('structure');
      snapshot = { ...fresh, songs: fresh.songs.map(song => ({ ...song })) };
      validated = true;
      this.result = snapshot;
      state = this.options.store.loadScan(input.uid,input.sourcePlaylistId);
      const allowed=new Set(snapshot.ids);
      cache = Object.fromEntries(Object.entries({...state?.checkpoint.cache,...memory.cache}).filter(([id])=>allowed.has(id)));

      const prior = memory.last?.checkpoint??state?.checkpoint;
      if (prior?.snapshot.revision === snapshot.revision && prior.snapshot.sourcePlaylistId === snapshot.sourcePlaylistId) {
        const priorCompleted = new Set(prior.completedIds);
        // Partial pause results stay visible while their sources are rechecked on resume.
        // They are not completed cache hits, and never skip an unfinished metadata operation.
        snapshot.songs.forEach((song, index) => {
          if (!priorCompleted.has(song.id)) {
            const previous = prior.snapshot.songs[index];
            song.genres = previous.genres;
            song.bpm = previous.bpm;
            song.language = previous.language;
          }
        });
      }
      for (const song of snapshot.songs) {
        const entry = cache[song.id];
        if (memory.force || !entry) continue;
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
              memory.cache=cache;memory.dirty=true;
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
      if (phase === 'complete') memory.force = false;
      return snapshot;
    } catch (error) {
      const identityLost = error instanceof ReadError && ['login', 'accountChanged'].includes(error.kind);
      this.result = !validated || identityLost || error instanceof ReadError && error.kind === 'collectionChanged'
        ? null : snapshot;
      // Let the controller revoke account-owned state before its next publication.
      if (identityLost) this.status = { phase: 'paused', processed, total: snapshot.ids.length, persisted: false };
      else publish('paused');
      if(validated&&!identityLost)remember('paused');
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
    defaultScanner = createScanner({readLibrary:(id,signal)=>library.readLibrary({kind:'playlist',id},signal),readUid:library.readUid, readMetadata, resetMetadataErrors, store: new LocalStore() });
  }
  return defaultScanner.scan(snapshot, signal, onProgress);
}
