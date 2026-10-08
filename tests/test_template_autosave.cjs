const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const withI18n=require('./i18n_context.cjs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
function harness(api){
 const draft={name:'Template',tasks:[{key:'a',name:'Task',duration_value:1,duration_unit:'days',dependencies:[]}]};
 const c={state:{draft,data:{templates:[],projects:[]},view:'templates'},projectColors:['#123456'],taskColors:['#123456'],api,$:()=>null,$$:()=>[],syncDraftFromEditor(){},templateSchedule(){},renderTemplateList(){},toast(){}};
 require('./mutation_context.cjs')(c,api);
 withI18n(vm.createContext(c));vm.runInContext(source.slice(source.indexOf('let templateSaveQueue ='),source.indexOf('async function deleteTemplate(')),c);
 return c;
}
test('new template saves serialize, adopt created ID, and retain live edits and identity',async()=>{
 const calls=[];let release;
 const c=harness(async(path,options)=>{calls.push({path,...options}); if(calls.length===1)await new Promise(resolve=>release=resolve);return {id:'created',...JSON.parse(options.body)};});
 const draft=c.state.draft;
 c.queueTemplateSave();await new Promise(resolve=>setImmediate(resolve));
 draft.tasks[0].name='Second';const pending=c.queueTemplateSave();
 draft.tasks[0].name='Still typing';release();await pending;
 assert.equal(calls.length,2);assert.equal(calls[0].method,'POST');assert.equal(calls[1].method,'PUT');
 assert.equal(calls[1].path,'/api/templates/created');assert.equal(c.state.draft,draft);
 assert.equal(draft.tasks[0].name,'Still typing');assert.equal(c.state.data.templates[0].tasks[0].name,'Second');
});
test('duplicate blur and change saves coalesce, failed save retries',async()=>{
 let count=0;const c=harness(async(path,options)=>{if(++count===1)throw Error('offline');return {id:'saved',...JSON.parse(options.body)};});
 const first=c.queueTemplateSave();c.queueTemplateSave();await first;assert.equal(count,1);
 await c.queueTemplateSave();assert.equal(count,2);
 await c.queueTemplateSave();assert.equal(count,2);
});
test('invalid draft never sends request',async()=>{
 let count=0;const c=harness(async()=>{count++;});c.state.draft.name='';await c.queueTemplateSave();assert.equal(count,0);
});
test('template and task group/tag values survive queued saves and can be cleared',async()=>{
 const payloads=[];
 const c=harness(async(path,options)=>{const payload=JSON.parse(options.body);payloads.push(payload);return {id:'saved',...payload};});
 Object.assign(c.state.draft,{group_name:'Production',tags:['Batch']});
 Object.assign(c.state.draft.tasks[0],{group_name:'QA',tags:['Check']});
 await c.queueTemplateSave();
 assert.equal(payloads[0].group_name,'Production');assert.deepEqual(payloads[0].tags,['Batch']);
 assert.equal(payloads[0].tasks[0].group_name,'QA');assert.deepEqual(payloads[0].tasks[0].tags,['Check']);
 Object.assign(c.state.draft,{group_name:'',tags:[]});
 Object.assign(c.state.draft.tasks[0],{group_name:'',tags:[]});
 await c.queueTemplateSave();
 assert.equal(payloads[1].group_name,'');assert.deepEqual(payloads[1].tasks[0].tags,[]);
});
test('focusout listener is registered once per render and ignores disabled fields',async()=>{
 const handlers=new Map();let calls=0;
 const editor={addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:(name,fn)=>{if(handlers.get(name)===fn)handlers.delete(name);}};
 const c=harness(async(path,options)=>{calls++;return {id:'t',...JSON.parse(options.body)};});
 c.$=selector=>selector==='#template-editor'?editor:null;c.bindInspectorFocusToggle=()=>{};c.disableFieldSuggestions=()=>{};
 c.bindTemplateAutoSave();c.bindTemplateAutoSave();assert.equal(handlers.size,1);
 handlers.get('focusout')({target:{matches:()=>true,disabled:true}});await Promise.resolve();assert.equal(calls,0);
 handlers.get('focusout')({target:{matches:()=>true,disabled:false}});await c.queueTemplateSave();assert.equal(calls,1);
});
