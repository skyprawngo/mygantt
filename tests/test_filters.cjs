const withI18n = require('./i18n_context.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
test('search, status, and each sort compose without mutating stored tasks',()=>{
 const fields={'#search-filter':{value:''},'#status-filter':{value:'all'},'#sort-select':{value:'start'}};
 const tasks=[{id:'a',name:'Z',owner:'구매',status:'todo',planned_start:'2026-10-10',progress:0},{id:'b',name:'A',owner:'품질',status:'blocked',planned_start:'2026-10-01',progress:70}];
 const state={data:{projects:[{id:'p',name:'배치',tasks,start_date:'2026-10-01',progress:35}]}};
 const c={state,$:s=>fields[s],taskProgress:t=>t.progress};withI18n(vm.createContext(c));vm.runInContext(source.slice(source.indexOf('function filteredProjects('),source.indexOf('function flatten(')),c);
 assert.equal(c.filteredProjects()[0].tasks[0].id,'b');
 for(const sort of ['name','progress']){fields['#sort-select'].value=sort;assert.equal(c.filteredProjects()[0].tasks[0].id,'b');}
 fields['#search-filter'].value='품질';assert.equal(c.filteredProjects()[0].tasks.length,1);
 fields['#status-filter'].value='todo';assert.equal(c.filteredProjects().length,0);
 fields['#search-filter'].value='배치';assert.equal(c.filteredProjects()[0].tasks[0].id,'a');
 assert.equal(tasks[0].id,'a');
});
test('manual order remains stable across display sorts and insertion uses full stored order',()=>{
 const fields={'#search-filter':{value:''},'#status-filter':{value:'all'},'#sort-select':{value:'manual'}};
 const tasks=Array.from({length:10},(_,i)=>({id:String(i+1),sort_order:i+1,name:String(10-i),planned_start:`2026-10-${String(10-i).padStart(2,'0')}`,progress:100-i*10}));
 const c={state:{data:{projects:[{id:'p',name:'P',tasks}]}},$:s=>fields[s],taskProgress:t=>t.progress};withI18n(vm.createContext(c));
 vm.runInContext(source.slice(source.indexOf('function filteredProjects('),source.indexOf('function flatten(')),c);
 vm.runInContext(source.slice(source.indexOf('function taskInsertionOrder('),source.indexOf('function bindTaskReordering(')),c);
 const before=JSON.stringify(tasks);
 for(const mode of ['start','name','progress','manual']){fields['#sort-select'].value=mode;c.filteredProjects();}
 assert.equal(JSON.stringify(tasks),before);
 assert.equal(c.filteredProjects()[0].tasks[0].id,'1');
 assert.equal(Array.from(c.taskInsertionOrder(tasks,'10','3',false)).join(','),'1,2,10,3,4,5,6,7,8,9');
 assert.equal(Array.from(c.taskInsertionOrder(tasks,'1','10',true)).join(','),'2,3,4,5,6,7,8,9,10,1');
});
test('empty projects remain visible while search and status filters still apply',()=>{
 const fields={'#search-filter':{value:''},'#status-filter':{value:'all'},'#sort-select':{value:'manual'}};
 const c={state:{data:{projects:[{id:'empty',name:'New project',tasks:[]},{id:'unassigned',is_unassigned:true,name:'None',tasks:[]}]}},$:s=>fields[s]};withI18n(vm.createContext(c));
 vm.runInContext(source.slice(source.indexOf('function filteredProjects('),source.indexOf('function flatten(')),c);
 assert.equal(c.filteredProjects().length,1);
 fields['#search-filter'].value='missing';assert.equal(c.filteredProjects().length,0);
 fields['#search-filter'].value='New';assert.equal(c.filteredProjects().length,1);
 fields['#status-filter'].value='done';assert.equal(c.filteredProjects().length,0);
});
