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
    $: selector => selector === '.bar-text' ? null : selector === '.gantt-body' ? body : selector === '.dependency-layer' ? { remove() {} } : {},
    $$: selector => selector === '.project-summary-bar[data-project-select]' ? [] : selector === '.gantt-row[data-project-boundary]' ? [] : selector === '.bar-label-overlay' ? [] : selector === '.has-label-overlay' ? allBars.filter(b=>b.classes.has('has-label-overlay')) : selector === '.task-bar' ? [planned, target] : selector === '.actual-task-bar' ? actual ? [recorded] : [] : allBars.filter(b => b.classes.has('has-dependency')),
    getComputedStyle: b => ({ getPropertyValue: () => b === recorded ? openSide : '', backgroundColor: b.classes.has('svg-backed') ? 'transparent' : '#5872d9',
      borderTopLeftRadius: b.classes.has('dependency-join-left') ? '0px' : '4px',
      borderBottomLeftRadius: b.classes.has('dependency-join-left') ? '0px' : '4px',
      borderTopRightRadius: b.classes.has('dependency-join-right') ? '0px' : '4px',
      borderBottomRightRadius: b.classes.has('dependency-join-right') ? '0px' : '4px' }) };
  withI18n(vm.createContext(context));
  vm.runInContext(source.slice(source.indexOf('function actualTaskRange('), source.indexOf('function renderTimeline(')), context);
  vm.runInContext(source.slice(source.indexOf('const paletteCache'),source.indexOf('function esc('))+source.slice(source.indexOf('function taskProgress('),source.indexOf('function bindTaskProgress(')),context);
  context.renderDependencyLinks();
  return { context, body, allBars, sourceBar: actual ? recorded : planned, target, origin };
}
for(const gap of [true,false]) for(const below of [true,false]) test(`connections pass beneath unrelated bars with connection-colored hatching: gap=${gap}, below=${below}`,()=>{
 const h=harness({gap,below});
 assert.doesNotMatch(h.body.markup,/dependency-hidden-layer/,'endpoints alone never cause hidden-line markings');
 const classes=new Set();
 const blocker={...h.target,classes,classList:{contains:name=>classes.has(name),add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n))},dataset:{taskSelect:'blocker'},
  getBoundingClientRect:()=>({left:h.origin.left+280,right:h.origin.left+460,top:h.origin.top+(below?75:30),bottom:h.origin.top+(below?97:42),width:180,height:below?22:12})};
 const query=h.context.$$;
 h.context.$$=selector=>selector==='.task-bar'?[...query(selector),blocker]:query(selector);
 h.context.renderDependencyLinks();
 assert.match(h.body.markup,/class="dependency-hidden-layer"[^>]*aria-hidden="true"/);
 const mask=h.body.markup.match(/<mask id="dependency-fill-0-under-bars"[^>]*>([\s\S]*?)<\/mask>/)[1];
 assert.match(mask,/<rect[^>]*fill="white"/);
 assert.match(mask,/<path d="M 284 (?:75|30)[^"]*" fill="black"/,'bar silhouette cuts out the connection paint');
 assert.equal((mask.match(/<path /g)||[]).length,1,'endpoint bars are not cut out');
 assert.match(h.body.markup,/class="dependency-paint"[^>]*mask="url\(#dependency-fill-0-under-bars\)"/);
 assert.match(h.body.markup,/class="dependency-progress"[^>]*mask="url\(#dependency-fill-0-under-bars\)"/);
 assert.match(h.body.markup,/class="dependency-crossing-hatch"[^>]*fill="url\(#dependency-fill-0-progress\)"[^>]*mask="url\(#dependency-fill-0-hidden-hatch-mask\)"[^>]*clip-path="url\(#dependency-fill-0-hidden-bars\)"/);
 assert.match(h.body.markup,/pattern id="dependency-fill-0-hidden-hatch" patternUnits="userSpaceOnUse"/);
 assert.doesNotMatch(h.body.markup,/class="dependency-crossing-paint"|class="dependency-hidden-(?:line|halo)"/,'no solid connection overlay or hidden bar contour');
 h.context.$$=query;h.context.renderDependencyLinks();
 assert.doesNotMatch(h.body.markup,/dependency-hidden-layer/,'redraw clears obsolete hidden markings');
});
for (const actual of [false, true]) test(`selected ${actual?'unified':'planned'} bar has one outline and clears on deselection`,()=>{
  const h=harness({actual});
  const planned=h.allBars[0];
  planned.closest=()=>({});
  h.context.state.selection={type:'task',id:'a'};
  h.context.renderDependencyLinks();
  assert.equal((h.body.markup.match(/class="selected-task-outline"/g)||[]).length,1);
  const path=h.body.markup.match(/class="selected-task-outline" d="([^"]+)"/)[1];
  assert.doesNotMatch(path,/NaN|Infinity/);
  if(actual) assert.equal(path,h.body.markup.match(/class="unified-task-paint"[^>]* d="([^"]+)"/)[1]);
  planned.classes.add('blocked');h.context.renderDependencyLinks();
  assert.match(h.body.markup,/class="selected-task-blocked"/);
  h.context.state.selection=null;planned.closest=()=>null;h.context.renderDependencyLinks();
  assert.doesNotMatch(h.body.markup,/class="selected-task-/);
});
test('isolated selected bar renders an outline without dependency links',()=>{
  const h=harness();h.allBars[0].closest=()=>({});h.context.state.selection={type:'task',id:'a'};
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
    const paint = h.body.markup.match(/class="dependency-paint"[^>]* d="([^\"]+)"/)[1];
    assert.equal((paint.match(/M /g) || []).length, 1, 'one exterior contour, no separate touching subpaths');
    assert.equal((paint.match(/Z/g) || []).length, 1, 'only the exterior contour is closed');
    assert(h.body.markup.includes('fill-rule="nonzero"'));
    assert(!h.body.markup.split('<defs><mask id="unified-task-progress-')[0].replace(/<defs>[\s\S]*?<\/defs>/g,'').includes('<rect'), 'connection contours have no seam patch rectangles (masks may use rectangles)');
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
  const paint = h.body.markup.match(/class="dependency-paint"[^>]* d="([^"]+)"/)[1];
  assert.equal((paint.match(/M /g) || []).length, 1);
  assert.equal((paint.match(/Z/g) || []).length, 1);
});

