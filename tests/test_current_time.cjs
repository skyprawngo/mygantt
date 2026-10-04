const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
const c={};vm.createContext(c);
vm.runInContext(source.slice(source.indexOf('function timeOfDayFraction('),source.indexOf('function updateCurrentTimeMarker(')),c);
test('local clock maps midnight, noon, and end of day inside one cell',()=>{
 for(const [h,m,s,expected] of [[0,0,0,0],[6,0,0,.25],[12,0,0,.5],[18,0,0,.75],[23,59,59,86399/86400]]) {
  assert.equal(c.timeOfDayFraction({getHours:()=>h,getMinutes:()=>m,getSeconds:()=>s}),expected);
 }
});
