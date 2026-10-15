import type {CapabilityReport} from '../core/model';
import {createReadApi,object,ReadError,ReadExecutor,type RequestFactory} from './requests';
export const ADAPTER_VERSION='ncm-mac-3019-v1';
export type WebpackRequire=((id:string)=>unknown)&{m:Record<string,Function>|Function[];c?:Record<string,{exports:unknown}>};
type WebpackSurface={push:(entry:unknown)=>unknown};
function factoryTable(value:unknown):value is WebpackRequire['m'] {
  if(!Array.isArray(value)&&!object(value))return false;
  return Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key,descriptor])=>
    Array.isArray(value)&&key==='length'||('value' in descriptor&&typeof descriptor.value==='function'));
}
let pageRequire:WebpackRequire|undefined;
let pageParts:{report:CapabilityReport;factory:RequestFactory|null}|undefined;
function captureRequire():WebpackRequire {
  if(pageRequire)return pageRequire;
  const surface=(globalThis as unknown as {webpackJsonp?:WebpackSurface}).webpackJsonp;
  if(!surface||typeof surface.push!=='function')throw new ReadError('structure');
  const unique=`ncm_organizer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let captured:WebpackRequire|undefined;
  surface.push([[unique],{[unique]:(_module:unknown,_exports:unknown,req:WebpackRequire)=>{captured=req;}},[[unique]]]);
  if(typeof captured!=='function'||!factoryTable(captured.m)||(captured.c!==undefined&&!object(captured.c)))throw new ReadError('structure');
  pageRequire=captured;return captured;
}
function functions(value:unknown,seen=new Set<unknown>(),depth=0):Function[] {
  if(seen.has(value)||depth>2)return [];seen.add(value);
  if(typeof value==='function')return [value];
  if(!object(value))return [];
  return Object.getOwnPropertyNames(value).flatMap(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor)return [];
    if('value' in descriptor)return functions(descriptor.value,seen,depth+1);
    // Webpack live exports use a getter that only returns a lexical binding.
    // Reject arbitrary accessors; never inspect native environment/config getters.
    if(descriptor.get) {
      const source=Function.prototype.toString.call(descriptor.get);
      const bindingOnly=/\{\s*return\s+[A-Za-z_$][\w$]*\s*;?\s*\}$/.test(source)||/=>\s*[A-Za-z_$][\w$]*\s*$/.test(source);
      if(bindingOnly)return functions(descriptor.get.call(value),seen,depth+1);
    }
    return [];
  });
}
function candidates(req:WebpackRequire,markers:string[],functionMarker?:string):Function[] {
  const found:Function[]=[];
  for(const [id,factory] of Object.entries(req.m)) {
    if(typeof factory!=='function')continue;
    const source=Function.prototype.toString.call(factory);
    if(!markers.every(m=>source.includes(m)))continue;
    const exported=req.c?.[id]?.exports??req(id);
    for(const fn of functions(exported))if(!functionMarker||Function.prototype.toString.call(fn).includes(functionMarker))found.push(fn);
  }
  return [...new Set(found)];
}
export function discoverClientParts(requireOverride?:WebpackRequire):{report:CapabilityReport;factory:RequestFactory|null} {
  if(!requireOverride&&pageParts)return pageParts;
  let report:CapabilityReport;let factory:RequestFactory|null=null;
  try {
    const req=requireOverride??captureRequire();
    if(typeof req!=='function'||!factoryTable(req.m))throw new ReadError('structure');
    const requests=candidates(req,['formatOption','cacheStrategy','fetchFrontEndEncryptError']);
    // The API endpoint and the normalization helper live in separate modules on build 3019.
    // Inspect path presence without executing that API/config factory; resolve only marked helper exports.
    const hasWikiPath=Object.values(req.m).some(factory=>typeof factory==='function'&&Function.prototype.toString.call(factory).includes('/api/music/wiki/home/song/desktop/get'));
    const wiki=hasWikiPath?candidates(req,['wikiSubElementVos'],'wikiSubElementVos'):[];
    if(requests.length!==1||wiki.length!==1)throw new ReadError('structure');
    factory=requests[0] as RequestFactory;
    const executor=new ReadExecutor();
    report={supported:true,adapterVersion:ADAPTER_VERSION,reasons:[],read:createReadApi(factory,{},executor),
      desktopWiki:async(id:string,signal?:AbortSignal)=>executor.run(async()=>{
        const result:unknown=await wiki[0](id);
        if(result===null)return null;
        if(!object(result)||!Array.isArray(result.metas)||result.metas.some(m=>!object(m)||typeof m.title!=='string'||typeof m.content!=='string'))throw new ReadError('structure');
        return {metas:result.metas.map(m=>({title:m.title as string,content:m.content as string}))};
      },signal)};
  }catch {report={supported:false,adapterVersion:ADAPTER_VERSION,reasons:['客户端能力缺失或候选不唯一，已停止读取'],read:null,desktopWiki:null};}
  const parts={report,factory};
  if(!requireOverride&&report.supported)pageParts=parts;
  return parts;
}

/** Read-only discovery: no write closure is constructed or exposed. */
export function discoverReadClient(requireOverride?:WebpackRequire):CapabilityReport {
  return discoverClientParts(requireOverride).report;
}
