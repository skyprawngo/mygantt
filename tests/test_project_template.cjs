const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('web/app.js','utf8');const c={t:k=>k};vm.createContext(c);
for(const [a,b] of [['function dateFrom(','function fmtDate('],['function projectTemplatePayload(','async function openProjectTemplateImport(']])vm.runInContext(src.slice(src.indexOf(a),src.indexOf(b)),c);
test('project conversion preserves planned gaps, order, dependencies and source data',()=>{
 const project={color:'#5872d9',tasks:[{id:'b',sort_order:1,name:'B',planned_start:'2026-10-12',planned_finish:'2026-10-14',dependencies:['a'],progress:100,actual_start:'2026-10-13'},{id:'a',sort_order:0,name:'A',planned_start:'2026-10-07',planned_finish:'2026-10-09',dependencies:[],owner:'Team',color:'#123456'}]};
 const original=JSON.stringify(project),p=c.projectTemplatePayload(project,' Copy ');assert.equal(JSON.stringify(project),original);assert.equal(p.name,'Copy');assert.equal(p.calendar_type,'calendar');assert.equal(p.tasks[0].owner,'Team');assert.equal(p.tasks[0].start_day,1);assert.equal(p.tasks[1].start_day,6);assert.equal(p.tasks[1].duration_value,3);assert.equal(p.tasks[1].dependencies[0],'task_1');assert.equal(p.tasks[1].actual_start,undefined);assert.equal(p.tasks[1].progress,undefined);
});
test('empty or invalid source cannot be converted',()=>{assert.throws(()=>c.projectTemplatePayload({tasks:[]},'T'));assert.throws(()=>c.projectTemplatePayload({tasks:[{planned_start:'2026-10-08',planned_finish:'2026-10-07'}]},'T'));});
