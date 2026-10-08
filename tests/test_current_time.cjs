const withI18n = require('./i18n_context.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
const clock=require('../web/timezones.js');
const c={clockParts:now=>clock.parts(now,'UTC')};withI18n(vm.createContext(c));
vm.runInContext(source.slice(source.indexOf('function timeOfDayFraction('),source.indexOf('function updateCurrentTimeMarker(')),c);
test('selected clock maps midnight, noon, and end of day inside one cell',()=>{
 for(const [h,m,s,expected] of [[0,0,0,0],[6,0,0,.25],[12,0,0,.5],[18,0,0,.75],[23,59,59,86399/86400]]) {
  assert.equal(c.timeOfDayFraction(new Date(Date.UTC(2026,0,1,h,m,s))),expected);
 }
});
