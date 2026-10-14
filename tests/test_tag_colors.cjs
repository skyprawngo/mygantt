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
test('uncolored tags have stable automatic colors and manual colors take precedence',()=>{
 c.state={data:{tag_colors:{}}};c.projectColors=['#5872d9','#b96749','#27897f'];
 assert.match(c.resolvedTagColor('신규 태그'),/^#[0-9a-f]{6}$/);
 assert.equal(c.resolvedTagColor(' Ｔeam   A '),c.resolvedTagColor('team a'));
 c.state.data.tag_colors['team a']='#123456';assert.equal(c.resolvedTagColor('TEAM A'),'#123456');
});
test('creating tags persists missing colors without overwriting existing manual choices',()=>{
 const calls=[];c.state={data:{tag_colors:{existing:'#123456'}}};c.projectColors=['#5872d9','#b96749'];
 c.api=(path,options)=>{calls.push({path,...JSON.parse(options.body)});return Promise.resolve();};c.toast=()=>{};
 c.ensureTagColors(['existing','new']);assert.equal(calls.length,1);assert.equal(calls[0].tag,'new');assert.match(calls[0].color,/^#[0-9a-f]{6}$/);
});
