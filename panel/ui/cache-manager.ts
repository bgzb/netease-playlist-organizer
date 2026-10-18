import type {PanelController} from './panel';
import {textElement} from './preview';
export function cacheSize(bytes:number):string{return bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1048576).toFixed(2)} MiB`;}
const date=(value:number|null)=>value===null?'暂无':new Date(value).toLocaleString('zh-CN');
export function renderCacheManager(doc:Document,controller:PanelController,close:()=>void):HTMLElement{
 const box=textElement(doc,'section','');box.className='cache-manager';box.setAttribute('aria-label','扫描缓存管理');
 const heading=textElement(doc,'div','');heading.className='cache-manager-heading';heading.append(textElement(doc,'h3','扫描缓存管理'));
 const back=textElement(doc,'button','关闭管理');back.dataset.key='cache-manager-close';back.onclick=close;heading.append(back);box.append(heading);
 const inventory=controller.cacheInventory();box.append(textElement(doc,'p',`本账号 ${inventory.items.length} 份缓存 · 估算占用 ${cacheSize(inventory.items.reduce((sum,row)=>sum+row.byteSize,0))}`),textElement(doc,'small','占用按本地存储文本估算。删除后可重新扫描；筛选方案、写入日志和真实歌单保留。'));
 if(inventory.error){const n=textElement(doc,'p',inventory.error);n.className='notice';box.append(n);}
 if(!inventory.items.length&&!inventory.error)box.append(textElement(doc,'p','暂无扫描缓存。'));
 for(const row of inventory.items){
  const item=textElement(doc,'article','');item.className='cache-row';item.dataset.key=`cache-row-${row.source.id}`;
  const current=controller.model.state.snapshot?.sourcePlaylistId===row.source.id,favorite=controller.model.state.sourceCatalog?.favoritesId===row.source.id;
  item.append(textElement(doc,'strong',`${row.source.name}${favorite?' · 我喜欢':''}${current?' · 当前来源':''}`),textElement(doc,'small',`歌单 ID ${row.source.id} · 约 ${cacheSize(row.byteSize)}`),textElement(doc,'p',row.invalid?'缓存无法读取，可删除后重新扫描。':`${row.phase==='complete'?'扫描完成':'尚未完成'} · ${row.processed}/${row.total} 首`),textElement(doc,'small',`最近保存：${date(row.updatedAt)} · 最近完整扫描：${date(row.lastCompletedAt)}`));
  const remove=textElement(doc,'button','删除该缓存');remove.dataset.key=`cache-delete-${row.source.id}`;remove.disabled=controller.isBusy;
  remove.onclick=()=>{if(!remove.disabled&&doc.defaultView?.confirm?.(`删除“${row.source.name}”的扫描缓存？${current?'当前来源将回到待扫描状态。':''}筛选方案、写入日志和真实歌单会保留。`))void controller.deleteScanCache(row.source.id);};item.append(remove);box.append(item);
 }
 if(controller.managementNotice){const notice=textElement(doc,'p',controller.managementNotice);notice.className='notice';notice.setAttribute('role','status');box.append(notice);}
 return box;
}
