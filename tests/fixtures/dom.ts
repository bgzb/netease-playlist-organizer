/** Minimal deterministic DOM for lifecycle tests. Browser fixture separately tests real layout. */
export class TestElement {
 children:TestElement[]=[];parent:TestElement|null=null;hidden=false;dataset:Record<string,string>={};attributes:Record<string,string>={};
 style={setProperty(_k:string,_v:string){}};value='';checked=false;disabled=false;className='';shadowRoot:TestElement|null=null;text='';scrollTop=0;tabIndex=0;type='';selectionStart=0;
 onclick:((e?:any)=>unknown)|null=null;oninput:(()=>void)|null=null;onchange:(()=>void)|null=null;onkeydown:((e:any)=>void)|null=null;
 constructor(public tagName:string,public ownerDocument?:any){}
 get parentElement(){return this.parent;}get id(){return this.attributes.id??'';}set id(v:string){this.attributes.id=v;}
 set textContent(value:string){this.text=value;this.children=[];}get textContent():string{return this.text+this.children.map(c=>c.textContent).join('');}
 set innerHTML(_v:string){throw Error('HTML sink');}
 append(...nodes:TestElement[]){for(const node of nodes){if(node.parent)node.remove();this.children.push(node);node.parent=this;}}
 replaceChildren(...nodes:TestElement[]){for(const n of this.children)n.parent=null;this.children=[];this.text='';this.append(...nodes);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
 setAttribute(k:string,v:string){this.attributes[k]=v;}removeAttribute(k:string){delete this.attributes[k];}
 attachShadow(){this.shadowRoot=new TestElement('shadow',this.ownerDocument);return this.shadowRoot;}
 querySelector(selector:string):TestElement|null{return walk(this).find(n=>selector.startsWith('[data-key=')?n.dataset.key===selector.match(/"([^"]+)"/)?.[1]:selector.startsWith('.')?n.className.split(' ').includes(selector.slice(1)):n.tagName===selector)??null;}
 focus(){if(this.ownerDocument)this.ownerDocument.activeElement=this;}setSelectionRange(start:number){this.selectionStart=start;}
 getBoundingClientRect(){return {top:0,bottom:55,left:0,width:1000,height:600};}
 contains(n:TestElement){return walk(this).includes(n);}getRootNode(){return this;}
}
export const walk=(n:TestElement):TestElement[]=>[n,...n.children.flatMap(walk)];
export function testDocument(){const listeners=new Map<string,Function>();const doc:any={activeElement:null,visibilityState:'visible',createElement:(t:string)=>new TestElement(t,doc),createTextNode:(text:string)=>{const e=new TestElement('#text',doc);e.textContent=text;return e;},querySelector:()=>null,addEventListener:(k:string,v:Function)=>listeners.set(k,v),removeEventListener:(k:string)=>listeners.delete(k)};doc.body=new TestElement('body',doc);doc.documentElement=doc.body;return {doc,listeners};}
