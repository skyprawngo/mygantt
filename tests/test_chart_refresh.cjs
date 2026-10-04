const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
test('change events coalesce, wait for dragging, and preserve inspector drafts',()=>{
 const document=new EventTarget(),frames=[],calls=[];
 const c={document,Date,state:{view:'timeline',drag:{}},requestAnimationFrame:f=>frames.push(f),renderSidebar:()=>calls.push('sidebar'),renderTimeline:o=>calls.push(o)};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function bindChartAutoRefresh('),source.indexOf('function attachEvents(')),c);c.bindChartAutoRefresh();
 document.dispatchEvent(new Event('chart-data-changed'));document.dispatchEvent(new Event('chart-data-changed'));
 assert.equal(frames.length,1);frames.shift()();assert.equal(calls.length,0);
 c.state.drag=null;c.state.savingDates=true;frames.shift()();assert.equal(calls.length,0);
 c.state.savingDates=false;frames.shift()();assert.equal(calls.length,2);assert.equal(calls[1].preserveInspector,true);
 document.dispatchEvent(new Event('chart-data-changed'));assert.equal(frames.length,1);
});
test('only successful mutations emit refresh events',async()=>{
 const document=new EventTarget();let events=0,ok=true;
 document.addEventListener('chart-data-changed',()=>events++);
 const c={document,Event,state:{},fetch:async()=>({ok,status:400,headers:{get:()=> 'application/json'},json:async()=>({error:'failed'})})};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('async function api('),source.indexOf('async function loadState(')),c);
 await c.api('/api/tasks/t');assert.equal(events,0);
 for(const method of ['POST','PUT','PATCH','DELETE']) await c.api('/api/tasks/t',{method});assert.equal(events,4);
 ok=false;await assert.rejects(c.api('/api/tasks/t',{method:'PATCH'}));assert.equal(events,4);
});
