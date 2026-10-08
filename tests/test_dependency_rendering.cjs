const withI18n = require('./i18n_context.cjs');
// Run with: node --test tests/test_dependency_rendering.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');
function harness({ actual = false, below = true, gap = true, openSide = '', barWidth = 92, startOnly = false } = {}) {
  const origin = { left: 17.375, top: -83.625 };
  function bar(id, x, y, width, height) {
    const classes = new Set();
    return { dataset: { taskSelect: id }, classes,
      classList: { contains: name => classes.has(name), add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)) },
      getBoundingClientRect: () => ({ left: origin.left + x, right: origin.left + x + width, top: origin.top + y, bottom: origin.top + y + height, width, height }) };
  }
  const planned = bar('a', 254, 45, barWidth, 22);
  const recorded = bar('a', 254, startOnly ? 67 : 64, barWidth, 20);
  if (openSide) recorded.classes.add(`open-${openSide}`);
  const target = bar('b', gap ? 438 : Math.min(330, 254 + barWidth - 4), below ? 110 : 7, barWidth, 22);
  const body = { getBoundingClientRect: () => origin, scrollWidth: 1000, offsetHeight: 180,
    insertAdjacentHTML(_, markup) { this.markup = markup; } };
  const allBars = [planned, target, ...(actual ? [recorded] : [])];
  const context = { state: { layout: 'gantt', drag: null }, esc: v => String(v),
    filteredProjects: () => [{ name: 'test', tasks: [
      { id: 'a', name: 'A', dependencies: [], planned_finish: '2026-10-07', actual_finish: actual && !startOnly ? '2026-10-08' : null },
      { id: 'b', name: 'B', dependencies: ['a'] } ] }],
    $: selector => selector === '.gantt-body' ? body : selector === '.dependency-layer' ? { remove() {} } : {},
    $$: selector => selector === '.task-bar' ? [planned, target] : selector === '.actual-task-bar' ? actual ? [recorded] : [] : allBars.filter(b => b.classes.has('has-dependency')),
    getComputedStyle: b => ({ getPropertyValue: () => b === recorded ? openSide : '', backgroundColor: b.classes.has('svg-backed') ? 'transparent' : '#5872d9',
      borderTopLeftRadius: b.classes.has('dependency-join-left') ? '0px' : '4px',
      borderBottomLeftRadius: b.classes.has('dependency-join-left') ? '0px' : '4px',
      borderTopRightRadius: b.classes.has('dependency-join-right') ? '0px' : '4px',
      borderBottomRightRadius: b.classes.has('dependency-join-right') ? '0px' : '4px' }) };
  withI18n(vm.createContext(context));
  vm.runInContext(source.slice(source.indexOf('function dependencyRibbon('), source.indexOf('function renderTimeline(')), context);
  vm.runInContext(source.slice(source.indexOf('const paletteCache'),source.indexOf('function esc('))+source.slice(source.indexOf('function taskProgress('),source.indexOf('function bindTaskProgress(')),context);
  context.renderDependencyLinks();
  return { context, body, allBars, sourceBar: actual ? recorded : planned, target, origin };
}
for(const gap of [true,false]) for(const below of [true,false]) test(`hidden ribbon clips unrelated bars only: gap=${gap}, below=${below}`,()=>{
 const h=harness({gap,below});
 assert.doesNotMatch(h.body.markup,/dependency-hidden-layer/,'endpoints alone never cause hidden-line markings');
 const classes=new Set();
 const blocker={...h.target,classes,classList:{contains:name=>classes.has(name),add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n))},dataset:{taskSelect:'blocker'},
  getBoundingClientRect:()=>({left:h.origin.left+280,right:h.origin.left+460,top:h.origin.top+75,bottom:h.origin.top+97,width:180,height:22})};
 const query=h.context.$$;
 h.context.$$=selector=>selector==='.task-bar'?[...query(selector),blocker]:query(selector);
 h.context.renderDependencyLinks();
 assert.match(h.body.markup,/class="dependency-hidden-layer"[^>]*aria-hidden="true"/);
 const clip=h.body.markup.match(/id="dependency-fill-0-hidden"[^>]*>(.*?)<\/clipPath>/)[1];
 assert.equal((clip.match(/<path /g)||[]).length,1,'only the unrelated silhouette clips the hidden section');
 assert.match(clip,/M 284 75/);
 assert.match(h.body.markup,/class="dependency-hidden-hatch"/);
 assert.match(h.body.markup,/class="dependency-hidden-line"/);
 h.context.$$=query;h.context.renderDependencyLinks();
 assert.doesNotMatch(h.body.markup,/dependency-hidden-layer/,'redraw clears obsolete hidden markings');
});
for (const actual of [false, true]) test(`selected ${actual?'unified':'planned'} bar has one outline and clears on deselection`,()=>{
  const h=harness({actual});
  const planned=h.allBars[0];
  planned.closest=()=>({});
  h.context.renderDependencyLinks();
  assert.equal((h.body.markup.match(/class="selected-task-outline"/g)||[]).length,1);
  const path=h.body.markup.match(/class="selected-task-outline" d="([^"]+)"/)[1];
  assert.doesNotMatch(path,/NaN|Infinity/);
  if(actual) assert.equal(path,h.body.markup.match(/class="unified-task-paint"[^>]* d="([^"]+)"/)[1]);
  planned.classes.add('blocked');h.context.renderDependencyLinks();
  assert.match(h.body.markup,/class="selected-task-blocked"/);
  planned.closest=()=>null;h.context.renderDependencyLinks();
  assert.doesNotMatch(h.body.markup,/class="selected-task-/);
});
test('isolated selected bar renders an outline without dependency links',()=>{
  const h=harness();h.allBars[0].closest=()=>({});
  h.context.filteredProjects=()=>[{tasks:[{id:'a',dependencies:[]},{id:'b',dependencies:[]}]}];
  h.context.renderDependencyLinks();
  assert.match(h.body.markup,/class="selected-task-outline"/);
  assert.doesNotMatch(h.body.markup,/class="dependency-link/);
});
for (const actual of [false, true]) for (const below of [false, true]) {
  test(`full-height shared SVG faces: ${actual ? 'actual 20px' : 'planned 22px'}, ${below ? 'downward' : 'upward'}, fractional origin`, () => {
    const h = harness({ actual, below });
    const d = h.body.markup.match(/class="dependency-link[^\"]*" d="([^\"]+)"/)[1];
    const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const s = h.sourceBar.getBoundingClientRect(), t = h.target.getBoundingClientRect();
    assert.equal(n[1], s.top - h.origin.top);
    assert.equal(n[n.length-1], s.bottom - h.origin.top);
    assert.equal(n[97], t.top - h.origin.top);
    assert.equal(n[99], t.bottom - h.origin.top);
    const paint = h.body.markup.match(/class="dependency-paint" d="([^\"]+)"/)[1];
    assert.equal((paint.match(/M /g) || []).length, 1, 'one exterior contour, no separate touching subpaths');
    assert.equal((paint.match(/Z/g) || []).length, 1, 'only the exterior contour is closed');
    assert(h.body.markup.includes('fill-rule="nonzero"'));
    assert(!h.body.markup.split('<defs><mask id="unified-task-progress-')[0].includes('<rect'), 'connection contours have no seam patch rectangles (unified masks may use rectangles)');
    assert(h.sourceBar.classes.has('svg-backed'));
    h.context.renderDependencyLinks();
    assert(!h.body.markup.includes('stop-color="transparent"'), 'redraw restores colors before measuring');
    h.context.state.layout = 'list'; h.context.renderDependencyLinks();
    assert(h.allBars.every(b => !b.classes.has('svg-backed')), 'HTML fill restored when leaving SVG rendering');
  });
}
for (const below of [false, true]) test(`surface connections meet exact bar surfaces without offsets: ${below ? 'downward' : 'upward'}`, () => {
  const h = harness({ gap: false, below });
  const d = h.body.markup.match(/class="dependency-link[^\"]*" d="([^\"]+)"/)[1];
  const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.equal(n[1], h.sourceBar.getBoundingClientRect()[below ? 'bottom' : 'top'] - h.origin.top);
  assert.equal(n[97], h.target.getBoundingClientRect()[below ? 'top' : 'bottom'] - h.origin.top);
  assert.equal(n[n.length-2], h.sourceBar.getBoundingClientRect().right-h.origin.left-7, 'source avoids corner radius plus 3px');
  assert.equal(n[96], h.target.getBoundingClientRect().left-h.origin.left+7, 'target avoids corner radius plus 3px');
  const paint = h.body.markup.match(/class="dependency-paint" d="([^"]+)"/)[1];
  assert.equal((paint.match(/M /g) || []).length, 1);
  assert.equal((paint.match(/Z/g) || []).length, 1);
});

