const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
function setup(narrow) {
  let click;
  const calls=[];
  const state={selection:{type:'task',id:'task-1'},inspectorOpen:'task'};
  const context={state,mobileLayout:()=>narrow,
    $:()=>({addEventListener:(_,handler)=>{click=handler;}}),
    renderSidebar:()=>calls.push('sidebar'),renderTimeline:()=>calls.push('timeline'),
    persistUi:()=>calls.push('persist'),renderInspector:()=>calls.push('inspector'),
    setMobileDrawer:panel=>calls.push(`drawer:${panel}`),
    projectMotion:{toggle:id=>calls.push(`toggle:${id}`)},
    selectItem:(type,id)=>calls.push(`select:${type}:${id}`)};
  vm.runInNewContext(source.slice(source.indexOf("  $('#gantt').addEventListener('click',"),source.indexOf("  $('#project-accordion').addEventListener('click',")),context);
  return {state,calls,clickRow:row=>click({target:{closest:s=>s==='.gantt-row'?row:null}}),click:selector=>click({target:{closest:s=>s===selector?{dataset:{collapse:'p',projectSelect:'p',taskSelect:'t'}}:null}})};
}
test('narrow project cell only toggles expansion and preserves inspector selection',()=>{
  const h=setup(true);
  h.click('[data-collapse]');h.click('[data-collapse]');
  assert.deepEqual(h.calls,['toggle:p','toggle:p']);
  assert.deepEqual(h.state.selection,{type:'task',id:'task-1'});
  assert.equal(h.state.inspectorOpen,'task');
});
test('desktop project cell still selects project properties and toggles expansion',()=>{
  const h=setup(false);h.click('[data-collapse]');
  assert.deepEqual(h.calls,['persist','inspector','toggle:p']);
  assert.equal(h.state.selection.type,'project');assert.equal(h.state.selection.id,'p');
});
test('narrow project bars and tasks keep their selection behavior',()=>{
  const h=setup(true);h.click('[data-project-select]');h.click('[data-task-select]');
  assert.deepEqual(h.calls,['select:project:p','select:task:t']);
});

for(const narrow of [false,true]) test(`blank chart clears selected outline and inspector: narrow=${narrow}`,()=>{
 const h=setup(narrow);h.click(null);
 assert.equal(h.state.selection,null);
 assert.equal(h.state.inspectorOpen,'');
 assert.deepEqual(h.calls,['persist','sidebar','timeline','drawer:null']);
 h.click(null);
 assert.equal(h.calls.length,4);
});
test('chart controls do not clear selection',()=>{
 const h=setup(false);h.click('button,input,textarea,select,[contenteditable],[role="button"]');
 assert.equal(h.state.selection.id,'task-1');assert.deepEqual(h.calls,[]);
});
function gestures() {
 const handlers={},calls=[],state={layout:'gantt'};let pending;
 const chart={addEventListener:(event,fn)=>handlers[event]=fn};
 const context={state,clearTimeout:()=>{pending=null;},setTimeout:fn=>{pending=fn;return 1;},selectItem:(type,id,options)=>calls.push({type,id,...options}),projectMotion:{toggle:id=>calls.push({toggle:id})}};
 vm.runInNewContext(source.slice(source.indexOf('function bindProjectBarGestures('),source.indexOf('function bindChartAutoRefresh(')),context);
 context.bindProjectBarGestures(chart);
 const bar={isConnected:true,dataset:{projectSelect:'p'}};
 const event=detail=>({detail,target:{closest:()=>bar},preventDefault(){},stopImmediatePropagation(){}});
 return {handlers,calls,state,bar,event,flush(){pending?.();pending=null;}};
}
test('double-click selects and opens inspector once before toggling project, without single-click toggle',()=>{
 const h=gestures();h.handlers.click(h.event(1));h.handlers.click(h.event(2));h.handlers.dblclick(h.event(2));h.flush();
 assert.deepEqual(h.calls,[{type:'project',id:'p',preserveChart:true,toggleInspector:false},{toggle:'p'}]);
});
test('single click retains normal inspector toggle and keyboard activation is immediate',()=>{
 const h=gestures();h.handlers.click(h.event(1));assert.equal(h.calls.length,0);h.flush();
 assert.deepEqual(h.calls,[{type:'project',id:'p',preserveChart:true}]);
 h.handlers.click(h.event(0));assert.equal(h.calls.length,2);
});
test('detached bars and switching to monthly view cancel delayed selection',()=>{
 for(const mode of ['detached','month']){
  const h=gestures();h.handlers.click(h.event(1));if(mode==='detached')h.bar.isConnected=false;else h.state.layout='month';h.flush();assert.equal(h.calls.length,0);
 }
 const h=gestures();h.state.layout='month';h.handlers.dblclick(h.event(2));assert.equal(h.calls.length,0);
});

for(const narrow of [false,true]) test(`blank task row selects its project with collapsed properties: narrow=${narrow}`,()=>{
 const h=setup(narrow);
 const row={dataset:{},querySelector:()=>({dataset:{project:'owner-project'}})};
 h.clickRow(row);
 assert.equal(h.state.selection.type,'project');assert.equal(h.state.selection.id,'owner-project');
 assert.equal(h.state.inspectorOpen,'');
 assert(h.calls.includes('timeline'));
 if(narrow) assert(h.calls.includes('drawer:inspector'));
 h.state.selection=null;h.clickRow(row);assert.equal(h.state.selection.id,'owner-project');
});
test('blank project header uses its own project identity',()=>{
 const h=setup(false);h.clickRow({dataset:{projectBoundary:'header-project'}});
 assert.equal(h.state.selection.id,'header-project');assert.equal(h.state.inspectorOpen,'');
});
