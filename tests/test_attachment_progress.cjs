const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
const c={};vm.createContext(c);
vm.runInContext(source.slice(source.indexOf('const paletteCache'),source.indexOf('function esc('))+source.slice(source.indexOf('function attachmentProgress('),source.indexOf('function renderDependencyLinks('))+source.slice(source.indexOf('function taskProgress('),source.indexOf('function bindTaskProgress(')),c);
test('outgoing joins stay at base color through 90%, then blend to complete',()=>{
  const task={color:'#5872d9'};
  for(const progress of [0,10,50,80,89,90]) assert.equal(c.outgoingConnectionColor({...task,progress}),c.colorPalette(task.color).base);
  const middle=c.outgoingConnectionColor({...task,progress:95});
  assert.notEqual(middle,c.colorPalette(task.color).base);
  assert.notEqual(middle,c.colorPalette(task.color).dark);
  assert.equal(c.outgoingConnectionColor({...task,progress:100}),c.colorPalette(task.color).dark);
});
test('right and surface ports share one late-fill stage even where regions overlap',()=>{
  const ports=[{side:'right'},{side:'bottom',x:380,width:120},{side:'top',x:310,width:48}];
  const mask=c.attachmentProgressMask(460,22,95,ports);
  assert.equal((mask.match(/<ellipse/g)||[]).length,3);
  assert.match(mask,/<g opacity="0.5">/);
  assert.equal((mask.match(/opacity="0.5"/g)||[]).length,1,'one group opacity avoids double-dimming overlapping attachment reserves');
  assert.match(mask,/cx="460" cy="11"/);
  assert.match(mask,/cx="380" cy="22"/);
  assert.match(mask,/cx="310" cy="0"/);
  assert.match(c.attachmentProgressMask(460,22,100,ports),/<g opacity="0">/);
});
test('unconnected bars keep linear timing; connected fill and release are bounded',()=>{
  assert.equal(c.attachmentProgress(50,false).front,.5);
  assert.equal(c.attachmentProgress(90).front,1);
  assert.equal(c.attachmentProgress(90).release,0);
  assert.equal(c.attachmentProgress(95).release,.5);
  assert.equal(c.attachmentProgress(200).release,1);
  assert.equal(c.attachmentProgress(-10).front,0);
});
test('incoming top/bottom/left contacts fill early, including contacts beyond the linear front',()=>{
  const ports=[{direction:'incoming',side:'top',x:180,width:100},{direction:'incoming',side:'bottom',x:150,width:60},{direction:'incoming',side:'left'}];
  for(const progress of [10,40,90,100]) {
    const mask=c.attachmentProgressMask(230,22,progress,ports);
    assert.match(mask,/<g opacity="1"><ellipse cx="180" cy="0"/);
    assert.match(mask,/cx="150" cy="22"/);
    assert.match(mask,/cx="0" cy="11"/);
    assert.equal((mask.match(/fill="url\(#incoming\)"/g)||[]).length,3);
    assert.equal(c.connectionFill(progress,'incoming'),1);
  }
  assert.match(c.attachmentProgressMask(230,22,0,ports),/<g opacity="0"><ellipse cx="180"/);
});
test('one mask handles simultaneous incoming and outgoing ports with matching endpoint colors',()=>{
 const ports=[{direction:'incoming',side:'top',x:75,width:60},{direction:'outgoing',side:'bottom',x:185,width:70}];
 const mask=c.attachmentProgressMask(230,22,40,ports);
 assert.match(mask,/cx="75" cy="0"[^>]+fill="url\(#incoming\)"/);
 assert.match(mask,/cx="185" cy="22"[^>]+fill="url\(#port\)"/);
 const task={color:'#5872d9',progress:40};
 assert.equal(c.connectionColor(task,'incoming'),c.colorPalette(task.color).dark);
 assert.equal(c.connectionColor(task,'outgoing'),c.colorPalette(task.color).base);
});
