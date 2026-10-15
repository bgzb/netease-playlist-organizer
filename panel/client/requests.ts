import type { ReadPath } from '../core/model';

export type ReadKind = 'network' | 'login' | 'permission' | 'rateLimit' | 'business'
  | 'structure' | 'accountChanged' | 'collectionChanged' | 'storage' | 'paused';

export class ReadError extends Error {
  constructor(public readonly kind: ReadKind, public readonly code?: number) {
    super(`读取已暂停：${kind}${code === undefined ? '' : ` (${code})`}`);
    this.name = 'ReadError';
  }
}

export function checkPause(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReadError('paused');
}

export const READ_PATHS: readonly ReadPath[] = [
  '/api/w/nuser/account/get', '/api/user/playlist', '/api/v6/playlist/detail',
  '/api/v3/song/detail', '/api/rep/ugc/song/get',
];

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function businessResponse(value: unknown): Record<string, unknown> {
  if (!object(value) || typeof value.code !== 'number' || !Number.isInteger(value.code)) {
    throw new ReadError('structure');
  }
  if (value.code !== 200) throw new ReadError(classifyCode(value.code), value.code);
  return value;
}

function classifyCode(code: number): ReadKind {
  if ([301, 302, 401, -101].includes(code)) return 'login';
  if (code === 403) return 'permission';
  if ([429, 509].includes(code)) return 'rateLimit';
  return 'business';
}

function safeError(error: unknown): ReadError {
  if (error instanceof ReadError) return error;
  // Raw client errors may carry credentials in option/body/message. Inspect numeric codes only.
  if (object(error) && typeof error.code === 'number') {
    return new ReadError(classifyCode(error.code), error.code);
  }
  return new ReadError('network');
}

export type RequestFactory = (path: ReadPath) =>
  (data: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
export type RequestOptions = {
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  pacingSleep?: (ms: number) => Promise<void>;
};
const UGC_START_INTERVAL_MS = 750;

export class ReadExecutor {
  private active = 0;
  private queue: (() => void)[] = [];
  private pacingActive = false;
  private pacingQueue: (() => void)[] = [];
  private lastUgcStart: number | null = null;

  constructor(private readonly options: RequestOptions = {}) {}

  private async acquire(): Promise<void> {
    if (this.active < 2) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }

  private wait(ms: number, signal?: AbortSignal, mode: 'retry' | 'pacing' = 'retry'): Promise<void> {
    checkPause(signal);
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', pause);
      };
      const complete = () => { cleanup(); resolve(); };
      const fail = (error: unknown) => { cleanup(); reject(error); };
      const pause = () => fail(new ReadError('paused'));
      signal?.addEventListener('abort', pause, { once: true });
      const sleep = mode === 'pacing' ? this.options.pacingSleep : this.options.sleep;
      if (sleep) sleep(ms).then(complete, fail);
      else timer = setTimeout(complete, ms);
    });
  }

  private clock(): number { return this.options.now?.() ?? performance.now(); }

  private acquirePacing(signal?: AbortSignal): Promise<void> {
    checkPause(signal);
    if (!this.pacingActive) {
      this.pacingActive = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const enter = () => {
        signal?.removeEventListener('abort', pause);
        resolve();
      };
      const pause = () => {
        const index = this.pacingQueue.indexOf(enter);
        if (index >= 0) this.pacingQueue.splice(index, 1);
        signal?.removeEventListener('abort', pause);
        reject(new ReadError('paused'));
      };
      this.pacingQueue.push(enter);
      signal?.addEventListener('abort', pause, { once: true });
      if (signal?.aborted) pause();
    });
  }

  private releasePacing(): void {
    const next = this.pacingQueue.shift();
    if (next) next();
    else this.pacingActive = false;
  }

  private async acquirePacedSlot(signal?: AbortSignal): Promise<() => void> {
    await this.acquirePacing(signal);
    try {
      for (;;) {
        checkPause(signal);
        const delay = this.lastUgcStart === null ? 0
          : this.lastUgcStart + UGC_START_INTERVAL_MS - this.clock();
        // Only UGC start admission is serialized. A pacing sleep owns no global
        // backend slot, so fresh ownership reads, library and wiki stay runnable.
        if (delay > 0) await this.wait(delay, signal, 'pacing');
        await this.acquire();
        if (signal?.aborted) {
          this.release();
          throw new ReadError('paused');
        }
        if (this.lastUgcStart !== null
          && this.clock() < this.lastUgcStart + UGC_START_INTERVAL_MS) {
          this.release();
          continue;
        }
        return () => this.releasePacing();
      }
    } catch (error) {
      this.releasePacing();
      throw error;
    }
  }

  async run<T>(operation: () => Promise<T>,
    signal: AbortSignal | undefined = this.options.signal, pacedUgc = false): Promise<T> {
    const delays = [2000, 5000, 15000];
    for (let attempt = 0; ; attempt++) {
      checkPause(signal);
      let releasePacing: (() => void) | undefined;
      if (pacedUgc) releasePacing = await this.acquirePacedSlot(signal);
      else await this.acquire();
      let error: ReadError;
      try {
        checkPause(signal);
        if (pacedUgc) {
          // Timestamp the actual backend invocation, including every retry,
          // rather than reserving a future time before a busy global slot.
          this.lastUgcStart = this.clock();
          releasePacing?.();
          releasePacing = undefined;
        }
        return await operation();
      } catch (cause) {
        error = safeError(cause);
      } finally {
        releasePacing?.();
        this.release();
      }
      checkPause(signal);
      if (error.kind !== 'network' || attempt === delays.length) throw error;
      await this.wait(delays[attempt], signal);
    }
  }
}

