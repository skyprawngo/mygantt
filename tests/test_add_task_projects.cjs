const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const src=fs.readFileSync('web/app.js','utf8');
for(const type of ['task','project'])test(`quick ${type} creates directly and focuses name without a modal`,async()=>{
 let calls=[],focused=0,selected=0,loads=0;const c={state:{collapsedProjects:new Set()},api:async(path,options)=>{calls.push([path,JSON.parse(options.body)]);return {id:'p',tasks:[{id:'t'}]};},t:k=>k,todayInput:()=> '2026-10-07',crypto:{randomUUID:()=> 'request'},$:()=>({value:'',focus(){focused++},select(){selected++}}),persistUi(){},renderTimeline:()=>{loads++},mobileLayout:()=>false,toast:msg=>{throw new Error(msg)}};
 vm.createContext(c);vm.runInContext(src.slice(src.indexOf('let quickCreatePending'),src.indexOf('let labelWidthFrame')),c);
 await Promise.all([c.createScheduleItem(type),c.createScheduleItem(type)]);
 assert.equal(calls.length,1);assert.equal(calls[0][0],type==='task'?'/api/projects/__unassigned__/tasks':'/api/projects');assert.equal(c.state.selection.id,type==='task'?'t':'p');assert.equal(focused,1);assert.equal(selected,1);assert.equal(loads,1);assert.equal(calls[0][1][type==='task'?'planned_start':'start_date'],'2026-10-07');
});
