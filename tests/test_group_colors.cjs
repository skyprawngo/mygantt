const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('web/app.js','utf8'),c={state:{data:{projects:[{group_name:' Team A ',tasks:[{group_name:'team   a'},{group_name:'Design'}]}]}},colorPalette:c=>({base:c})};vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function normalizeGroupName('),src.indexOf('function bindGroupSuggestions('))+src.slice(src.indexOf('function newProjectColor('),src.indexOf('function openInstantiate(')),c);
test('group identity normalizes case, whitespace and Unicode width',()=>{assert.equal(c.groupKey(' Ｔeam  A '),'team a');assert.equal(c.groupNames().length,2);assert.equal(c.canonicalGroupName('TEAM A'),'Team A');});
test('blank categories never suggest and owner names are shared across tasks and templates',()=>{
 c.state.data.templates=[{tasks:[{owner:' Team A '},{owner:'team a'}]}];c.state.data.projects[0].tasks[0].owner='Team B';
 assert.equal(c.matchingCategoryNames(['Team A'],'   ').length,0);
 assert.equal(c.matchingCategoryNames(['Team A','Other'],'eam').length,1);
 assert.equal(c.ownerNames().length,2);
 assert.equal(c.matchingCategoryNames(c.ownerNames(),'TEAM').length,2);
});
test('native owner suggestions require input and match only the beginning',()=>{
 c.state.data={projects:[{tasks:[{owner:'에스엠티에스'},{owner:'한국 에스엠티에스'},{owner:'Team A'}]}],templates:[]};
 assert.equal(c.matchingOwnerNames('').length,0);assert.equal(c.matchingOwnerNames('  ').length,0);
 assert.deepEqual(Array.from(c.matchingOwnerNames('에스')),['에스엠티에스']);
 assert.equal(c.matchingOwnerNames('엠티').length,0);
 assert.deepEqual(Array.from(c.matchingOwnerNames('team')),['Team A']);
});
test('owner datalist stays empty on focus and follows typed prefixes including IME completion',()=>{
 const handlers={},list={id:'',options:[],replaceChildren(...items){this.options=items;}};
 const h={document:{body:{append(){}},createElement:type=>type==='datalist'?list:{},addEventListener:(type,fn)=>handlers[type]=fn},matchingOwnerNames:value=>value==='에'?['에스엠티에스']:[],ownerNames:()=>['에스엠티에스'],groupKey:v=>v,normalizeGroupName:v=>v};
 vm.createContext(h);vm.runInContext(src.slice(src.indexOf('function bindOwnerSuggestions('),src.indexOf('function bindGroupSuggestions(')),h);h.bindOwnerSuggestions();
 const input={value:'에스엠티에스',matches:()=>true,setAttribute(key,value){this[key]=value;}};
 handlers.focusin({target:input});assert.equal(list.options.length,0);assert.equal(input.list,'owner-suggestions');
 input.value='에';handlers.input({target:input,isComposing:true});assert.equal(list.options.length,0);
 handlers.compositionend({target:input});assert.equal(list.options[0].value,'에스엠티에스');
 input.value='';handlers.input({target:input});assert.equal(list.options.length,0);
});
