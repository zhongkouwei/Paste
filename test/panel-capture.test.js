const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness(testMode = false) {
  const root = path.resolve(__dirname, '..'), local = createRequire(path.join(root, 'src/main.js'));
  const timers = new Map(); let timerID = 0;
  const app = { setPath() {}, getPath: () => '/tmp/paste-panel-capture-unused', getAppPath: () => root,
    requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) };
  const context = vm.createContext({ require: id => id === 'electron' ? { app } : id === 'node:child_process'
    ? { execFile() { throw Error('Forbidden OS adapter'); } } : local(id), __dirname: path.join(root, 'src'),
    process: { argv: testMode ? ['--test-mode'] : [], env: {}, pid: 999, platform: 'darwin' }, console, Buffer,
    setTimeout: (callback, delay) => { assert.equal(delay, 1000); const id = ++timerID; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  // Inspect the actual production wiring without starting Electron or OS helpers.
  vm.runInContext(fs.readFileSync(path.join(root, 'src/main.js'), 'utf8') + `
    const errors = []; report = error => errors.push(error);
    globalThis.probe = { targets: pasteTargets, before: pollBeforeShow, errors,
      setup: (value, pause) => { monitor = value; capturePause = pause; } };
  `, context);
  context.probe.targets.read = async () => ({ pid: 111, bundleId: 'test.panel.target', launchTime: 123 });
  context.probe.expire = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); };
  return context.probe;
}
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
test('production panel opening is wired to drain an old poll and perform a new guarded capture before committing the target', async () => {
  const h = harness(), old = gate(), calls = []; assert.equal(h.targets.beforeReady, h.before);
  h.setup({ pending: old.promise, tick: async () => { calls.push('tick'); } }, { check: async () => { calls.push('pause'); } });
  const opening = h.targets.refresh(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.targets.pending, true); assert.deepEqual(calls, []);
  old.resolve(); assert.equal(await opening, true); assert.deepEqual(calls, ['pause', 'tick']); assert.equal(h.targets.snapshot().pid, 111);
  await h.targets.refresh(true); assert.deepEqual(calls, ['pause', 'tick']);
});
test('production opening cancelled while draining an old poll cannot start another payload read', async () => {
  const h = harness(), old = gate(); let ticks = 0;
  h.setup({ pending: old.promise, tick: async () => { ticks++; } }, { check: async () => {} });
  const opening = h.targets.refresh(); await new Promise(resolve => setImmediate(resolve)); h.targets.cancel(); old.resolve();
  assert.equal(await opening, false); assert.equal(ticks, 0); assert.equal(h.targets.snapshot(), null);
});
test('test mode does not automatically enable production clipboard capture when opening', async () => {
  const h = harness(true); assert.equal(h.targets.beforeReady, undefined);
  h.setup({ tick: () => { throw Error('Forbidden automatic clipboard read'); } }, { check: async () => {} });
  assert.equal(await h.targets.refresh(), true);
});
test('the opening deadline releases old history and invalidates late capture instead of waiting forever', async () => {
  const h = harness(), old = gate(); let ticks = 0, baselines = 0;
  h.setup({ pending: old.promise, tick: async () => { ticks++; }, requireBaseline: () => { baselines++; } }, { check: async () => {} });
  const opening = h.targets.refresh(); await new Promise(resolve => setImmediate(resolve)); h.expire();
  assert.equal(await opening, true); assert.equal(baselines, 1); assert.match(h.errors[0].message, /读取未完成/);
  old.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(ticks, 0);
});
test('a pause check completing after the opening deadline cannot start another capture', async () => {
  const h = harness(), pause = gate(); let ticks = 0, baselines = 0;
  h.setup({ tick: async () => { ticks++; }, requireBaseline: () => { baselines++; } }, { check: () => pause.promise });
  const opening = h.targets.refresh(); await new Promise(resolve => setImmediate(resolve)); h.expire(); assert.equal(await opening, true);
  pause.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(ticks, 0); assert.equal(baselines, 1);
});
test('an expired preparation timer from a cancelled invocation neither invalidates recording nor reports a stale error', async () => {
  const h = harness(), old = gate(); let baselines = 0;
  h.setup({ pending: old.promise, tick: async () => { throw Error('Unexpected capture'); }, requireBaseline: () => { baselines++; } }, { check: async () => {} });
  const opening = h.targets.refresh(); await new Promise(resolve => setImmediate(resolve)); h.targets.cancel(); h.expire();
  assert.equal(await opening, false); assert.equal(baselines, 0); assert.equal(h.errors.length, 0); old.resolve();
});
