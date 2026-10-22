const { test } = require('node:test');
const assert = require('node:assert/strict');
const { itemLocations, isComposingKey, itemNavigation } = require('../src/model');
const { applicationMenuTemplate, previewShortcut, newTextShortcut } = require('../src/app-menu');

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
test('list navigation recognizes exact Command boundaries plus existing arrows and Home/End, with range selection independent', () => {
  for (const shiftKey of [false, true]) {
    for (const [key, expected] of [['ArrowUp', 'first'], ['ArrowDown', 'last']]) {
      assert.equal(itemNavigation({ key, metaKey: true, shiftKey }), expected);
      assert.equal(itemNavigation({ key, ctrlKey: true, shiftKey }, 'linux'), expected);
    }
    for (const [key, expected] of [['Home', 'first'], ['End', 'last'], ['ArrowLeft', -1], ['ArrowRight', 1]]) assert.equal(itemNavigation({ key, shiftKey }), expected);
  }
});
test('list commands never interpret text-cursor, additional modifiers or IME keys as item boundary navigation', () => {
  for (const event of [{ key: 'ArrowUp' }, { key: 'ArrowDown', ctrlKey: true }, { key: 'ArrowUp', metaKey: true, altKey: true },
    { key: 'ArrowDown', metaKey: true, ctrlKey: true }, { key: 'ArrowUp', metaKey: true, isComposing: true }, { key: 'ArrowDown', metaKey: true, keyCode: 229 },
    { key: 'ArrowRight', altKey: true }, { key: 'End', metaKey: true }, { key: 'f', metaKey: true }]) assert.equal(itemNavigation(event), null);
});
test('boundary commands read native KeyboardEvent accessors rather than enumerable object properties', () => {
  const event = Object.create({ get key() { return 'ArrowDown'; }, get metaKey() { return true; }, get ctrlKey() { return false; }, get altKey() { return false; }, get shiftKey() { return true; } });
  assert.equal(itemNavigation(event), 'last');
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
  assert.equal(previewShortcut({ type: 'keyDown', key: 'o', meta: true }, 'darwin'), 'open');
  assert.equal(previewShortcut({ type: 'keyDown', key: 'o', meta: true, alt: true }, 'darwin'), null);
  for (const input of [
    { type: 'keyUp', key: 'r', meta: true }, { type: 'keyDown', key: 'r', meta: true, isComposing: true },
    { type: 'keyDown', key: 'r', meta: true, shift: true }, { type: 'keyDown', key: 'e', control: true }
  ]) assert.equal(previewShortcut(input, 'darwin'), null);
});
test('Open is an explicit File command routed to the focused product view', () => {
  let count = 0;
  const entry = applicationMenuTemplate(() => {}, 'darwin', undefined, {}, () => count++)
    .find(item => item.role === 'fileMenu').submenu.find(item => item.id === 'open-item');
  assert.equal(entry.accelerator, 'CommandOrControl+O'); entry.click(); assert.equal(count, 1);
});
test('new text has an actual File command and exact native shortcut without shadowing new Pinboard or composition', () => {
  let requests = 0; const template = applicationMenuTemplate(() => {}, 'darwin', () => { requests++; });
  const entry = template.find(item => item.role === 'fileMenu').submenu.find(item => item.id === 'new-text');
  assert.equal(entry.accelerator, 'CommandOrControl+N'); entry.click(); assert.equal(requests, 1);
  assert.equal(newTextShortcut({ type: 'keyDown', key: 'n', meta: true }, 'darwin'), true);
  assert.equal(newTextShortcut({ type: 'keyDown', key: 'n', control: true }, 'linux'), true);
  for (const change of [{ type: 'keyUp' }, { shift: true }, { alt: true }, { control: true }, { isComposing: true }]) {
    assert.equal(newTextShortcut({ type: 'keyDown', key: 'n', meta: true, ...change }, 'darwin'), false);
  }
});
