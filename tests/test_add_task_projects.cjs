const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const src=fs.readFileSync('web/app.js','utf8');
for(const type of ['task','project'])test(`quick ${type} requests focus on the optimistic row and late response does not change selection`,async()=>{
 let calls=[],release;const state={};
 const c={state,api(path,options){calls.push([path,JSON.parse(options.body)]);state.selection={type,id:'pending:new'};return new Promise(done=>release=done);},t:k=>k,todayInput:()=> '2026-10-07',ChartMutations:{randomUUID:()=> 'request'},persistUi(){},toast:msg=>{throw new Error(msg)}};
 vm.createContext(c);vm.runInContext(src.slice(src.indexOf('let quickCreatePending'),src.indexOf('let labelWidthMotion')),c);
 const request=c.createScheduleItem(type);await c.createScheduleItem(type);
 assert.equal(calls.length,1);assert.equal(calls[0][0],type==='task'?'/api/projects/__unassigned__/tasks':'/api/projects');
 assert.deepEqual(JSON.parse(JSON.stringify(state.pendingNameFocus)),{type,id:'pending:new'});
 state.selection={type:'task',id:'user-selected'};release({id:'p',tasks:[{id:'t'}]});await request;
 assert.equal(state.selection.id,'user-selected');assert.equal(calls[0][1][type==='task'?'planned_start':'start_date'],'2026-10-07');
});
