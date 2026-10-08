const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
function setup(){
 const root=new EventTarget(),c={};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function bindTextCellSelection('),source.indexOf('function bindInspector(project,')),c);
 c.bindTextCellSelection(root);
 return (kind,{type='text',tagName='INPUT',disabled=false,button=0}={})=>{
  const calls=[];const input={type,tagName,disabled,focus:()=>calls.push('focus'),select:()=>calls.push('select'),blur:()=>calls.push('blur')};
  const event=new Event(kind,{cancelable:true});event.button=button;
  Object.defineProperty(event,'target',{value:{closest:()=>input}});
  root.dispatchEvent(event);return {calls,prevented:event.defaultPrevented};
 };
}
test('single clicks and repeated presses retain native caret behavior',()=>{
 const send=setup();
 for(const kind of ['pointerdown','mousedown','pointermove','mousemove','pointerup','mouseup','click','pointerdown','click']) assert.deepEqual(send(kind),{calls:[],prevented:false});
});
test('native text dragging is isolated from row reordering without cancelling browser selection',()=>{
 const handlers={},c={};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function bindTextCellSelection('),source.indexOf('function bindInspector(project,')),c);
 c.bindTextCellSelection({addEventListener:(name,handler,capture)=>handlers[name]={handler,capture}});
 assert.equal(handlers.dragstart.capture,true);
 let stopped=0,prevented=0;
 const event={target:{closest:()=>({})},stopPropagation:()=>stopped++,preventDefault:()=>prevented++};
 handlers.dragstart.handler(event);assert.equal(stopped,1);assert.equal(prevented,0);
 event.target.closest=()=>null;handlers.dragstart.handler(event);assert.equal(stopped,1);
});
test('double click selects the entire dynamically created text field on every page',()=>{
 const send=setup();
 for(const type of ['text','search','url','tel','email','password','number']) assert.deepEqual(send('dblclick',{type}),{calls:['focus','select'],prevented:true});
 assert.deepEqual(send('dblclick',{tagName:'TEXTAREA'}),{calls:['focus','select'],prevented:true});
});
test('date pickers and non-text controls retain native behavior',()=>{
 const send=setup();
 for(const type of ['date','time','checkbox','radio','range','color','button','file']) assert.deepEqual(send('dblclick',{type}),{calls:[],prevented:false});
 assert.deepEqual(send('dblclick',{disabled:true}),{calls:[],prevented:false});
 assert.deepEqual(send('dblclick',{button:2}),{calls:[],prevented:false});
});

test('projection updates clean fields without replacing focused or queued input drafts',()=>{
 const src=require('node:fs').readFileSync('web/app.js','utf8');
 const inputs=[{value:'old',type:'text'},{value:'typing',type:'text'},{value:'waiting',type:'text'}];
 const saved=new Map(inputs.map(i=>[i,i.value])),queued=new Map([[inputs[2],'waiting']]);
 const form={},context={document:{activeElement:inputs[1]}};
 vm.createContext(context);
 vm.runInContext(src.slice(src.indexOf('function bindInspectorProjection('),src.indexOf('function bindProjectAutoSave(')),context);
 context.bindInspectorProjection(form,inputs,()=> 'server',saved,queued,input=>input);
 form.syncProjection();
 assert.equal(inputs[0].value,'server');assert.equal(saved.get(inputs[0]),'server');
 assert.equal(inputs[1].value,'typing');assert.equal(inputs[2].value,'waiting');
});
