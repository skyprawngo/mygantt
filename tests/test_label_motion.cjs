const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
function fixture(collapsed,reduced=false){
 const to=collapsed?36:254,classes=new Set(collapsed?['labels-collapsed']:[]),animations=[];
 function element(style={}){return {style,dataset:{},getClientRects:()=>[1],matches:()=>false,getBoundingClientRect:()=>({width:145,left:classes.has('labels-collapsed')?14:29,top:0}),animate(frames,options){let finish;const a={frames,options,effect:{getComputedTiming:()=>({progress:.5})},finished:new Promise(r=>finish=r),finish:()=>finish(),cancel(){this.cancelled=true}};animations.push(a);return a;}};}
 const chart=element({getPropertyValue:()=>`${to}px`});chart.classList={contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k),toggle:(k,v)=>v?classes.add(k):classes.delete(k)};
 const anchor=element(),head=element(),body=element({width:`${to+1000}px`}),content=element(),band=element({left:`${to+100}px`}),svg=element();
 const c={matchMedia:()=>({matches:reduced}),$:s=>s==='.gantt-body'?body:s==='.template-chart-content'?content:head,$$:s=>s==='.gantt-left'?[head]:s.startsWith('.gantt-head-right')?[content,band,svg]:s.startsWith('.task-state')?[anchor]:[body],requestAnimationFrame(){throw Error('JS frame loop must not drive column animation')},renderDependencyLinks(){throw Error('SVG must not rebuild during animation')}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('let labelWidthMotion'),source.indexOf('function renderTimeline(')),c);
 return {c,chart,classes,animations,to,anchor,body};
}
for(const collapsed of [true,false])test(`native column ${collapsed?'collapse':'expand'} keeps geometry and SVG synchronized`,async()=>{
 const f=fixture(collapsed),from=collapsed?254:36;f.c.animateGanttLabelWidth(f.chart,from);
 assert.equal(f.animations.length,6);assert(f.animations.every(a=>a.options.duration===180&&a.options.easing==='linear'));
 assert.equal(f.animations[0].frames[0].clipPath,`inset(0 ${254-from}px 0 0)`);
 assert(f.animations.every(a=>a.frames.every(frame=>Object.keys(frame).every(k=>['transform','clipPath','opacity','offset'].includes(k)))));
 assert.equal(f.animations[3].frames[0].transform,`translateX(${from-f.to}px)`);
 f.animations.forEach(a=>a.finish());await new Promise(r=>setImmediate(r));
 assert(!f.classes.has('labels-width-animating'));assert.equal(f.classes.has('labels-collapsed'),collapsed);
});
test('rapid reversal cancels old animation and reads visible width',()=>{
 const f=fixture(true);f.c.animateGanttLabelWidth(f.chart,254);const old=[...f.animations];
 f.c.animateGanttLabelWidth(f.chart,f.c.currentGanttLabelWidth(f.chart));assert(old.every(a=>a.cancelled));assert.equal(f.animations[6].frames[0].clipPath,'inset(0 0px 0 0)');
});
test('reduced motion bypasses interpolation',()=>{const f=fixture(true,true);f.c.animateGanttLabelWidth(f.chart,254);assert.equal(f.animations.length,0)});
test('label anchors reach the collapsed center before class restoration',()=>{
 const f=fixture(true);f.c.animateGanttLabelWidth(f.chart,254);
 assert.equal(f.animations[4].frames[1].transform,'translate(-15px,0px)');
 assert.equal(f.animations[5].frames[1].offset,.65);assert.equal(f.animations[5].frames[1].opacity,0);
});
test('reversed text animation retains its current position and opacity',()=>{
 const f=fixture(false);const initial=new Map([[f.body,{left:25,top:0,opacity:.35}]]);
 f.c.animateGanttLabelWidth(f.chart,145,initial);
 assert.equal(f.animations[5].frames[0].transform,'translateX(-4px)');
 assert.equal(f.animations[5].frames[0].opacity,.35);
 assert.equal(f.animations[5].frames[1].opacity,.35);
 assert.equal(f.animations[5].frames.at(-1).opacity,1);
});
