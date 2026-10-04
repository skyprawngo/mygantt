const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
test('status help requires a label click or 3 seconds hovering and cancels on exit or slider use',()=>{
 class Node extends EventTarget {
  constructor(kind){super();this.kind=kind;this.style={};this.dataset={hoverHelp:'help'};this.isConnected=true;this.offsetWidth=100;this.offsetHeight=40;}
  closest(selector){if(selector==='.status-help-trigger')return this.kind==='label'?this:null;return this.kind==='cell'||this.parent===cell?cell:null;}
  matches(s){return this.kind==='cell'&&s==='.task-status-help';}
  contains(n){return n===this||n?.parent===this;}
  querySelector(){return null;} setAttribute(){} replaceChildren(){} append(){}
  showPopover(){this.open=true;} hidePopover(){this.open=false;}
  getBoundingClientRect(){return {left:20,top:20,bottom:60};}
 }
 const cell=new Node('cell'),label=new Node('label'),knob=new Node('knob'),overlay=new Node('overlay');label.parent=cell;knob.parent=cell;
 const document=new EventTarget();document.body={append(){}};document.createElement=()=>overlay;
 let next=0;const timers=new Map();
 const c={document,Element:Node,window:new EventTarget(),innerWidth:500,innerHeight:800,setTimeout:(fn,ms)=>{timers.set(++next,{fn,ms});return next;},clearTimeout:id=>timers.delete(id)};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function bindFloatingHelp('),source.indexOf('function bindCascadeHelp(')),c);c.bindFloatingHelp();
 const fire=(type,target,relatedTarget=null)=>{const e=new Event(type);Object.defineProperties(e,{target:{value:target},relatedTarget:{value:relatedTarget},pointerType:{value:'mouse'},buttons:{value:0}});document.dispatchEvent(e);};
 fire('pointerover',cell);assert.equal(overlay.open,undefined);assert.equal([...timers.values()][0].ms,3000);
 fire('pointerover',knob,cell);assert.equal(timers.size,1);
 fire('pointerout',cell);assert.equal(timers.size,0);
 fire('focusin',knob);assert.equal(overlay.open,false);
 fire('click',label);assert.equal(overlay.open,true);
 fire('pointerdown',knob);assert.equal(overlay.open,false);
 fire('pointerover',cell);[...timers.values()][0].fn();assert.equal(overlay.open,true);assert.equal(timers.size,0);
});
test('all info icons use delayed hover and immediate click, including dynamically rendered forms',()=>{
 class Node extends EventTarget {
  constructor(kind){super();this.kind=kind;this.style={};this.isConnected=true;this.offsetWidth=100;this.offsetHeight=40;this.dataset={};}
  closest(selector){if(selector==='.status-help-trigger')return null;return this.kind==='info'?this:this.parent||null;}
  matches(s){return this.kind==='info'&&s==='.info-tip';}
  contains(n){return n===this||n?.parent===this;}
  querySelector(){return {childNodes:[{cloneNode:()=>({textContent:'description'})}]};}
  setAttribute(){} replaceChildren(){} append(){}
  showPopover(){this.open=true;} hidePopover(){this.open=false;}
  getBoundingClientRect(){return {left:20,top:20,bottom:60};}
 }
 const overlay=new Node('overlay'),document=new EventTarget();document.body={append(){}};document.createElement=()=>overlay;
 const timers=new Map();let next=0;
 const c={document,Element:Node,window:new EventTarget(),innerWidth:500,innerHeight:800,setTimeout:(fn,ms)=>{timers.set(++next,{fn,ms});return next},clearTimeout:id=>timers.delete(id)};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function bindFloatingHelp('),source.indexOf('function bindCascadeHelp(')),c);c.bindFloatingHelp();
 const fire=(type,target,relatedTarget=null)=>{const e=new Event(type);Object.defineProperties(e,{target:{value:target},relatedTarget:{value:relatedTarget},pointerType:{value:'mouse'},buttons:{value:0}});document.dispatchEvent(e)};
 for(const name of ['page','chart','schedule','relations','form']){
   const info=new Node('info'),button=new Node(name);button.parent=info;
   fire('focusin',button);assert(!overlay.open);
   fire('pointerover',button);assert(!overlay.open);assert.equal([...timers.values()][0].ms,3000);
   fire('pointerout',button);assert.equal(timers.size,0);
   fire('pointerover',button);[...timers.values()][0].fn();assert(overlay.open);
   fire('pointerout',button);assert(!overlay.open);
   fire('pointerover',button);fire('click',button);assert(overlay.open);assert.equal(timers.size,0);
   fire('click',new Node('outside'));assert(!overlay.open);
 }
});
