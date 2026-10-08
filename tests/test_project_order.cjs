const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
test('project drag submits insertion order and does not call task placement',async()=>{
 const events={}, requests=[], classes=new Set();
 const row={classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},getBoundingClientRect:()=>({top:100,height:30})};
 const chart={addEventListener:(name,fn)=>events[name]=fn};
 const sort={value:'manual',addEventListener:()=>{}};
 const wrap={scrollTop:0,getBoundingClientRect:()=>({top:0,bottom:500})};
 const c={$:s=>({'#gantt':chart,'#sort-select':sort,'#gantt-wrap':wrap}[s]),$$:()=>[],taskSaveQueue:Promise.resolve(),api:async(path,options)=>requests.push([path,JSON.parse(options.body)]),loadState:async()=>{},renderTimeline(){},toast:()=>{}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function bindTaskReordering('),source.indexOf('// A top-layer popover')),c);c.bindTaskReordering();
 const transfer={setData:()=>{}};
 events.dragstart({target:{closest:()=>({dataset:{collapse:'p3'},closest:()=>row})},dataTransfer:transfer});
 const cell={dataset:{dropProject:'p1'},querySelector:()=>null,closest:()=>row};
 const over=()=>events.dragover({target:{closest:()=>cell},clientY:105,dataTransfer:transfer,preventDefault:()=>{}});
 over(); assert.ok(classes.has('task-insert-before'));
 await events.drop({preventDefault:()=>{}});
 assert.equal(requests[0][0],'/api/projects/p3/order');
 assert.deepEqual(requests[0][1],{anchor_id:'p1',after:false});
 events.dragstart({target:{closest:()=>({dataset:{collapse:'p3'},closest:()=>row})},dataTransfer:transfer});
 sort.value='name';over();await events.drop({preventDefault:()=>{}});
 assert.equal(requests.length,1);
});

test('project display sorts preserve manual sequence',()=>{
 const fields={'#search-filter':{value:''},'#status-filter':{value:'all'},'#sort-select':{value:'manual'}};
 const projects=[{id:'b',name:'B',sort_order:2,tasks:[],start_date:'2026-01-01',progress:100},{id:'a',name:'A',sort_order:1,tasks:[],start_date:'2026-02-01',progress:0}];
 const c={state:{data:{projects}},$:s=>fields[s],I18n:{locale:'en'}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function filteredProjects('),source.indexOf('function flatten(')),c);
 const before=JSON.stringify(projects);
 for(const sort of ['name','start','progress','manual']) {fields['#sort-select'].value=sort;c.filteredProjects();}
 assert.equal(c.filteredProjects()[0].id,'a');assert.equal(JSON.stringify(projects),before);
});
