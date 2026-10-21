const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GlobalHotkeys } = require('../src/hotkeys');
const { DEFAULT_SETTINGS, modifierPressed, shortcutMatches } = require('../src/model');

test('global shortcut registration is atomic and restores both shortcuts after a conflict', () => {
  const registered = new Map();
  const registry = { unregisterAll: () => registered.clear(), register: (key, callback) => {
    if (key === 'CommandOrControl+X' || registered.has(key)) return false;
    registered.set(key, callback); return true;
  } };
  const callbacks = { history: () => {}, stack: () => {} }, hotkeys = new GlobalHotkeys(registry, callbacks);
  hotkeys.apply(DEFAULT_SETTINGS);
  assert.equal(registered.get(DEFAULT_SETTINGS.stackHotkey), callbacks.stack);
  assert.throws(() => hotkeys.apply({ hotkey: 'CommandOrControl+Alt+V', stackHotkey: 'CommandOrControl+X' }), /被占用/);
  assert.deepEqual([...registered.keys()], [DEFAULT_SETTINGS.hotkey, DEFAULT_SETTINGS.stackHotkey]);
  hotkeys.apply({ ...DEFAULT_SETTINGS, stackHotkey: '' }); assert.equal(registered.size, 1);
});
test('duplicate shortcut combinations fail without losing previous registrations', () => {
  const registered = new Set(), registry = { unregisterAll: () => registered.clear(), register: key => {
    if (registered.has(key)) return false; registered.add(key); return true;
  } };
  const manager = new GlobalHotkeys(registry, { history: () => {}, stack: () => {} }); manager.apply(DEFAULT_SETTINGS);
  assert.throws(() => manager.apply({ hotkey: 'CommandOrControl+A', stackHotkey: 'CommandOrControl+A' }));
  assert.equal(registered.size, 2); assert.ok(registered.has(DEFAULT_SETTINGS.hotkey));
});
test('local shortcuts match exact modifiers, arrow aliases and platform conventions', () => {
  assert.equal(shortcutMatches({ key: 'ArrowRight', metaKey: true }, 'CommandOrControl+Right'), true);
  assert.equal(shortcutMatches({ key: 'ArrowRight', metaKey: true, shiftKey: true }, 'CommandOrControl+Right'), false);
  assert.equal(shortcutMatches({ key: 'v', ctrlKey: true, shiftKey: true }, 'CommandOrControl+Shift+V', 'linux'), true);
  assert.equal(shortcutMatches({ key: 'v', ctrlKey: true, shiftKey: true }, 'CommandOrControl+Shift+V'), false);
  assert.equal(modifierPressed({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }, 'Shift'), true);
  assert.equal(modifierPressed({ altKey: true }, 'Alt'), true);
});
