const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
test('sidebar follows chart sorting and live order values without hiding filtered projects',()=>{
 const controls={'#sort-select':{value:'manual'},'#search-filter':{value:''},'#status-filter':{value:'all'}};
 const c={state:{data:{projects:[{id:'a',name:'Alpha',sort_order:2,start_date:'2026-01-01',tasks:[]},{id:'b',name:'Beta',sort_order:1,start_date:'2026-01-02',tasks:[]}]},hiddenProjects:new Set()},$:id=>controls[id],I18n:{locale:'en'},taskProgress:()=>0};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function filteredProjects('),source.indexOf('\nfunction ',source.indexOf('function filteredProjects(')+1)),c);
 const ids=()=>Array.from(c.filteredProjects({forSidebar:true}),p=>p.id);
 assert.deepEqual(ids(),['b','a']);
 c.state.data.projects[0].sort_order=1;c.state.data.projects[1].sort_order=2;
 assert.deepEqual(ids(),['a','b']);
 controls['#sort-select'].value='name';assert.deepEqual(ids(),['a','b']);
 c.state.hiddenProjects.add('a');c.state.filterProject='b';controls['#search-filter'].value='no match';
 assert.deepEqual(ids(),['a','b']);assert.equal(c.filteredProjects().length,0);
});
test('sidebar follows compact chart project order and always places unassigned last',()=>{
 const controls={'#sort-select':{value:'manual'},'#search-filter':{value:''},'#status-filter':{value:'all'}};
 const projects=[{id:'u',is_unassigned:true,name:'Unassigned',sort_order:0,start_date:'2026-01-01',progress:100,tasks:[{id:'t',name:'Task',planned_start:'2026-01-01',sort_order:1}]},{id:'a',name:'Alpha',sort_order:1,start_date:'2026-01-01',tasks:[]},{id:'b',name:'Beta',sort_order:2,start_date:'2026-01-02',tasks:[]}];
 const c={state:{layout:'gantt',compactBy:'owner',data:{projects,compact_orders:{owner:{projects:['b','u','a']}}},hiddenProjects:new Set()},$:id=>controls[id],I18n:{locale:'en'},taskProgress:()=>0,CompactOrder:require('../web/compact-order.js')};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function filteredProjects('),source.indexOf('function flatten(')),c);
 assert.deepEqual(Array.from(c.filteredProjects(),p=>p.id),['b','u','a']);
 assert.deepEqual(Array.from(c.filteredProjects({forSidebar:true}),p=>p.id),['b','a','u']);
 for(const sort of ['name','start','progress']){controls['#sort-select'].value=sort;assert.equal(c.filteredProjects({forSidebar:true}).at(-1).id,'u');}
 assert.deepEqual(projects.map(p=>p.id),['u','a','b']);
});
