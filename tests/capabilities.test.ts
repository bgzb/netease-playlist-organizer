import test from 'node:test';import assert from 'node:assert/strict';import {discoverClient} from '../panel/client/capabilities';import {createReadApi,ReadError} from '../panel/client/requests';import {paths} from './fixtures/read';
function client(id='312'){const options:any[]=[];const factory=(_p:string)=>async(_d:any,o:any)=>{options.push(o);return {code:200,profile:{userId:7}}};const wiki=async(_id:string)=>{const wikiSubElementVos:any[]=[];return {metas:wikiSubElementVos};};const req=Object.assign((key:string)=>{throw Error(`uncached ${key}`)},{m:{[id]:function(){const formatOption='';const cacheStrategy='';const fetchFrontEndEncryptError='';},'913':function(){const x='/api/music/wiki/home/song/desktop/get';const wikiSubElementVos:any[]=[];}},c:{[id]:{exports:{renamed:factory}},'913':{exports:{different:wiki}}}});return {req,options};}
test('discover by source and unique cached export after module IDs change',async()=>{for(const id of ['312','944']){const c=client(id);const report=discoverClient(c.req);assert.equal(report.supported,true);await report.read!(paths.account,{});assert.equal(c.options[0].skipLocalRpcCache,true);assert.equal(c.options[0].cacheStrategy.enable,false);assert.deepEqual(await report.desktopWiki!('1'),{metas:[]});}});
test('ambiguous candidates fail closed',()=>{const c=client();c.req.c['312'].exports={a:c.req.c['312'].exports.renamed,b:()=>{}} as any;assert.equal(discoverClient(c.req).supported,false);});
test('wiki incompatible response rejects safely',async()=>{const c=client();c.req.c['913'].exports.different=async()=>{const wikiSubElementVos:any[]=[];return {wrong:wikiSubElementVos} as any};const report=discoverClient(c.req);assert.equal(report.supported,true);await assert.rejects(()=>report.desktopWiki!('1'));});
test('read whitelist rejects writes and business mismatch',async()=>{let calls=0;const read=createReadApi((_path:string)=>async()=>{calls++;return {code:200};});await assert.rejects(()=>read('/api/playlist/tracks' as any,{}));assert.equal(calls,0);await assert.rejects(()=>createReadApi(()=>async()=>({wrong:true}))(paths.account,{}));});
test('retry fake clock uses 2 5 15 seconds and never exceeds two requests', async () => {
  const delays: number[] = [];
  let calls = 0, active = 0, maximum = 0, time = 0;
  const read = createReadApi(() => async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (++calls <= 3) throw { code: 'ECONNRESET', option: { secret: 'DO_NOT_COPY' } };
    return { code: 200, data: { language: '国语' } };
  }, {
    now: () => time,
    sleep: async ms => { delays.push(ms); time += ms; },
    pacingSleep: async ms => { time += ms; },
  });
  await read(paths.ugc, {});
  assert.deepEqual(delays, [2000, 5000, 15000]);
  // Fast unpaced reads can still use both backend slots; paced UGC starts need
  // not reach concurrency two when each synthetic backend finishes in 1ms.
  await Promise.all(Array.from({ length: 8 }, () => read(paths.account, {})));
  assert.equal(maximum, 2);
});
for(const code of [301,401,403,429])test(`code ${code} pauses without retry`,async()=>{let calls=0;const read=createReadApi(()=>async()=>{calls++;return {code};},{sleep:async()=>assert.fail('must not retry')});await assert.rejects(()=>read(paths.account,{}),ReadError);assert.equal(calls,1);});

test('original wiki and API share the same two backend slots',async()=>{let active=0,max=0;const c=client();const delay=async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,1));active--;};c.req.c['312'].exports.renamed=()=>async()=>{await delay();return {code:200,profile:{userId:7}}};c.req.c['913'].exports.different=async()=>{const wikiSubElementVos:any[]=[];await delay();return {metas:wikiSubElementVos};};const report=discoverClient(c.req);await Promise.all(Array.from({length:12},(_,i)=>i%2?report.read!(paths.account,{}):report.desktopWiki!('1')));assert.equal(max,2);});
test('network retry exhaustion is sanitized and finite',async()=>{let calls=0;const read=createReadApi(()=>async()=>{calls++;throw {message:'SECRET',option:{body:'SECRET'}}},{sleep:async()=>{}});await assert.rejects(()=>read(paths.account,{}),(e:any)=>{assert.equal(e.kind,'network');assert.equal(JSON.stringify(e).includes('SECRET'),false);assert.equal(e.message.includes('SECRET'),false);return true;});assert.equal(calls,4);});
test('aborted retry never issues another request',async()=>{const abort=new AbortController();let calls=0;const read=createReadApi(()=>async()=>{calls++;throw Error('network')},{signal:abort.signal,sleep:async()=>{abort.abort()}});await assert.rejects(()=>read(paths.account,{}));assert.equal(calls,1);});
test('standard webpack live export getters retain capability discovery',()=>{const c=client();const request=c.req.c['312'].exports.renamed,wiki=c.req.c['913'].exports.different;const liveRequest={},liveWiki={};Object.defineProperty(liveRequest,'changed',{enumerable:true,get(){return request}});Object.defineProperty(liveWiki,'changed',{enumerable:true,get(){return wiki}});c.req.c['312'].exports=liveRequest as any;c.req.c['913'].exports=liveWiki as any;assert.equal(discoverClient(c.req).supported,true);});

