import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({options: {'source-root': {type: 'string', default: '.'},
  'delay-ms': {type: 'string', default: '1'}}});
const delay = Number(values['delay-ms']);
if (!Number.isFinite(delay) || delay < 1 || delay > 100) throw new Error('delay-ms must be between 1 and 100');
const source = resolve(values['source-root']);
await mkdir('work/scan-benchmark', {recursive: true});
const temporary = await mkdtemp(resolve('work/scan-benchmark/run-'));
try {
  const entry = `import {runScanBenchmark} from ${JSON.stringify(resolve('tests/fixtures/scan-benchmark.ts'))};
    import {createScanner} from ${JSON.stringify(join(source, 'panel/scan/scan.ts'))};
    import {LocalStore} from ${JSON.stringify(join(source, 'panel/scan/store.ts'))};
    import {createLibraryReader} from ${JSON.stringify(join(source, 'panel/client/library.ts'))};
    export const run = () => runScanBenchmark({createScanner, LocalStore, createLibraryReader}, 1419, ${delay});`;
  const outfile = join(temporary, 'benchmark.mjs');
  await build({stdin: {contents: entry, resolveDir: process.cwd()}, outfile, bundle: true,
    platform: 'node', format: 'esm', target: 'node24', sourcemap: false});
  const { run } = await import(pathToFileURL(outfile).href);
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await run());
  const median = values => [...values].sort((a, b) => a - b)[1];
  console.log(JSON.stringify({schemaVersion: 1, syntheticSongs: 1419, fixedDependencyDelayMs: delay,
    runs, medianTotalMs: median(runs.map(run => run.totalMs)),
    medianStages: Object.fromEntries(Object.keys(runs[0].stages).map(key =>
      [key, median(runs.map(run => run.stages[key]))]))}, null, 2));
} catch {
  // Never serialize an exception carrying fixture or request contents.
  process.stderr.write('Synthetic scan benchmark failed; aggregate output withheld.\n');
  process.exitCode = 1;
} finally { await rm(temporary, {recursive: true, force: true}); }
