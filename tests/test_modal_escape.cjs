const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('Escape closes a modal and its help before focused controls consume the key',()=>{
 const source=fs.readFileSync('web/app.js','utf8');
 const root={innerHTML:'dialog'},help={hidePopover(){this.closed=true}},removed=[];
 const c={$:s=>s==='#modal-root'?root:help,document:{removeEventListener(...args){removed.push(args)}}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function modalEscape('),source.indexOf('function setModalError(')),c);
 c.modalEscape({key:'Enter'});assert.equal(root.innerHTML,'dialog');
 for(const event of [{key:'HangulMode'},{key:'Alt',code:'AltRight'},{key:'Process',keyCode:229},{key:'Escape',isComposing:true},{key:'Escape',keyCode:229}]) {
  c.modalEscape({...event,preventDefault(){throw Error('IME key must remain native');},stopImmediatePropagation(){throw Error('IME key must propagate');}});
  assert.equal(root.innerHTML,'dialog');
 }
 let prevented=false,stopped=false;
 c.modalEscape({key:'Escape',preventDefault(){prevented=true},stopImmediatePropagation(){stopped=true}});
 assert.equal(root.innerHTML,'');assert(help.closed);assert(prevented&&stopped);
 assert.equal(removed[0][0],'keydown');assert.equal(removed[0][2],true);
});
