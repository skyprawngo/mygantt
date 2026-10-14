const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
const c={};vm.createContext(c);
for(const [start,end] of [['function dateFrom(','function fmtDate('],['function monthCalendar(','function updateMonthToday(']])vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end)),c);
test('annual calendar covers all days including leap day and Sunday week boundaries',()=>{
 for(const year of [2024,2026,2028]){
  const cal=c.monthCalendar(year);assert.equal(cal.months.length,12);assert.equal(cal.days,year===2026?365:366);
  assert.equal(cal.months.reduce((n,m)=>n+m.days,0),cal.days);
  assert.equal(cal.weeks[0],0);for(const day of cal.weeks.slice(1))assert.equal(new Date(year,0,day+1).getDay(),0);
 }
});
test('project summary clips across years without changing actual dates',()=>{
 const cal=c.monthCalendar(2026);
 const span=c.monthProjectSpan({tasks:[{planned_start:'2025-12-20',planned_finish:'2027-02-04'}]},cal);
 assert.equal(span.left,0);assert.equal(span.width,365);assert.equal(span.start,'2025-12-20');assert.equal(span.end,'2027-02-04');
 assert.equal(c.monthProjectSpan({tasks:[],start_date:'2027-01-01'},cal),null);
});
test('summary spans earliest to latest task and empty projects have a one-day marker',()=>{
 const cal=c.monthCalendar(2026),span=c.monthProjectSpan({tasks:[{planned_start:'2026-10-01',planned_finish:'2026-10-10'},{planned_start:'2026-09-01',planned_finish:'2026-09-05'}]},cal);
 assert.equal(span.start,'2026-09-01');assert.equal(span.end,'2026-10-10');assert.equal(span.width,40);
 assert.equal(c.monthProjectSpan({tasks:[],start_date:'2026-04-01'},cal).width,1);
});
test('half-year pages cross December and retain the following leap February',()=>{
 const cal=c.monthCalendar(2023,6);
 assert.equal(cal.start,'2023-07-01');assert.equal(cal.end,'2024-06-30');assert.equal(cal.days,366);
 assert.equal(cal.months[6].year,2024);assert.equal(cal.months[6].month,1);assert.equal(cal.months[7].days,29);
 assert.equal(c.monthCalendar(2026,-6).start,'2025-07-01');
 for(const day of cal.weeks.slice(1))assert.equal(new Date(2023,6,day+1).getDay(),0);
});
test('today opens a half-year anchor with next year visible in November and December',()=>{
 assert.equal(c.monthPageStart('2026-11-15'),'2026-07-01');
 assert.equal(c.monthPageStart('2026-12-31'),'2026-07-01');
 assert.equal(c.monthPageStart('2027-01-01'),'2027-01-01');
});
function paging(){
 const handlers={},moves=[];let idle;
 const context={state:{layout:'month'},moveMonthPage:(direction,focus)=>moves.push(direction),Date,Math,
  clearTimeout:()=>{},setTimeout:fn=>{idle=fn;}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function bindMonthPaging('),source.indexOf('function renderMonthTimeline(')),context);
 context.bindMonthPaging({clientWidth:600,addEventListener:(type,fn)=>handlers[type]=fn});
 const event=(x,y=0)=>({deltaX:x,deltaY:y,deltaMode:0,preventDefault(){this.prevented=true;}});
 return {handlers,moves,event,context,idle:()=>idle()};
}
test('one horizontal wheel gesture moves one page despite momentum; vertical scrolling stays native',()=>{
 const p=paging();const vertical=p.event(1,80);p.handlers.wheel(vertical);assert.equal(vertical.prevented,undefined);
 p.handlers.wheel(p.event(20));p.handlers.wheel(p.event(35));p.handlers.wheel(p.event(100));assert.deepEqual(p.moves,[1]);
 p.idle();p.handlers.wheel(p.event(-70));assert.deepEqual(p.moves,[1,-1]);
 p.idle();p.context.state.layout='gantt';p.handlers.wheel(p.event(100));assert.deepEqual(p.moves,[1,-1]);
});
test('touch swipe pages once, while vertical and cancelled gestures do not page',()=>{
 const p=paging(),ev=(x,y=100)=>({touches:[{identifier:1,clientX:x,clientY:y}],changedTouches:[{identifier:1,clientX:x,clientY:y}],cancelable:true,preventDefault(){}});
 p.handlers.touchstart(ev(200));p.handlers.touchmove(ev(120));p.handlers.touchend(ev(100));assert.deepEqual(p.moves,[1]);
 p.handlers.touchstart(ev(100));p.handlers.touchmove(ev(110,200));p.handlers.touchend(ev(180,230));assert.deepEqual(p.moves,[1]);
 p.handlers.touchstart(ev(100));p.handlers.touchmove(ev(170));p.handlers.touchcancel();p.handlers.touchend(ev(180));assert.deepEqual(p.moves,[1]);
 p.handlers.touchstart(ev(100));p.handlers.touchmove(ev(170));p.handlers.touchend(ev(180));assert.deepEqual(p.moves,[1,-1]);
});
