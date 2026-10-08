const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
test('native clipboard events copy rows, paste after selection, and leave text fields alone',async()=>{
 const events={},calls=[],clipboard={};
 const state={view:'timeline',selection:{type:'task',id:'a'},data:{projects:[{id:'p',tasks:[{id:'a'}]}]},hiddenProjects:new Set(),collapsedProjects:new Set()};
 const c={state,document:{addEventListener:(name,fn)=>events[name]=fn},window:{getSelection:()=>({toString:()=>''})},taskSaveQueue:Promise.resolve(),projectSaveQueues:new Map(),t:x=>x,toast:()=>{},$:()=>({value:'manual'}),persistUi:()=>{},loadState:async()=>{},renderTimeline(){},api:async(path,options)=>{calls.push([path,JSON.parse(options.body)]);return {project:{id:'p'},selection:{type:'task',id:'copy'}};}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function bindRowClipboard('),source.indexOf('function bindRowRenameShortcut(')),c);c.bindRowClipboard();
 let prevented=0;
 const event={target:{closest:()=>null},clipboardData:{setData:(type,text)=>clipboard[type]=text,getData:type=>clipboard[type]},preventDefault:()=>prevented++};
 events.copy(event);assert.equal(JSON.parse(clipboard['text/plain']).source_id,'a');
 await events.paste(event);
 assert.deepEqual(calls[0],['/api/duplicate',{kind:'task',source_id:'a',project_id:'p',anchor_id:'a'}]);
 assert.equal(state.selection.id,'copy');assert.equal(prevented,2);
 const textEvent={...event,target:{closest:()=>({})}};
 events.copy(textEvent);await events.paste(textEvent);assert.equal(prevented,2);assert.equal(calls.length,1);
 clipboard['text/plain']='ordinary text';await events.paste(event);assert.equal(calls.length,1);
});