export function createReadApi(
  factory: RequestFactory,
  options: RequestOptions = {},
  executor = new ReadExecutor(options),
) {
  return async (path: ReadPath, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    if (!READ_PATHS.includes(path)) throw new ReadError('permission');
    const fresh = path !== '/api/rep/ugc/song/get';
    return executor.run(async () => businessResponse(await factory(path)(
      data, fresh ? { skipLocalRpcCache: true, cacheStrategy: { enable: false } } : undefined,
    )), signal, !fresh);
  };
}

export async function readApi(path: ReadPath, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const { discoverReadClient } = await import('./read-capabilities');
  const report = discoverReadClient();
  if (!report.supported || !report.read) throw new ReadError('structure');
  return report.read(path, data, signal);
}

export type WritePath = '/api/playlist/create' | '/api/playlist/manipulate/tracks';
export type WriteApi = (path: WritePath, data: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
export type WriteFactory = (path: WritePath) => (data: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
const decimalId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
/** Only these exact payloads may cross the write boundary. Never retry a write. */
export function createWriteApi(factory: WriteFactory): WriteApi {
  let active = false;
  return async (path, data, signal) => {
    checkPause(signal);
    if (!object(data)) throw new ReadError('permission');
    const keys = Object.keys(data).sort().join(',');
    if (path === '/api/playlist/create') {
      if (keys !== 'name,privacy,type' || typeof data.name !== 'string' || !data.name.trim()
        || data.name.length > 100 || data.privacy !== 10 || data.type !== 'NORMAL') throw new ReadError('permission');
    } else if (path === '/api/playlist/manipulate/tracks') {
      let ids: unknown;
      try { ids = JSON.parse(String(data.trackIds)); } catch { throw new ReadError('permission'); }
      if (keys !== 'imme,op,pid,trackIds' || data.op !== 'add' || !decimalId(data.pid)
        || data.imme !== 'true' || typeof data.trackIds !== 'string' || !Array.isArray(ids)
        || ids.length === 0 || ids.length > 50 || ids.some(value => !decimalId(value))
        || new Set(ids).size !== ids.length) throw new ReadError('permission');
    } else throw new ReadError('permission');
    if (active) throw new ReadError('permission');
    active = true;
    try { return businessResponse(await factory(path)(data,
      {skipLocalRpcCache:true, cacheStrategy:{enable:false}})); }
    catch (cause) { throw safeError(cause); }
    finally { active = false; }
  };
}
