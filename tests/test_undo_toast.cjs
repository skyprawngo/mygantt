const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
function setup(){
 const classes=new Set(),timers=[];
 const node={textContent:'',classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}};
 const c={$:()=>node,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function toast('),source.indexOf('async function requestJson(')),c);
 return {c,node,classes,timers};
}
test('progress toast stays visible until dismissed',()=>{
 const {c,node,classes,timers}=setup();const dismiss=c.toast('실행취소 중',{progress:true});
 assert.equal(node.textContent,'실행취소 중');assert.ok(classes.has('toast-progress'));assert.ok(classes.has('show'));assert.equal(timers.length,0);
 dismiss();assert.equal(classes.has('show'),false);
});
test('completion cannot dismiss a newer error toast and removes its spinner',()=>{
 const {c,node,classes,timers}=setup();const dismiss=c.toast('실행취소 중',{progress:true});
 c.toast('error');dismiss();assert.equal(node.textContent,'error');assert.ok(classes.has('show'));assert.equal(classes.has('toast-progress'),false);
 assert.equal(timers[0].ms,2600);timers[0].fn();assert.equal(classes.has('show'),false);
});
