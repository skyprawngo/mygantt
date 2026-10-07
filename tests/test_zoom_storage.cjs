const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('web/app.js', 'utf8');
const restore = source.slice(source.indexOf('function restoreZoom('), source.indexOf('const state ='));
test('zoom restores valid saved values and handles old or invalid settings', () => {
  const c = {}; vm.createContext(c); vm.runInContext(restore, c);
  assert.equal(c.restoreZoom(31, 24), 31);
  assert.equal(c.restoreZoom(15, 12), 15);
  for (const value of [undefined, null, '31', NaN, Infinity]) assert.equal(c.restoreZoom(value, 24), 46);
  assert.equal(c.restoreZoom(2, 24), 24);
  assert.equal(c.restoreZoom(90, 12), 62);
});
test('schedule and template zoom survive a storage round trip independently', () => {
  let stored;
  const c = {state:{zoom:29,templateZoom:17,collapsedProjects:new Set(),hiddenProjects:new Set()},localStorage:{setItem(key,value){assert.equal(key,'mygantt-ui');stored=value;}}};
  vm.createContext(c);
  vm.runInContext(restore + source.slice(source.indexOf('function persistUi()'), source.indexOf('function setCascadeSetting(')), c);
  c.persistUi();
  const saved = JSON.parse(stored);
  assert.equal(c.restoreZoom(saved.zoom,24),29);
  assert.equal(c.restoreZoom(saved.templateZoom,12),17);
});
