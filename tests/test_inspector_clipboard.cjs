const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../web/shortcuts.js');
const {copyText,pasteText,bind,normalizeHex}=require('../web/inspector-clipboard.js');
function input(value='작업 이름',type='text') {
 return {value,type,tagName:'INPUT',selectionStart:type==='text'?0:null,selectionEnd:type==='text'?0:null,isConnected:true,
 closest:()=>({}),matches:()=>true,dispatchEvent(){},cloneNode(){return {value:'',checkValidity:()=>true};}};
}
test('HEX paste accepts exactly six hexadecimal digits with an optional hash; invalid text leaves value and selection untouched',()=>{
 for(const text of ['123456','#123456','aBcDeF','#ABCDEF'])assert.equal(normalizeHex(text),'#'+text.replace('#','').toLowerCase());
 const field=input('#123456');field.hasAttribute=()=>true;field.selectionStart=2;field.selectionEnd=4;
 for(const text of ['abc','#abc','1234567','#1234567','gggggg',' 123456','123456\n','rgb(1,2,3)','']){
  assert.equal(pasteText(field,text,{}),false);assert.equal(field.value,'#123456');assert.equal(field.selectionStart,2);assert.equal(field.selectionEnd,4);
 }
 assert.equal(pasteText(field,'ABCDEF',{}),true);assert.equal(field.value,'#abcdef');
});
test('copy respects selection and copies the entire field at a collapsed cursor, including date and color',()=>{
 const f=input();assert.equal(copyText(f),'작업 이름');f.selectionStart=3;f.selectionEnd=5;assert.equal(copyText(f),'이름');
 for(const [type,value] of [['date','2026-10-19'],['color','#007527'],['number','12']])assert.equal(copyText(input(value,type)),value);
});
test('inspector actions are independent of row actions, customizable, and platform aware',()=>{
 for(const [platform,modifier] of [['Win32','ctrlKey'],['MacIntel','metaKey']]){
  const s=create({device:{platform}});
  assert(s.matches({key:'c',[modifier]:true},'inspectorCopy'));
  assert(s.matches({key:'v',[modifier]:true},'inspectorPaste'));
  s.set('inspectorCopy',['Mod+Shift+c']);assert.deepEqual(s.keys('copy'),['Mod+c']);
  assert.throws(()=>s.set('inspectorPaste',['Mod+Shift+c']));
 }
});
test('native text paste stays native; invalid color paste never clears or changes the field',()=>{
 const f=input('#123456','color');assert.equal(pasteText(f,'not a color',{}),false);assert.equal(f.value,'#123456');
 const handlers={};bind({addEventListener:(name,fn)=>handlers[name]=fn},create(),{},()=>{});
 let prevented=false;
 handlers.paste({target:input(),clipboardData:{getData:()=> 'abc'},preventDefault(){prevented=true;}});
 assert.equal(prevented,false);
});
test('remapped paste ignores stale focus and clipboard failures do not mutate fields',async()=>{
 const f=input(),handlers={},errors=[];let resolve;
 const doc={activeElement:f,addEventListener:(name,fn)=>handlers[name]=fn};const s=create();s.set('inspectorPaste',['Mod+Shift+v']);
 bind(doc,s,{readText:()=>new Promise(r=>resolve=r)},e=>errors.push(e));
 const event={target:f,key:'V',ctrlKey:true,shiftKey:true,preventDefault(){}};
 const pending=handlers.keydown(event);doc.activeElement=null;resolve('changed');await pending;assert.equal(f.value,'작업 이름');
 bind(doc,s,{readText:async()=>{throw Error('denied');}},e=>errors.push(e));await handlers.keydown(event);assert.equal(errors.length,1);assert.equal(f.value,'작업 이름');
});
