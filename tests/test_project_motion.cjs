const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(progress){
 const events=[]; const state={data:{projects:[{id:'p',name:'P',tasks:[{progress}]}]},hiddenProjects:new Set(),collapsedProjects:new Set()};
 const c={matchMedia:()=>({matches:true}),document:{querySelectorAll:()=>[],dispatchEvent:e=>events.push(e)},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}}};vm.createContext(c);vm.runInContext(fs.readFileSync('web/project-motion.js','utf8'),c);
 const motion=c.createProjectMotion({getState:()=>state,render:()=>motion.observe(),persist(){}});
 return {state,motion,events};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('completion transition folds then hides and emits lifecycle events',async()=>{
 const {state,motion,events}=setup(90);motion.observe();state.data.projects[0].tasks[0].progress=100;motion.observe();await tick();
 assert(state.collapsedProjects.has('p'));assert(state.hiddenProjects.has('p'));
 assert.deepEqual(events.map(e=>[e.type,e.detail.action]),[['project-animation-start','complete'],['project-animation-start','collapse'],['project-animation-end','collapse'],['project-animation-end','complete']]);
 state.hiddenProjects.delete('p');motion.observe();await tick();assert(!state.hiddenProjects.has('p'));
});
test('initial completed projects stay visible and ordinary toggle does not hide',async()=>{
 const {state,motion}=setup(100);motion.observe();await tick();assert(!state.hiddenProjects.has('p'));
 await motion.toggle('p');assert(state.collapsedProjects.has('p'));await motion.toggle('p');assert(!state.collapsedProjects.has('p'));assert(!state.hiddenProjects.has('p'));
});
test('reopened project during queued completion is not hidden',async()=>{
 const {state,motion}=setup(90);motion.observe();state.data.projects[0].tasks[0].progress=100;motion.observe();state.data.projects[0].tasks[0].progress=90;motion.observe();await tick();assert(!state.hiddenProjects.has('p'));
});
test('expansion fades the calendar cover to zero before removing it',async()=>{
 const style=()=>({setProperty(k,v){this[k]=v},removeProperty(k){delete this[k]}});
 const classes=()=>({add(){},remove(){},toggle(){}});
 const summary={offsetTop:7,offsetHeight:23,style:style(),classList:classes()};
 const projectRow={classList:classes(),querySelector:()=>summary};
 const control={dataset:{collapse:'p'},closest:()=>projectRow};
 const cell={style:style(),classList:{contains:()=>false}};
 const row={children:[cell],style:style(),getBoundingClientRect:()=>({height:36}),querySelector:()=>({dataset:{project:'p'}})};
 const samples=[];
 const cover={style:style(),classList:classes(),removeAttribute(){},remove(){assert.equal(this.style.opacity,'0');this.removed=true}};
 const band={dataset:{projectBand:'p'},style:Object.assign(style(),{top:'0px',height:'74px'}),classList:classes(),cloneNode:()=>cover,after(){}};
 const state={collapsedProjects:new Set(['p'])};
 let now=0;
 const c={matchMedia:()=>({matches:false}),performance:{now:()=>0},requestAnimationFrame:fn=>{now+=80;fn(now)},CustomEvent:class{},document:{dispatchEvent(){},querySelectorAll:s=>s.includes('data-collapse')?[control]:s.includes('task-row')?[row]:[band]}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('web/project-motion.js','utf8'),c);
 const motion=c.createProjectMotion({getState:()=>state,render(){},persist(){},redraw(){samples.push(Number(cover.style.opacity))}});
 await motion.toggle('p');
 assert.equal(samples[0],1);assert.equal(samples.at(-1),0);
 assert(samples.some(x=>x>0&&x<1));
 assert(samples.every((x,i)=>i===0||x<=samples[i-1]));
 assert(cover.removed);
});
test('completion paints the collapsed row before flight and hides only after arrival',async()=>{
 const events=[],order=[];
 const state={data:{projects:[{id:'p',name:'P',tasks:[{progress:90}]}]},hiddenProjects:new Set(),collapsedProjects:new Set()};
 const rect={left:250,right:1050,top:120,bottom:158,width:800,height:38};
 const source={style:{cssText:''},children:[],getBoundingClientRect:()=>rect,closest:()=>({getBoundingClientRect:()=>({left:250,right:1050})}),cloneNode:()=>({style:{},children:[]})};
 const destination={dataset:{project:'p'},getBoundingClientRect:()=>({left:15,right:210,top:300,width:195,height:36})};
 const control={dataset:{collapse:'p'},closest:()=>source};
 const ghost={style:{},offsetWidth:800,setAttribute(){},append(){order.push('snapshot')},remove(){order.push('remove-ghost')},animate(){
   assert(state.collapsedProjects.has('p'));
   assert(!state.hiddenProjects.has('p'));
   assert.equal(source.style.opacity,'0');
   order.push('flight');return {finished:Promise.resolve(),cancel(){}};
 }};
 const c={innerWidth:1200,innerHeight:900,matchMedia:()=>({matches:false}),requestAnimationFrame:fn=>{order.push('paint');fn()},CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail}},document:{body:{append(){}},createElement:()=>ghost,querySelector:()=>null,querySelectorAll:s=>s.includes('data-collapse')?[control]:s==='.side-project'?[destination]:[],dispatchEvent:e=>events.push([e.type,e.detail.action])}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('web/project-motion.js','utf8'),c);
 const motion=c.createProjectMotion({getState:()=>state,render(){order.push(state.hiddenProjects.has('p')?'hidden':'collapsed')},persist(){}});
 motion.observe();state.data.projects[0].tasks[0].progress=100;motion.observe();await tick();
 assert.deepEqual(order,['collapsed','paint','paint','snapshot','flight','remove-ghost','hidden']);
 assert.deepEqual(events.map(e=>e.join(':')),['project-animation-start:complete','project-animation-start:collapse','project-animation-end:collapse','project-animation-start:transfer','project-animation-end:transfer','project-animation-end:complete']);
 assert(state.hiddenProjects.has('p'));
});
test('folding keeps sticky labels opaque and unscaled while only their contents animate',async()=>{
 const style=()=>({removeProperty(k){delete this[k]}});
 const classes=(...initial)=>{const values=new Set(initial);return {contains:k=>values.has(k),add:k=>values.add(k),remove:k=>values.delete(k)}};
 const label={style:style()},left={style:style(),classList:classes('gantt-left'),children:[label]};
 const timeline={style:style(),classList:classes('gantt-right')};
 const row={style:style(),children:[left,timeline],getBoundingClientRect:()=>({height:54}),querySelector:()=>({dataset:{project:'p'}})};
 const state={collapsedProjects:new Set()},samples=[];
 let now=0;
 const c={matchMedia:()=>({matches:false}),performance:{now:()=>now},requestAnimationFrame:fn=>{now+=80;fn(now)},CustomEvent:class{},document:{dispatchEvent(){},querySelectorAll:s=>s.includes('task-row')?[row]:[]}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('web/project-motion.js','utf8'),c);
 const motion=c.createProjectMotion({getState:()=>state,render(){},persist(){},redraw(){
   assert.equal(left.style.opacity,undefined);
   assert.equal(left.style.transform,undefined);
   if (row.style.height === undefined) return; // final redraw after cleanup
   assert(left.classList.contains('project-motion-label'));
   samples.push({height:parseFloat(row.style.height),opacity:Number(label.style.opacity)});
 }});
 await motion.toggle('p');
 assert(state.collapsedProjects.has('p'));
 assert(samples.some(s=>s.height>0&&s.height<54&&s.opacity>0&&s.opacity<1));
 samples.length=0;
 await motion.toggle('p');
 assert(!state.collapsedProjects.has('p'));
 assert(samples.some(s=>s.height>0&&s.height<54));
 assert(!left.classList.contains('project-motion-label'));
 assert.equal(label.style.opacity,undefined);
});
