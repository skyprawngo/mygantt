const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('column toggles keep existing chart nodes and restore SVG offset on reversal',()=>{
 const source=fs.readFileSync('web/app.js','utf8'),values=new Map([['--label-width','254px']]),classes=new Set();
 const chart={dataset:{},style:{getPropertyValue:k=>values.get(k),setProperty:(k,v)=>values.set(k,v)},classList:{contains:k=>classes.has(k),toggle:(k,v)=>v?classes.add(k):classes.delete(k)}};
 const head={style:{width:'254px'}},body={style:{width:'1254px'}},content={style:{}},band={style:{left:'354px'}},layer={dataset:{},style:{},setAttribute(k,v){this[k]=v}},button={setAttribute(k,v){this[k]=v}},chevron={};
 const c={captureLabelContents:()=>new Map(),state:{},labelWidthMotion:null,mobileLayout:()=>false,t:k=>k,currentGanttLabelWidth:()=>parseFloat(head.style.width),animateGanttLabelWidth(){},$:s=>s==='.gantt-head-left'?head:s==='.gantt-body'?body:s==='.template-chart-content'?content:s==='.gantt-label-toggle'?button:chevron,$$:s=>s==='.project-duration-band'?[band]:[layer]};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function toggleGanttLabels('),source.indexOf('function renderTimeline(')),c);
 c.toggleGanttLabels(chart);assert.equal(body.style.width,'1036px');assert.equal(layer.style.transform,'translateX(-218px)');assert.equal(button['aria-expanded'],'false');
 c.toggleGanttLabels(chart);assert.equal(body.style.width,'1254px');assert.equal(band.style.left,'354px');assert.equal(layer.style.transform,'translateX(0px)');assert.equal(button['aria-expanded'],'true');assert.equal(c.state.desktopLabelsExpanded,true);
});
