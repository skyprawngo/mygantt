// Run with: node --test tests/test_gantt_dates.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
function between(a,b){return source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));}
function harness(task) {
  const handlers={}, calls=[];
  const state={data:{projects:[{id:'p',tasks:[task]}]},zoom:46,cascadeDependents:true};
  const context={state,Date,console,$:()=>({addEventListener:(name,fn)=>handlers[name]=fn}),
    api:async(path,options)=>calls.push(JSON.parse(options.body)),persistUi(){},loadState:async()=>{},toast(){},renderTimeline(){},renderDependencyLinks(){}};
  vm.createContext(context);
  vm.runInContext(between('function dateFrom(', 'function dateRangeLabel(')+between('function dependencySourceKind(', 'function renderDependencyLinks(')+between('async function saveDraggedTaskDates(', 'function normalizedTemplate('),context);
  vm.runInContext(between("  $('#gantt').addEventListener('pointerdown'", "  $('#gantt').addEventListener('keydown'"),context);
  const classes={add(){},remove(){},toggle(){}};
  function begin(period,edge){
    const bar={dataset:{datePeriod:period,taskSelect:task.id,project:'p'},style:{left:'100px',width:'322px'},classList:classes};
    const handle={dataset:{resizeEdge:edge},closest:()=>bar,classList:classes,setPointerCapture(){}};
    const event={target:{closest:()=>handle},isPrimary:true,button:0,clientX:100,pointerId:1,preventDefault(){}};
    handlers.pointerdown(event);return {bar,event};
  }
  return {context,state,calls,handlers,begin};
}
const record={id:'t',planned_start:'2026-10-08',planned_finish:'2026-10-12',actual_start:'2026-10-03',actual_finish:'2026-10-09'};
test('actual end drag switches outgoing source live, saves only actual finish',async()=>{
 const h=harness(record),{bar,event}=h.begin('actual','end');
 h.handlers.pointermove({...event,clientX:330}); // +5 days
 assert.equal(bar.style.width,'552px');
 assert.equal(h.context.dependencySourceKind(record),'actual');
 await h.handlers.pointerup(event);
 assert.deepEqual(h.calls,[{actual_finish:'2026-10-14'}]);assert.equal(h.state.savingDates,false);
});
test('actual start drag leaves end and planned dates untouched',async()=>{
 const h=harness(record),{event}=h.begin('actual','start');
 h.handlers.pointermove({...event,clientX:146});await h.handlers.pointerup(event);
 assert.deepEqual(h.calls,[{actual_start:'2026-10-04'}]);
});
test('reversed actual range and cancelled drag do not save',async()=>{
 const h=harness(record),{event}=h.begin('actual','start');
 h.handlers.pointermove({...event,clientX:560});assert.equal(h.state.drag.valid,false);
 await h.handlers.pointerup(event);assert.equal(h.calls.length,0);
 h.begin('actual','end');h.handlers.pointermove({...event,clientX:192});h.handlers.pointercancel(event);
 assert.equal(h.state.drag,null);assert.equal(h.calls.length,0);
});
test('partial start marker moves without inventing finish; end handle can add finish',async()=>{
 const h=harness({...record,actual_finish:''}),{bar,event}=h.begin('actual','start');
 h.handlers.pointermove({...event,clientX:146});assert.equal(bar.style.width,'46px');
 await h.handlers.pointerup(event);assert.deepEqual(h.calls,[{actual_start:'2026-10-04'}]);
 const g=harness({...record,actual_finish:''}),e=g.begin('actual','end').event;
 g.handlers.pointermove({...e,clientX:192});await g.handlers.pointerup(e);
 assert.deepEqual(g.calls,[{actual_finish:'2026-10-05'}]);
});
test('later finish wins; equal ends use the tier facing the target; preview stays live',()=>{
 const h=harness(record),fn=h.context.dependencySourceKind;
 assert.equal(fn(record),'planned');assert.equal(fn({...record,actual_finish:'2026-10-12'}),'actual');
 assert.equal(fn({...record,actual_finish:'2026-10-12'},null,false),'planned');
 assert.equal(fn({...record,actual_finish:'2026-10-13'}),'actual');assert.equal(fn({...record,actual_finish:''}),'planned');
 const {event}=h.begin('planned','end');h.handlers.pointermove({...event,clientX:-84});
 assert.equal(fn(record),'actual');
});
test('planned drag still sends cascade preference',async()=>{
 const h=harness(record),{event}=h.begin('planned','end');h.handlers.pointermove({...event,clientX:146});await h.handlers.pointerup(event);
 assert.deepEqual(h.calls,[{planned_finish:'2026-10-13',cascade_dependents:true}]);
});

test('drag preview entering and leaving a tie follows the successor direction',()=>{
 const h=harness(record),fn=h.context.dependencySourceKind;
 const preview={taskId:'t',valid:true,previewFields:{actual_finish:'2026-10-12'}};
 assert.equal(fn(record,preview,true),'actual');assert.equal(fn(record,preview,false),'planned');
 preview.previewFields.actual_finish='2026-10-13';assert.equal(fn(record,preview,false),'actual');
 preview.previewFields.actual_finish='2026-10-11';assert.equal(fn(record,preview,true),'planned');
});

test('planned drag uses intermediate slider scale for day conversion',async()=>{
 const h=harness(record);h.state.zoom=53;
 const {event}=h.begin('planned','end');
 h.handlers.pointermove({...event,clientX:206});await h.handlers.pointerup(event);
 assert.deepEqual(h.calls,[{planned_finish:'2026-10-14',cascade_dependents:true}]);
});
