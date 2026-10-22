const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortcutRecorder } = require('../src/shortcut-recorder');
const { GlobalHotkeys } = require('../src/hotkeys');
const { shortcutCandidate } = require('../src/model');
function fixture() {
  const menus = [], messages = [], errors = [], saves = [];
  const window = { destroyed: false, visible: true, focused: true, isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isFocused() { return this.focused; },
    webContents: { isDestroyed: () => window.destroyed, setIgnoreMenuShortcuts: value => menus.push(value), send: (channel, value) => messages.push([channel, value]) } };
  const f = { window, menus, messages, errors, saves, owner: window, settings: { hotkey: 'CommandOrControl+Shift+V', stackHotkey: 'CommandOrControl+Shift+C', nextBoardHotkey: 'CommandOrControl+Right', previousBoardHotkey: 'CommandOrControl+Left' } };
  f.recorder = new ShortcutRecorder({ getWindow: () => f.owner, getSettings: () => f.settings, save: async change => { const value = change(f.settings); saves.push(value); Object.assign(f.settings, value); return { settings: { ...f.settings } }; }, onError: error => errors.push(error) });
  return f;
}
test('recording has an owned unique token, ignores stale cancellation and restores menus when replaced or ended', () => {
  const f = fixture(), first = f.recorder.begin(f.window, 'hotkey'), next = f.recorder.begin(f.window, 'stackHotkey');
  assert.notEqual(first.id, next.id); assert.equal(f.recorder.cancel(f.window, first.id), false); assert.equal(f.recorder.current.id, next.id);
  assert.equal(f.recorder.cancel(f.window, next.id), true); assert.deepEqual(f.menus, [true, false, true, false]); assert.equal(f.recorder.mode(f.window), null);
});
test('invalid fields, hidden windows and non-owners cannot begin, finish or cancel another session', async () => {
  const f = fixture(), session = f.recorder.begin(f.window, 'hotkey');
  assert.throws(() => f.recorder.begin(f.window, 'paused')); assert.equal(f.recorder.cancel({}, session.id), false);
  await assert.rejects(f.recorder.finish({}, session.id, 'CommandOrControl+A')); assert.equal(f.recorder.current.id, session.id);
  f.window.visible = false; assert.equal(f.recorder.mode(f.window), null); assert.deepEqual(f.saves, []); assert.deepEqual(f.menus, [true, false]);
});
test('finish updates only the captured field and closes its menu suppression on success or invalid input', async () => {
  const f = fixture(), session = f.recorder.begin(f.window, 'nextBoardHotkey');
  const result = await f.recorder.finish(f.window, session.id, 'CommandOrControl+T'); assert.equal(result.settings.nextBoardHotkey, 'CommandOrControl+T');
  assert.deepEqual(f.saves, [{ nextBoardHotkey: 'CommandOrControl+T' }]); assert.deepEqual(f.menus, [true, false]);
  const bad = f.recorder.begin(f.window, 'hotkey'); await assert.rejects(f.recorder.finish(f.window, bad.id, ''), /无效/); assert.equal(f.recorder.current, null);
});
test('a concurrent value change is not overwritten and the capture still exits', async () => {
  const f = fixture(), session = f.recorder.begin(f.window, 'hotkey'); f.settings.hotkey = 'Control+Alt+V';
  await assert.rejects(f.recorder.finish(f.window, session.id, 'CommandOrControl+A'), /另一处改变/); assert.equal(f.settings.hotkey, 'Control+Alt+V'); assert.deepEqual(f.saves, []); assert.equal(f.recorder.current, null);
});
test('a queued completion cannot save after cancellation or clear a newer capture', async () => {
  const f = fixture(); let release; const gate = new Promise(resolve => { release = resolve; });
  f.recorder.save = async change => { await gate; const value = change(f.settings); Object.assign(f.settings, value); return f.settings; };
  const old = f.recorder.begin(f.window, 'hotkey'), pending = f.recorder.finish(f.window, old.id, 'CommandOrControl+A');
  assert.equal(f.recorder.mode(f.window), 'finishing'); const next = f.recorder.begin(f.window, 'stackHotkey'); release();
  await assert.rejects(pending, /已取消/); assert.equal(f.recorder.current.id, next.id); assert.equal(f.settings.hotkey, 'CommandOrControl+Shift+V'); assert.equal(f.menus.at(-1), true);
});
test('global dispatchers keep forwarding while recording and resume after focus leaves, without re-registration', () => {
  const f = fixture(), active = new Map(), calls = [], fired = [];
  const registry = { register: (key, callback) => { calls.push(['register', key]); active.set(key, callback); return true; }, unregister: key => { calls.push(['unregister', key]); active.delete(key); } };
  const manager = new GlobalHotkeys(registry, { history: () => fired.push('history'), stack: () => fired.push('stack') }, false, key => f.recorder.interceptGlobal(key));
  manager.apply(f.settings); calls.length = 0; f.recorder.begin(f.window, 'hotkey');
  active.get(f.settings.hotkey)(); active.get(f.settings.hotkey)(); assert.deepEqual(fired, []); assert.equal(f.messages.length, 2); assert.equal(f.messages[0][1].accelerator, f.settings.hotkey);
  assert.deepEqual(calls, []); f.window.focused = false; active.get(f.settings.hotkey)(); assert.deepEqual(fired, ['history']); assert.equal(f.recorder.current, null); assert.deepEqual(f.menus, [true, false]);
});
test('destroyed or replaced owners end capture, and cleanup failures do not leave the global gate active', () => {
  const f = fixture(); f.recorder.begin(f.window, 'hotkey'); f.owner = {}; assert.equal(f.recorder.mode(f.window), null);
  f.owner = f.window; f.recorder.begin(f.window, 'hotkey'); f.window.destroyed = true; assert.equal(f.recorder.mode(f.window), null);
  f.window.destroyed = false; f.recorder.begin(f.window, 'hotkey'); f.window.webContents.setIgnoreMenuShortcuts = () => { throw Error('Owner gone'); };
  f.recorder.cancel(f.window); assert.equal(f.recorder.current, null); assert.equal(f.errors.length, 1);
});
test('native accessor properties, physical digits, arrows, Space and Plus produce canonical shortcuts without dropping Control', () => {
  const event = Object.create({ get key() { return '+'; }, get metaKey() { return true; }, get ctrlKey() { return true; }, get shiftKey() { return true; } });
  assert.equal(shortcutCandidate(event), 'CommandOrControl+Control+Shift+Plus');
  assert.equal(shortcutCandidate({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }), 'CommandOrControl+Shift+1');
  assert.equal(shortcutCandidate({ key: 'ArrowLeft', metaKey: true }), 'CommandOrControl+Left');
  assert.equal(shortcutCandidate({ key: ' ', ctrlKey: true, altKey: true }), 'Control+Alt+Space');
});
test('repeat, modifiers alone, incomplete keys and IME/Dead input never become a saved candidate', () => {
  for (const event of [{ key: '' }, { key: 'Meta', metaKey: true }, { key: 'AltGraph', ctrlKey: true, altKey: true }, { key: 'Dead', metaKey: true },
    { key: 'v', metaKey: true, repeat: true }, { key: 'v', metaKey: true, isComposing: true }, { key: 'v', metaKey: true, keyCode: 229 }, { key: 'v' }]) assert.equal(shortcutCandidate(event), null);
  assert.equal(shortcutCandidate({ key: 'v', metaKey: true }, true), null);
});
