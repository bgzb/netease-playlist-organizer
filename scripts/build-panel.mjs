import { build } from 'esbuild';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args[0] === '--test') {
  const entries = args.length > 1 ? args.slice(1) : (await readdir(resolve(root, 'tests')))
    .filter(name => /\.test\.(?:ts|mjs)$/.test(name)).sort().map(name => `tests/${name}`);
  if (entries.length === 0) throw new Error('No test files found');
  const outdir = resolve(root, 'work/test-build');
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const output = await build({ absWorkingDir: root, entryPoints: entries, bundle: true,
    platform: 'node', format: 'esm', target: 'node20', sourcemap: false,
    loader: { '.css': 'text' }, outdir, outbase: 'tests', metafile: true });
  const paths = Object.keys(output.metafile.outputs).filter(path => path.endsWith('.js'))
    .map(path => resolve(root, path));
  const run = spawnSync(process.execPath, ['--test', ...paths], { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
} else {
  if (args.length) throw new Error('Usage: build-panel.mjs [--test [tests/*.test.ts]]');
  await build({ absWorkingDir: root, entryPoints: ['panel/ui/entry.ts'], bundle: true,
    platform: 'browser', format: 'iife', target: 'es2020', sourcemap: false,
    loader: { '.css': 'text' }, outfile: 'work/dist/panel.js' });
}
