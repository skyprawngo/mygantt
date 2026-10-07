const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');const c={};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function rowRenameKey('),source.indexOf('function bindRowRenameShortcut(')),c);
test('OS takes precedence over browser and unknown OS uses Safari fallback',()=>{
 for(const [device,key] of [[{userAgentData:{platform:'macOS'},userAgent:'Chrome Safari'},'Enter'],[{platform:'Win32',userAgent:'Safari'},'F2'],[{platform:'',userAgent:'Macintosh Chrome'},'Enter'],[{userAgent:'Version/18 Safari'},'Enter'],[{userAgent:'Chrome Safari'},'F2'],[{userAgent:'Firefox'},'F2'],[{},'F2']]) assert.equal(c.rowRenameKey(device),key);
});
test('selected row shortcut opens name input without toggling project',()=>{
 const listeners={};const capture={};let focused=0,selected=0,rendered=0,prevented=0;
 const row={dataset:{taskSelect:'task-1'}};
 const c={navigator:{platform:'MacIntel'},state:{view:'timeline',layout:'gantt'},document:{addEventListener:(name,fn,options)=>{listeners[name]=fn;capture[name]=options;}},persistUi(){},renderInspector(){rendered++;},setMobileDrawer(){},startInlineRowRename(){focused++;selected++;},mobileLayout:()=>false,$:()=>({focus(){focused++;},select(){selected++;}})};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function rowRenameKey('),source.indexOf('let inlineNameEditor'))+source.slice(source.indexOf('function bindRowRenameShortcut('),source.indexOf('function syncLayoutToggle(')),c);c.bindRowRenameShortcut();
 assert.equal(capture.click,true,'selection must be captured before renderTimeline detaches the clicked row');
 let attached=true;const target={closest:()=>attached?row:null};listeners.click({target});attached=false;
 listeners.keydown({key:'Enter',target:{closest:()=>null},preventDefault(){prevented++;},stopImmediatePropagation(){}});
 assert.equal(c.state.selection.id,'task-1');assert.equal(c.state.inspectorOpen,'task');assert.equal(focused,1);assert.equal(selected,1);assert.equal(rendered,1);assert.equal(prevented,1);
});

for (const type of ['project','task']) for (const key of ['Enter','Escape']) {
 test(`${type} inline editing previews inspector immediately and saves with ${key}`,async()=>{
  const handlers={},writes=[];
  const input={value:'',setAttribute(){},removeAttribute(){},addEventListener(name,fn){handlers[name]=fn;},focus(){},select(){}};
  const field={value:'Old'},heading={textContent:'Old',title:'Old'};
  const task={id:'t',name:'Old'},project={id:'p',name:'Old',tasks:[task]};
  const button={closest:()=>({append(){}}),focus(){}};
  const context={state:{data:{projects:[project]}},CSS:{escape:v=>v},document:{createElement:()=>input},t:v=>v,
   $:selector=>selector.startsWith('#ins-')?field:selector.endsWith('-context-label')?heading:button,
   saveProjectField:async(id,fields)=>{writes.push({id,...fields});return fields;},
   saveTaskFields:async(id,fields)=>{writes.push({id,...fields});Object.assign(task,fields);},
   renderSidebar(){},renderTimeline(){},toast(message){throw Error(message);}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let inlineNameEditor'),source.indexOf('function bindRowRenameShortcut(')),context);
  context.startInlineRowRename({type,id:type==='project'?'p':'t'});
  input.value='새 이름';handlers.input();
  assert.equal(field.value,'새 이름');assert.equal(heading.textContent,'새 이름');assert.equal(heading.title,'새 이름');
  assert.equal(writes.length,0,'preview must not persist every keystroke');
  handlers.keydown({key,isComposing:true,stopPropagation(){},preventDefault(){}});
  assert.equal(writes.length,0,'IME composition must not commit');
  handlers.keydown({key,isComposing:false,stopPropagation(){},preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.length,1);assert.equal(writes[0].name,'새 이름');
  assert.equal(type==='project'?project.name:task.name,'새 이름');
 });
}