test('operation abort before network failure handling suppresses retries', async () => {
  const abort = new AbortController();
  let calls = 0;
  const read = createReadApi(() => async () => {
    calls++;
    if (calls > 1) return {code: 200};
    abort.abort();
    throw new Error('network');
  }, {sleep: async () => assert.fail('aborted operation must not wait for retry')});
  await assert.rejects(() => read(paths.ugc, {}, abort.signal), (error: any) => error.kind === 'paused');
  assert.equal(calls, 1);
  assert.equal((await read(paths.account, {}) as any).code, 200);
});

test('aborted queued operation does not issue backend request and frees its slot', async () => {
  const releases: (() => void)[] = [];
  let calls = 0;
  const read = createReadApi(() => async () => {
    calls++;
    if (calls <= 2) await new Promise<void>(resolve => releases.push(resolve));
    return {code: 200};
  });
  const first = read(paths.account, {}), second = read(paths.account, {});
  while (releases.length < 2) await new Promise(resolve => setImmediate(resolve));
  const abort = new AbortController();
  const queued = assert.rejects(() => read(paths.ugc, {}, abort.signal));
  const unrelated = read(paths.account, {});
  abort.abort();
  releases.forEach(release => release());
  await Promise.all([first, second, queued, unrelated]);
  assert.equal(calls, 3);
  assert.equal((await read(paths.account, {}) as any).code, 200);
});


test('split API path factory and unique lexical live wiki helper remain discoverable', async () => {
  const c=client();
  c.req.m['913']=function(){const endpoint='/api/music/wiki/home/song/desktop/get';};
  const wiki=async(id:string)=>{const wikiSubElementVos:any[]=[];return {metas:wikiSubElementVos};};
  const live={};Object.defineProperty(live,'renamed',{enumerable:true,get(){return wiki;}});
  (c.req.m as any)['new-helper']=function(){const wikiSubElementVos:any[]=[];};
  (c.req.c as any)['new-helper']={exports:live};
  c.req.c['913'].exports={} as any;
  const report=discoverClient(c.req);
  assert.equal(report.supported,true);
  assert.deepEqual(await report.desktopWiki!('1'),{metas:[]});
  delete (c.req.m as Record<string,Function>)['913'];assert.equal(discoverClient(c.req).supported,false,'path presence is required');
});
test('split helper ambiguity fails closed without invoking getters for environment data',()=>{
  const c=client();c.req.m['913']=function(){const path='/api/music/wiki/home/song/desktop/get';};
  const helper=async(_id:string)=>{const wikiSubElementVos:any[]=[];return {metas:wikiSubElementVos};};
  (c.req.m as any)['helper']=function(){const wikiSubElementVos:any[]=[];};
  let touched=0;const env={get environment(){touched++;return {secret:'NO'};}};
  (c.req.c as any)['helper']={exports:{a:helper,b:async(_id:string)=>{const wikiSubElementVos:any[]=[];return {metas:wikiSubElementVos};},env}};
  assert.equal(discoverClient(c.req).supported,false);assert.equal(touched,0);
});

test('actual capture path supports sparse webpack array factories and rejects invalid containers',async()=>{
  const original=(globalThis as any).webpackJsonp;
  try {
    const c=client();const record=c.req.m;
    const factories:Function[]=[];factories[7]=record['312'];factories[42]=record['913'];
    const req=Object.assign((key:string)=>{throw Error(`unexpected uncached ${key}`);},{m:factories,c:{'7':c.req.c['312'],'42':c.req.c['913']}});
    const surface=(captured:any)=>({push(entry:any){for(const factory of Object.values(entry[1]) as Function[])factory({}, {}, captured);}});
    (globalThis as any).webpackJsonp=surface(Object.assign(()=>{}, {m:[null]}));
    assert.equal(discoverClient().supported,false,'non-function factory entries must stop capture');
    (globalThis as any).webpackJsonp=surface(req);
    const report=discoverClient();assert.equal(report.supported,true);
    assert.deepEqual(await report.desktopWiki!('1'),{metas:[]});
    assert.equal((await report.read!(paths.account,{}) as any).code,200);
  } finally {(globalThis as any).webpackJsonp=original;}
});

