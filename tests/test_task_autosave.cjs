const withI18n = require('./i18n_context.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
function harness(api) {
  const state = {view:'timeline',data:{projects:[{id:'p',name:'new project name',tasks:[],progress:0}]}};
  const renders=[];
  const context={state,api,$:()=>({value:'manual'}),renderSidebar(){},renderTimeline(options){renders.push(options);}};
  withI18n(vm.createContext(context));
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
test('Backspace clears the whole date; only optional actual dates save empty',async()=>{
 for(const required of [false,true]){
  const events={},patches=[];
  const input={id:required?'ins-task-planned-start':'ins-task-actual-start',type:'date',tagName:'INPUT',value:'2026-10-04',required,checked:false,addEventListener(k,fn){events[k]=fn;},checkValidity(){return !required||!!this.value;},dispatchEvent(){},removeAttribute(){},setAttribute(){}};
  const status={textContent:'',classList:{toggle(){}}},form={isConnected:false,addEventListener(){}};
  const c={$$:()=>[input],$:()=>status,state:{cascadeDependents:false},Event,saveTaskFields:async(id,fields)=>{patches.push(fields);return {tasks:[]};},toast(){}};
  withI18n(vm.createContext(c));vm.runInContext(source.slice(source.indexOf('function bindTaskAutoSave('),source.indexOf('async function completeTask(')),c);
  c.bindTaskAutoSave(form,{id:'t'});
  let prevented=false;events.keydown({key:'Backspace',isComposing:false,preventDefault(){prevented=true;},stopPropagation(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(input.value,'');assert.equal(prevented,true);assert.equal(patches.length,required?0:1);
  if(!required)assert.equal(patches[0].actual_start,'');
 }
});
test('numeric task order resolves insertion against full project order in the save queue',async()=>{
 const calls=[];
 const h=harness(async(path,options)=>{calls.push({path,...JSON.parse(options.body)});return {id:'p',tasks:[{id:'c',sort_order:1},{id:'a',sort_order:2},{id:'b',sort_order:3}],progress:0};});
 h.state.data.projects[0].tasks=[{id:'a',sort_order:1},{id:'b',sort_order:2},{id:'c',sort_order:3}];
 await h.saveTaskFields('c',{sort_order:1});
 assert.deepEqual(calls[0],{path:'/api/tasks/c/order',anchor_id:'a',after:false});
 await h.saveTaskFields('c',{sort_order:3});
 assert.deepEqual(calls[1],{path:'/api/tasks/c/order',anchor_id:'b',after:true});
 await assert.rejects(h.saveTaskFields('c',{sort_order:0}));
 assert.equal(calls.length,2);
});