test('finish-only actual dependency paint retains its curved open start', () => {
 const h = harness({actual:true,openSide:'left'});
 const paint = h.body.markup.match(/class="dependency-paint"[^>]* d="([^"]+)"/)[1];
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

test('stacked geometry is computed once per redraw and recomputed after geometry changes',()=>{
 const h=harness({actual:true,startOnly:true,openSide:'right',gap:false});
 const original=h.context.unifiedTaskBarShape;
 let calculations=0;
 h.context.unifiedTaskBarShape=(...args)=>{calculations++;return original(...args);};
 h.context.renderDependencyLinks();
 assert.equal(calculations,1);
 h.context.renderDependencyLinks();
 assert.equal(calculations,2,'cache must not outlive a redraw');
});

test('dependency ribbon connects task UUIDs across project boundaries',()=>{
 const h=harness();
 const [a,b]=h.context.filteredProjects()[0].tasks;
 h.context.filteredProjects=()=>[{id:'p',tasks:[a]},{id:'q',tasks:[b]}];
 h.context.renderDependencyLinks();
 assert.match(h.body.markup,/data-task-select="b" data-predecessor="a"/);
});

test('cross-project routes use facing boundaries and one vertical lane in either direction',()=>{
 const h=harness();
 for(const below of [true,false]) {
   const from={kind:'surface',surfaceX:320,y:below?60:560,width:24};
   const to={surfaceX:480,y:below?560:60,width:24};
   const sourceBounds=below?{top:0,bottom:120}:{top:500,bottom:620};
   const targetBounds=below?{top:500,bottom:620}:{top:0,bottom:120};
   const route=h.context.crossProjectRoute(from,to,sourceBounds,targetBounds);
   assert.equal(route.x,400);
   assert.equal(route.exitY,below?118:502);
   assert.equal(route.entryY,below?502:118);
   const path=h.context.dependencyRibbon({...from,projectRoute:route},to);
   assert(path.includes(`M 397 ${route.exitY} H 403 V ${route.entryY} H 397 Z`));
   assert(!/NaN|Infinity/.test(path));
 }
});
test('adjacent project boundary markers remain distinct and show the opposite project colors',()=>{
 const h=harness();const [a,b]=h.context.filteredProjects()[0].tasks;
 h.context.filteredProjects=()=>[{id:'p',color:'#ff0000',tasks:[a]},{id:'q',color:'#0000ff',tasks:[b]}];
 const query=h.context.$$;
 h.context.$$=selector=>selector==='.gantt-row[data-project-boundary]'?[
   {dataset:{projectBoundary:'p'},getBoundingClientRect:()=>({top:h.origin.top,bottom:h.origin.top+90})},
   {dataset:{projectBoundary:'q'},getBoundingClientRect:()=>({top:h.origin.top+90,bottom:h.origin.top+180})},
 ]:query(selector);
 h.context.renderDependencyLinks();
 assert.match(h.body.markup,/class="dependency-project-boundary" d="M [^"]+ 88 H [^"]+" stroke="#0000ff"/);
 assert.match(h.body.markup,/class="dependency-project-boundary" d="M [^"]+ 92 H [^"]+" stroke="#ff0000"/);
});

test('unequal project heights place the boundary on the joined endpoint chord',()=>{
 const h=harness();
 const from={kind:'surface',surfaceX:200,y:40,width:24};
 const to={surfaceX:500,y:440,width:24};
 const route=h.context.crossProjectRoute(from,to,{top:0,bottom:100},{top:400,bottom:500});
 assert.equal(route.x,380); // 60 / (60 + 40), rather than the horizontal midpoint.
 assert.equal(route.exitX,route.entryX);
 const joined={...to,y:140};
 const adjacent=h.context.crossProjectRoute(from,joined,{top:0,bottom:100},{top:100,bottom:200});
 assert.equal(adjacent.adjacent,true);
 for(const [x,y] of [[adjacent.exitX,adjacent.exitY],[adjacent.entryX,adjacent.entryY]]) {
   assert.equal((x-from.surfaceX)/(joined.surfaceX-from.surfaceX),(y-from.y)/(joined.y-from.y));
 }
 assert.equal(h.context.dependencyRibbon({...from,projectRoute:adjacent},joined),h.context.dependencyRibbon(from,joined));
});

test('either folded endpoint preserves the visible project fragment, including first render while folded',()=>{
 for(const foldSource of [true,false]) {
  const h=harness();const [a,b]=h.context.filteredProjects()[0].tasks;
  a.planned_start='2026-10-06';a.planned_finish='2026-10-07';
  b.planned_start='2026-10-10';b.planned_finish='2026-10-11';
  const p={id:'p',color:'#ff0000',tasks:[a]},q={id:'q',color:'#0000ff',tasks:[b]};
  h.context.filteredProjects=()=>[p,q];
  h.context.state.collapsedProjects=new Set([foldSource?'p':'q']);
  h.context.state.zoom=46;
  h.context.dayDiff=(a,b)=>(Date.parse(b)-Date.parse(a))/86400000;
  const query=h.context.$$;
  h.context.$$=selector=>selector==='.task-bar'?[foldSource?h.target:h.sourceBar]:selector==='.gantt-row[data-project-boundary]'?[
    {dataset:{projectBoundary:'p'},getBoundingClientRect:()=>({top:h.origin.top,bottom:h.origin.top+90})},
    {dataset:{projectBoundary:'q'},getBoundingClientRect:()=>({top:h.origin.top+90,bottom:h.origin.top+180})},
  ]:query(selector);
  h.context.renderDependencyLinks();
  assert.match(h.body.markup,/class="folded-project-connection"/);
  assert.match(h.body.markup,new RegExp(`stroke="${foldSource?'#ff0000':'#0000ff'}"`));
  assert(!/NaN|Infinity/.test(h.body.markup));
 }
});

test('boundary marker progress follows the project timeline coordinate, not the marker percentage',()=>{
 const h=harness(), project={color:'#5872d9',progress:40}, geometry={left:100,width:1000};
 // Project progress boundary is x=500, regardless of where the marker is located.
 const before=h.context.projectBoundaryMarker(project,300,80,geometry);
 assert.match(before,/dependency-project-progress" d="M 286 80 H 314"/);
 const across=h.context.projectBoundaryMarker(project,500,80,geometry);
 assert.match(across,/dependency-project-progress" d="M 486 80 H 500"/);
 assert.doesNotMatch(h.context.projectBoundaryMarker(project,700,80,geometry),/dependency-project-progress/);
 assert.doesNotMatch(h.context.projectBoundaryMarker({...project,progress:0},300,80,geometry),/dependency-project-progress/);
 assert.match(h.context.projectBoundaryMarker({...project,progress:100},1200,80,geometry),/dependency-project-progress" d="M 1186 80 H 1214"/);
});

test('distant tasks do not allocate crossing masks or hidden layers',()=>{
 const h=harness();const query=h.context.$$;
 const far={...h.target,dataset:{taskSelect:'far'},getBoundingClientRect:()=>({left:9000,right:9100,top:9000,bottom:9022,width:100,height:22})};
 h.context.$$=selector=>selector==='.task-bar'?[...query(selector),far]:query(selector);
 h.context.renderDependencyLinks();
 assert.doesNotMatch(h.body.markup,/-under-bars|dependency-hidden-layer|hatch-mask/);
});
test('crossing masks use local geometry, not the full timeline surface',()=>{
 const h=harness();const query=h.context.$$;
 const near={...h.target,dataset:{taskSelect:'near'},getBoundingClientRect:()=>({left:h.origin.left+380,right:h.origin.left+410,top:h.origin.top+75,bottom:h.origin.top+95,width:30,height:20})};
 h.context.$$=selector=>selector==='.task-bar'?[...query(selector),near]:query(selector);
 h.context.renderDependencyLinks();
 const masks=[...h.body.markup.matchAll(/<mask[^>]*width="([\d.]+)" height="([\d.]+)"/g)];
 assert.equal(masks.length,2);
 assert(masks.every(match=>Number(match[1])<300&&Number(match[2])<120));
});

test('same-row periods connect exact task endpoints and select only one task',()=>{
 const h=harness(),[a,b]=h.context.filteredProjects()[0].tasks;
 Object.assign(a,{name:'Repeated',gantt_row_id:'row'});Object.assign(b,{name:'Repeated',gantt_row_id:'row'});
 h.context.filteredProjects=()=>[{id:'p',name:'Project',tasks:[a,b]}];
 const before=h.target.getBoundingClientRect();const source=h.sourceBar.getBoundingClientRect();
 h.target.getBoundingClientRect=()=>({...before,top:source.top,bottom:source.bottom});
 h.allBars.forEach(bar=>bar.closest=()=>({})); // Both bars share a highlighted row.
 h.context.state.selection={type:'task',id:'b'};
 h.context.renderDependencyLinks();
 const path=h.body.markup.match(/class="dependency-link[^"]*" d="([^"]+)"/)[1];
 const n=path.match(/-?\d+(?:\.\d+)?/g).map(Number);
 assert.equal(n[0],source.right-h.origin.left);
 assert.equal(n[1],source.top-h.origin.top);
 assert.equal(n[96],before.left-h.origin.left);
 assert.equal(n[97],source.top-h.origin.top);
 assert.match(h.body.markup,/data-task-select="b" data-predecessor="a"/);
 assert.equal((h.body.markup.match(/class="selected-task-outline"/g)||[]).length,1);
 assert.match(h.body.markup,/class="selected-task-outline"[^>]*data-selected-task="b"/);
 assert.match(h.body.markup,/Repeated · 작업1/);assert.match(h.body.markup,/Repeated · 작업2/);
});

test('a repeated task owns its actual endpoint and outgoing edge, not its sibling',()=>{
 const h=harness({actual:true}),[a,b]=h.context.filteredProjects()[0].tasks;
 Object.assign(a,{name:'Repeated',gantt_row_id:'row',dependencies:[]});
 Object.assign(b,{name:'Repeated',gantt_row_id:'row',dependencies:[],planned_finish:'2026-10-07',actual_finish:'2026-10-09'});
 const c={id:'c',name:'Next',dependencies:['b']};
 const rect=h.target.getBoundingClientRect();
 const actualB={...h.sourceBar,dataset:{taskSelect:'b'},getBoundingClientRect:()=>({...rect,top:rect.top+22,bottom:rect.top+42,height:20})};
 const next={...h.allBars[0],dataset:{taskSelect:'c'},getBoundingClientRect:()=>({...rect,left:rect.right+92,right:rect.right+184,top:rect.top+80,bottom:rect.top+102})};
 const query=h.context.$$;
 h.context.$$=selector=>selector==='.task-bar'?[h.allBars[0],h.target,next]:selector==='.actual-task-bar'?[actualB]:query(selector);
 h.context.filteredProjects=()=>[{id:'p',tasks:[a,b,c]}];
 h.context.renderDependencyLinks();
 assert.match(h.body.markup,/data-task-select="c" data-predecessor="b" data-source-period="actual"/);
 assert.doesNotMatch(h.body.markup,/data-predecessor="a"/);
 const n=h.body.markup.match(/class="dependency-link[^"]*" d="([^"]+)"/)[1].match(/-?\d+(?:\.\d+)?/g).map(Number);
 assert.equal(n[0],actualB.getBoundingClientRect().right-h.origin.left);
 assert.equal(n[1],actualB.getBoundingClientRect().top-h.origin.top);
});

test('folded geometry uses shared row heights and overlapping tier offsets',()=>{
 const h=harness();h.context.dayDiff=(a,b)=>(Date.parse(b)-Date.parse(a))/86400000;
 const a={id:'a',gantt_row_id:'row',planned_start:'2026-10-01',planned_finish:'2026-10-03'};
 const b={id:'b',gantt_row_id:'row',planned_start:'2026-10-07',planned_finish:'2026-10-09'};
 const c={id:'c',planned_start:'2026-10-10',planned_finish:'2026-10-11'};
 const p={tasks:[a,b,c]},origin={top:0},bounds={top:0,bottom:38},reference={left:0,date:'2026-10-01'};
 const geometry=(task,actual=false,above=false)=>h.context.foldedTaskGeometry(p,task,actual,bounds,above,reference,46,origin);
 assert.equal(geometry(a).rect.top,45);assert.equal(geometry(b).rect.top,45);
 assert.equal(geometry(c).rect.top,81);assert.equal(geometry(c).bounds.bottom,110);
 assert.equal(geometry(b,false,true).rect.top,38-110+45);
 b.actual_start='2026-10-07';b.actual_finish='2026-10-09';
 assert.equal(geometry(b,true).rect.top,67);assert.equal(geometry(c).rect.top,99);
 b.planned_start='2026-10-03';
 assert.equal(geometry(b).rect.top,99);assert.equal(geometry(b,true).rect.top,121);
});

test('template selection remains independent of the selected schedule task',()=>{
 const h=harness();h.context.state.selection={type:'task',id:'a'};h.context.state.templateTaskKey='b';
 h.context.renderDependencyLinks({chart:{},projects:h.context.filteredProjects()});
 assert.equal((h.body.markup.match(/class="selected-task-outline"/g)||[]).length,1);
 assert.match(h.body.markup,/class="selected-task-outline"[^>]*data-selected-task="b"/);
});

for (const actual of [false,true]) test(`selection sits in its own overlay across progress changes: actual=${actual}`,()=>{
 const h=harness({actual});const projects=h.context.filteredProjects();
 h.context.filteredProjects=()=>projects;h.context.state.selection={type:'task',id:'a'};
 for(const progress of [0,50,100]) {
  projects[0].tasks[0].progress=progress;h.context.renderDependencyLinks();
  const base=h.body.markup.match(/<svg class="dependency-layer"[^>]*>([\s\S]*?)<\/svg>/)[1];
  const overlay=h.body.markup.match(/<svg class="task-selection-layer"[^>]*aria-hidden="true"[^>]*>([\s\S]*?)<\/svg>/)[1];
  assert.doesNotMatch(base,/selected-task-outline/);
  assert.match(overlay,/class="selected-task-outline"[^>]*data-selected-task="a"/);
  assert.equal((overlay.match(/class="selected-task-outline"/g)||[]).length,1);
 }
 const query=h.context.$;let removed=0;
 h.context.$=selector=>selector==='.task-selection-layer'?{remove:()=>removed++}:query(selector);
 h.context.state.selection=null;h.context.renderDependencyLinks();
 assert.equal(removed,1);assert.doesNotMatch(h.body.markup,/task-selection-layer/);
});
