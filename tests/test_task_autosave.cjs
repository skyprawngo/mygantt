const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
function harness(api) {
  const state = {view:'timeline',data:{projects:[{id:'p',name:'new project name',tasks:[],progress:0}]}};
  const renders=[];
  const context={state,api,renderSidebar(){},renderTimeline(options){renders.push(options);}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let taskSaveQueue ='),source.indexOf('function bindTaskAutoSave(')),context);
  return {...context,renders};
}
test('blur patches serialize and keep inspector drafts and project metadata intact',async()=>{
  let release; const gate=new Promise(resolve=>release=resolve); const calls=[];
  const h=harness(async(path,options)=>{
    calls.push(JSON.parse(options.body));
    if(calls.length===1) await gate;
    return {id:'p',name:'stale project name',tasks:[{id:'t',owner:'new owner'}],progress:0};
  });
  const first=h.saveTaskFields('t',{owner:'new owner'});
  const second=h.saveTaskFields('t',{notes:'new notes'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1); release(); await Promise.all([first,second]);
  assert.deepEqual(calls,[{owner:'new owner'},{notes:'new notes'}]);
  assert.equal(h.state.data.projects[0].name,'new project name');
  assert.ok(h.renders.every(options=>options.preserveInspector));
});
test('a rejected save does not block the next correction',async()=>{
  let count=0;
  const h=harness(async()=>{if(++count===1)throw Error('invalid date'); return {id:'p',tasks:[{id:'t',actual_start:'2026-10-04',actual_finish:''}],progress:0};});
  await assert.rejects(h.saveTaskFields('t',{actual_start:'invalid'}));
  await h.saveTaskFields('t',{actual_start:'2026-10-04'});
  assert.equal(h.state.data.projects[0].tasks[0].actual_finish,'');
});
