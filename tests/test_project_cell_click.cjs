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
  return {state,calls,click:selector=>click({target:{closest:s=>s===selector?{dataset:{collapse:'p',projectSelect:'p',taskSelect:'t'}}:null}})};
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
