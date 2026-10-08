const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
function setup(reduced=false){
 const classes=new Set(),animations=[];
 const element={inert:false,classList:{contains:k=>classes.has(k),remove:k=>classes.delete(k),toggle:(k,v)=>v?classes.add(k):classes.delete(k)},getBoundingClientRect:()=>({height:200}),animate(frames){let finish;const a={frames,finished:new Promise(r=>finish=r),finish:()=>finish(),cancel(){this.cancelled=true}};animations.push(a);return a;}};
 const c={matchMedia:()=>({matches:reduced}),getComputedStyle:()=>({opacity:'1',paddingTop:'1px',paddingBottom:'13px'})};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('const inspectorMotions'),source.indexOf('function syncAccordionVisibility')),c);
 return {c,element,classes,animations};
}
test('inspector remains rendered during close, then becomes hidden and inert',async()=>{
 const f=setup();f.c.animateInspectorSection(f.element,false);
 assert(!f.classes.has('hidden'));assert(f.element.inert);
 assert.equal(f.animations[0].frames[1].height,'0px');assert.equal(f.animations[0].frames[1].paddingBottom,'0px');
 f.animations[0].finish();await new Promise(r=>setImmediate(r));assert(f.classes.has('hidden'));
});
test('reopening during close cancels stale completion',async()=>{
 const f=setup();f.c.animateInspectorSection(f.element,false);f.c.animateInspectorSection(f.element,true);
 assert(f.animations[0].cancelled);f.animations[0].finish();await new Promise(r=>setImmediate(r));
 assert(!f.classes.has('hidden'));assert(!f.element.inert);
 f.animations[1].finish();await new Promise(r=>setImmediate(r));assert(!f.classes.has('hidden'));
});
test('reduced motion closes immediately',()=>{
 const f=setup(true);f.c.animateInspectorSection(f.element,false);assert(f.classes.has('hidden'));assert.equal(f.animations.length,0);
});
