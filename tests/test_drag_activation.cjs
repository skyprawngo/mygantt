const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/app.js', 'utf8');
function setup(pointerType, edge) {
  const handlers={}, timers=[];
  const classes=new Set();
  const bar={dataset:{project:'p',taskSelect:'t'},style:{left:'0px',width:'92px'},isConnected:true,classList:{add:x=>classes.add(x)},setPointerCapture:()=>{}};
  const handle=edge?{dataset:{resizeEdge:edge},closest:()=>bar,setPointerCapture:()=>{}}:null;
  const context={state:{zoom:46,data:{projects:[{id:'p',tasks:[{id:'t',planned_start:'2026-10-14',planned_finish:'2026-10-15'}]}]}}, $:()=>({addEventListener:(name,fn)=>handlers[name]=fn}),setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;}};
  vm.createContext(context);
  const start=source.indexOf("  $('#gantt').addEventListener('pointerdown'");
  const end=source.indexOf("  $('#gantt').addEventListener('pointermove'",start);
  vm.runInContext(source.slice(start,end),context);
  handlers.pointerdown({target:{closest:selector=>selector==='.resize-handle'?handle:bar},isPrimary:true,button:0,pointerId:1,pointerType,clientX:100,clientY:100,preventDefault:()=>{}});
  return {context,timers,classes};
}
test('mouse date moves activate immediately without a hold timer',()=>{
  const {context,timers,classes}=setup('mouse');
  assert.equal(context.state.drag.active,true);
  assert.equal(context.state.drag.edge,'move');
  assert.equal(timers.length,0);
  assert.ok(classes.has('is-resizing'));
});
test('touch date moves retain the 450ms hold',()=>{
  const {context,timers,classes}=setup('touch');
  assert.equal(context.state.drag.active,false);
  assert.equal(classes.has('is-resizing'),false);
  assert.equal(timers[0].delay,450);
  timers[0].fn();
  assert.equal(context.state.drag.active,true);
  assert.ok(classes.has('is-resizing'));
});
test('touch resize handles still activate immediately',()=>{
  const {context,timers}=setup('touch','start');
  assert.equal(context.state.drag.active,true);
  assert.equal(timers.length,0);
});
