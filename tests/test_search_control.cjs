const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8');
function setup(){
 const document={handlers:{},addEventListener(n,f){this.handlers[n]=f;}};
 const nodes={};
 for(const id of ['timeline-search','search-filter','search-toggle','search-clear','search-active-description']){
  const classes=new Set();
  nodes['#'+id]={id,value:'',hidden:true,handlers:{},attrs:{},textContent:'',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)},addEventListener(n,f){this.handlers[n]=f;},setAttribute(k,v){this.attrs[k]=v;},focus(){document.activeElement=this;},dispatchEvent(e){this.handlers[e.type]?.(e);},contains(n){return n===this||n===nodes['#search-filter']||n===nodes['#search-toggle']||n===nodes['#search-clear'];}};
 }
 const context={document,$:s=>nodes[s],t:()=> 'Search filter active',Event:class{constructor(type){this.type=type;}}};context.Shortcuts=require('../web/shortcuts.js').create({device:context.navigator || {}});vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('function syncTimelineSearch()'),source.indexOf('function bindMobileSearch()')),context);context.bindTimelineSearch();
 return {nodes,document,box:nodes['#timeline-search'],input:nodes['#search-filter'],toggle:nodes['#search-toggle'],clear:nodes['#search-clear']};
}
test('Escape collapses without clearing query and returns focus; reopen restores query',()=>{
 const h=setup();h.toggle.handlers.click();assert.equal(h.document.activeElement,h.input);
 h.input.value='품질';h.input.handlers.input();let prevented=false;
 h.box.handlers.keydown({key:'Escape',preventDefault(){prevented=true},stopPropagation(){}});
 assert.ok(prevented);assert.equal(h.input.value,'품질');assert.ok(h.input.hidden);assert.equal(h.document.activeElement,h.toggle);assert.ok(h.box.classList.contains('search-active'));
 h.toggle.handlers.click();assert.equal(h.input.value,'품질');assert.equal(h.input.hidden,false);
});
test('internal focus and clear remain open; external focus and pointer collapse',()=>{
 const h=setup();h.toggle.handlers.click();h.input.value='test';h.input.handlers.input();h.box.handlers.focusout({relatedTarget:h.clear});assert.equal(h.input.hidden,false);
 h.clear.handlers.click();assert.equal(h.input.value,'');assert.equal(h.input.hidden,false);assert.equal(h.document.activeElement,h.input);assert.equal(h.box.classList.contains('search-active'),false);
 h.box.handlers.focusout({relatedTarget:{}});assert.equal(h.input.hidden,true);
 h.toggle.handlers.click();h.document.handlers.pointerdown({target:{}});assert.equal(h.input.hidden,true);
});
test('IME composition Escape does not collapse',()=>{const h=setup();h.toggle.handlers.click();h.box.handlers.keydown({key:'Escape',isComposing:true});assert.equal(h.input.hidden,false);});
