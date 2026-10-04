const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
for(const collapsed of [true,false]) test(`column width ${collapsed?'collapse':'expand'} keeps bands and body synchronized`,()=>{
 const from=collapsed?254:36,to=collapsed?36:254;
 const values=new Map([['--label-width',`${to}px`]]),classes=new Set(collapsed?['labels-collapsed']:[]);
 const chart={style:{getPropertyValue:k=>values.get(k),setProperty:(k,v)=>values.set(k,v),removeProperty:k=>values.delete(k)},classList:{contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k),toggle:(k,v)=>v?classes.add(k):classes.delete(k)}};
 const head={style:{}},body={style:{width:`${to+1000}px`}},band={style:{left:`${to+100}px`}},samples=[];let frame;
 const c={matchMedia:()=>({matches:false}),performance:{now:()=>0},requestAnimationFrame:fn=>{frame=fn;return 1},$:s=>s==='.gantt-body'?body:head,$$:()=>[band],renderDependencyLinks(){samples.push(parseFloat(values.get('--label-width')));assert.equal(parseFloat(body.style.width),parseFloat(values.get('--label-width'))+1000);assert.equal(parseFloat(band.style.left),parseFloat(values.get('--label-width'))+100)}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('let labelWidthFrame'),source.indexOf('function renderTimeline(')),c);
 c.animateGanttLabelWidth(chart,from);frame(120);frame(240);
 assert.equal(samples[0],from);assert.equal(samples.at(-1),to);assert(samples.some(w=>w>36&&w<254));assert(!classes.has('labels-width-animating'));assert.equal(classes.has('labels-collapsed'),collapsed);
});
