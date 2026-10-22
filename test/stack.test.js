const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { StackQueue } = require('../src/stack-queue');
const { StackInput } = require('../src/stack-input');
const { PasteDelivery } = require('../src/paste-target');
const flush = () => new Promise(resolve => setImmediate(resolve));
const target = { pid: 111, bundleId: 'test.target', launchTime: 123 };
function fixture(overrides = {}) {
  const writes = [], child = new EventEmitter(); child.exitCode = child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.stdin.on('data', data => writes.push(...String(data).trim().split('\n').map(JSON.parse)));
  child.stdin.on('finish', () => { child.exitCode = 0; setImmediate(() => child.emit('close', 0)); });
  child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('close'); };
  const input = new StackInput({ helper: '', ownPID: 999, ...overrides });
  input.launch = () => { setImmediate(() => child.stdout.write('{"event":"ready","version":10,"keyboard":true}\n')); return child; };
  return { input, child, writes };
}
test('automatic Stack occurrences repeat known content but exclude old sessions, owned and uncertain writes', () => {
  const queue = new StackQueue(); queue.start(10); const session = queue.session;
  queue.observe('A', { version: 10, session }); queue.observe('A', { version: 11, session }); queue.observe('A', { version: 12, session });
  assert.deepEqual(queue.ordered().map(entry => entry.itemId), ['A', 'A']); assert.notEqual(queue.entries[0].id, queue.entries[1].id);
  queue.observe('B', { version: 13, session, owned: true }); queue.observe('B', { version: 15, session, uncertain: true });
  assert.equal(queue.entries.length, 2); assert.match(queue.problem, /归属/);
  queue.stop(); queue.start(20); queue.observe('A', { version: 21, session }); assert.equal(queue.entries.length, 0);
});
test('fast requests reserve distinct occurrences; reversal, deletion and completion cannot consume a different item', () => {
  const queue = new StackQueue(); queue.start(); queue.add('A'); queue.add('B'); queue.add('C');
  const a = queue.reserve('native', 1), b = queue.reserve('native', 1); queue.reverse();
  assert.equal(queue.reserve().itemId, 'C'); assert.equal(queue.begin(a), true); queue.remove(a.entryId);
  queue.finish(a, true); assert.deepEqual(queue.ordered().map(entry => entry.itemId), ['C', 'B']);
  assert.equal(queue.begin(b), true); queue.finish(b, false); assert.equal(queue.entries.length, 2);
});
test('abort invalidates queued requests but retains started completion, and old sessions never consume a replacement', () => {
  const queue = new StackQueue(); queue.start(); queue.add('A'); queue.add('B');
  const a = queue.reserve('native', 2), b = queue.reserve('native', 2); queue.begin(a);
  assert.deepEqual(queue.inventory(2), { count: 2, busy: true }); queue.cancelPending();
  assert.equal(queue.begin(b), false); assert.deepEqual(queue.inventory(3), { count: 1, busy: true });
  queue.finish(a, true); assert.deepEqual(queue.ordered().map(entry => entry.itemId), ['B']);
  const old = queue.reserve(); queue.begin(old); queue.start(); queue.add('B'); queue.finish(old, true); assert.equal(queue.entries.length, 1);
});
test('Stack capacity failure is visible and history references are retained without reading bodies', () => {
  const queue = new StackQueue(); queue.start(); for (let i = 0; i < 1000; i++) queue.add(String(i));
  assert.equal(queue.add('overflow'), false); assert.match(queue.problem, /1000/); queue.retain(id => id === '5'); assert.equal(queue.entries.length, 1);
});
test('native protocol acknowledges only contiguous completions and ignores commands from an invalidated epoch', async () => {
  const jobs = [], { input, child, writes } = fixture({ inventory: () => ({ count: 3, busy: true }), onPaste: request => new Promise(resolve => jobs.push({ ...request, resolve })) });
  try {
    await input.start(); const epoch = input.epoch;
    for (const seq of [1, 2]) child.stdout.write(JSON.stringify({ event: 'paste', epoch, seq, target }) + '\n');
    await flush(); assert.equal(jobs.length, 2); jobs[1].resolve(); await flush(); assert.equal(input.ack, 0);
    jobs[0].resolve(); await flush(); assert.equal(input.ack, 2); assert.equal(writes.at(-1).ack, 2);
    input.reset(); child.stdout.write(JSON.stringify({ event: 'paste', epoch, seq: 3, target }) + '\n'); await flush(); assert.equal(jobs.length, 2);
  } finally { jobs.forEach(job => job.resolve()); await input.stop(); }
  assert.equal(input.state.running, false); assert.equal(child.exitCode, 0);
});
test('invalid native messages stop the child even if an error observer throws', async () => {
  const { input, child } = fixture({ onFailure: () => { throw Error('observer'); } });
  const previous = console.error; console.error = () => {};
  try {
    await input.start(); child.stdout.write(JSON.stringify({ event: 'paste', epoch: input.epoch, seq: 2, target }) + '\n');
    await flush(); if (input.closing) await input.closing;
    assert.equal(input.state.running, false); assert.equal(input.child, null); assert.equal(child.exitCode, 0);
  } finally { console.error = previous; await input.stop(); }
});
test('permission loss and retry are explicit; malformed targets cannot schedule a paste', async () => {
  let pastes = 0; const { input, child, writes } = fixture({ onPaste: async () => { pastes++; } });
  try {
    await input.start(); child.stdout.write('{"event":"keyboard","keyboard":false,"error":"keyboard-paused"}\n');
    assert.equal(input.state.keyboard, false); input.refreshPermission(); assert.deepEqual(writes.at(-1), { refresh: true });
    child.stdout.write(JSON.stringify({ event: 'paste', epoch: input.epoch, seq: 1, target: { ...target, pid: 999 } }) + '\n');
    await flush(); assert.equal(pastes, 0); assert.equal(input.state.running, false);
  } finally { await input.stop(); }
});
test('test-mode Stack neither launches a helper nor claims real keyboard permission', async () => {
  const input = new StackInput({ simulate: true, baseline: () => 12 }); input.launch = () => { throw Error('must not run'); };
  assert.deepEqual(await input.start(), { version: 12, keyboard: false, simulated: true }); await input.stop();
});
test('a late rejected paste from an old protocol epoch cannot report failure into the new session', async () => {
  let reject, failures = 0;
  const { input, child } = fixture({ onPaste: () => new Promise((_resolve, fail) => { reject = fail; }), onFailure: () => { failures++; } });
  try {
    await input.start(); child.stdout.write(JSON.stringify({ event: 'paste', epoch: input.epoch, seq: 1, target }) + '\n'); await flush();
    input.reset(); reject(Error('Old session failed')); await flush(); assert.equal(failures, 0); assert.equal(input.state.running, true);
  } finally { await input.stop(); }
});
test('background delivery never closes a draft or reopens a focused panel on failure', async () => {
  let dismissed = 0, recovered = 0;
  const delivery = new PasteDelivery({ permission: async () => ({ accessibility: true }), verify: async () => ({ ok: true }),
    activate: async () => ({ ok: false }), dismiss: () => { dismissed++; }, recover: async () => { recovered++; } });
  assert.equal((await delivery.deliver({ paste: true, pasteTarget: 'application', target, background: true })).ok, false);
  assert.equal((await delivery.deliver({ paste: false, background: true })).ok, true);
  assert.equal(dismissed, 0); assert.equal(recovered, 0);
});
