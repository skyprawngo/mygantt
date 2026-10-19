const {test}=require('node:test'),assert=require('node:assert/strict');
const Order=require('../web/compact-order.js');
const {create}=require('../web/mutations.js');
const data=()=>({projects:[{id:'p',sort_order:1,tasks:['A','B','C','A'].map((owner,i)=>({id:String(i),owner,group_name:owner,tags:[owner],sort_order:i}))},{id:'q',sort_order:2,tasks:[]}]});
const fields=(mode='owner',row='C',anchor='A')=>({mode,project_id:'p',row_id:Order.key({owner:row,group_name:row,tags:[row]},mode),anchor_id:Order.key({owner:anchor,group_name:anchor,tags:[anchor]},mode),after:false});
test('compact modes keep independent grouped order without modifying projects or tasks',()=>{
 const d=data(),original=structuredClone(d.projects);
 for(const mode of ['owner','group','tags']) Order.apply(d,fields(mode,mode==='group'?'B':'C'));
 assert.deepEqual(d.projects,original);
 assert.deepEqual(d.compact_orders.owner.tasks.p,['C','A','B'].map(owner=>Order.key({owner},'owner')));
 assert.deepEqual(d.compact_orders.group.tasks.p,['B','A','C'].map(group_name=>Order.key({group_name},'group')));
 Order.apply(d,{mode:'owner',project_id:null,row_id:'q',anchor_id:'p',after:false});
 assert.deepEqual(Order.sort(d.projects,d.compact_orders.owner.projects).map(p=>p.id),['q','p']);
 assert.deepEqual(Order.sort(d.projects,d.compact_orders.group.projects).map(p=>p.id),['p','q']);
});
test('moving visible rows retains hidden rows, removes obsolete keys and appends new rows stably',()=>{
 assert.deepEqual(Order.move(['old','B','A','C'],['A','B','C','D'],'D','A',false),['B','D','A','C']);
 assert.deepEqual(Order.sort([{id:'B'},{id:'C'}],['C','A','B']).map(x=>x.id),['C','B']);
 assert.equal(Order.key({tags:[' B ','Ａ','A']},'tags'),'["compact",["A","B"]]');
 assert.equal(Order.key({id:'t',owner:''},'owner'),'["row","t"]');
 assert.throws(()=>Order.move([],['a'],'a','missing',false));
});
test('failed order rolls back while later pending mode survives and reconciles server order',async()=>{
 let view;const calls=[];
 const journal=create({initial:data(),publish:v=>view=v,send:()=>new Promise((resolve,reject)=>calls.push({resolve,reject}))});
 const write=f=>journal.mutate('/api/settings/compact-order',{method:'PATCH',body:JSON.stringify(f)});
 const a=write(fields()),failure=assert.rejects(a,/offline/),b=write(fields('group','B'));
 assert.ok(view.compact_orders.owner);assert.ok(view.compact_orders.group);
 await new Promise(setImmediate);calls[0].reject(Error('offline'));await failure;
 assert.equal(view.compact_orders.owner,undefined);assert.ok(view.compact_orders.group);
 await new Promise(setImmediate);calls[1].resolve({compact_orders:structuredClone(view.compact_orders)});await b;
 assert.equal(journal.pendingCount,0);assert.deepEqual(view.projects.map(p=>[p.id,p.sort_order,p.tasks]),data().projects.map(p=>[p.id,p.sort_order,p.tasks]));
});
