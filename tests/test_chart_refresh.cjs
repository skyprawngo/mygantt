const withI18n = require('./i18n_context.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
test('change events coalesce, wait for dragging, and preserve inspector drafts',()=>{
 const document=new EventTarget(),frames=[],calls=[];
 const c={document,Date,state:{view:'timeline',drag:{}},requestAnimationFrame:f=>frames.push(f),renderSidebar:()=>calls.push('sidebar'),renderTimeline:o=>calls.push(o)};
 withI18n(vm.createContext(c));vm.runInContext(source.slice(source.indexOf('function bindChartAutoRefresh('),source.indexOf('function attachEvents(')),c);c.bindChartAutoRefresh();
 document.dispatchEvent(new Event('chart-data-changed'));document.dispatchEvent(new Event('chart-data-changed'));
 assert.equal(frames.length,1);frames.shift()();assert.equal(calls.length,0);
 c.state.drag=null;c.state.savingDates=true;frames.shift()();assert.equal(calls.length,2);assert.equal(calls[1].preserveInspector,true);
 document.dispatchEvent(new Event('chart-data-changed'));assert.equal(frames.length,1);
});
test('the common API publishes before response and on rollback, GET does not dispatch raw writes',async()=>{
 const document=new EventTarget();let events=0,reject;
 document.addEventListener('chart-data-changed',()=>events++);
 const c={document,Event,$:()=>null,state:{data:{projects:[],templates:[]},view:'settings'},ChartMutations:require('../web/mutations.js'),
   fetch:()=>new Promise((_,fail)=>reject=fail)};
 withI18n(vm.createContext(c));vm.runInContext(source.slice(source.indexOf('async function requestJson('),source.indexOf('async function loadState(')),c);
 const request=c.api('/api/settings/tag-color',{method:'PATCH',body:JSON.stringify({tag:'Tag',color:'#123456'})});
 assert.equal(events,1);assert.equal(c.state.data.tag_colors.tag,'#123456');
 const failed=assert.rejects(request);await new Promise(resolve=>setImmediate(resolve));reject(Error('offline'));await failed;
 assert.equal(events,2);assert.equal(c.state.data.tag_colors,undefined);
});
