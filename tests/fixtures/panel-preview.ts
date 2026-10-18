/** Browser-only synthetic harness. Never imported by the production entry. */
import {mountOrganizer} from '../../panel/ui/entry';
import {PanelController} from '../../panel/ui/panel';
import {createScanner} from '../../panel/scan/scan';
import {LocalStore} from '../../panel/scan/store';
import {createWriter} from '../../panel/write/writer';
import {ReadError} from '../../panel/client/requests';
import {snapshot,memoryStorage} from './read';
import {makeSong} from './synthetic';
const params=new URLSearchParams(location.search),scenario=params.get('scenario')??'welcome';
// Reproduce Mac 3.1.1's document hotkeys: the retargeted shadow host is not an
// input, so the first Backspace is cancelled; duplicate keydowns are ignored.
if(params.has('host-hotkeys')){
 let previous='';
 const hotkey=(event:KeyboardEvent)=>{
  const signature=[event.type,event.keyCode,event.shiftKey,event.ctrlKey,event.altKey,event.metaKey].join(',');
  if(signature===previous)return;previous=signature;if(event.type!=='keydown')return;
  const target=event.target as HTMLInputElement,tag=target.tagName?.toLowerCase();
  const editing=tag==='textarea'||tag==='input'&&['text','password','email','number','search','tel','url'].includes(target.type);
  if(!editing&&event.key==='Backspace')event.preventDefault();
  if(!editing&&event.key===' '){event.preventDefault();document.getElementById('preview-state')!.textContent='宿主空格快捷键被触发';}
 };
 document.addEventListener('keydown',hotkey);document.addEventListener('keyup',hotkey);
}
const colors:Record<string,string>={brown:'#71473e',green:'#506d3a',teal:'#356959',fallback:'#15151b'};
document.body.style.backgroundColor=colors[params.get('theme')??'brown']??colors.brown;
window.__ncmOrganizerV1?.remove();
const dense=scenario==='candidates';
const count=Number(params.get('count'))||(['filter','scanning','paused','candidates'].includes(scenario)?1419:203),s=snapshot(count);
const names=['春日来信','夜航 · The Night We Remember','海边的风 / Letters from the Coast','无人知晓的漫长告白（特别现场版）','回到夏天','月亮与六便士','沿途的微光'];
s.songs=s.songs.map((song,i)=>({...song,name:`${names[i%names.length]}${i>6?` ${i+1}`:''}`,artists:{value:dense?[{id:String(1000+i),name:`候选歌手${String(i+1).padStart(4,'0')}`}]:[{id:'11',name:'合成歌手 · 雨声'},{id:String(12+i%3),name:['山野来客','白昼旅行家','Echo Collective'][i%3]}],status:'known',source:'songDetail'}}));
let account='7';const storage=memoryStorage();if(scenario==='storage-error')storage.setItem=()=>{throw new Error('synthetic quota');};const store=new LocalStore(storage);
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const meta=(id:string)=>{const {genres,bpm,language}=makeSong(id,{genres:dense?[`候选曲风${id.padStart(4,'0')}`]:Number(id)%11===0?null:[['独立流行','摇滚-日系摇滚','民谣'][Number(id)%3]],bpm:Number(id)%13===0?null:80+Number(id)%70,language:Number(id)%17===0?null:['国语','日语','英语'][Number(id)%3]});return {genres,bpm,language};};
const scanner=createScanner({store,readLibrary:async()=>s,readUid:async()=>account,readMetadata:async id=>{if(scenario==='scanning'||scenario==='paused')await delay(70);return meta(id);}});
const tracks=new Set<string>(),playlists=[{id:8,name:'我喜欢的音乐',specialType:5,privacy:10,creator:{userId:7}},{id:9,name:'沿途收集的声音',specialType:0,privacy:0,subscribed:false,creator:{userId:7}},{id:12,name:'夜晚的独白',specialType:0,privacy:10,subscribed:false,creator:{userId:7}}];
const writes:{path:string;data:Record<string,unknown>}[]=[];
const writer=createWriter({store,read:async(path,data)=>{
 if(path==='/api/w/nuser/account/get')return {code:200,profile:{userId:Number(account)}};
 if(path==='/api/user/playlist')return {code:200,more:false,playlist:playlists};
 if(path==='/api/v6/playlist/detail'){const ids=String(data.id)==='8'?s.ids:[...tracks];return {code:200,playlist:{...playlists.find(p=>String(p.id)===String(data.id)),trackCount:ids.length,trackIds:ids.map(id=>({id:Number(id)}))}};}
 throw new Error('Unexpected synthetic read');
 },write:async(path,data)=>{writes.push({path,data});if(scenario==='writing')await delay(1800);if(path==='/api/playlist/create'){playlists.push({id:10,name:String(data.name),specialType:0,privacy:10,subscribed:false,creator:{userId:7}});if(scenario==='uncertain')throw new ReadError('network');return {code:200,playlist:{id:10}};}for(const id of JSON.parse(String(data.trackIds)))tracks.add(String(id));return {code:200};}});