test('finish-only actual dependency paint retains its curved open start', () => {
 const h = harness({actual:true,openSide:'left'});
 const paint = h.body.markup.match(/class="dependency-paint" d="([^"]+)"/)[1];
 const curves = [...paint.matchAll(/C\s+([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)/g)].map(m=>m.slice(1).map(Number));
 assert.ok(curves.some(c => Math.abs(c[0]-286.89)<.001 && c[1]===84 && c[4]===254 && c[5]===64));
 assert.equal((paint.match(/M /g)||[]).length,1);
});

for (const actual of [false, true]) for (const below of [false, true]) {
  test(`overlap attachment stays bounded across task durations: actual=${actual}, below=${below}`, () => {
    for (const barWidth of [20, 92, 420]) {
      const h = harness({ actual, below, gap: false, barWidth });
      const d = h.body.markup.match(/class="dependency-link[^\"]*" d="([^\"]+)"/)[1];
      const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
      const sourceWidth = n[n.length - 2] - n[0];
      const targetWidth = n[98] - n[96];
      assert(sourceWidth > 0 && sourceWidth <= 33);
      assert(targetWidth > 0 && targetWidth <= 33);
      assert(sourceWidth <= barWidth && targetWidth <= barWidth);
    }
  });
}

test('start-only actual fillet is not painted over by the planned dependency endpoint',()=>{
 const h=harness({actual:true,startOnly:true,openSide:'right',gap:false,barWidth:414});
 const markup=h.body.markup;
 assert.ok(markup.includes("-stacked"),markup);
 const clip=markup.match(/id="dependency-fill-0-stacked"[^>]*>([\s\S]*?)<\/clipPath>/)[1];
 const contour=markup.match(/class="unified-task-paint"[^>]* d="([^"]+)"/)[1];
 assert.ok(contour.includes(' Q 668 67 '),'planned finish joins the open actual curve with a fillet');
 assert.ok(clip.includes(`d="${contour}"`),'endpoint clip uses the exact unified exterior');
 assert.match(markup,/class="dependency-paint"[^>]*clip-path="url\(#dependency-fill-0-stacked\)"/);
 assert.equal((clip.match(/<path /g)||[]).length,3,'both endpoints and the connecting ribbon remain visible');
});
