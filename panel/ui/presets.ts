import type {PanelController} from './panel';
import {textElement} from './preview';
type Draft={uid:string|null;id:string;name:string;open:boolean};
const drafts=new WeakMap<PanelController,Draft>();
export function renderPresets(doc:Document,controller:PanelController):HTMLElement{
 const uid=controller.model.state.uid;let draft=drafts.get(controller);
 if(!draft||draft.uid!==uid){draft={uid,id:'',name:'',open:false};drafts.set(controller,draft);}
 const catalog=controller.presetCatalog(),items=catalog.items;if(draft.id&&!items.some(p=>p.id===draft!.id))draft.id='';
 const box=doc.createElement('details');box.className='preset-manager';box.open=draft.open;box.ontoggle=()=>{draft!.open=box.open;};const summary=textElement(doc,'summary',`筛选方案 · ${items.length}`);summary.dataset.key='preset-toggle';const content=textElement(doc,'div','');content.className='preset-body';box.append(summary,content);content.append(textElement(doc,'small','仅保存筛选条件，按账号保存在本机，可跨歌单套用。'));
 const select=doc.createElement('select');select.dataset.key='preset-select';select.setAttribute('aria-label','已保存的筛选方案');
 const empty=textElement(doc,'option','选择已保存的方案');empty.value='';select.append(empty);
 for(const p of items){const option=textElement(doc,'option',p.name);option.value=p.id;select.append(option);}select.value=draft.id;
 const input=doc.createElement('input');input.type='text';input.maxLength=40;input.dataset.key='preset-name';input.placeholder='方案名称';input.setAttribute('aria-label','方案名称');input.value=draft.name;input.oninput=()=>{draft!.name=input.value;};
 const buttons=textElement(doc,'div','');buttons.className='preset-actions';
 const selected=()=>controller.presetCatalog().items.find(p=>p.id===draft!.id);
 const add=(label:string,key:string,fn:()=>unknown,requiresSelection=false)=>{const b=textElement(doc,'button',label);b.dataset.key=key;b.disabled=controller.isBusy||!uid||!!catalog.error||requiresSelection&&!selected();b.onclick=()=>{if(!b.disabled)void fn();};buttons.append(b);return b;};
 add('保存当前条件','preset-save',()=>controller.savePreset(draft!.name));
 const apply=add('套用方案','preset-apply',()=>{
  const p=selected();if(!p)return;
  if((controller.model.state.added.size||controller.model.state.removed.size)&&!doc.defaultView?.confirm?.(`套用“${p.name}”会清除本次人工加入和排除的歌曲，是否继续？`))return;
  controller.applyPreset(p.id);
 },true);
 const rename=add('重命名','preset-rename',()=>{const p=selected();if(p)return controller.renamePreset(p.id,draft!.name);},true);
 const remove=add('删除方案','preset-delete',()=>{const p=selected();if(p&&doc.defaultView?.confirm?.(`删除筛选方案“${p.name}”？不会删除扫描缓存或真实歌单。`))return controller.deletePreset(p.id);},true);
 select.disabled=controller.isBusy||!uid||!!catalog.error;input.disabled=controller.isBusy||!uid||!!catalog.error;
 select.onchange=()=>{draft!.id=select.value;const p=selected();draft!.name=p?.name??'';input.value=draft!.name;for(const b of [apply,rename,remove])b.disabled=controller.isBusy||!p;};
 content.append(select,input,buttons);
 const notice=catalog.error??controller.managementNotice;if(notice){const n=textElement(doc,'p',notice);n.className='notice';n.setAttribute('role','status');content.append(n);}
 return box;
}
