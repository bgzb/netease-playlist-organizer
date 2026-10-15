import test from 'node:test';import assert from 'node:assert/strict';
import * as filters from '../panel/ui/filters';import {PanelModel} from '../panel/ui/panel';
import {snapshot} from './fixtures/read';import {makeSong} from './fixtures/synthetic';import {testDocument,walk} from './fixtures/dom';
const api=filters as any;
function loaded(){const m=new PanelModel(),s=snapshot(203);s.songs=s.songs.map((song,i)=>({...makeSong(song.id,{genres:[`曲风${String(i+1).padStart(4,'0')}`]}),position:i,artists:{status:'known',source:'songDetail',value:[{id:String(1001+i),name:`歌手${String(i+1).padStart(4,'0')}`}]}}));m.setLibrary(s);m.setProgress({phase:'complete',processed:203,total:203},true);m.setFilters({...m.state.filters,bpmMin:80});return m;}
test('candidate cache survives selection edits and invalidates same-array metadata publication/account changes',()=>{
 assert.equal(typeof api.FilterCandidateCache,'function');const cache=new api.FilterCandidateCache(),m=loaded();let reads=0;const field=m.state.snapshot!.songs[0].genres;Object.defineProperty(field,'value',{get:()=>{reads++;return ['更新标签'];},configurable:true});
 const first=cache.get(m,'genres');assert.equal(first.length,203);const count=reads;assert.ok(count>0);assert.ok(cache.get(m,'genres')===first);assert.equal(reads,count);
 m.setFilters({...m.state.filters,bpmMin:90});reads=0;assert.ok(cache.get(m,'genres')===first);assert.equal(reads,0);
 m.state.snapshot!.songs[1].genres={status:'known',source:'manual',value:['更新标签']};m.setLibrary(m.state.snapshot!);const next=cache.get(m,'genres');assert.equal(next.find((c:any)=>c.id==='更新标签').count,2);assert.notEqual(next,first);m.setAccount('9');assert.deepEqual(cache.get(m,'genres'),[]);
});
test('203 candidates render 50 per group; pages/search/selected options preserve full filter semantics',()=>{
 assert.equal(typeof api.FilterCandidateCache,'function');const cache=new api.FilterCandidateCache(),m=loaded(),{doc}=testDocument(),pages={},searches={};
 const draw=()=>doc.body.replaceChildren(api.renderFilters(doc,m,{cache,pages,searches,changed:draw}));draw();
 const group=()=>walk(doc.body).find(n=>n.dataset.dimension==='artists')!;const rows=()=>walk(group()).filter(n=>n.tagName==='input'&&n.type==='checkbox');const a=(key:string)=>{const n=walk(doc.body).find(n=>n.dataset.key===key)!;assert.ok(n,key);return n;};
 assert.equal(rows().length,50);a('candidates-artists-next').focus();a('candidates-artists-next').onclick!();assert.equal(rows()[0].dataset.key,'choice-artistIds-1051');assert.equal(doc.activeElement,a('candidates-artists-next'));
 rows()[0].checked=true;rows()[0].onchange!();assert.deepEqual(m.preview().ids,['51']);assert.equal(rows()[0].checked,true);
 const input=a('search-artistIds');input.value='歌手0203';input.oninput!();assert.equal(rows().length,2);assert.ok(rows().some(n=>n.dataset.key==='choice-artistIds-1051'&&n.checked));const last=a('choice-artistIds-1203');last.checked=true;last.onchange!();assert.deepEqual(m.preview().ids,['51','203']);
 const search=a('search-artistIds');search.value='';search.oninput!();for(let i=0;i<4;i++)a('candidates-artists-next').onclick!();assert.equal(rows().length,3);assert.equal(a('choice-artistIds-1203').checked,true);
 const details=group();(details as any).open=false;(details as any).ontoggle();assert.equal(rows().length,0);(details as any).open=true;(details as any).ontoggle();assert.equal(rows().length,3);
});
