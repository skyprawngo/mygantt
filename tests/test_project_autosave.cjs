const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('web/app.js','utf8');
class Input extends EventTarget {
 constructor(id,value){super();Object.assign(this,{id,value,tagName:'INPUT',type:'text',attrs:{}})}
 checkValidity(){return true} setAttribute(k,v){this.attrs[k]=v} removeAttribute(k){delete this.attrs[k]} blur(){this.dispatchEvent(new Event('blur'))}
}
(async()=>{
 const name=new Input('ins-project-name','A'),group=new Input('ins-project-group','');
 const inputs=[name,group],status={textContent:'',style:{setProperty(){}},classList:{toggle(){}}},form=new EventTarget();form.isConnected=true;
 const project={id:'p',name:'A',group_name:'',tasks:[{id:'t'}]};
 const calls=[];const controls=[];
 const ctx=vm.createContext({Map,Promise,encodeURIComponent,state:{data:{projects:[project]},view:'timeline'},$:()=>status,$$:()=>inputs,renderSidebar(){},renderTimeline(options){assert.equal(options.preserveInspector,true)},toast(){},api(path,options){calls.push(JSON.parse(options.body));return new Promise((resolve,reject)=>controls.push({resolve,reject}))}});
 vm.runInContext(source.slice(source.indexOf('const projectSaveQueues'),source.indexOf('function bindInspector(')),ctx);
 vm.runInContext(source.slice(source.indexOf('const paletteCache'),source.indexOf('function esc(')),ctx);
 ctx.bindProjectAutoSave(form,project);
 const tick=()=>new Promise(r=>setImmediate(r));
 name.blur();await tick();assert.equal(calls.length,0);
 name.value='B';name.blur();group.value='G';group.blur();await tick();assert.equal(calls.length,1);
 assert.deepEqual(calls[0],{name:'B'});
 group.value='still typing';controls[0].resolve({...project,name:'B'});await tick();assert.equal(group.value,'still typing');assert.equal(calls.length,2);assert.deepEqual(calls[1],{group_name:'G'});
 controls[1].reject(new Error('offline'));await tick();assert.match(status.textContent,/저장 실패/);assert.equal(group.value,'still typing');
 group.blur();await tick();assert.equal(calls.length,3);assert.deepEqual(calls[2],{group_name:'still typing'});
 controls[2].resolve({...project,group_name:'still typing'});await tick();assert.equal(status.textContent,'자동 저장됨');assert.equal(project.tasks[0].id,'t');
 name.value=' ';name.blur();await tick();assert.equal(calls.length,3);assert.match(status.textContent,/이름/);
 console.log('PASS: unchanged blur, per-field patches, ordered saves, retained draft, failure/retry, invalid name, preserved task data.');
})().catch(e=>{console.error(e);process.exit(1)});
