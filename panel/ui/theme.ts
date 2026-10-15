export type AmbientTheme={rgb:[number,number,number];source:'client'|'fallback'};
const fallback=():AmbientTheme=>({rgb:[52,52,63],source:'fallback'});
function color(raw:string):[number,number,number]|null{
 let values:number[];
 if(/^#[\da-f]{6}$/i.test(raw))values=[1,3,5].map(i=>parseInt(raw.slice(i,i+2),16));
 else if(/^#[\da-f]{3}$/i.test(raw))values=[1,2,3].map(i=>parseInt(raw[i]+raw[i],16));
 else {const m=raw.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);if(!m||m[4]!==undefined&&Number(m[4])<0.15)return null;values=m.slice(1,4).map(Number);}
 if(values.some(n=>!Number.isFinite(n)||n<0||n>255))return null;
 const hi=Math.max(...values),lo=Math.min(...values);if(hi-lo<14||hi>235&&lo>185||hi<28)return null;
 // Bound both brightness and saturation; only numeric channels cross into CSS.
 const scale=Math.min(1,125/hi);const rgb=values.map(v=>Math.round(v*scale));const low=Math.min(...rgb);
 return rgb.map(v=>Math.round(low+(v-low)*0.78)) as [number,number,number];
}
export function resolveAmbientTheme(doc:Document):AmbientTheme{
 try{
  const win=doc.defaultView;if(!win?.getComputedStyle||!doc.elementFromPoint)return fallback();
  for(const [x,y] of [[Math.floor(win.innerWidth*0.45),90],[Math.floor(win.innerWidth*0.75),160]]){
   let el=doc.elementFromPoint(x,y);
   for(let depth=0;el&&depth<6;depth++,el=el.parentElement){
    if(el.id==='ncm-organizer-v1-root'||(el.getRootNode?.() as ShadowRoot|undefined)?.host?.id==='ncm-organizer-v1-root')continue;
    const style=win.getComputedStyle(el),image=style.backgroundImage??'';
    if(image.includes('url('))continue;
    const candidates=image.startsWith('linear-gradient(')?image.match(/rgba?\([^)]*\)|#[\da-f]{3,8}\b/gi)??[]:[];
    for(const raw of [...candidates,style.backgroundColor]){const rgb=color(raw??'');if(rgb)return {rgb,source:'client'};}
   }
  }
 }catch{/* Host DOM and computed styles are optional. */}
 return fallback();
}
export function applyAmbientTheme(host:HTMLElement,theme:AmbientTheme):void{host.style.setProperty('--ambient',theme.rgb.join(', '));}
