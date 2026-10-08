const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
function add(tasks,sync=()=>{}) {
 let saved=0;
 const c={state:{draft:{tasks}},syncDraftFromEditor:()=>sync(tasks),crypto:{randomUUID:()=> 'new-task-id'},taskColors:['#123456'],t:k=>k,renderTemplateEditor(){},queueTemplateSave(){saved++;},setMobileDrawer(){},$:()=>null};
 vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function templateSchedule('),source.indexOf('// Apply one end-offset'))+source.slice(source.indexOf('function addTemplateTask('),source.indexOf('let quickCreatePending')),c);
 c.addTemplateTask();assert.equal(saved,1);return tasks.at(-1);
}
test('new task starts after the latest end, not the final row or project start',()=>{
 const tasks=[{key:'a',start_day:8,duration_value:4,dependencies:[]},{key:'b',start_day:1,duration_value:2,dependencies:[]}];
 const task=add(tasks);assert.equal(task.start_day,12);assert.equal(task.duration_value,1);assert.deepEqual(Array.from(task.dependencies),[]);
 assert.equal(add(tasks).start_day,13);
});
test('implicit dependency dates and week durations determine the project end',()=>{
 const task=add([{key:'a',duration_value:2,duration_unit:'weeks',dependencies:[]},{key:'b',duration_value:3,dependencies:['a']}]);
 assert.equal(task.start_day,14);
});
test('pending inspector edits are synchronized before computing the next day',()=>{
 assert.equal(add([{key:'a',start_day:1,duration_value:1}],tasks=>tasks[0].start_day=20).start_day,21);
});
test('an empty template starts at D+0',()=>{assert.equal(add([]).start_day,1);});
