const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClipboardMonitor } = require('../src/monitor');

function fixture(overrides = {}) {
  const state = { version: 1, snapshot: { signature: 'one' }, reads: 0, captures: [], errors: [], paused: false };
  const monitor = new ClipboardMonitor({ readVersion: async () => state.version,
    readSnapshot: async () => { state.reads += 1; return state.snapshot; },
    onSnapshot: value => state.captures.push(value), isPaused: () => state.paused, onError: error => state.errors.push(error), ...overrides });
  return { state, monitor };
}
test('unchanged pasteboard versions never reread or decode large payloads', async () => {
  const { state, monitor } = fixture();
  for (let n = 0; n < 100; n++) await monitor.tick();
  assert.equal(state.reads, 1); assert.equal(state.captures.length, 1);
});
test('a copy during an asynchronous snapshot is discarded and retried', async () => {
  const { state, monitor } = fixture();
  monitor.readSnapshot = async () => { state.version = 2; return { signature: 'stale' }; };
  await monitor.tick(); assert.equal(state.captures.length, 0);
  monitor.readSnapshot = async () => ({ signature: 'fresh' });
  await monitor.tick(); assert.equal(state.captures[0].signature, 'fresh');
});
test('paused content is not read or replayed when capture resumes', async () => {
  const { state, monitor } = fixture();
  state.paused = true; await monitor.tick(); assert.equal(state.reads, 0);
  state.version = 2; state.snapshot = { signature: 'private' }; await monitor.tick();
  await monitor.suspend(() => { state.paused = false; }, { baseline: true });
  await monitor.tick(); assert.equal(state.captures.length, 0);
  state.version = 3; state.snapshot = { signature: 'new' }; await monitor.tick();
  assert.equal(state.captures[0].signature, 'new');
});
test('pause or an owned write invalidates a read already in flight', async () => {
  const { state, monitor } = fixture();
  let finish; monitor.readSnapshot = () => new Promise(resolve => { finish = resolve; });
  const pending = monitor.tick(); await new Promise(resolve => setImmediate(resolve));
  await monitor.suspend(() => { monitor.remember('owned'); });
  finish({ signature: 'stale' }); await pending;
  assert.equal(state.captures.length, 0);
});
test('persistence failures do not advance the version or lose a retry', async () => {
  const { state, monitor } = fixture({ onSnapshot: () => { throw new Error('disk full'); } });
  await monitor.tick(); assert.equal(state.errors[0].message, 'disk full');
  monitor.onSnapshot = item => state.captures.push(item); await monitor.tick();
  assert.equal(state.captures.length, 1);
});
test('startup preserves timestamps of an already known clipboard item', async () => {
  const { state, monitor } = fixture({ isKnown: signature => signature === 'one' });
  await monitor.tick(); assert.equal(state.captures.length, 0);
  state.version = 2; state.snapshot = { signature: 'two' }; await monitor.tick();
  state.version = 3; state.snapshot = { signature: 'one' }; await monitor.tick();
  assert.deepEqual(state.captures.map(item => item.signature), ['two', 'one']);
});
test('resuming capture records the next genuine recopy even when it is already known', async () => {
  const { state, monitor } = fixture({ isKnown: () => true });
  state.paused = true; await monitor.tick();
  await monitor.suspend(() => { state.paused = false; }, { baseline: true });
  state.version += 1; await monitor.tick();
  assert.equal(state.captures.length, 1);
});
test('a failed pause baseline leaves settings and capture retryable', async () => {
  const { state, monitor } = fixture();
  monitor.readVersion = async () => { throw new Error('bridge failed'); };
  await assert.rejects(monitor.suspend(() => { state.paused = true; }, { baseline: true }), /bridge failed/);
  assert.equal(state.paused, false); assert.equal(monitor.suspended, 0);
  monitor.readVersion = async () => 1; await monitor.tick();
  assert.equal(state.captures.length, 1);
});