const controller=new PanelController({listSources:async()=>({uid:'7',favoritesId:'8',created:[],collected:[]}),store,scanner,writer,readLibrary:async()=>{await delay(100);return s;},readUid:async()=>account,readTargets:async()=>playlists.filter(p=>p.specialType===0).map(p=>({id:String(p.id),name:p.name,visibility:p.privacy===10?'private':'public'}))});
mountOrganizer({controller,openPlaylist:id=>{
 if(params.get('navigation')==='unavailable')return false;
 const destination=document.getElementById('preview-destination');if(!destination)return false;
 destination.replaceChildren();const title=document.createElement('h2'),description=document.createElement('p');title.textContent='模拟目标歌单详情';description.textContent=`已打开歌单 ID ${id} · 本地合成导航演示，不连接真实账号`;destination.append(title,description);destination.hidden=false;destination.dataset.playlistId=id;return true;
}});
const root=()=>document.getElementById('ncm-organizer-v1-root')!.shadowRoot!;
function click(key:string){const button=root().querySelector(`[data-key="${key}"]`) as HTMLButtonElement|null;if(!button)throw new Error(`Missing fixture action ${key}`);button.click();}
// Record event→next paint for real synthetic interactions without a flaky pass/fail threshold.
const timings:number[]=[];document.addEventListener('click',()=>{const start=performance.now();requestAnimationFrame(()=>{timings.push(performance.now()-start);const out=document.getElementById('preview-performance');if(out)out.textContent=`响应 ${timings.slice(-5).map(t=>t.toFixed(1)).join(' / ')} ms`;});},true);
const banner=document.getElementById('preview-state')!;
banner.textContent=`合成预览 · ${scenario} · ${count} 首`;
async function init(){
 if(scenario==='welcome')return;
 if(scenario==='paused'){controller.subscribe(()=>{if(controller.model.state.progress.processed>=120&&controller.isBusy&&controller.model.state.progress.phase==='scanning')controller.pause();});void controller.prepareCollection();return;}
 if(scenario==='scanning'){void controller.prepareCollection();return;}
 await controller.prepareCollection();if(scenario==='storage-error')return;
 controller.model.setFilters({...controller.model.state.filters,...(dense?{bpmMin:80}:{genres:['独立流行']})});controller.changed();
 if(scenario==='presets'){await controller.savePreset('日常独立流行');controller.model.setFilters({...controller.model.state.filters,genres:[],languages:['日语'],bpmMin:80,bpmMax:120});await controller.savePreset('日语 · 中速');controller.changed();return;}
 if(scenario==='cache-manager'){
  const extra=snapshot(12,'7','20');extra.source={id:'20',name:'夏日漫游 · 合成歌单',creatorUid:'99'};
  store.saveScan('7','20',{schemaVersion:2,uid:'7',source:extra.source,checkpoint:{snapshot:extra,cache:{},completedIds:extra.ids.slice(0,5),phase:'paused',updatedAt:Date.now()-86400000},lastCompletedAt:null});
  await controller.refreshSources();click('nav-prepare');click('cache-manager-open');return;
 }
 if(scenario==='filter'||dense){if(params.has('detail')){const row=root().querySelector('.song') as HTMLElement;row?.click();}return;}
 if(scenario==='account-changed'){account='9';await controller.checkAccount();return;}
 click('to-write');if(scenario==='target')return;click('target-new');click('write-review');
 if(scenario==='write-review')return;
 if(scenario==='writing'){void controller.confirmWrite();return;}
 if(scenario==='uncertain'||scenario==='result')await controller.confirmWrite();
}
void init().catch(()=>{banner.textContent='合成预览初始化失败，请查看开发日志';});
