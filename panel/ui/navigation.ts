/** UI navigation for Mac 3.1.1/build3019. No request factory or uninitialized module is executed. */
type MemoryHistory={push(path:string):unknown};
function own(value:unknown,key:string):unknown {
 if((typeof value!=='object'||value===null)&&typeof value!=='function')return undefined;
 const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value' in descriptor?descriptor.value:undefined;
}
export function validPlaylistId(id:unknown):id is string{return typeof id==='string'&&/^[1-9]\d{0,19}$/.test(id);}
export function createPlaylistNavigator(doc:Document,scope:unknown=globalThis):(id:string)=>boolean {
 let captured:unknown;
 return id=>{
  try {
   if(!validPlaylistId(id)||doc.location?.href!=='orpheus://orpheus/app.html')return false;
   if(!captured){
    const surface=own(scope,'webpackJsonp'),push=own(surface,'push');if(typeof push!=='function')return false;
    const key=`ncm_organizer_navigation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    push.call(surface,[[key],{[key]:(_module:unknown,_exports:unknown,req:unknown)=>{captured=req;}},[[key]]]);
   }
   const factories=own(captured,'m'),cache=own(captured,'c');if(!factories||!cache)return false;
   const histories=new Set<MemoryHistory>();
   for(const [id,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(factories))){
    const factory='value' in descriptor?descriptor.value:undefined;if(typeof factory!=='function')continue;
    const source=Function.prototype.toString.call(factory);if(!['dva-tool','getHistory','getDispatch'].every(marker=>source.includes(marker)))continue;
    const exported=own(own(cache,id),'exports');if(!exported)continue;
    const values=[exported,...Object.values(Object.getOwnPropertyDescriptors(exported)).flatMap(d=>'value' in d?[d.value]:[])];
    for(const value of values){
     if(own(value,'inited')!==true)continue;const history=own(value,'history');
     if(typeof own(history,'push')==='function')histories.add(history as MemoryHistory);
    }
   }
   if(histories.size!==1)return false;
   // The client registers /playlist/<id> on its in-memory history (not window.hash).
   const history=[...histories][0],path=`/playlist/${id}`,current=own(own(history,'location'),'pathname');
   if(typeof current!=='string')return false;
   if(current===path)return true;
   history.push(path);return own(own(history,'location'),'pathname')===path;
  }catch{return false;}
 };
}
