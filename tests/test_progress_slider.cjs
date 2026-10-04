const withI18n = require('./i18n_context.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
test('click stops at retained progress; drag resumes; cancellation restores',()=>{
 const handlers={},calls=[],attrs={};const track={style:{setProperty(){}},getBoundingClientRect:()=>({width:100})};
 const knob={parentElement:track,classList:{toggle(){}},setAttribute:(k,v)=>attrs[k]=v,addEventListener:(k,f)=>handlers[k]=f,setPointerCapture(){}};
 const c={$:s=>s==='#task-progress-knob'?knob:s==='#task-progress-label'?{}:{classList:{toggle(){}}},saveTaskFields:async(id,fields)=>calls.push(fields),toast(){}};
 withI18n(vm.createContext(c));vm.runInContext(source.slice(source.indexOf('function taskProgress('),source.indexOf('function bindInspector(')),c);c.bindTaskProgress({}, {id:'t',progress:40,status:'doing'});
 const e={button:0,isPrimary:true,pointerId:1,clientX:40,preventDefault(){}};
 handlers.pointerdown(e);handlers.pointerup(e);assert.equal(calls[0].status,'blocked');assert.equal(calls[0].progress,40);assert.equal(knob.textContent,'−');
 handlers.pointerdown(e);handlers.pointermove({...e,clientX:60});handlers.pointerup(e);assert.equal(calls[1].status,'doing');assert.equal(calls[1].progress,60);assert.equal(knob.textContent,'');
 handlers.pointerdown(e);handlers.pointermove({...e,clientX:90});handlers.pointercancel();assert.equal(attrs['aria-valuenow'],60);assert.equal(calls.length,2);
});
