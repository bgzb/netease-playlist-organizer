import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Smoke runs the actual shipped entry, freshly bundled against synthetic page/API/storage.
const bundle=resolve(root,'work/offline-smoke/panel.js');
await build({absWorkingDir:root,entryPoints:['panel/ui/entry.ts'],bundle:true,platform:'browser',
  format:'iife',target:'es2020',loader:{'.css':'text'},outfile:bundle});
const result=spawnSync(process.execPath,['tests/writer-bundle-smoke.mjs',bundle],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
process.exit(result.status??1);
