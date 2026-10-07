const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('web/app.js','utf8');
test('mobile inspector follows active page, isolates hidden panels, and closes on desktop',()=>{
 let focused = 0, narrow = true;
 const make = () => ({inert:false,getBoundingClientRect(){},querySelector:()=>({focus(){focused++;}})});
 const sidebar=make(), schedule=make(), template=make(), backdrop={}, toggle={setAttribute(){}};
 const nodes={'.sidebar':sidebar,'#mobile-inspector':schedule,'#template-inspector':template,'#drawer-backdrop':backdrop,'#mobile-menu-toggle':toggle};
 const classes=new Set();
 const c={state:{view:'templates'},mobileLayout:()=>narrow,$:s=>nodes[s],$$:()=>[schedule,template],document:{activeElement:null,body:{classList:{contains:k=>classes.has(k),toggle(k,v){v?classes.add(k):classes.delete(k);}}}}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function activeMobileInspector('),source.indexOf('function bindMobileMenuSwipe(')),c);
 c.setMobileDrawer('inspector');assert.equal(template.inert,false);assert.equal(schedule.inert,true);assert.equal(sidebar.inert,true);assert.equal(backdrop.hidden,false);assert.equal(focused,1);
 c.setMobileDrawer(null);assert.equal(template.inert,true);assert.equal(backdrop.hidden,true);
 c.state.view='timeline';c.setMobileDrawer('inspector');assert.equal(schedule.inert,false);assert.equal(template.inert,true);
 narrow=false;c.setMobileDrawer('inspector');assert.equal(schedule.inert,false);assert.equal(template.inert,false);assert.equal(classes.has('inspector-open'),false);
});
