const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
const c={};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function taskDropPlacement('),source.indexOf('function bindTaskReordering(')),c);
const drop=(target,manual=true)=>JSON.parse(JSON.stringify(c.taskDropPlacement({id:'a',projectId:'p'},target,manual)));
test('folder, root and cross-project insertion share one placement contract',()=>{
 assert.deepEqual(drop({projectId:'q'}),{project_id:'q'});
 assert.deepEqual(drop({projectId:'__unassigned__'}),{project_id:null});
 assert.deepEqual(drop({projectId:'q',taskId:'b',after:true}),{project_id:'q',anchor_id:'b',after:true});
 assert.deepEqual(drop({projectId:'p',taskId:'b',after:false}),{project_id:'p',anchor_id:'b',after:false});
 assert.equal(drop({projectId:'p',taskId:'a'}),null);
 assert.equal(drop(null),null);
});
test('sorted views allow folder moves without implying a manual insertion position',()=>{
 assert.deepEqual(drop({projectId:'q',taskId:'b',after:true},false),{project_id:'q'});
 assert.equal(drop({projectId:'p',taskId:'b',after:true},false),null);
});
