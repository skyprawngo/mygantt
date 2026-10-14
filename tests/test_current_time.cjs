const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
function setup(){
 const events={},cells=['2026-10-14','2026-10-15'].map(date=>({dataset:{date,dateTitle:date},style:{setProperty(k,v){this[k]=v},removeProperty(k){delete this[k]}},classList:{toggle(k,v){this[k]=v}}}));
 const line={style:{}},chart={dataset:{todayDate:'2026-10-14'}};
 const c={Date,state:{view:'timeline',zoom:48},document:{hidden:false,addEventListener:(k,fn)=>events[k]=fn},window:{addEventListener:(k,fn)=>events[k]=fn},setInterval:(fn,ms)=>{events.tick=fn;events.interval=ms},$:()=>chart,$$:selector=>selector==='.today-line'?[line]:cells,t:(_k,p)=>`${p.p0} ${p.p1}:${p.p2}`,timelineCalendarRange:()=>({start:'2026-10-14'})};
 vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function browserClockParts('),source.indexOf('function fmtDate(')),c);
 return {c,events,cells,line,chart};
}
test('browser clock maps local hours within a day independently of server timezone',()=>{
 const {c}=setup();
 for(const [h,m,s,expected] of [[0,0,0,0],[6,0,0,.25],[12,0,0,.5],[23,59,59,86399/86400]])
  assert.equal(c.timeOfDayFraction(new Date(2026,9,14,h,m,s)),expected);
 assert.equal(c.browserClockParts(new Date(2026,9,14,23,59)).date,'2026-10-14');
});
test('midnight moves the indicator and today header without a chart render',()=>{
 const {c,cells,line,chart}=setup();
 c.updateCurrentTimeMarker(new Date(2026,9,14,12));
 assert.equal(line.style.left,'24px');assert.equal(cells[0].classList.today,true);
 c.updateCurrentTimeMarker(new Date(2026,9,15,6));
 assert.equal(line.style.left,'60px');assert.equal(chart.dataset.todayDate,'2026-10-15');
 assert.equal(cells[0].classList.today,false);assert.equal(cells[0].title,'2026-10-14');
 assert.equal(cells[1].classList.today,true);assert.equal(cells[1].style['--time-progress'],'25%');
});
test('timer, tab return, focus and history restore refresh the browser clock',()=>{
 const {c,events}=setup();let updates=0;c.updateCurrentTimeMarker=()=>updates++;
 c.bindCurrentTimeClock();assert.equal(events.interval,1800000);
 events.tick();events.focus();events.pageshow();events.visibilitychange();assert.equal(updates,4);
 c.document.hidden=true;events.tick();assert.equal(updates,4);
 c.document.hidden=false;events.visibilitychange();assert.equal(updates,5);
});
