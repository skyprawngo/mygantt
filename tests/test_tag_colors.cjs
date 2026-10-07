const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const src=fs.readFileSync('web/app.js','utf8'),c={};vm.createContext(c);
vm.runInContext(src.slice(src.indexOf('function normalizeGroupName('),src.indexOf('function groupNames('))+src.slice(src.indexOf('function firstTagColor('),src.indexOf('function bindTagColors(')),c);
test('first explicitly colored tag determines family with normalized identity',()=>{
 const colors={'team a':'#cc6600',other:'#229944'};
 assert.equal(c.firstTagColor('unknown, Ｔeam   A, other',colors),'#cc6600');
 assert.equal(c.firstTagColor('other, team a',colors),'#229944');
 assert.equal(c.firstTagColor('unknown',colors),null);
 assert.equal(c.firstTagColor('',colors),null);
});
test('random button uses tags, never group or owner, and tags precede notes',()=>{
 const random=src.slice(src.indexOf('function bindRandomColorButtons('),src.indexOf('function newProjectColor('));
 assert.ok(random.includes('firstTagColor'));
 assert.ok(!random.includes('groupRandomColor'));assert.ok(!random.includes('groupInput'));
 assert.ok(src.indexOf('id="ins-task-tags"')>src.indexOf('id="ins-task-owner"'));
 assert.ok(src.indexOf('id="ins-task-tags"')<src.indexOf('id="ins-task-notes"'));
});
vm.runInContext(src.slice(src.indexOf('function mergeTagTokens('),src.indexOf('function bindTagColors(')),c);
test('tag tokens append, trim and deduplicate comma-separated names',()=>{
 assert.deepEqual(Array.from(c.mergeTagTokens(['Alpha'],'Beta, Gamma')) ,['Alpha','Beta','Gamma']);
 assert.deepEqual(Array.from(c.mergeTagTokens(['Alpha'],' ALPHA, , Ｂeta  ')),['ALPHA','Beta']);
 assert.deepEqual(Array.from(c.mergeTagTokens([],', ,')),[]);
});
test('tag popover random selection has no family restriction and persists through the API',()=>{
 const ui=src.slice(src.indexOf('function bindTagColors('),src.indexOf('// A manual choice'));
 assert.ok(ui.includes("event.key===',' || event.key==='Enter'"));
 assert.ok(ui.includes('event.isComposing || event.keyCode===229'));
 assert.ok(ui.includes("setAttribute('popover','auto')"));
 assert.ok(ui.includes('selectColor(newProjectColor('));
 assert.ok(!ui.includes('manualColorVariant('));
 assert.ok(ui.includes("api('/api/settings/tag-color'"));
});
