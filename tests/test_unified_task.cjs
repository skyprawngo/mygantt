const withI18n = require('./i18n_context.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
const c={getComputedStyle:()=>({borderTopLeftRadius:'4px',borderTopRightRadius:'4px',borderBottomRightRadius:'4px',borderBottomLeftRadius:'4px'}),esc:String,taskProgress:t=>t.progress,colorPalette:()=>({dark:'#111111',base:'#888888'})};withI18n(vm.createContext(c));
vm.runInContext(source.slice(source.indexOf('function unifiedTaskShape('),source.indexOf('function renderDependencyLinks(')),c);
vm.runInContext(source.slice(source.indexOf('const paletteCache'),source.indexOf('function esc('))+source.slice(source.indexOf('function attachmentProgress('),source.indexOf('function unifiedTaskShape(')),c);
const p={left:0,right:100,top:7,bottom:29,width:100};
for(const [left,right] of [[30,150],[-30,70],[20,80],[-20,120],[0,100]]) test(`single contour for stacked range ${left} to ${right}`,()=>{
 const s=c.unifiedTaskShape(p,{left,right,top:29,bottom:49,width:right-left});
 assert.equal((s.path.match(/M /g)||[]).length,1);assert.equal((s.path.match(/Z/g)||[]).length,1);
 assert.equal(s.left,Math.min(0,left));assert.equal(s.right,Math.max(100,right));
});
test('open actual curves retained; disjoint dates never gain a bridge',()=>{
 const a={left:20,right:120,top:29,bottom:49,width:100};
 for(const side of ['left','right']) assert.match(c.unifiedTaskShape(p,a,side).path,/ C /);
 assert.equal((c.unifiedTaskShape(p,{...a,left:150,right:250}).path.match(/M /g)||[]).length,2);
});
test('one user-space progress gradient for both tiers, including zero and complete',()=>{
 const bar=r=>({getBoundingClientRect:()=>r,classList:{contains:()=>false,add(){}}});
 for(const progress of [0,40,90,100]) {
  const paint=c.unifiedTaskPaint({id:'a',progress},bar(p),bar({left:30,right:150,top:29,bottom:49,width:120}),{left:0,top:0},0);
  assert.equal((paint.match(/<path /g)||[]).length,2);
  assert.match(paint,/maskUnits="userSpaceOnUse"/);
  const mask=paint;
  assert.match(mask,/width="150" height="42"/);
  assert.match(mask,/<linearGradient id="unified-task-progress-0-front">/);
 }
});

test('rounds exterior and reentrant corners but respects zero attachment radii',()=>{
 const a={left:30,right:150,top:29,bottom:49,width:120};
 const rounded=c.unifiedTaskShape(p,a).path;
 assert.equal((rounded.match(/ Q /g)||[]).length,8);
 const attached=c.unifiedTaskShape(p,a,'',[4,0,0,4],[0,4,4,0]).path;
 assert.equal((attached.match(/ Q /g)||[]).length,4);
 assert.doesNotMatch(attached,/ Q 100 7 | Q 100 29 | Q 30 29 | Q 30 49 /);
});
test('aligned and short edges have finite clamped corner geometry',()=>{
 for(const a of [{left:0,right:100,top:29,bottom:49,width:100},{left:99,right:101,top:29,bottom:49,width:2}]) {
  const path=c.unifiedTaskShape(p,a).path;
  assert.doesNotMatch(path,/NaN|Infinity/);
  assert.equal((path.match(/M /g)||[]).length,1);
 }
});
test('partial actual tier keeps rounding on its closed side',()=>{
 const a={left:30,right:150,top:29,bottom:49,width:120};
 assert.match(c.unifiedTaskShape(p,a,'right').path,/ Q 30 49 /);
 assert.match(c.unifiedTaskShape(p,a,'right').path,/ Q 30 29 /);
 assert.match(c.unifiedTaskShape(p,a,'left').path,/ Q 150 49 /);
 const attached=c.unifiedTaskShape(p,a,'right',[4,4,4,4],[0,4,4,0]).path;
 assert.doesNotMatch(attached,/ Q 30 49 | Q 30 29 /);
});

test('both tier attachments are translated into one shared progress mask on every redraw',()=>{
 const bar=r=>({getBoundingClientRect:()=>r,classList:{contains:()=>false,add(){}}});
 const planned=bar({...p,height:22}),actual=bar({left:30,right:150,top:29,bottom:49,width:120,height:20});
 const ports=new Map([[planned,{ports:[{side:'top',x:40,width:30,direction:'incoming'}]}],[actual,{ports:[{side:'right',direction:'outgoing'}]}]]);
 const render=progress=>c.unifiedTaskPaint({id:'a',progress},planned,actual,{left:0,top:0},0,ports);
 const mask=render(90);
 assert.match(mask,/cx="40" cy="0"/);
 assert.match(mask,/cx="150" cy="32"/);
 assert.match(mask,/rx="30" ry="26"/);
 assert.notEqual(mask,render(95));
 assert.match(render(95),/<g opacity="0.5">/);
 ports.get(actual).ports=[{side:'top',x:60,width:20,direction:'outgoing'}];
 assert.match(render(90),/cx="90" cy="22"/);
});

test('aligned open-left curve rounds into the planned lower-left edge',()=>{
 const a={left:0,right:80,top:29,bottom:49,width:80};
 const path=c.unifiedTaskShape(p,a,'left').path;
 assert.match(path,/ Q 0 29 0 25/);
 assert.doesNotMatch(path,/NaN|Infinity/);
});
test('start-only actual rounds the planned finish into the open curve with matching tangents',()=>{
 const a={left:20,right:100,top:29,bottom:49,width:80};
 const path=c.unifiedTaskShape(p,a,'right').path;
 assert.match(path,/L 100 25 Q 100 29 96 29 C 76\.6 29 71\.4 49 48 49/);
});
for(const [dateCase,side,a,corner] of [
 ['start only','right',{left:20,right:100,top:29,bottom:49,width:80},'100 29'],
 ['finish only','left',{left:0,right:80,top:29,bottom:49,width:80},'0 29'],
 ['both','',{left:20,right:120,top:29,bottom:49,width:100},'100 29'],
]) {
 for(const attachment of ['none','top','bottom','left','right']) test(`${dateCase}: ${attachment} attachment corner classification`,()=>{
  const pr=[4,4,4,4];
  if(attachment==='left') pr[0]=pr[3]=0;
  if(attachment==='right') pr[1]=pr[2]=0;
  const path=c.unifiedTaskShape(p,a,side,pr).path;
  const square=side==='left'?attachment==='left':attachment==='right';
  assert.equal(path.includes(` Q ${corner} `),!square);
  assert.doesNotMatch(path,/NaN|Infinity/);
 });
}
test('open curves remain finite at narrow widths and separated dates',()=>{
 for(const width of [1,2,4,8,20,80,300]) for(const side of ['left','right']) {
  const a={left:side==='left'?0:100-width,right:side==='left'?width:100,top:29,bottom:49,width};
  const path=c.unifiedTaskShape(p,a,side).path;
  assert.doesNotMatch(path,/NaN|Infinity/);
  assert.equal((path.match(/M /g)||[]).length,1);
 }
});
test('unified grips and masks are inline SVG without nested image decoding',()=>{
 const bar=r=>({getBoundingClientRect:()=>r,classList:{contains:()=>false,add(){}}});
 const paint=c.unifiedTaskPaint({id:'a',progress:100,actual_finish:'2026-10-04'},bar(p),bar({left:0,right:80,top:29,bottom:49,width:80}),{left:0,top:0},0);
 assert.doesNotMatch(paint,/<image|data:image/);
 assert.equal((paint.match(/class="unified-task-grip"/g)||[]).length,3);
 assert.match(paint,/id="unified-task-progress-0-fill"/);
 assert.match(paint,/url\(#unified-task-progress-0-fill\)/);
});

test('blocked unified bar outlines its exterior once without a tier seam',()=>{
 const bar=r=>({getBoundingClientRect:()=>r,classList:{contains:()=>false,add(){}}});
 const args=[bar(p),bar({left:30,right:150,top:29,bottom:49,width:120}),{left:0,top:0},0];
 const paint=c.unifiedTaskPaint({id:'a',progress:40,status:'blocked'},...args);
 const outline=paint.match(/class="blocked-task-outline" d="([^"]+)"/)[1];
 assert.equal(outline,paint.match(/class="unified-task-paint"[^>]* d="([^"]+)"/)[1]);
 assert.equal((outline.match(/M /g)||[]).length,1);
 assert.doesNotMatch(c.unifiedTaskPaint({id:'a',progress:40,status:'doing'},...args),/blocked-task-outline/);
});

test('completed unified bars do not leave a light base-color halo beneath antialiased progress edges',()=>{
 const bar=r=>({getBoundingClientRect:()=>r,classList:{contains:()=>false,add(){}}});
 for(const progress of [90,100]) {
  const markup=c.unifiedTaskPaint({id:'a',color:'#27897f',progress},bar(p),bar({left:0,right:80,top:29,bottom:49,width:80}),{left:0,top:0},0);
  const fill=markup.match(/class="unified-task-paint"[^>]*fill="([^"]+)"/)[1];
  assert.equal(fill,progress===100?c.colorPalette('#27897f').progress:c.colorPalette('#27897f').base);
 }
});

test('subpixel tier boundaries keep the open finish fillet instead of a near-zero radius',()=>{
 const exact={left:20,right:100,top:29,bottom:49,width:80};
 const expected=c.unifiedTaskShape(p,exact,'right').path;
 for(const dx of [-.25,-.000001,.000001,.25]) for(const dy of [-.25,.25]) {
  const actual={...exact,right:100+dx,top:29+dy,width:80+dx};
  assert.equal(c.unifiedTaskShape(p,actual,'right').path,expected);
 }
 const left={left:0,right:80,top:29,bottom:49,width:80};
 assert.equal(c.unifiedTaskShape(p,{...left,left:.25,top:29.25,width:79.75},'left').path,c.unifiedTaskShape(p,left,'left').path);
});
