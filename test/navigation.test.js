const { test } = require('node:test');
const assert = require('node:assert/strict');
const { itemLocations, isComposingKey } = require('../src/model');
const { applicationMenuTemplate, previewShortcut } = require('../src/app-menu');

test('location commands offer only other actual lists, including a global-search return to history', () => {
  const boards = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], item = { boardIds: ['b', 'a', 'missing'] };
  assert.deepEqual(itemLocations(item, { boards, board: 'history' }).map(value => value.id), ['a', 'b']);
  assert.deepEqual(itemLocations(item, { boards, board: 'a' }).map(value => value.id), ['history', 'b']);
  assert.deepEqual(itemLocations(item, { boards, board: 'a', searching: true }).map(value => value.id), ['history', 'a', 'b']);
  assert.deepEqual(itemLocations({ boardIds: [] }), []); assert.deepEqual(itemLocations(null), []);
});
test('IME guards recognize composition state, Chromium process keys and the legacy 229 signal', () => {
  for (const event of [{ isComposing: true }, { key: 'Process' }, { keyCode: 229 }]) assert.equal(isComposingKey(event), true);
  assert.equal(isComposingKey({ key: 'Enter' }, true), true); assert.equal(isComposingKey({ key: 'Enter' }), false);
});
test('product menus preserve native editing and window roles without browser reload or developer accelerators', () => {
  const openSettings = () => {}, template = applicationMenuTemplate(openSettings, 'darwin');
  const entries = template.flatMap(entry => [entry, ...(entry.submenu || [])]);
  assert.ok(entries.some(entry => entry.role === 'editMenu')); assert.ok(entries.some(entry => entry.role === 'fileMenu'));
  assert.ok(entries.some(entry => entry.role === 'windowMenu'));
  assert.equal(entries.some(entry => /reload|devtools|viewmenu/i.test(entry.role || '')), false);
  const preferences = entries.find(entry => entry.accelerator === 'CommandOrControl+,'); assert.equal(preferences.click, openSettings);
});
test('native preview shortcuts bridge exact commands only, never composition, key-up or additional modifiers', () => {
  assert.equal(previewShortcut({ type: 'keyDown', key: 'r', meta: true }, 'darwin'), 'rename');
  assert.equal(previewShortcut({ type: 'keyDown', key: 'e', meta: true }, 'darwin'), 'edit');
  assert.equal(previewShortcut({ type: 'keyDown', key: 'e', control: true }, 'linux'), 'edit');
  for (const input of [
    { type: 'keyUp', key: 'r', meta: true }, { type: 'keyDown', key: 'r', meta: true, isComposing: true },
    { type: 'keyDown', key: 'r', meta: true, shift: true }, { type: 'keyDown', key: 'e', control: true }
  ]) assert.equal(previewShortcut(input, 'darwin'), null);
});
