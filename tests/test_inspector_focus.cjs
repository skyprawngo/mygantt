const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
test('a second primary press blurs the editing field without refocusing; first and secondary presses remain native',()=>{
 const input=new EventTarget(); let blurs=0;
 const document={activeElement:null};
 input.blur=()=>{blurs++;document.activeElement=null;input.dispatchEvent(new Event('blur'));};
 let saves=0; input.addEventListener('blur',()=>saves++);
 const c={document,$$:()=>[input]};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function bindInspectorFocusToggle('),source.indexOf('function bindInspector(project,')),c);
 c.bindInspectorFocusToggle({});
 const press=button=>{const event=new Event('pointerdown',{cancelable:true});event.button=button;input.dispatchEvent(event);return event.defaultPrevented;};
 assert.equal(press(0),false); assert.equal(blurs,0);
 document.activeElement=input;
 assert.equal(press(2),false);assert.equal(blurs,0);
 assert.equal(press(0),true);assert.equal(blurs,1);assert.equal(saves,1);assert.equal(document.activeElement,null);
 assert.equal(press(0),false);
});
