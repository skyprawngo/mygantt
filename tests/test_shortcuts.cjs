const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../web/shortcuts.js');
const event=(key,extra={})=>({key,...extra});
test('platform defaults use primary modifier and match exact modifiers, excluding IME',()=>{
 for(const [platform,modifier,rename] of [['MacIntel','metaKey','Enter'],['Win32','ctrlKey','F2']]) {
  const s=create({device:{platform}});
  assert(s.matches(event('h',{[modifier]:true}),'today'));
  assert(s.matches(event(rename),'rename'));
  for(const extra of [{shiftKey:true},{altKey:true},{isComposing:true},{keyCode:229}]) assert(!s.matches(event('h',{[modifier]:true,...extra}),'today'));
 }
});
test('remapping, disabling and resetting persist and replace defaults',()=>{
 let value=null;const storage={getItem:()=>value,setItem:(k,v)=>value=v,removeItem:()=>value=null};
 let s=create({storage});s.set('today',['Mod+Shift+y']);s.set('undo',[]);
 s=create({storage});assert(s.matches(event('Y',{ctrlKey:true,shiftKey:true}),'today'));assert(!s.matches(event('h',{ctrlKey:true}),'today'));assert(!s.matches(event('z',{ctrlKey:true}),'undo'));
 s.reset();assert.equal(value,null);assert(s.matches(event('z',{ctrlKey:true}),'undo'));
});
test('conflicts reject overlapping scopes but permit independent contexts',()=>{
 const s=create();assert.throws(()=>s.set('today',['Mod+z']),e=>e.conflicts[0].id==='undo');
 assert.throws(()=>s.set('menuUp',['ArrowDown']),e=>e.conflicts[0].id==='menuDown');
 s.set('previous',['Home']);assert.deepEqual(s.keys('previous'),['Home']);
 assert.throws(()=>s.set('today',['Tab']));assert.throws(()=>s.set('today',['h','h']));
});
test('failed storage writes do not change active bindings',()=>{
 const s=create({storage:{getItem(){return null;},setItem(){throw Error('quota');},removeItem(){throw Error('blocked');}}});
 assert.throws(()=>s.set('today',['Mod+y']));assert.deepEqual(s.keys('today'),['Mod+h']);assert.throws(()=>s.reset());
});
test('invalid storage is ignored and modifier-only keys cannot be recorded',()=>{
 const s=create({storage:{getItem:()=>'{broken'}});assert.deepEqual(s.keys('today'),['Mod+h']);
 for(const key of ['Meta','Control','Alt','Shift','Dead','Unidentified','Tab'])assert.equal(s.chord(event(key)),null);
 assert.equal(s.chord(event('+',{ctrlKey:true,shiftKey:true})),'Mod+Shift+Plus');
});
test('every registered action has complete localized modal text',()=>{
 const rows=require('../web/translations.json');
 for(const d of create().definitions){const row=rows.find(r=>r.textID==='shortcuts.action.'+d.id);assert(row,d.id);for(const lang of ['KR','US','JP'])assert(row[lang],d.id+lang);}
});
test('today handler follows remapping, preserves focused inputs, and opens timeline',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync('web/app.js','utf8');
 const start=source.indexOf("document.addEventListener('keydown',event=>{\n  if(!Shortcuts.matches(event,'today')");
 assert(start>=0);let handler,moved=0,prevented=0;
 const Shortcuts=create();Shortcuts.set('today',['Mod+Shift+y']);
 const c={Shortcuts,state:{view:'settings'},document:{addEventListener:(n,fn)=>handler=fn},switchView(v){c.state.view=v;},scrollTimelineToToday(){moved++;}};
 vm.runInNewContext(source.slice(start,source.indexOf('bindCurrentTimeClock();',start)),c);
 const target={closest:()=>null},preventDefault=()=>prevented++;
 handler(event('h',{ctrlKey:true,target,preventDefault}));assert.equal(moved,0);
 handler(event('Y',{ctrlKey:true,shiftKey:true,target,preventDefault}));assert.equal(moved,1);assert.equal(prevented,1);assert.equal(c.state.view,'timeline');
 handler(event('Y',{ctrlKey:true,shiftKey:true,target:{closest:()=>({})},preventDefault}));assert.equal(moved,1);
});
test('undo handler honors the configured binding and leaves native text undo untouched',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync('web/app.js','utf8');
 const start=source.indexOf("document.addEventListener('keydown', async event => {");const end=source.indexOf('\n});',start)+4;
 let handler,prevented=0;const Shortcuts=create();Shortcuts.set('undo',['Mod+Shift+u']);
 vm.runInNewContext(source.slice(start,end),{Shortcuts,undoBusy:true,document:{addEventListener:(n,fn)=>handler=fn}});
 const target={closest:()=>null},preventDefault=()=>prevented++;
 await handler(event('z',{ctrlKey:true,target,preventDefault}));assert.equal(prevented,0);
 await handler(event('U',{ctrlKey:true,shiftKey:true,target,preventDefault}));assert.equal(prevented,1);
 await handler(event('U',{ctrlKey:true,shiftKey:true,target:{closest:()=>({})},preventDefault}));assert.equal(prevented,1);
});