function pacingClock() {
  let time = 0;
  const waits: { due: number; resolve: () => void }[] = [];
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    now: () => time,
    sleep: (ms: number) => new Promise<void>(resolve => { waits.push({ due: time + ms, resolve }); }),
    async advance(ms: number) {
      time += ms;
      for (const wait of waits.filter(wait => wait.due <= time)) {
        waits.splice(waits.indexOf(wait), 1);
        wait.resolve();
      }
      await flush();
    }, flush,
  };
}

test('two simultaneous UGC backend starts are separated by default 750ms', async () => {
  const clock = pacingClock();
  const starts: number[] = [];
  const read = createReadApi(() => async () => { starts.push(clock.now()); return { code: 200 }; },
    { now: clock.now, pacingSleep: clock.sleep } as any);
  const first = read(paths.ugc, {}), second = read(paths.ugc, {});
  await first;
  await clock.flush();
  assert.deepEqual(starts, [0]);
  await clock.advance(749);
  assert.deepEqual(starts, [0]);
  await clock.advance(1);
  await second;
  assert.deepEqual(starts, [0, 750]);
});

test('aborted paced UGC never starts and account reads do not wait behind pacing', async () => {
  const clock = pacingClock();
  const starts: string[] = [];
  const read = createReadApi(path => async () => { starts.push(path); return { code: 200 }; },
    { now: clock.now, pacingSleep: clock.sleep } as any);
  await read(paths.ugc, {});
  const abort = new AbortController();
  let rejection: any;
  const cancelled = read(paths.ugc, {}, abort.signal).catch(error => { rejection = error; });
  await clock.flush();
  await read(paths.account, {});
  assert.deepEqual(starts, [paths.ugc, paths.account]);
  abort.abort();
  await cancelled;
  assert.equal(rejection?.kind, 'paused');
  await clock.advance(750);
  assert.deepEqual(starts, [paths.ugc, paths.account]);
});

test('every UGC retry observes spacing and retains exactly three 2 5 15 second backoffs', async () => {
  const clock = pacingClock();
  const starts: number[] = [], delays: number[] = [];
  const read = createReadApi(() => async () => { starts.push(clock.now()); throw Error('synthetic network'); },
    { now: clock.now, pacingSleep: clock.sleep, sleep: async (ms: number) => { delays.push(ms); } } as any);
  const failed = assert.rejects(() => read(paths.ugc, {}), (e: any) => e.kind === 'network');
  await clock.flush();
  assert.deepEqual(starts, [0]);
  for (let attempt = 0; attempt < 3; attempt++) await clock.advance(750);
  await failed;
  assert.deepEqual(starts, [0, 750, 1500, 2250]);
  assert.deepEqual(delays, [2000, 5000, 15000]);
});

test('pacing releases shared slots to wiki and library while backend concurrency stays at two', async () => {
  const clock = pacingClock();
  const executor = new (await import('../panel/client/requests')).ReadExecutor({ now: clock.now, pacingSleep: clock.sleep } as any);
  const starts: { kind: string; time: number }[] = [];
  const releases: (() => void)[] = [];
  let active = 0, maximum = 0;
  const backend = async (kind: string) => {
    starts.push({ kind, time: clock.now() }); active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => releases.push(resolve)); active--; return { code: 200 };
  };
  const read = createReadApi(path => () => backend(path), {}, executor);
  const first = read(paths.ugc, {}), second = read(paths.ugc, {});
  await clock.flush();
  const wiki = executor.run(() => backend('wiki'));
  await clock.flush();
  assert.deepEqual(starts.map(s => s.kind), [paths.ugc, 'wiki']);
  releases.shift()!(); await first;
  const library = read(paths.playlist, {});
  await clock.flush();
  assert.deepEqual(starts.map(s => s.kind), [paths.ugc, 'wiki', paths.playlist]);
  await clock.advance(750);
  assert.equal(starts.length, 3);
  releases.shift()!(); await wiki;
  await clock.flush();
  assert.deepEqual(starts[3], { kind: paths.ugc, time: 750 });
  assert.equal(maximum, 2);
  releases.splice(0).forEach(release => release());
  await Promise.all([second, library]);
});

test('UGC business 405 remains a single non-retried business pause', async () => {
  const clock = pacingClock(); let calls = 0;
  const read = createReadApi(() => async () => { calls++; return { code: 405 }; },
    { now: clock.now, pacingSleep: clock.sleep, sleep: async () => assert.fail('business 405 must not retry') } as any);
  await assert.rejects(() => read(paths.ugc, {}), (e: any) => e.kind === 'business' && e.code === 405);
  assert.equal(calls, 1);
});

test('read-only discovery exposes no write closure while product discovery retains guarded writes',async()=>{
  const {discoverReadClient}=await import('../panel/client/read-capabilities');
  const c=client();const read=discoverReadClient(c.req);assert.equal(read.supported,true);assert.equal(read.write,undefined);
  assert.equal((await read.read!(paths.account,{}) as any).code,200);
  const product=discoverClient(c.req);assert.equal(typeof product.write,'function');
});
