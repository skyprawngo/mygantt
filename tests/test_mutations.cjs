const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create,apply}=require('../web/mutations.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const task=(id,fields={})=>({id,project_id:'p',name:id,sort_order:1,planned_start:'2026-10-08',planned_finish:'2026-10-09',actual_start:'',actual_finish:'',dependencies:[],status:'todo',progress:0,...fields});
const initial=()=>({templates:[],projects:[{id:'p',name:'P',start_date:'2026-10-08',calendar_type:'calendar',tasks:[task('a'),task('b',{sort_order:2,dependencies:['a']})]}]});
function harness(data=initial()) {
  let view;const calls=[],history=[];
  const journal=create({initial:data,publish(value){view=value;history.push(structuredClone(value));},send(path,options){return new Promise((resolve,reject)=>calls.push({path,options,resolve,reject}));}});
  const write=(path,fields={},method='PATCH')=>journal.mutate(path,{method,body:JSON.stringify(fields)});
  return {journal,write,calls,history,get view(){return view;},get tasks(){return view.projects.flatMap(p=>p.tasks);}};
}
test('projection is synchronous while ordered HTTP writes do not block later local edits',async()=>{
  const h=harness();
  const a=h.write('/api/tasks/a',{name:'first'});
  assert.equal(h.tasks[0].name,'first');assert.equal(h.calls.length,0);
  const b=h.write('/api/tasks/a',{name:'second'});
  assert.equal(h.tasks[0].name,'second');await tick();assert.equal(h.calls.length,1);
  h.calls[0].resolve({...initial().projects[0],tasks:[task('a',{name:'first'}),task('b')]});await a;
  assert.equal(h.tasks[0].name,'second');await tick();assert.equal(h.calls.length,2);
  h.calls[1].resolve({...initial().projects[0],tasks:[task('a',{name:'second'}),task('b')]});await b;
  assert.equal(h.tasks[0].name,'second');assert.equal(h.journal.pendingCount,0);
});
test('two failed edits restore confirmed base; unrelated pending edit survives both',async()=>{
  const h=harness(),a=h.write('/api/tasks/a',{name:'first'}),b=h.write('/api/tasks/a',{name:'second'}),c=h.write('/api/tasks/b',{owner:'Kim'});
  const failureA=assert.rejects(a,/offline/),failureB=assert.rejects(b,/offline/);
  await tick();h.calls[0].reject(Error('offline'));await failureA;
  assert.equal(h.tasks[0].name,'second');assert.equal(h.tasks[1].owner,'Kim');
  await tick();h.calls[1].reject(Error('offline'));await failureB;
  assert.equal(h.tasks[0].name,'a');assert.equal(h.tasks[1].owner,'Kim');
  await tick();h.calls[2].resolve({...initial().projects[0],tasks:[task('a'),task('b',{owner:'Kim'})]});await c;
});
test('cascade uses later finish, shifts a diamond once, retains actual dates and project metadata',async()=>{
  const data=initial();data.projects[0].tasks=[task('a'),task('b',{dependencies:['a']}),task('c',{dependencies:['a']}),task('d',{dependencies:['b','c'],actual_start:'2026-10-07'})];
  const h=harness(data),save=h.write('/api/tasks/a',{actual_finish:'2026-10-12',cascade_dependents:true});
  assert.deepEqual(h.tasks.map(t=>t.planned_start),['2026-10-08','2026-10-11','2026-10-11','2026-10-11']);assert.equal(h.tasks[3].actual_start,'2026-10-07');
  await tick();h.calls[0].resolve(h.view.projects[0]);await save;
});
test('order, cross-project placement and rejected delete restore graph and exact position',async()=>{
  const data=initial();data.projects.push({id:'q',tasks:[]});const h=harness(data);
  let save=h.write('/api/tasks/b/order',{anchor_id:'a',after:false});assert.deepEqual(h.tasks.map(t=>t.id),['b','a']);await tick();h.calls[0].resolve(h.view.projects[0]);await save;
  save=h.write('/api/tasks/a/placement',{directory_id:'project:q'});assert.deepEqual(h.view.projects[0].tasks[0].dependencies,[]);assert.equal(h.view.projects[1].tasks[0].id,'a');
  await tick();h.calls[1].resolve(h.view.projects[1]);await save;
  save=h.write('/api/projects/q',{},'DELETE');const failed=assert.rejects(save);assert.equal(h.view.projects.length,1);await tick();h.calls[2].reject(Error('offline'));await failed;
  assert.equal(h.view.projects[1].tasks[0].id,'a');
});
test('create immediately shows provisional row; subsequent edit uses real server ID',async()=>{
  const h=harness(),created=h.write('/api/projects',{name:'New',start_date:'2026-10-08'},'POST');
  const temp=h.view.projects.at(-1).id;assert.match(temp,/^pending:/);
  const edit=h.write(`/api/projects/${encodeURIComponent(temp)}`,{name:'Edited'});
  await tick();h.calls[0].resolve({id:'server-id',name:'New',tasks:[]});await created;
  assert.equal(h.view.projects.at(-1).name,'Edited');await tick();assert.equal(h.calls[1].path,'/api/projects/server-id');
  h.calls[1].resolve({id:'server-id',name:'Edited',tasks:[]});await edit;
  assert.equal(h.view.projects.filter(p=>p.id==='server-id').length,1);
});
test('failed create rolls back provisional row and dependent requests never reach server',async()=>{
  const h=harness(),created=h.write('/api/projects',{name:'New'},'POST');const temp=h.view.projects.at(-1).id;
  const edit=h.write(`/api/projects/${encodeURIComponent(temp)}`,{name:'Edited'});
  const a=assert.rejects(created),b=assert.rejects(edit);await tick();h.calls[0].reject(Error('offline'));await Promise.all([a,b]);
  assert.equal(h.view.projects.length,1);assert.equal(h.calls.length,1);
});
test('a stale GET cannot overwrite an edit started while it was in flight',async()=>{
  const h=harness(),refresh=h.journal.refresh();await tick();assert.equal(h.calls[0].path,'/api/state');
  const save=h.write('/api/tasks/a',{name:'new'});await tick();h.calls[0].resolve(initial());await tick();assert.equal(h.tasks[0].name,'new');
  h.calls[1].resolve({...initial().projects[0],tasks:[task('a',{name:'new'}),task('b')]});await save;await tick();
  const fresh=initial();fresh.projects[0].tasks[0].name='new';h.calls[2].resolve(fresh);await refresh;assert.equal(h.tasks[0].name,'new');
});
test('refresh failure after successful save never rolls back committed data',async()=>{
  const h=harness(),save=h.write('/api/tasks/a',{name:'saved'});await tick();h.calls[0].resolve(h.view.projects[0]);await save;
  const read=h.journal.refresh(),failure=assert.rejects(read);await tick();h.calls[1].reject(Error('offline'));await failure;assert.equal(h.tasks[0].name,'saved');
});
test('template edits keep instantiated snapshots immutable; tag colors and completion project immediately',()=>{
  const data=initial();data.templates=[{id:'template',tasks:[]}];const op=(path,fields,method='PATCH')=>({path,fields,method,tempId:'tmp'});
  apply(data,op('/api/templates/template',{name:'Updated',tasks:[]},'PUT'));assert.equal(data.projects[0].tasks[0].name,'a');
  apply(data,op('/api/tasks/a',{tags:'Tag, Tag, Other',progress:50}));assert.deepEqual(data.projects[0].tasks[0].tags,['Tag','Other']);assert.equal(data.projects[0].tasks[0].status,'doing');
  apply(data,op('/api/settings/tag-color',{tag:' Tag ',color:'#123456'}));assert.equal(data.tag_colors.tag,'#123456');
  apply(data,op('/api/projects/p/complete',{},'POST'));assert.equal(data.projects[0].progress,100);assert.equal(data.projects[0].tasks[0].actual_finish,'');
});
test('template instantiation previews explicit offsets, weekdays and known holidays; task creation reconciles once',async()=>{
  const data=initial();data.templates=[{id:'template',name:'T',tasks:[{id:'tt',key:'k',name:'T',start_day:2,duration_value:2,dependencies:[]}]}];
  const h=harness(data),save=h.write('/api/instantiate',{template_id:'template',name:'New',start_date:'2026-10-09',calendar_type:'working'},'POST');
  assert.equal(h.view.projects.at(-1).tasks[0].planned_start,'2026-10-12');assert.equal(h.view.projects.at(-1).tasks[0].planned_finish,'2026-10-13');
  await tick();h.calls[0].resolve({...h.view.projects.at(-1),id:'new-project',tasks:[{...h.view.projects.at(-1).tasks[0],id:'new-task'}]});await save;
  const add=h.write('/api/projects/p/tasks',{name:'Added',planned_start:'2026-10-08',planned_finish:'2026-10-08'},'POST');const temp=h.view.projects[0].tasks.at(-1).id;
  await tick();h.calls[1].resolve({...h.view.projects[0],tasks:h.view.projects[0].tasks.map(t=>({...t,id:t.id===temp?'created-task':t.id}))});await add;
  assert.equal(h.journal.resolveId(temp),'created-task');assert.equal(h.view.projects[0].tasks.length,3);
});
