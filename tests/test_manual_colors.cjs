const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
function context(){const c={localStorage:{getItem:()=>null},state:{data:{projects:[{id:'p',tasks:[{id:'t'}]}]},selection:{type:'task',id:'t'}},};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('let manualColorAnchors'),source.indexOf('function randomColorButton')),c);return c;}
test('manual anchor keeps repeated random changes in original red family',()=>{
 const c=context();let old='#cc3333';
 for(let i=0;i<200;i++){
  const next=c.manualColorVariant('#cc3333',[old],String(i));
  const [r,g,b]=[1,3,5].map(n=>parseInt(next.slice(n,n+2),16));
  assert.ok(r>g*1.5&&r>b*1.5,next);assert.notEqual(next,old);assert.notEqual(next,'#5872d9');old=next;
 }
});
test('neutral manual choices stay neutral',()=>{
 const c=context();for(const anchor of ['#000000','#ffffff','#808080']){
  const next=c.manualColorVariant(anchor,[],anchor);assert.notEqual(next,anchor);assert.equal(next.slice(1,3),next.slice(3,5));assert.equal(next.slice(3,5),next.slice(5,7));
 }
});
test('project anchor uses parent project even while its task is selected',()=>{
 const c=context();assert.equal(c.colorAnchorKey({id:'ins-project-color'}),'project:p');assert.equal(c.colorAnchorKey({id:'ins-task-color'}),'task:t');
});
test('random events cannot overwrite manual anchor and new manual input persists',()=>{
 const c=context(),handlers={},stored=[];
 c.document={addEventListener:(event,fn)=>handlers[event]=fn};c.localStorage.setItem=(key,value)=>stored.push(JSON.parse(value));
 vm.runInContext(source.slice(source.indexOf('function bindRandomColorButtons()'),source.indexOf('function newProjectColor(')),c);c.bindRandomColorButtons();
 const input={id:'ins-task-color',value:'#cc3333',dataset:{},matches:()=>true};
 handlers.input({target:input});assert.equal(stored[0]['task:t'],'#cc3333');
 input.dataset.randomizing='true';input.value='#dd4444';handlers.input({target:input});assert.equal(stored.length,1);
 delete input.dataset.randomizing;input.value='#33cc33';handlers.input({target:input});assert.equal(stored[1]['task:t'],'#33cc33');
});
