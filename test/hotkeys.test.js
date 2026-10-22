const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GlobalHotkeys } = require('../src/hotkeys');
const { DEFAULT_SETTINGS, modifierPressed, shortcutMatches } = require('../src/model');

test('a conflicting global shortcut edit preserves both existing registrations', () => {
  const registered = new Map();
  const registry = { unregister: key => registered.delete(key), unregisterAll: () => registered.clear(), register: (key, callback) => {
    if (key === 'CommandOrControl+X' || registered.has(key)) return false;
    registered.set(key, callback); return true;
  } };
  const callbacks = { history: () => {}, stack: () => {} }, hotkeys = new GlobalHotkeys(registry, callbacks);
  hotkeys.apply(DEFAULT_SETTINGS);
  assert.notEqual(registered.get(DEFAULT_SETTINGS.stackHotkey), callbacks.stack); assert.equal(typeof registered.get(DEFAULT_SETTINGS.stackHotkey), 'function');
  assert.throws(() => hotkeys.apply({ hotkey: 'CommandOrControl+Alt+V', stackHotkey: 'CommandOrControl+X' }), /被占用/);
  assert.deepEqual([...registered.keys()], [DEFAULT_SETTINGS.hotkey, DEFAULT_SETTINGS.stackHotkey]);
  hotkeys.apply({ ...DEFAULT_SETTINGS, stackHotkey: '' }); assert.equal(registered.size, 1);
});
test('duplicate shortcut combinations fail without losing previous registrations', () => {
  const registered = new Set(), registry = { unregister: key => registered.delete(key), unregisterAll: () => registered.clear(), register: key => {
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
test('a conflicting edit never releases existing shortcuts that another app could claim before rollback', () => {
  const active = new Map(); let released = false;
  const registry = { unregisterAll() { if (active.size) released = true; active.clear(); }, unregister(key) { active.delete(key); }, register(key, callback) {
    if (key === 'Occupied' || (released && key === 'Old')) return false; active.set(key, callback); return true;
  } };
  const manager = new GlobalHotkeys(registry, { history() {}, stack() {} }); manager.apply({ hotkey: 'Old', stackHotkey: '' });
  assert.throws(() => manager.apply({ hotkey: 'Occupied', stackHotkey: '' }));
  assert.deepEqual([...active.keys()], ['Old']); assert.equal(released, false);
});
test('staging keeps previous callbacks until durable commit and rollback does not reacquire released originals', () => {
  const active = new Map(), fired = [];
  const registry = { unregisterAll: () => active.clear(), unregister: key => active.delete(key), register(key, callback) { active.set(key, callback); return true; } };
  const manager = new GlobalHotkeys(registry, { history: () => fired.push('history'), stack: () => fired.push('stack') });
  manager.apply({ hotkey: 'Old', stackHotkey: '' }); const staged = manager.prepare({ hotkey: 'New', stackHotkey: '' });
  active.get('New')(); active.get('Old')(); assert.deepEqual(fired, ['history']);
  staged.rollback(); assert.deepEqual([...active.keys()], ['Old']); active.get('Old')(); assert.deepEqual(fired, ['history', 'history']);
});
function registryFixture() {
  const active = new Map(), calls = [], fired = [];
  const registry = { unregisterAll() { throw Error('Must never release unrelated/previous registrations'); },
    isRegistered: key => active.has(key), register(key, callback) { calls.push(['register', key]); if (key === 'Occupied') return false; active.set(key, callback); return true; },
    unregister(key) { calls.push(['unregister', key]); active.delete(key); } };
  const manager = new GlobalHotkeys(registry, { history: () => fired.push('history'), stack: () => fired.push('stack') });
  manager.apply({ hotkey: 'A', stackHotkey: 'B' }); calls.length = 0; return { active, calls, fired, registry, manager };
}
test('unchanged keys and role swaps reuse OS dispatchers while successful changes release only obsolete owned keys', () => {
  const f = registryFixture(), dispatcher = f.active.get('A'); f.active.set('Other', () => {});
  f.manager.apply({ hotkey: 'A', stackHotkey: 'B' }); assert.deepEqual(f.calls, []);
  f.manager.apply({ hotkey: 'B', stackHotkey: 'A' }); assert.deepEqual(f.calls, []); assert.equal(f.active.get('A'), dispatcher);
  f.active.get('A')(); f.active.get('B')(); assert.deepEqual(f.fired, ['stack', 'history']);
  f.manager.apply({ hotkey: 'C', stackHotkey: 'A' }); assert.deepEqual(f.calls, [['register', 'C'], ['unregister', 'B']]); assert.equal(f.active.has('Other'), true);
});
test('a later registration failure cleans only newly staged keys and keeps both original callbacks usable', () => {
  const f = registryFixture(); assert.throws(() => f.manager.prepare({ hotkey: 'C', stackHotkey: 'Occupied' }), /被占用/);
  assert.deepEqual([...f.active.keys()], ['A', 'B']); assert.deepEqual(f.calls, [['register', 'C'], ['register', 'Occupied'], ['unregister', 'C']]);
  f.active.get('A')(); f.active.get('B')(); assert.deepEqual(f.fired, ['history', 'stack']); assert.equal(f.manager.pending, null);
});
test('cleanup failure reports an inactive old reservation and retry releases it without re-registering live shortcuts', () => {
  const f = registryFixture(), unregister = f.registry.unregister; f.registry.unregister = key => { if (key === 'A') throw Error('OS release failed'); unregister(key); };
  assert.match(f.manager.apply({ hotkey: 'C', stackHotkey: 'B' }), /未能释放/); assert.equal(f.manager.needsCleanup, true);
  f.active.get('A')(); f.active.get('C')(); assert.deepEqual(f.fired, ['history']);
  f.calls.length = 0; f.registry.unregister = unregister; assert.equal(f.manager.apply({ hotkey: 'C', stackHotkey: 'B' }), '');
  assert.equal(f.manager.needsCleanup, false); assert.deepEqual(f.calls, [['unregister', 'A']]);
});
test('transactions reject overlap, cannot commit after rollback and close idempotently', () => {
  const f = registryFixture(), first = f.manager.prepare({ hotkey: 'C', stackHotkey: 'B' });
  assert.throws(() => f.manager.prepare({ hotkey: 'D', stackHotkey: 'B' }), /处理中/); first.rollback(); first.rollback(); assert.throws(() => first.commit(), /取消/);
  const next = f.manager.prepare({ hotkey: 'D', stackHotkey: '' }); next.commit(); next.commit(); next.rollback(); assert.deepEqual([...f.active.keys()], ['D']);
});
test('disabled test mode never calls the system registry even when settings are staged, committed or cleared', () => {
  const registry = new Proxy({}, { get() { throw Error('Unexpected native access'); } });
  const manager = new GlobalHotkeys(registry, { history() {}, stack() {} }, true);
  manager.apply({ hotkey: 'A', stackHotkey: 'B' }); manager.prepare({ hotkey: '', stackHotkey: '' }).commit(); assert.deepEqual(manager.current, []);
});
