const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createFields,createActions,createDrafts,createRenderer}=require('../web/editing.js');
const {create}=require('../web/mutations.js');
const input=value=>({value,type:'text',attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];}});
const gate=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('older acknowledgement or failure preserves the newer field edit and its save state',async()=>{
 for(const rejectFirst of [false,true]){
  const field=input('old'),first=gate(),second=gate();let projected='old';
  const fields=createFields({inputs:[field],valueFor:()=>projected});
  field.value='first';const a=fields.save([field],()=>first.promise);const handled=a.catch(()=>{});
  field.value='second';const b=fields.save([field],()=>second.promise);
  projected='second';fields.sync();assert.equal(field.value,'second');
  if(rejectFirst)first.reject(Error('first failed'));else first.resolve();await handled;
  assert.equal(fields.pending,1);assert.equal(fields.errors.size,0);assert.equal(field.value,'second');
  projected='server normalized second';second.resolve();await b;
  assert.equal(fields.pending,0);assert.equal(field.value,'server normalized second');assert.equal(fields.needsSave(field),false);
 }
});
test('failed field retains draft across rollback, can retry, and does not block another field',async()=>{
 const a=input('old'),b=input('original');const fields=createFields({inputs:[a,b],valueFor:i=>i===a?'old':'saved b'});
 const failed=gate();a.value='draft';const save=fields.save([a],()=>failed.promise);const rejected=assert.rejects(save,/offline/);
 b.value='saved b';await fields.save([b],async()=>{});
 failed.reject(Error('offline'));await rejected;fields.sync();
 assert.equal(a.value,'draft');assert.equal(b.value,'saved b');assert.equal(a.attrs['aria-invalid'],'true');assert.equal(fields.needsSave(a),true);
 a.value='corrected';fields.edit(a);await fields.save([a],async()=>{});
 assert.equal(fields.errors.size,0);assert.equal(fields.pending,0);
});
test('acknowledgement preserves focused caret owner and an unsent newer draft',async()=>{
 const a=input('old'),response=gate();let focused=true,projected='old';
 const fields=createFields({inputs:[a],valueFor:()=>projected,focused:()=>focused});
 a.value='sent';const saving=fields.save([a],()=>response.promise);
 a.value='still typing';projected='sent';response.resolve();await saving;
 assert.equal(a.value,'still typing');focused=false;fields.sync();assert.equal(a.value,'still typing');assert.equal(fields.needsSave(a),true);
});
test('100ms responses preserve a later edit in both journal and input; renders coalesce',async()=>{
 const data={templates:[],projects:[{id:'p',tasks:[{id:'a',name:'old',progress:0}]}]};
 const field=input('old'),server=structuredClone(data),frames=[],history=[];let view=data,calls=0,renders=0;
 const fields=createFields({inputs:[field],valueFor:()=>view.projects[0].tasks[0].name});
 const renderer=createRenderer({frame:fn=>frames.push(fn),render(){renders++;fields.sync();}});
 const journal=create({initial:data,publish(next,event){view=next;history.push([event.phase,next.projects[0].tasks[0].name]);renderer.request();},
  async send(path,options){calls++;await new Promise(resolve=>setTimeout(resolve,100));Object.assign(server.projects[0].tasks[0],JSON.parse(options.body));return structuredClone(server.projects[0]);}});
 function edit(value){field.value=value;return fields.save([field],()=>journal.mutate('/api/tasks/a',{method:'PATCH',body:JSON.stringify({name:value})}));}
 const a=edit('first');await tick();const b=edit('second');
 assert.equal(calls,1);assert.equal(view.projects[0].tasks[0].name,'second');assert.equal(frames.length,1);frames.shift()();assert.equal(renders,1);
 await a;assert.equal(field.value,'second');assert.equal(view.projects[0].tasks[0].name,'second');
 await b;frames.shift()();assert.equal(renders,2);assert.equal(field.value,server.projects[0].tasks[0].name);assert.equal(fields.pending,0);
 assert.deepEqual(history,[['optimistic','first'],['optimistic','second'],['confirmed','second'],['confirmed','second']]);
});
test('identical actions deduplicate without preventing edits or other actions; failure releases key',async()=>{
 const actions=createActions(),one=gate();let calls=0;
 const a=actions.run('complete:p',()=>{calls++;return one.promise;});
 assert.equal(actions.run('complete:p',()=>{throw Error('duplicate');}),a);
 assert.equal(await actions.run('complete:q',async()=>42),42);
 const rejected=assert.rejects(a,/offline/);one.reject(Error('offline'));await rejected;
 assert.equal(await actions.run('complete:p',async()=>{calls++;return 7;}),7);assert.equal(calls,2);
});
test('detached editor failures retain retry drafts without erasing newer edits',()=>{
 const drafts=createDrafts(),old=drafts.set('task:a','first'),next=drafts.set('task:a','second');
 drafts.settle('task:a',old);assert.equal(drafts.get('task:a'),next);
 drafts.settle('task:a',old,Error('old failure'));assert.equal(next.error,undefined);
 drafts.settle('task:a',next,Error('offline'));assert.equal(drafts.get('task:a').value,'second');
 const retry=drafts.set('task:a','corrected');drafts.settle('task:a',retry);assert.equal(drafts.get('task:a'),undefined);
});
test('a matching projection from another editor adopts the field without duplicate save',()=>{
 const field=input('old');let projected='old';
 const fields=createFields({inputs:[field],valueFor:()=>projected});
 field.value='row rename';projected='row rename';fields.sync();
 assert.equal(fields.needsSave(field),false);
 projected='old';fields.sync();assert.equal(field.value,'old','rollback still updates a clean field');
});
