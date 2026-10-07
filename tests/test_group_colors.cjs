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
