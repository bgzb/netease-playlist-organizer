import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const folder=await mkdtemp(join(tmpdir(),'ncm-panel-preview-'));let server;let closing=false;
async function cleanup(){if(closing)return;closing=true;server?.closeAllConnections();if(server?.listening)await new Promise(r=>server.close(r));await rm(folder,{recursive:true,force:true});}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void cleanup().then(()=>process.exit(0));});
try{
 await build({absWorkingDir:root,entryPoints:['tests/fixtures/panel-preview.ts'],bundle:true,format:'iife',platform:'browser',target:'es2020',loader:{'.css':'text'},outfile:join(folder,'preview.js')});
 const scenarios=['welcome','scanning','paused','storage-error','filter','target','write-review','writing','uncertain','result','account-changed'];
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>歌单整理 · 本地合成预览</title><style>*{box-sizing:border-box}body{margin:0;color:#f4f4f6;font:13px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;min-height:100vh;background-image:linear-gradient(180deg,transparent,#121217 75%)}header{height:64px;display:flex;gap:12px;align-items:center;padding:0 24px;border-bottom:1px solid #ffffff12}header strong{margin-right:12px}header select{background:#1e1e26;color:#eee;border:1px solid #ffffff22;border-radius:5px;padding:5px}footer{position:fixed;bottom:0;height:72px;width:100%;background:#18181ecc;display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-top:1px solid #ffffff12}small{color:#a7a7b0}#preview-performance{font-size:10px;position:fixed;bottom:5px;right:16px;color:#a7a7b0}#preview-state{font-size:11px;color:#ccc}@media(max-width:800px){header{padding:0 16px;gap:6px}header strong{display:none}#preview-state{display:none}footer{padding:12px 16px;font-size:12px}}</style><header><strong>云音乐 · 合成宿主</strong><label>情景 <select id="scenario">${scenarios.map(s=>`<option>${s}</option>`).join('')}</select></label><label>色调 <select id="theme">${['brown','green','teal','fallback'].map(s=>`<option>${s}</option>`).join('')}</select></label><span id="preview-state"></span></header><footer><div>♫ &nbsp; 白昼旅行家 · 合成播放栏<br><small>纯本地合成数据，不连接网易云账号</small></div><span>◀ &nbsp; ▶ &nbsp; ▶▶</span></footer><span id="preview-performance"></span><script>const p=new URLSearchParams(location.search);for(const id of ['scenario','theme']){const el=document.getElementById(id);el.value=p.get(id)||(id==='scenario'?'welcome':'brown');el.onchange=()=>{p.set(id,el.value);location.search=p.toString();};}</script><script src="/preview.js"></script></html>`;
 await writeFile(join(folder,'index.html'),html);
 server=createServer(async(req,res)=>{const url=new URL(req.url??'/','http://127.0.0.1');const file=url.pathname==='/'?'index.html':url.pathname==='/preview.js'?'preview.js':null;if(!file){res.writeHead(404);res.end();return;}try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(await readFile(join(folder,file)));}catch{res.writeHead(500);res.end();}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.PREVIEW_PORT??0),'127.0.0.1',resolve);});
 console.log(`Synthetic panel preview: http://127.0.0.1:${server.address().port}/`);
 console.log('Scenarios: '+scenarios.join(', '));
}catch(error){await cleanup();throw error;}
