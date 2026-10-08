const withI18n = require('./i18n_context.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
test('change events coalesce, wait for dragging, and preserve inspector drafts',()=>{
 const document=new EventTarget(),frames=[],calls=[];
 const c={ChartEditing:require('../web/editing.js'),inlineNameEditor:null,focusCreatedName(){},syncInspectorProjection(){},document,Date,state:{view:'timeline',drag:{}},requestAnimationFrame:f=>frames.push(f),renderSidebar:()=>calls.push('sidebar'),renderTimeline:o=>calls.push(o)};
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

test('real mutation notifications use a single frame render path and preserve frozen timeline time',async()=>{
 const document=new EventTarget(),frames=[],calls=[];let resolve;
 const reference=new Date('2026-10-08T00:00:00Z');
 const c={document,Event,Date,ChartEditing:require('../web/editing.js'),ChartMutations:require('../web/mutations.js'),inlineNameEditor:null,focusCreatedName(){},
  timelineReferenceTime:reference,state:{data:{projects:[],templates:[]},view:'timeline'},$:()=>null,
  requestAnimationFrame:fn=>frames.push(fn),syncInspectorProjection:()=>calls.push('sync'),renderSidebar:()=>calls.push('sidebar'),renderTimeline:()=>calls.push('chart'),
  fetch:()=>new Promise(done=>resolve=done)};
 withI18n(vm.createContext(c));
 vm.runInContext(source.slice(source.indexOf('async function requestJson('),source.indexOf('async function loadState('))+source.slice(source.indexOf('function bindChartAutoRefresh('),source.indexOf('function attachEvents(')),c);
 c.bindChartAutoRefresh();
 const saving=c.api('/api/settings/tag-color',{method:'PATCH',body:JSON.stringify({tag:'Tag',color:'#123456'})});
 assert.equal(calls.length,0);assert.equal(frames.length,1);frames.shift()();assert.deepEqual(calls,['sync','sidebar','chart']);
 await new Promise(done=>setImmediate(done));resolve({ok:true,headers:{get:()=> 'application/json'},json:async()=>({key:'tag',color:'#123456'})});await saving;
 assert.equal(calls.length,3);assert.equal(frames.length,1);frames.shift()();assert.equal(calls.length,6);assert.equal(c.timelineReferenceTime,reference);
});

test('blank chart click clears selection even while a date save remains pending',()=>{
 let click;const state={selection:{type:'task',id:'t'},savingDates:true,drag:null};
 const c={state,$:()=>({addEventListener:(name,fn)=>click=fn}),persistUi(){},renderSidebar(){},renderTimeline(){},setMobileDrawer(){}};
 vm.createContext(c);
 const start=source.indexOf("  $('#gantt').addEventListener('click'");
 vm.runInContext(source.slice(start,source.indexOf("  $('#project-accordion')",start)),c);
 click({target:{closest:()=>null}});assert.equal(state.selection,null);assert.equal(state.inspectorOpen,'');
});
