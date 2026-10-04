const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
function setup(){
 const handlers={},docs={};let pending=null,shown=0;
 const control={addEventListener:(n,f)=>handlers[n]=f,getBoundingClientRect:()=>({left:240,bottom:106})};
 const overlay={style:{},showPopover:()=>shown++};
 const ctx={$:s=>s==='#cascade-help'?overlay:{closest:()=>control},innerWidth:390,document:{addEventListener:(n,f)=>docs[n]=f},window:{addEventListener(){}},setTimeout:f=>(pending=f,1),clearTimeout:()=>pending=null};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function bindCascadeHelp()'),source.indexOf('function bindMobileSearch()')),ctx);ctx.bindCascadeHelp();
 const down=()=>handlers.pointerdown({isPrimary:true,button:0,clientX:245,clientY:90});
 return {handlers,docs,down,fire:()=>pending?.(),shown:()=>shown};
}
test('long press shows help and prevents checkbox activation on release',()=>{
 const h=setup();h.down();h.fire();assert.equal(h.shown(),1);h.docs.pointerup();let prevented=false;
 h.handlers.click({preventDefault(){prevented=true},stopPropagation(){}});assert.equal(prevented,true);
});
test('short tap remains a normal checkbox click',()=>{
 const h=setup();h.down();h.docs.pointerup();h.fire();assert.equal(h.shown(),0);
 h.handlers.click({preventDefault(){assert.fail('short tap must toggle')},stopPropagation(){}});
});
test('scroll movement and cancellation abort pending help',()=>{
 for(const mode of ['move','cancel']){const h=setup();h.down();if(mode==='move')h.docs.pointermove({clientX:270,clientY:90});else h.docs.pointercancel();h.fire();assert.equal(h.shown(),0);}
});
