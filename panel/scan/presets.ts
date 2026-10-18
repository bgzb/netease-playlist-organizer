import type {Filters} from '../core/model';
import {validateFilters} from '../core/filter';
import {id} from '../client/library';
import type {StorageLike} from './store';
export type FilterPreset={id:string;name:string;filters:Filters;artistNames:Record<string,string>;updatedAt:number};
export class PresetError extends Error {}
const prefix='ncm-organizer:presets:v1:';
function name(value:string):string {const text=value.trim();if(!text||text.length>40)throw new PresetError('方案名称需为 1–40 个字符。');return text;}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('shape');return value as Record<string,unknown>;}
function conditions(value:unknown):Filters {
 const f=record(value);const labels=(v:unknown):string[]=>{if(!Array.isArray(v)||v.some(s=>typeof s!=='string'||!s.trim()||s.length>200))throw new Error('labels');return [...new Set(v.map(s=>s.trim()))];};
 if(typeof f.allSongs!=='boolean')throw new Error('allSongs');
 const filters:Filters={genres:labels(f.genres),languages:labels(f.languages),artistIds:labels(f.artistIds).map(id),bpmMin:f.bpmMin as number|null,bpmMax:f.bpmMax as number|null,allSongs:f.allSongs};
 validateFilters(filters);return filters;
}
function preset(value:unknown):FilterPreset {
 const p=record(value);if(typeof p.id!=='string'||!/^[-\w]{1,80}$/.test(p.id)||typeof p.name!=='string'||typeof p.updatedAt!=='number'||!Number.isFinite(p.updatedAt)||p.updatedAt<0)throw new Error('preset');
 const filters=conditions(p.filters),names=record(p.artistNames),artistNames:Record<string,string>={};
 for(const artist of filters.artistIds){if(typeof names[artist]==='string'&&(names[artist] as string).length<=200)artistNames[artist]=names[artist] as string;}
 return {id:p.id,name:name(p.name),filters,artistNames,updatedAt:p.updatedAt};
}
export function listPresets(storage:StorageLike,uid:string):FilterPreset[]{
 try{const account=id(uid),raw=storage.getItem(prefix+account);if(raw===null)return [];const value=record(JSON.parse(raw));if(value.schemaVersion!==1||value.uid!==account||!Array.isArray(value.items)||value.items.length>100)throw new Error('envelope');
 const items=value.items.map(preset);if(new Set(items.map(p=>p.id)).size!==items.length||new Set(items.map(p=>p.name)).size!==items.length)throw new Error('duplicate');return items;
 }catch{throw new PresetError('筛选方案无法读取，原数据已保留。');}
}
function save(storage:StorageLike,uid:string,items:FilterPreset[]):void {try{storage.setItem(prefix+id(uid),JSON.stringify({schemaVersion:1,uid:id(uid),items}));}catch{throw new PresetError('方案保存失败，请检查本地存储后重试。');}}
export function savePreset(storage:StorageLike,uid:string,title:string,filters:Filters,artistNames:Record<string,string>):FilterPreset {
 const items=listPresets(storage,uid),titleText=name(title);if(items.some(p=>p.name===titleText))throw new PresetError('已有同名方案，请使用其他名称。');if(items.length>=100)throw new PresetError('最多保存 100 个方案，请先删除不再使用的方案。');
 let presetId=`preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;while(items.some(p=>p.id===presetId))presetId+='x';
 let next:FilterPreset;try{next=preset({id:presetId,name:titleText,filters,artistNames,updatedAt:Date.now()});}catch{throw new PresetError('请先设置有效的筛选条件或明确选择全部歌曲，再保存方案。');}
 save(storage,uid,[next,...items]);return next;
}
export function renamePreset(storage:StorageLike,uid:string,presetId:string,title:string):void {
 const items=listPresets(storage,uid),current=items.find(p=>p.id===presetId),titleText=name(title);if(!current)throw new PresetError('方案已不存在，请重新选择。');if(items.some(p=>p.id!==presetId&&p.name===titleText))throw new PresetError('已有同名方案，请使用其他名称。');
 current.name=titleText;current.updatedAt=Date.now();save(storage,uid,items);
}
export function deletePreset(storage:StorageLike,uid:string,presetId:string):void {const items=listPresets(storage,uid);if(!items.some(p=>p.id===presetId))throw new PresetError('方案已不存在，请重新选择。');save(storage,uid,items.filter(p=>p.id!==presetId));}
