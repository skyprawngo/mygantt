const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
function setup({mobile=true,open=false}={}){
 const handlers={}, calls=[], opts={};let prevented=0,taps=0;
 const context={mobileLayout:()=>mobile,setMobileDrawer:v=>calls.push(v),document:{body:{classList:{contains:()=>open}},addEventListener:(n,f,o)=>{handlers[n]=f;opts[n]=o;}}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function bindMobileMenuSwipe('),source.indexOf('function bindMobileDrawers(')),context);context.bindMobileMenuSwipe();
 const target={closest:s=>s==='.modal-overlay'?null:{click:()=>taps++}};
 const event=(x,y=100)=>({touches:[{identifier:1,clientX:x,clientY:y}],changedTouches:[{identifier:1,clientX:x,clientY:y}],target,cancelable:true,preventDefault(){prevented++;}});
 return {handlers,calls,opts,event,get prevented(){return prevented;},get taps(){return taps;}};
}
test('edge right swipe cancels native gesture from touchstart and opens menu',()=>{
 const h=setup();h.handlers.touchstart(h.event(5));assert.equal(h.prevented,1);assert.equal(h.opts.touchstart.passive,false);
 h.handlers.touchmove(h.event(90));h.handlers.touchend(h.event(90));assert.deepEqual(h.calls,['menu']);
});
test('chart interior remains untouched',()=>{const h=setup();h.handlers.touchstart(h.event(100));h.handlers.touchmove(h.event(200));h.handlers.touchend(h.event(200));assert.equal(h.prevented,0);assert.equal(h.calls.length,0);});
test('vertical, short, cancelled and multitouch gestures do not open menu',()=>{
 for(const mode of ['vertical','short','cancel','multi']){const h=setup();h.handlers.touchstart(h.event(5));
 if(mode==='cancel')h.handlers.touchcancel();
 if(mode==='multi')h.handlers.touchmove({...h.event(80),touches:[{},{}]});
 h.handlers.touchend(h.event(mode==='short'?30:80,mode==='vertical'?260:100));assert.equal(h.calls.length,0);}
});
test('desktop and already open drawers do not capture gestures',()=>{for(const config of [{mobile:false},{open:true}]){const h=setup(config);h.handlers.touchstart(h.event(4));h.handlers.touchend(h.event(100));assert.equal(h.prevented,0);assert.equal(h.calls.length,0);}});
test('edge tap preserves button activation once',()=>{const h=setup();h.handlers.touchstart(h.event(5));h.handlers.touchend(h.event(5));assert.equal(h.taps,1);assert.equal(h.calls.length,0);});
