import type { Progress } from '../core/model';
export type ScanMetrics={elapsedMs:number;ratePerMinute:number|null;remainingMs:number|null;estimating:boolean};
/** Active monotonic time, independent of browser timer frequency and cached prefixes. */
export class ScanProgressMeter {
 private last=0;private accumulated=0;private since:number|null=null;private started=false;private done=false;
 private samples:{at:number;processed:number}[]=[];private latest:Progress|null=null;private lastAdvance=0;
 private time(at:number):number{if(Number.isFinite(at))this.last=Math.max(this.last,at);return this.last;}
 start(at:number):void{this.reset();const t=this.time(at);this.started=true;this.since=t;}
 reset():void{this.last=0;this.accumulated=0;this.since=null;this.started=false;this.done=false;this.samples=[];this.latest=null;this.lastAdvance=0;}
 pause(at:number):void{const t=this.time(at);if(this.since!==null){this.accumulated+=t-this.since;this.since=null;}this.samples=[];}
 resume(at:number):void{const t=this.time(at);if(!this.started){this.started=true;}if(this.since===null&&!this.done){this.since=t;this.samples=[];}}
 observe(p:Progress,at:number):void{
  const t=this.time(at);this.latest={...p};
  if(p.phase==='complete'){this.pause(t);this.done=true;return;}
  if(p.phase==='reading')return;
  if(p.phase!=='scanning'){this.pause(t);return;}
  this.resume(t);const active=this.elapsed(t),last=this.samples[this.samples.length-1];
  if(!last||p.processed>last.processed)this.lastAdvance=active;
  this.samples.push({at:active,processed:p.processed});
  while(this.samples.length>1&&this.samples[0].at<active-60000)this.samples.shift();
 }
 private elapsed(t:number):number{return this.accumulated+(this.since===null?0:t-this.since);}
 snapshot(at:number):ScanMetrics{
  const elapsedMs=this.elapsed(this.time(at));let ratePerMinute:number|null=null,remainingMs:number|null=null;
  if(this.done)remainingMs=0;
  else if(this.since!==null&&this.latest&&elapsedMs-this.lastAdvance<60000){
   const first=this.samples.find(s=>s.at>=elapsedMs-60000),last=this.samples[this.samples.length-1];
   if(first&&last&&last.at-first.at>=10000&&last.processed-first.processed>=5&&this.latest.total>this.latest.processed){
    ratePerMinute=(last.processed-first.processed)/(last.at-first.at)*60000;
    remainingMs=(this.latest.total-this.latest.processed)/ratePerMinute*60000;
   }
  }
  return {elapsedMs,ratePerMinute,remainingMs,estimating:!this.done&&ratePerMinute===null};
 }
}
