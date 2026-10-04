const withI18n = require('./i18n_context.cjs');
const {test}=require('node:test'), assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const s=fs.readFileSync('web/app.js','utf8'),c={};withI18n(vm.createContext(c));
vm.runInContext(s.slice(s.indexOf('const paletteCache'),s.indexOf('function esc('))+s.slice(s.indexOf('function taskProgress('),s.indexOf('function bindTaskProgress(')),c);
test('arbitrary hex colors retain base, darken and lighten monotonically with valid ink',()=>{
 for(const hex of ['#000000','#ffffff','#ff0000','#00ff00','#0000ff','#eeee00','#101010','#5872d9','#abcdef']){
  const p=c.colorPalette(hex);assert.equal(p.base,hex);
  for(let i=1;i<7;i+=2){const v=x=>parseInt(x.slice(i,i+2),16);assert.ok(v(p.dark)<=v(hex));assert.ok(v(p.light)>=v(hex));}
  assert.ok(['#000000','#ffffff'].includes(p.ink));assert.equal(c.colorPalette(hex),p);
 }
 assert.equal(c.colorPalette('#abc').base,'#aabbcc');assert.equal(c.colorPalette('bad').base,'#5872d9');
 assert.equal(c.colorPalette('#ffffff').ink,'#000000');assert.equal(c.colorPalette('#000000').ink,'#ffffff');
});
test('incoming connection uses dark color as soon as the successor starts',()=>{
 for(const progress of [0,10,50,90,100]){
  const t={color:'#a45ca8',progress};assert.equal(c.connectionColor(t),c.colorPalette(t.color)[progress>0?'dark':'base']);
 }
 assert.notEqual(c.connectionColor({color:'#ff0000',progress:10}),c.connectionColor({color:'#0000ff',progress:100}));
 assert.match(c.paletteStyle('#abc','project'),/--project-dark:/);
});

test('black text is reserved for very light backgrounds, not brown or midtones',()=>{
 for(const hex of ['#b48527','#b96749','#a45ca8','#5872d9','#999999','#abcdef']) assert.equal(c.colorPalette(hex).ink,'#ffffff',hex);
 for(const hex of ['#ffffff','#eeeeee','#fff5d6','#e8f4ff','#ffff00']) assert.equal(c.colorPalette(hex).ink,'#000000',hex);
});
