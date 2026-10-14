const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {create}=require('../web/mutations.js');
const source=fs.readFileSync('web/app.js','utf8');
const c={t:x=>x};vm.createContext(c);
for(const [a,b] of [['function actualTaskRange(', '// A filled neck'],['function groupedTaskRows(', 'function taskBarsMarkup(']]) vm.runInContext(source.slice(source.indexOf(a),source.indexOf(b)),c);
const task=(id,start,finish,fields={})=>({id,name:'검사',gantt_row_id:'a',planned_start:`2026-11-${start}`,planned_finish:`2026-11-${finish}`,...fields});
test('two separate periods share one row and unrelated same-name tasks remain separate',()=>{
 const rows=c.groupedTaskRows([task('a','01','03'),task('b','07','09'),task('c','10','11',{gantt_row_id:''})]);
 assert.equal(rows.length,2);assert.equal(rows[0].tasks.length,2);assert.equal(rows[0].height,36);
 assert.equal(rows[0].offsets.get('a'),0);assert.equal(rows[0].offsets.get('b'),0);
});
test('overlapping planned and actual periods remain reachable inside the same row',()=>{
 const rows=c.groupedTaskRows([task('a','01','03',{actual_start:'2026-11-01',actual_finish:'2026-11-08'}),task('b','07','09')]);
 assert.equal(rows.length,1);assert.equal(rows[0].height,108);assert.equal(rows[0].offsets.get('b'),54);
 const touching=c.groupedTaskRows([task('a','01','03'),task('b','03','05')]);
 assert.equal(touching[0].height,72);
});
test('failed same-row creation rolls back both new task and original group membership',async()=>{
 let view,rejectSend;
 const journal=create({initial:{templates:[],projects:[{id:'p',tasks:[task('a','01','03',{gantt_row_id:''})]}]},publish:v=>view=v,send:()=>new Promise((_,reject)=>rejectSend=reject)});
 const saving=journal.mutate('/api/projects/p/tasks',{method:'POST',body:JSON.stringify({name:'검사',planned_start:'2026-11-07',planned_finish:'2026-11-09',same_row_as:'a'})});
 const rejected=assert.rejects(saving,/offline/);
 assert.equal(view.projects[0].tasks.length,2);assert.equal(c.groupedTaskRows(view.projects[0].tasks).length,1);
 await new Promise(resolve=>setImmediate(resolve));rejectSend(Error('offline'));await rejected;
 assert.equal(view.projects[0].tasks.length,1);assert.equal(view.projects[0].tasks[0].gantt_row_id,'');
});

test('dot add creates directly with identical dates and deduplicates pending clicks',async()=>{
 const requests=[];let resolve;
 const original=task('a','01','03',{color:'#123456'});
 const h={state:{data:{projects:[{id:'p',tasks:[original]}]}},Set,encodeURIComponent,api:(path,options)=>{requests.push({path,fields:JSON.parse(options.body)});return new Promise(done=>resolve=done);},setMobileDrawer:()=>{},toast:()=>{}};
 vm.createContext(h);vm.runInContext(source.slice(source.indexOf('const sameRowCreates ='),source.indexOf('function openTaskEditor(')),h);
 const pending=h.openSameRowTask('a');await h.openSameRowTask('a');
 assert.equal(requests.length,1);assert.deepEqual(requests[0].fields,{name:'검사',planned_start:'2026-11-01',planned_finish:'2026-11-03',same_row_as:'a'});
 resolve();await pending;
});
test('row inspector lists only the selected project row in task order',()=>{
 const h={t:(key,p)=>p?`작업${p.p0} 속성`:'작업 속성'};vm.createContext(h);
 vm.runInContext(source.slice(source.indexOf('function rowTaskMembers('),source.indexOf('function renderRowTaskSections(')),h);
 const a=task('a','01','03',{sort_order:1}),b=task('b','07','09',{sort_order:2});
 const members=h.rowTaskMembers({tasks:[b,task('c','10','11',{gantt_row_id:''}),a]},b);
 assert.equal(members.length,2);assert.equal(members[0].id,'a');assert.equal(members[1].id,'b');
 assert.equal(h.rowTaskSectionTitle(0),'작업 속성');assert.equal(h.rowTaskSectionTitle(1),'작업2 속성');
});
