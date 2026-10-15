import {discoverReadClient,ADAPTER_VERSION} from '../panel/client/read-capabilities';
import {createLibraryReader} from '../panel/client/library';
import {ReadError} from '../panel/client/requests';

/** No UI, persistence, metadata scan or write API. Only integrity counters leave the page. */
export async function runVerification() {
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timedOut=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
    controller.abort();reject(new ReadError('paused'));
  },40_000);});
  try {
    const report=discoverReadClient();
    if(!report.supported||!report.read)return {supported:false,adapterVersion:ADAPTER_VERSION,status:'unsupported'};
    const read=report.read;
    const snapshot=await Promise.race([createLibraryReader((path,data)=>read(path,data,controller.signal)).readLibrary(),timedOut]);
    return {supported:true,adapterVersion:ADAPTER_VERSION,status:'complete',integrity:{
      declared:snapshot.declaredCount,ids:snapshot.ids.length,
      uniqueIds:new Set(snapshot.ids).size,details:snapshot.songs.length,
      ordered:snapshot.songs.every((song,i)=>song.id===snapshot.ids[i]&&song.position===i),
    }};
  } catch(error) {
    controller.abort();
    return {supported:true,adapterVersion:ADAPTER_VERSION,status:'paused',reason:error instanceof ReadError?error.kind:'structure'};
  } finally {if(timer!==undefined)clearTimeout(timer);}
}
