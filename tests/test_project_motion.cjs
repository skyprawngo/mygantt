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
for(const collapsed of [false,true])test(`native project ${collapsed?'expansion':'collapse'} starts all effects after preparation and an initial paint`,async()=>{
 const animations=[],removed=[],frames=[];let preparationDone=false;
 function el(name,top=0,height=0){return {name,style:{cssText:'original'},children:[],dataset:{},attributes:[],classList:{contains:k=>name==='left'&&k==='gantt-left',add(){},remove(){}},getBoundingClientRect:()=>({top,bottom:top+height,height}),querySelectorAll:()=>[],setAttribute(){},removeAttribute(){},after(){},remove(){removed.push(name)},cloneNode(){return el(name+'-clone',top,height)},animate(frames,options){let finish;const a={frames,options,finished:new Promise(r=>finish=r),finish:()=>finish(),pause(){this.paused=true},play(){assert(preparationDone);this.paused=false},cancel(){this.cancelled=true}};animations.push(a);return a;}};}
 const body=el('body'),row=el('row',38,54),left=el('left'),label=el('label'),right=el('right');left.children=[label];row.children=[left,right];row.parentElement=body;row.querySelector=()=>({dataset:{project:'p'}});
 const band=el('band');Object.assign(band.style,{top:'0px',height:'92px'});band.dataset.projectBand='p';
 const later=el('later');later.style.top='92px';const svg=el('svg',0,300);
 body.querySelectorAll=s=>s==='.project-summary-bar'?[]:s.includes('project-duration')?[band,later]:[svg];
 const control={dataset:{collapse:'p'},closest:()=>({querySelector:()=>({offsetTop:7,offsetHeight:23,classList:{add(){},remove(){}}})})};
 const state={collapsedProjects:new Set(collapsed?['p']:[])};let renders=0;
 const c={getComputedStyle:()=>({transform:'none'}),matchMedia:()=>({matches:false}),requestAnimationFrame(fn){frames.push(fn)},CustomEvent:class{},document:{timeline:{currentTime:1250},querySelectorAll:s=>s.includes('task-row')?[row]:[control],dispatchEvent(){}}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('web/project-motion.js','utf8'),c);
 const motion=c.createProjectMotion({getState:()=>state,render(){renders++},persist(){},redraw(){throw Error('unexpected SVG rebuild')}});
 const pending=motion.toggle('p');await tick();assert.equal(animations.length,5);
 assert(animations.every(a=>a.paused&&a.currentTime===0));
 assert(animations.some(a=>a.frames.some(f=>f.transform==='scaleY(0.13043478260869565)')));
 assert.equal(frames.length,1);
 preparationDone=true;
 frames.shift()(); // first paint retains the initial pose
 assert(animations.every(a=>a.paused));
 frames.shift()();await tick();
 assert(animations.every(a=>!a.paused&&a.startTime===1250));
 assert.equal(frames.length,0); // no per-frame JS loop
 assert(animations.every(a=>a.options.duration===200&&a.options.easing==='linear'));
 assert.equal(animations[0].frames[collapsed?0:1].transform,'translateY(0px) scaleY(0)');
 assert(animations.every(a=>a.frames.every(frame=>Object.keys(frame).every(k=>['transform','opacity'].includes(k)))));
 assert(!animations.some(a=>a.node===left));
 animations.forEach(a=>a.finish());await pending;
 assert.equal(renders,1);assert.equal(state.collapsedProjects.has('p'),!collapsed);
 assert.equal(removed.length,3);assert.equal(row.style.cssText,'original');
});

test('header effects include folded endpoints and markers but preserve unrelated transit lines',()=>{
 const c={};vm.createContext(c);vm.runInContext(fs.readFileSync('web/project-motion.js','utf8'),c);
 assert(c.isProjectHeaderConnection({connectionSource:'p',connectionTarget:'q'},'p'));
 assert(c.isProjectHeaderConnection({connectionSource:'q',connectionTarget:'p'},'p'));
 assert(c.isProjectHeaderConnection({boundaryProject:'p'},'p'));
 assert(!c.isProjectHeaderConnection({connectionSource:'q',connectionTarget:'r'},'p'));
 assert(!c.isProjectHeaderConnection({boundaryProject:'q'},'p'));
});

test('project text stays opaque while its position and folded contrast animate',()=>{
 const c={};vm.createContext(c);vm.runInContext(fs.readFileSync('web/project-motion.js','utf8'),c);
 const own=c.projectTextFrames(true,false,108,'rgb(30,40,50)','rgb(255,255,255)');
 assert.equal(own.folded.opacity,1);assert.equal(own.expanded.opacity,1);
 assert.equal(own.folded.color,'rgb(255,255,255)');assert.equal(own.expanded.color,'rgb(30,40,50)');
 const following=c.projectTextFrames(false,true,108,'rgb(20,30,40)','white');
 assert.equal(following.folded.transform,'translateY(-108px)');
 assert.equal(following.folded.color,following.expanded.color);
 assert.equal(following.folded.opacity,1);
});

for(const collapsing of [true,false])test(`row paint preserves endpoint alignment, collapse row = ${collapsing}`,()=>{
 const c={};vm.createContext(c);vm.runInContext(fs.readFileSync('web/project-motion.js','utf8'),c);
 const base='matrix(1, 0, 0, 1, -64, -6)';
 const frames=c.projectPaintFrames(base,108,collapsing);
 assert.equal(frames.expanded.transform,`translateY(0px)${collapsing?' scaleY(1)':''} ${base}`);
 assert.equal(frames.folded.transform,`translateY(-108px)${collapsing?' scaleY(0)':''} ${base}`);
 const rule=c.projectPaintFrames('none',108,false);
 assert.equal(rule.folded.transform,'translateY(-108px)');
 assert.equal(rule.expanded.transform,'translateY(0px)');
});

// Browser zoom can leave offsetTop on the other side of a fractional DOMRect
// boundary. Only the immediately following header was excluded by that test.
test('following project header and tasks share membership at fractional boundaries',()=>{
 const c={};vm.createContext(c);vm.runInContext(fs.readFileSync('web/project-motion.js','utf8'),c);
 const previous={},second={},task={bottom:526.625},third={offsetTop:526},thirdTask={offsetTop:564},add={};
 const all=[previous,second,task,third,thirdTask,add];
 assert(third.offsetTop < task.bottom-.5);
 assert.deepEqual(Array.from(c.projectFollowingRows(all,[task])),[third,thirdTask,add]);
 assert.deepEqual(Array.from(c.projectFollowingRows(all,[])),[]);
 assert.deepEqual(Array.from(c.projectFollowingRows(all,[second,task])),[third,thirdTask,add]);
});
