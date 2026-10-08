const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
function setup(){
 const c={t:key=>key};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('const externalRelationRows'),source.indexOf('function openExternalRelationPicker')),c);
 const selected={id:'a',sort_order:1,dependencies:['outside-in']};
 const p={id:'p',tasks:[{id:'b',sort_order:2,dependencies:[]},selected]};
 const q={id:'q',name:'Other',tasks:[{id:'outside-in',dependencies:[]},{id:'outside-out',dependencies:['a']},{id:'unlinked',dependencies:[]}]};
 return {c,p,q,selected};
}
test('own tasks exclude current task and retain manual order; only connected external tasks appear initially',()=>{
 const {c,p,q,selected}=setup();
 const rows=c.relationRows(p,selected,[q,p]);
 assert.deepEqual(Array.from(rows,x=>x.id),['b','outside-in','outside-out']);
 assert.equal(rows[1].relationProjectName,'Other');
});
test('picker candidates are scoped to each selected task and deduplicated with saved links',()=>{
 const {c,p,q,selected}=setup();
 vm.runInContext("externalRelationRows.set('a',new Set(['unlinked','outside-in']))",c);
 const rows=c.relationRows(p,selected,[p,q]);
 assert.equal(rows.filter(x=>x.id==='outside-in').length,1);
 assert(rows.some(x=>x.id==='unlinked'));
 assert(!c.relationRows(p,p.tasks[0],[p,q]).some(x=>x.id==='unlinked'));
});

test('project badges appear only with external rows and order follows current manual positions',()=>{
 const {c,p,q,selected}=setup();
 selected.dependencies=[];q.tasks.forEach(task=>task.dependencies=[]);
 assert(c.relationRows(p,selected,[p,q]).every(row=>!row.showRelationProject));
 p.tasks.push({id:'c',sort_order:3,dependencies:[]});
 p.tasks[0].sort_order=4;
 assert.deepEqual(Array.from(c.relationRows(p,selected,[p,q]),row=>row.id),['c','b']);
 selected.dependencies=['outside-in','outside-out'];
 q.tasks[0].sort_order=2;q.tasks[1].sort_order=1;
 const rows=c.relationRows(p,selected,[p,q]);
 assert(rows.every(row=>row.showRelationProject));
 assert.deepEqual(Array.from(rows,row=>row.id),['c','b','outside-out','outside-in']);
});

test('clearing saved-task draft rows removes unconnected external rows but preserves both link directions',()=>{
 const {c,p,q,selected}=setup();
 vm.runInContext("externalRelationRows.set('a',new Set(['unlinked','outside-in','outside-out']))",c);
 assert(c.relationRows(p,selected,[p,q]).some(row=>row.id==='unlinked'));
 vm.runInContext("externalRelationRows.delete('a')",c);
 assert.deepEqual(Array.from(c.relationRows(p,selected,[p,q]),row=>row.id),['b','outside-in','outside-out']);
});
