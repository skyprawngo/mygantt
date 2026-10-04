const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
const block=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
test('relative schedule retains legacy dependencies and permits explicit overlaps',()=>{
  const c={};vm.createContext(c);vm.runInContext(block('function templateSchedule(', 'function renderTemplateGantt('),c);
  const tasks=[{key:'a',duration_value:1,duration_unit:'weeks',dependencies:[]},{key:'b',duration_value:2,dependencies:['a']}];
  assert.equal(c.templateSchedule(tasks)[1].start,6);
  assert.equal(c.templateSchedule(tasks,'calendar')[1].start,8);
  tasks[1].start_day=3;assert.equal(c.templateSchedule(tasks)[1].start,3);
  tasks[0].dependencies=['b'];assert.throws(()=>c.templateSchedule(tasks),/순환/);
});
test('body and endpoint drags save relative days; cancellation keeps original',()=>{
  for(const [edge,delta,expected] of [[undefined,2,[5,4]],['start',1,[4,3]],['end',2,[3,6]],['cancel',2,[3,4]]]){
    const handlers={}; const task={key:'a',name:'A',start_day:3,duration_value:4,duration_unit:'days',dependencies:[]};
    const chart={addEventListener:(type,fn)=>handlers[type]=fn};
    const bar={dataset:{templateSelect:'a'},style:{},setPointerCapture(){}};
    const c={state:{draft:{tasks:[task]}},$:s=>s==='#template-gantt'?chart:{addEventListener(){},textContent:''},renderTemplateEditor(){},renderTemplateGantt(){},renderTemplateConnections(){},syncDraftFromEditor(){},toast(){}};
    vm.createContext(c);vm.runInContext(block('function templateSchedule(', 'function renderTemplateGantt(')+block('function attachTemplateDrag(', 'function renderTemplateEditor('),c);
    c.attachTemplateDrag();
    const event={button:0,isPrimary:true,pointerId:1,clientX:100,preventDefault(){},target:{closest:s=>s==='.template-bar'?bar:edge?{dataset:{templateEdge:edge}}:null}};
    handlers.pointerdown(event);handlers.pointermove({...event,clientX:100+46*delta});
    if(edge==='cancel')handlers.pointercancel();else handlers.pointerup(event);
    assert.deepEqual([task.start_day,task.duration_value],expected);
  }
});
test('successor selection updates reverse dependency, removes it, and rejects cycles atomically',()=>{
  const c={};vm.createContext(c);
  vm.runInContext(block('function templateSchedule(', 'function renderTemplateGantt(')+block('function setTemplateRelation(', 'function templateTaskRow('),c);
  const tasks=[{key:'a',duration_value:1,dependencies:[]},{key:'b',duration_value:1,dependencies:[]}];
  c.setTemplateRelation(tasks,'a','b',true,true);
  assert.equal(tasks[1].dependencies.join(','),'a');
  assert.equal(c.templateSchedule(tasks)[1].start,2);
  assert.throws(()=>c.setTemplateRelation(tasks,'a','b',false,true),/순환/);
  assert.equal(tasks[0].dependencies.length,0);
  assert.equal(tasks[1].dependencies.join(','),'a');
  c.setTemplateRelation(tasks,'a','b',true,false);
  assert.equal(tasks[1].dependencies.length,0);
});

function cascadeHarness(enabled) {
  const tasks=[
    {key:'a',start_day:5,duration_value:3,dependencies:[]},
    {key:'b',duration_value:2,dependencies:['a']},
    {key:'c',start_day:6,duration_value:4,dependencies:['a']},
    {key:'d',duration_value:1,dependencies:['b','c']},
    {key:'e',duration_value:2,dependencies:[]}
  ];
  const c={state:{draft:{tasks},cascadeDependents:enabled,templateCalendar:'working'}};
  vm.createContext(c);vm.runInContext(block('function templateSchedule(', 'function renderTemplateGantt('),c);
  return {c,tasks,positions:()=>Array.from(c.templateSchedule(tasks),r=>[r.start,r.end])};
}
test('cascade shifts implicit and overlapping successors once across a diamond, preserving unrelated tasks',()=>{
  const {c,positions}=cascadeHarness(true),before=positions();
  c.updateTemplateSchedule('a',{duration_value:5});
  const after=positions();
  for(const i of [1,2,3]) assert.deepEqual(after[i],before[i].map(day=>day+2));
  assert.deepEqual(after[4],before[4]);
  c.updateTemplateSchedule('a',{duration_value:3});
  assert.deepEqual(positions(),before);
});
test('unchecked edits freeze implicit successors and start-only changes do not offset them',()=>{
  const {c,positions}=cascadeHarness(false),before=positions();
  c.updateTemplateSchedule('a',{duration_value:5});
  assert.deepEqual(positions().slice(1),before.slice(1));
  c.state.cascadeDependents=true;
  c.updateTemplateSchedule('a',{start_day:6,duration_value:4});
  assert.deepEqual(positions().slice(1),before.slice(1));
});
test('invalid negative successor position rejects entire edit atomically',()=>{
  const {c,tasks}=cascadeHarness(true);
  tasks[2].start_day=1;
  const before=JSON.stringify(tasks);
  assert.throws(()=>c.updateTemplateSchedule('a',{duration_value:1}),/D\+9999/);
  assert.equal(JSON.stringify(tasks),before);
});
