import test from 'node:test';import assert from 'node:assert/strict';
import {createPlaylistNavigator} from '../panel/ui/navigation';
function fixture(options:{uncached?:boolean;duplicate?:boolean;uninitialized?:boolean;throwing?:boolean;blocked?:boolean}={}){
 const paths:string[]=[];let captures=0,executed=0;
 const factory=function(){const marker='dva-tool getHistory getDispatch';return marker;};
 const history={location:{pathname:'/'},push:(path:string)=>{if(options.throwing)throw Error('RAW_PRIVATE');if(options.blocked)return;history.location={pathname:path};paths.push(path);}};
 const req=Object.assign((_id:string)=>{executed++;throw Error('uncached execution');},{m:{'12':factory,...(options.duplicate?{'13':factory}:{})},c:{...(!options.uncached?{'12':{exports:{a:{inited:!options.uninitialized,history}}}}:{}),...(options.duplicate?{'13':{exports:{a:{inited:true,history:{push:(path:string)=>paths.push(path)}}}}}:{})}});
 const scope={webpackJsonp:{push(entry:any){captures++;for(const fn of Object.values(entry[1]) as Function[])fn({}, {}, req);}}};
 const doc={location:{href:'orpheus://orpheus/app.html'}} as Document;
 return {paths,doc,scope,counts:()=>({captures,executed})};
}
test('navigation is lazy, uses verified memory route once clicked and never executes uncached factories',()=>{const f=fixture(),open=createPlaylistNavigator(f.doc,f.scope);assert.deepEqual(f.counts(),{captures:0,executed:0});assert.equal(open('123456'),true);assert.deepEqual(f.paths,['/playlist/123456']);assert.equal(open('123456'),true);assert.deepEqual(f.paths,['/playlist/123456']);assert.equal(open('9'),true);assert.equal(f.counts().captures,1);assert.equal(f.counts().executed,0);});
for(const options of [{uncached:true},{duplicate:true},{uninitialized:true},{throwing:true},{blocked:true}])test(`unavailable/ambiguous navigation fails safely ${JSON.stringify(options)}`,()=>{const f=fixture(options);assert.equal(createPlaylistNavigator(f.doc,f.scope)('10'),false);assert.deepEqual(f.paths,[]);assert.equal(f.counts().executed,0);});
test('unsafe target IDs and noncanonical host never discover or navigate',()=>{const f=fixture();for(const id of ['', '0','../2','1?x=2','javascript:alert(1)','<img onerror=x>','9'.repeat(100)])assert.equal(createPlaylistNavigator(f.doc,f.scope)(id),false);assert.equal(createPlaylistNavigator({location:{href:'https://example.invalid/'}} as Document,f.scope)('10'),false);assert.deepEqual(f.counts(),{captures:0,executed:0});assert.deepEqual(f.paths,[]);});

test('cached export accessors are never evaluated while discovering navigation',()=>{const paths:string[]=[];let touched=0;const exports={};Object.defineProperty(exports,'a',{get(){touched++;throw Error('private getter');}});const req=Object.assign(()=>{throw Error('factory must not execute');},{m:{'1':function(){return 'dva-tool getHistory getDispatch';}},c:{'1':{exports}}});const scope={webpackJsonp:{push(entry:any){for(const fn of Object.values(entry[1]) as Function[])fn({}, {},req);}}};assert.equal(createPlaylistNavigator({location:{href:'orpheus://orpheus/app.html'}} as Document,scope)('10'),false);assert.equal(touched,0);assert.deepEqual(paths,[]);});
