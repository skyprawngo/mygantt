const withI18n = require('./i18n_context.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
const block=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
test('relative schedule retains legacy dependencies and permits explicit overlaps',()=>{
  const c={};withI18n(vm.createContext(c));vm.runInContext(block('function templateSchedule(', 'function renderTemplateGantt('),c);
  const tasks=[{key:'a',duration_value:1,duration_unit:'weeks',dependencies:[]},{key:'b',duration_value:2,dependencies:['a']}];
  assert.equal(c.templateSchedule(tasks)[1].start,6);
  assert.equal(c.templateSchedule(tasks,'calendar')[1].start,8);
  tasks[1].start_day=3;assert.equal(c.templateSchedule(tasks)[1].start,3);
  tasks[0].dependencies=['b'];assert.throws(()=>c.templateSchedule(tasks),/순환/);
});
test('body and endpoint drags save relative days; cancellation keeps original',()=>{
  for(const [edge,delta,expected] of [[undefined,2,[5,4]],['start',1,[4,3]],['end',2,[3,6]],['cancel',2,[3,4]]]){
    let saves=0;
    const handlers={}; const task={key:'a',name:'A',start_day:3,duration_value:4,duration_unit:'days',dependencies:[]};
    const chart={addEventListener:(type,fn)=>handlers[type]=fn};
    const bar={dataset:{templateSelect:'a'},style:{},setPointerCapture(){}};
    const c={state:{draft:{tasks:[task]}},$:s=>s==='#template-gantt'?chart:{style:{},addEventListener(){},textContent:''},renderTemplateEditor(){},renderTemplateGantt(){},renderTemplateConnections(){},queueTemplateSave(){saves++;},syncDraftFromEditor(){},toast(){}};
    withI18n(vm.createContext(c));vm.runInContext(block('function templateSchedule(', 'function renderTemplateGantt(')+block('function attachTemplateDrag(', 'function renderTemplateEditor('),c);
    c.attachTemplateDrag();
    const event={button:0,isPrimary:true,pointerId:1,clientX:100,preventDefault(){},target:{closest:s=>s==='.template-bar'?bar:edge?{dataset:{templateEdge:edge}}:null}};
    handlers.pointerdown(event);handlers.pointermove({...event,clientX:100+46*delta});
    if(edge==='cancel')handlers.pointercancel();else handlers.pointerup(event);
    assert.deepEqual([task.start_day,task.duration_value],expected);
    assert.equal(saves,edge==='cancel'?0:1);
  }
});
test('successor selection updates reverse dependency, removes it, and rejects cycles atomically',()=>{
  const c={};withI18n(vm.createContext(c));
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
  withI18n(vm.createContext(c));vm.runInContext(block('function templateSchedule(', 'function renderTemplateGantt('),c);
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

test('template inspector shares schedule date grid and disables execution-only fields',()=>{
  const c={esc:value=>String(value??''),taskColors:['#5872d9'],paletteStyle:()=>''};withI18n(vm.createContext(c));
  vm.runInContext(block('function randomColorButton(', 'function bindRandomColorButtons(')+block('function taskDateGrid(', 'function renderInspector(')+block('function templateTaskRow(', 'function syncDraftFromEditor(')+block('function templateTaskProperties(', 'function attachTemplateDayFields('),c);
  const task={key:'a',name:'Template task',duration_value:2,duration_unit:'days',dependencies:[],handoff:'Keep this note'};
  const html=c.templateTaskProperties(task,0,[task]);
  assert.match(html,/class="task-date-grid"/);
  assert.match(html,/template-start-day/);
  assert.match(html,/template-end-day/);
  assert.equal((html.match(/type="date"[^>]*disabled/g)||[]).length,2);
  assert.match(html,/role="slider"[^>]*disabled/);
  assert.match(html,/textarea[^>]*template-task-handoff[^>]*>Keep this note/);
  assert.ok(html.indexOf('template-task-name') < html.indexOf('task-date-grid'));
  assert.match(html,/inspector-actions/);
});

test('template scroll range starts at 45 days and grows by 15 only at the right edge',()=>{
 const chart={scrollLeft:0,scrollTop:0,clientWidth:500,innerHTML:'',style:{setProperty(){}},classList:{toggle(){}}};
 const c={mobileLayout:()=>false,fitTemplateDayLabels(){},state:{draft:{name:'Template',tasks:[]}},projectColors:['#123456'],taskColors:['#123456'],esc:v=>v,colorPalette:()=>({base:'#123456'}),paletteStyle:()=>'',ganttAddRow:()=>'',addTemplateTask(){},renderTemplateConnections(){},templateDayLabel:d=>String(d),templateSchedule:()=>[],$:s=>s==='#template-gantt'?chart:{style:{},addEventListener(){},textContent:''}};
 Object.defineProperty(chart,'scrollWidth',{get:()=>254+c.state.templateVisibleDays*46});
 withI18n(vm.createContext(c));vm.runInContext(block('function renderTemplateGantt(', 'function renderTemplateConnections('),c);
 c.renderTemplateGantt();assert.equal(c.state.templateVisibleDays,45);
 chart.scrollLeft=100;chart.onscroll();assert.equal(c.state.templateVisibleDays,45);
 chart.scrollLeft=chart.scrollWidth-chart.clientWidth;chart.onscroll();assert.equal(c.state.templateVisibleDays,60);
 const preserved=chart.scrollLeft;chart.onscroll();assert.equal(c.state.templateVisibleDays,60);assert.equal(chart.scrollLeft,preserved);
 chart.scrollLeft=chart.scrollWidth-chart.clientWidth;chart.onscroll();assert.equal(c.state.templateVisibleDays,75);
 chart.scrollLeft=0;chart.onscroll();assert.equal(c.state.templateVisibleDays,75);
 c.state.draft={name:'Other',tasks:[]};c.renderTemplateGantt();assert.equal(c.state.templateVisibleDays,45);
});

test('template day headers progressively remove D and plus to fit their own cells',()=>{
 const text={textContent:''};let selected;
 const c={templateDayLabel:d=>d===1?'D':`D+${d-1}`,document:{createRange:()=>({selectNodeContents:el=>selected=el,getBoundingClientRect:()=>({width:selected.textContent.length*6})})}};
 vm.createContext(c);vm.runInContext(block('function fitTemplateDayLabels(', 'function renderTemplateGantt('),c);
 for(const [width,expected] of [[30,'D+20'],[20,'+20'],[12,'20']]){
   c.fitTemplateDayLabels({querySelectorAll:()=>[{dataset:{day:'21'},clientWidth:width,querySelector:()=>text}]});
   assert.equal(text.textContent,expected);
 }
 c.fitTemplateDayLabels({querySelectorAll:()=>[{dataset:{day:'1'},clientWidth:12,querySelector:()=>text}]});
 assert.equal(text.textContent,'D');
});
