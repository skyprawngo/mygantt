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
    const c={state:{draft:{tasks:[task]}},$:s=>s==='#template-gantt'?chart:{addEventListener(){},textContent:''},renderTemplateEditor(){},renderTemplateGantt(){},syncDraftFromEditor(){},toast(){}};
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
