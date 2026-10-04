const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
function setup(){
 const handlers={},classes=new Set(),props={};let removed=null;
 const button={tabIndex:-1,setAttribute(){},addEventListener:(type,fn)=>handlers['delete:'+type]=fn,focus(){}};
 const shell={dataset:{swipeProject:'p'},classList:{contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k),toggle:(k,on)=>on?classes.add(k):classes.delete(k)},style:{setProperty:(k,v)=>props[k]=v,removeProperty:k=>delete props[k]},setPointerCapture(){},addEventListener:(type,fn)=>handlers[type]=fn};
 const c={$$:()=>[shell],$:()=>button,state:{data:{projects:[{id:'p',name:'P'}]}},deleteInspectorItem:(...args)=>removed=args};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function bindSidebarProjectSwipe('),source.indexOf('function filteredProjects(')),c);c.bindSidebarProjectSwipe();
 const event=(x,y=0)=>({button:0,isPrimary:true,pointerId:1,clientX:x,clientY:y,target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){}});
 return {handlers,classes,button,event,get removed(){return removed;}};
}
test('left swipe reveals delete, suppresses selection, and right swipe closes',()=>{
 const h=setup();h.handlers.pointerdown(h.event(100));h.handlers.pointermove(h.event(50));h.handlers.pointerup(h.event(50));
 assert.ok(h.classes.has('swipe-open'));assert.equal(h.button.tabIndex,0);
 let stopped=false;h.handlers.click({...h.event(50),stopImmediatePropagation(){stopped=true;}});assert.ok(stopped);
 h.handlers['delete:click']();assert.deepEqual(h.removed,['projects','p','P']);
 h.handlers.pointerdown(h.event(50));h.handlers.pointermove(h.event(110));h.handlers.pointerup(h.event(110));assert.ok(!h.classes.has('swipe-open'));
});
test('vertical scroll and cancelled swipe never expose a new delete action',()=>{
 for(const cancel of [false,true]){const h=setup();h.handlers.pointerdown(h.event(100));h.handlers.pointermove(h.event(cancel?50:98,cancel?0:30));h.handlers[cancel?'pointercancel':'pointerup'](h.event(50,30));assert.ok(!h.classes.has('swipe-open'));assert.equal(h.button.tabIndex,-1);}
});
