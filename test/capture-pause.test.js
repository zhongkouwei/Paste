const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CapturePause } = require('../src/capture-pause');
const { ClipboardMonitor } = require('../src/monitor');
const { sanitizeSettings, DEFAULT_SETTINGS } = require('../src/model');
const { applicationMenuTemplate, pauseShortcut } = require('../src/app-menu');
function fixture(settings = {}) {
  const state = { settings: sanitizeSettings(settings), now: 1000000, version: 1, value: { signature: 'private' }, reads: 0, captures: [], timers: new Map(), errors: [] };
  let controller, queue = Promise.resolve(), serial = 0;
  const monitor = new ClipboardMonitor({ readVersion: async () => { if (state.counterFailure) throw Error('counter unavailable'); return state.version; },
    readSnapshot: async () => { state.reads++; return state.value; }, onSnapshot: value => state.captures.push(value), isPaused: () => controller?.isPaused() || false, onError: error => state.errors.push(error) });
  controller = new CapturePause({ read: () => state.settings, monitor, now: () => state.now,
    schedule: (fn, ms) => { state.timers.set(++serial, { fn, ms }); return serial; }, cancel: id => state.timers.delete(id),
    save: changes => {
      const ticket = controller.request(changes);
      const operation = queue.then(() => {
        controller.beforeCommit(ticket); if (state.persistFailure) throw Error('disk full');
        state.settings = sanitizeSettings(changes, state.settings); controller.committed(ticket); return state.settings;
      }).catch(error => { controller.failed(ticket, error); throw error; });
      queue = operation.catch(() => {}); return operation;
    }
  });
  return { state, monitor, controller };
}
test('pause closes the capture gate synchronously even when the version helper is unavailable', async () => {
  const { state, monitor, controller } = fixture(); state.counterFailure = true;
  const operation = controller.pauseFor(); assert.equal(controller.isPaused(), true); assert.equal(state.settings.paused, false);
  await operation; await monitor.tick(); assert.equal(state.settings.paused, true); assert.equal(state.reads, 0); assert.equal(state.captures.length, 0);
});
test('manual resume first establishes a fresh baseline, skips private content and resumes on a later copy', async () => {
  const { state, monitor, controller } = fixture({ paused: true });
  await controller.resume(); assert.equal(controller.snapshot().resuming, true); await monitor.tick();
  assert.equal(state.reads, 0); assert.equal(controller.snapshot().resuming, false);
  state.version++; state.value = { signature: 'public' }; await monitor.tick(); assert.deepEqual(state.captures, [{ signature: 'public' }]);
});
test('failed or invalid baseline reads cannot leak a private clipboard, and retries keep the barrier', async () => {
  const { state, monitor, controller } = fixture({ paused: true }); await controller.resume(); state.counterFailure = true;
  await monitor.tick(); assert.equal(monitor.needsBaseline, true); assert.equal(state.reads, 0); assert.match(controller.snapshot().error, /counter/);
  state.counterFailure = false; state.version = null; await monitor.tick(); assert.equal(monitor.needsBaseline, true); assert.equal(state.reads, 0);
  state.version = 9; await monitor.tick(); assert.equal(monitor.needsBaseline, false); assert.equal(state.reads, 0);
});
test('timed pause respects its persisted deadline, clock changes, wake checks and stale timer ownership', async () => {
  const { state, monitor, controller } = fixture(); await controller.pauseFor(300000);
  const until = state.now + 300000, old = [...state.timers.values()][0].fn; assert.equal(state.settings.pausedUntil, until);
  state.now -= 10000; await controller.check(); assert.equal(state.settings.paused, true);
  await controller.pauseFor(); old(); assert.equal(state.settings.paused, true); assert.equal(state.timers.size, 0);
  await controller.pauseFor(300000); state.now += 900000; await controller.check(); assert.equal(state.settings.paused, false); assert.equal(state.timers.size, 0);
  await monitor.tick(); assert.equal(state.reads, 0);
});
test('rapid pause/resume/pause intents never let an older completion release the newer privacy hold', async () => {
  const { state, monitor, controller } = fixture(); const operations = [controller.toggle(), controller.toggle(), controller.toggle()];
  assert.equal(controller.isPaused(), true); await Promise.all(operations); assert.equal(state.settings.paused, true); assert.equal(controller.snapshot().pending, false);
  await monitor.tick(); assert.equal(state.reads, 0); controller.close();
});
test('persistence failure keeps the current session paused and timed expiry retries with bounded backoff', async () => {
  const { state, controller } = fixture(); state.persistFailure = true;
  await assert.rejects(controller.pauseFor(), /disk full/); assert.equal(state.settings.paused, false); assert.equal(controller.isPaused(), true); assert.match(controller.snapshot().error, /仍停止记录/);
  state.persistFailure = false; await controller.pauseFor(300000); state.now += 300001; state.persistFailure = true;
  await assert.rejects(controller.check(), /disk full/); assert.equal(state.settings.paused, true); assert.equal([...state.timers.values()][0].ms, 5000);
  state.persistFailure = false; await controller.check(); assert.equal(state.settings.paused, true);
  state.now += 5000; await controller.check(); assert.equal(state.settings.paused, false);
});
test('old indefinite pauses remain indefinite and expired restart state resumes only through the baseline barrier', async () => {
  const old = fixture({ paused: true }); old.controller.sync(); assert.equal(old.state.timers.size, 0); assert.equal(old.state.settings.pausedUntil, null);
  const restored = fixture({ paused: true, pausedUntil: 5 }); await restored.controller.check(); assert.equal(restored.state.settings.paused, false); assert.equal(restored.monitor.needsBaseline, true);
  await restored.monitor.tick(); assert.equal(restored.state.reads, 0);
  for (const value of [0, -1, '300000', Infinity, 1000]) await assert.rejects(restored.controller.pauseFor(value), /有效/);
  restored.controller.close(); assert.equal(restored.state.timers.size, 0);
});
test('shutdown cancels timers and invalidates an in-flight snapshot without persisting it', async () => {
  const { state, controller, monitor } = fixture(); let release;
  monitor.readSnapshot = () => new Promise(resolve => { release = resolve; });
  const operation = monitor.tick(); await new Promise(resolve => setImmediate(resolve)); controller.close(); release({ signature: 'late private' }); await operation;
  assert.equal(state.captures.length, 0); assert.equal(controller.isPaused(), true); assert.equal(state.timers.size, 0);
});
test('pause metadata validates canonical timestamps and clears deadlines on manual mode or resume', () => {
  const timed = sanitizeSettings({ paused: true, pausedUntil: 1234567 }); assert.equal(timed.pausedUntil, 1234567);
  assert.equal(sanitizeSettings({ theme: 'dark' }, timed).pausedUntil, 1234567);
  assert.equal(sanitizeSettings({ paused: true }, timed).pausedUntil, null); assert.equal(sanitizeSettings({ paused: false, pausedUntil: 1234567 }, timed).pausedUntil, null);
  for (const value of [-1, '1000', true, NaN, Infinity, 8640000000000001]) assert.equal(sanitizeSettings({ paused: true, pausedUntil: value }).pausedUntil, null);
  assert.equal(DEFAULT_SETTINGS.pausedUntil, null);
});
test('native pause menu and exact local accelerator do not register a system-wide Command-T', () => {
  let toggles = 0; const durations = [];
  const template = applicationMenuTemplate(() => {}, 'darwin', () => {}, { toggle: () => { toggles++; }, pauseFor: duration => durations.push(duration) });
  const entry = template[0].submenu.find(entry => entry.id === 'capture-toggle'); assert.equal(entry.accelerator, 'CommandOrControl+T'); entry.click(); assert.equal(toggles, 1);
  template[0].submenu.find(entry => entry.label === '暂停时长').submenu.forEach(entry => entry.click()); assert.deepEqual(durations, [300000, 900000, 3600000, null]);
  assert.equal(pauseShortcut({ type: 'keyDown', key: 't', meta: true }, 'darwin'), true);
  for (const value of [{ type: 'keyUp' }, { isComposing: true }, { shift: true }, { alt: true }, { control: true }]) assert.equal(pauseShortcut({ type: 'keyDown', key: 't', meta: true, ...value }, 'darwin'), false);
});
