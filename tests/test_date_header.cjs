const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/app.js', 'utf8');
function setup() {
  const c = {state:{holidays:{}}, I18n:{systemText:()=>''}, browserClockParts:()=>({date:'2026-11-01'}), t:(id,p)=>p?`${p.p0}주`:id, esc:s=>String(s)};
  vm.createContext(c);
  for (const [start,end] of [['function dateFrom(', 'function fmtDate('], ['const weekdayIDs =', 'function renderHolidayStatus('], ['function calendarHeaderMarkup(', 'function calendarShadingMarkup(']]) {
    vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), c);
  }
  return c;
}
test('month and week labels occupy a separate slot above every day', () => {
  const c=setup(), dates=c.dateColumns('2026-11-01',30,24);
  assert.equal(dates[0].dateText,'1');
  assert.equal(dates[0].periodText,'11');
  for (const [day,label] of [[2,''],[8,'1주'],[15,'2주'],[22,'3주'],[29,'4주']]) assert.equal(dates[day-1].periodText,label);
  const html=c.calendarHeaderMarkup(dates,24);
  assert.equal((html.match(/class="date-period"/g)||[]).length,30);
  assert.match(html, /class="date-period">11<\/span><b>1<\/b>/);
  assert.match(html, /class="date-period"><\/span><b>2<\/b>/);
});
test('week numbering resets monthly and remains stable for partial calendar ranges', () => {
  const c=setup();
  assert.equal(c.dateColumns('2026-10-04',1,46)[0].periodText,'1주');
  assert.equal(c.dateColumns('2026-10-18',1,46)[0].periodText,'3주');
  assert.equal(c.dateColumns('2026-12-06',1,46)[0].periodText,'1주');
  const dates=c.dateColumns('2026-12-31',2,46);
  assert.equal(dates[1].periodText,'1');
  assert.equal(dates[1].dateText,'1');
});
