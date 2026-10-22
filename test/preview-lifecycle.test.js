const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function harness() {
  const root = path.resolve(__dirname, '..'), local = createRequire(path.join(root, 'src/main.js'));
  const timers = new Map(), immediates = []; let serial = 0;
  class Window extends EventEmitter {
    constructor() {
      super(); this.closed = 0; this.destroyed = false; this.focused = false; this.hidden = false;
      this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler() {}, send() {} });
    }
    loadFile() {}
    isDestroyed() { return this.destroyed; }
    isFocused() { if (this.destroyed) throw Error('Focus queried after destruction'); return this.focused; }
    isVisible() { return !this.hidden; }
    getBounds() { return { x: 0, y: 748, width: 1920, height: 332 }; }
    show() { this.hidden = false; }
    focus() {}
    hide() { this.hidden = true; }
    close() { this.closed++; this.destroyed = true; this.emit('closed'); }
  }
  const app = { setPath() {}, getPath: () => '/tmp/unused-preview-lifecycle', getAppPath: () => root,
    requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) };
  const electron = { app, BrowserWindow: Window, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } };
  const context = vm.createContext({ require: id => id === 'electron' ? electron : local(id), __dirname: path.join(root, 'src'),
    process: { argv: [], env: {}, pid: 999, platform: 'darwin' }, console, Buffer,
    setTimeout: fn => { const id = ++serial; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setImmediate: fn => immediates.push(fn), clearInterval() {} });
  // Execute the production handlers, but never call startup or any OS adapter.
  vm.runInContext(fs.readFileSync(path.join(root, 'src/main.js'), 'utf8') + `
    mainWindow = new electron.BrowserWindow();
    store = { get: id => ({ id, type: 'text', body: id, title: id }), data: { boards: [] } };
    globalThis.probe = { showPreview, hidePanel, window: () => previewWindow, panel: () => mainWindow, state: () => previewState,
      capture: () => previewBlurAction(previewWindow), newPanelSession: () => pasteTargets.cancel(),
      fields: values => { if ('dirty' in values) previewDirty = values.dirty; if ('opening' in values) previewOpening = values.opening;
        if ('quitting' in values) quitting = values.quitting; if ('suppressed' in values) suppressBlur = values.suppressed; } };
  `, context);
  const p = context.probe;
  function flushImmediate() { immediates.splice(0).forEach(fn => fn()); }
  return { p, timers, flushImmediate,
    open(id = 'A') { p.showPreview(id); p.window().emit('ready-to-show'); flushImmediate(); return p.window(); },
    flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); flushImmediate(); } };
}

test('production delayed blur cannot close a different item reused in the same preview window', () => {
  const h = harness(), window = h.open(); window.emit('blur'); assert.equal(h.timers.size, 1);
  h.p.showPreview('B'); h.flush();
  assert.equal(h.p.state().id, 'B'); assert.equal(window.closed, 0); assert.equal(h.p.panel().hidden, false);
});
test('closed and refocused previews cancel timers; a callback already obtained still cannot target a newer window', () => {
  const h = harness(), old = h.open(); old.emit('blur'); const late = h.p.capture();
  old.emit('focus'); assert.equal(h.timers.size, 0);
  old.emit('blur'); assert.equal(h.timers.size, 1); old.close(); assert.equal(h.timers.size, 0);
  const next = h.open('B'); assert.equal(late(), false); h.flush(); assert.equal(next.closed, 0); assert.equal(h.p.state().id, 'B');
  old.emit('closed'); assert.equal(h.p.state().id, 'B'); assert.equal(h.p.window(), next);
});
test('a new panel session invalidates the old preview blur even when the same preview remains alive', () => {
  const h = harness(), window = h.open(); window.emit('blur'); h.p.newPanelSession(); h.flush();
  assert.equal(window.closed, 0); assert.equal(h.p.panel().hidden, false);
});
test('only the latest uninterrupted blur closes the clean unfocused preview and hides its panel', () => {
  const h = harness(), window = h.open(); window.emit('blur'); window.emit('focus'); window.emit('blur');
  assert.equal(h.timers.size, 1); h.flush(); assert.equal(window.closed, 1); assert.equal(h.p.panel().hidden, true); assert.equal(h.p.state(), null);
});
test('dirty, opening, quitting and native-dialog states remain protected at timeout execution', () => {
  for (const field of ['dirty', 'opening', 'quitting', 'suppressed']) {
    const h = harness(), window = h.open(); window.emit('blur'); h.p.fields({ [field]: true }); h.flush();
    assert.equal(window.closed, 0, field); assert.equal(h.p.panel().hidden, false, field);
  }
});
test('current focus is checked at execution and destroyed windows are never queried', () => {
  for (const focused of ['window', 'panel']) {
    const h = harness(), window = h.open(); window.emit('blur'); h.p[focused]().focused = true; h.flush(); assert.equal(window.closed, 0);
  }
  const h = harness(), window = h.open(), late = h.p.capture(); h.p.panel().destroyed = true;
  assert.equal(late(), false); h.p.panel().destroyed = false; window.close(); assert.equal(late(), false);
});
