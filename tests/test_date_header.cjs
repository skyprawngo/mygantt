const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/app.js', 'utf8');
function setup() {
  const c = {state:{holidays:{}}, I18n:{systemText:()=>''}, browserClockParts:()=>({date:'2026-11-01'}), t:(id,p)=>p?`${p.p0}${id==='calendar.month_number'?'월':'주'}`:id, esc:s=>String(s)};
  vm.createContext(c);
  for (const [start,end] of [['function dateFrom(', 'function fmtDate('], ['const weekdayIDs =', 'function renderHolidayStatus('], ['function calendarHeaderMarkup(', 'function calendarShadingMarkup(']]) {
    vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), c);
  }
  return c;
}
test('month and week labels share merged weekly cells above compact days', () => {
  const c=setup(), dates=c.dateColumns('2026-11-01',30,24);
  assert.equal(dates[0].dateText,'1');
  assert.equal(dates[0].periodText,'11.');
  for (const [day,label] of [[2,''],[8,'2주'],[15,'3주'],[22,'4주'],[29,'1주']]) assert.equal(dates[day-1].periodText,label);
  const html=c.calendarHeaderMarkup(dates,24);
  assert.equal((html.match(/class="calendar-week-cell"/g)||[]).length,5);
  assert.match(html,/width:168px" data-week-start="2026-11-01">11월 · 1주/);
  assert.match(html,/width:48px" data-week-start="2026-11-29">12월 · 1주/);
  assert.equal((html.match(/data-date="/g)||[]).length,30);
  assert.doesNotMatch(html,/class="date-period/);
  assert.match(html,/<b>2<\/b><small>/);
});
test('week numbering resets monthly and remains stable for partial calendar ranges', () => {
  const c=setup();
  assert.equal(c.dateColumns('2026-10-04',1,46)[0].periodText,'2주');
  assert.equal(c.dateColumns('2026-10-18',1,46)[0].periodText,'4주');
  assert.equal(c.dateColumns('2026-12-06',1,46)[0].periodText,'2주');
  const dates=c.dateColumns('2026-12-31',2,46);
  assert.equal(dates[1].periodText,'1.');
  assert.equal(dates[1].dateText,'1');
});

test('Thursday assigns boundary weeks to the correct month', () => {
  const c=setup();
  for (const [date,label] of [['2026-05-03','1주'],['2026-01-25','5주'],['2026-12-27','5주'],['2027-01-03','1주']]) {
    assert.equal(c.dateColumns(date,1,46)[0].periodText,label,date);
  }
});

test('month boundary marks only the first day, including year rollover and row shading',()=>{
 const c=setup();
 vm.runInContext(source.slice(source.indexOf('function calendarShadingMarkup('),source.indexOf('function calendarShadingMarkup(')+source.slice(source.indexOf('function calendarShadingMarkup(')).indexOf('\n}')+2),c);
 const dates=c.dateColumns('2026-12-31',3,46);
 for(const markup of [c.calendarHeaderMarkup(dates,46),c.calendarShadingMarkup(dates,46)]) {
  assert.equal((markup.match(/month-boundary/g)||[]).length,1);
 }
 assert.match(c.calendarHeaderMarkup(dates,46),/data-date="2027-01-01"[^>]*class="date-header month-boundary/);
 assert.match(c.calendarShadingMarkup(dates,46),/class="date-shade month-boundary[^>]*left:46px/);
});

test('partial edge weeks preserve Sunday alignment across month and year boundaries',()=>{
 const c=setup(),html=c.calendarHeaderMarkup(c.dateColumns('2026-12-31',10,30),30);
 assert.match(html,/width:90px" data-week-start="2026-12-27">12월 · 5주/);
 assert.match(html,/width:210px" data-week-start="2027-01-03">1월 · 1주/);
});

test('month rules align to calendar days inside partial weeks at fractional scales',()=>{
 const c=setup();
 for(const px of [30,46,57.5]) {
  const dates=c.dateColumns('2026-12-29',8,px),lines=c.calendarMonthLines(dates,px);
  assert.equal((lines.match(/data-month-start=/g)||[]).length,1);
  assert.match(lines,new RegExp(`data-month-start="2027-01-01" style="left:${3*px}px"`));
  assert.ok(c.calendarHeaderMarkup(dates,px).includes(lines));
 }
});
