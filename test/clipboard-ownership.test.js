const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClipboardOwnership, validLease, validWriteID, WRITE_ID_MIME } = require('../src/clipboard-ownership');
const { ClipboardService } = require('../src/clipboard');
const { PasteDelivery } = require('../src/paste-target');
const { textSignature } = require('../src/store');
const token = '22222222-2222-4222-8222-222222222222';
const target = { pid: 111, bundleId: 'test.app', launchTime: 123 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

test('ownership binds the pre-write version plus a unique nonce, without certifying a later foreign copy', async () => {
  let version = 20, reads = 0, writes = 0, current;
  const owner = new ClipboardOwnership({ readVersion: async () => { reads++; return version; }, check: async lease => ({ ok: lease.version === version && lease.token === current, error: 'clipboard-changed' }) });
  const first = await owner.write(async value => { writes++; current = value; version++; return 'signature'; });
  assert.equal(first.signature, 'signature'); assert.equal(first.lease.version, 21); assert.ok(Object.isFrozen(first.lease)); assert.equal((await owner.verify(first.lease)).ok, true);
  version++; // Another writer could even copy the marker; the version still invalidates it.
  assert.equal((await owner.verify(first.lease)).ok, false); assert.equal(reads, 1); assert.equal(writes, 1);
  const second = await owner.write(async value => { current = value; version++; return 'second'; });
  assert.notEqual(first.lease.token, second.lease.token); assert.equal((await owner.verify(first.lease)).ok, false); assert.equal((await owner.verify(second.lease)).ok, true);
});
test('invalid or unavailable version still copies once, but never verifies automatic paste', async () => {
  for (const version of [undefined, null, true, -1, 1.5, '12', NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    let writes = 0, checks = 0;
    const owner = new ClipboardOwnership({ readVersion: async () => version, check: async () => { checks++; return { ok: true }; } });
    const receipt = await owner.write(async () => { writes++; return 'copied'; });
    assert.equal(receipt.lease, null); assert.equal(writes, 1); assert.equal((await owner.verify(receipt.lease)).ok, false); assert.equal(checks, 0);
  }
  const errors = [], owner = new ClipboardOwnership({ readVersion: async () => { throw Error('helper unavailable'); }, onError: error => errors.push(error), check: async () => { throw Error('check unavailable'); } });
  assert.equal((await owner.write(async () => 'copied')).lease, null); assert.equal(errors.length, 1);
  assert.equal((await owner.verify({ version: 1, token })).ok, false); assert.equal(errors.length, 2);
});
test('failed writes never yield a success receipt and malformed identities fail before writing', async () => {
  const owner = new ClipboardOwnership({ readVersion: async () => 0, check: async () => ({ ok: true }) });
  await assert.rejects(owner.write(async () => { throw Error('write failed'); }), /write failed/);
  let writes = 0; owner.token = () => 'invalid'; await assert.rejects(owner.write(async () => { writes++; }), /identity/); assert.equal(writes, 0);
  for (const value of [null, '', {}, 'x'.repeat(36), token + 'a']) assert.equal(validWriteID(value), false);
  for (const value of [null, {}, { version: true, token }, { version: -1, token }, { version: 1, token: 'bad' }]) assert.equal(validLease(value), false);
});
test('permission wait interrupted by a foreign copy cancels without activation, dismissal or rewriting', async () => {
  const permission = deferred(); let current = 'Requested A', version = 1, sent = 0, dismissed = 0;
  const owner = new ClipboardOwnership({ readVersion: async () => version, check: async lease => ({ ok: version === lease.version, error: 'clipboard-changed' }) });
  const receipt = await owner.write(async () => { version++; return 'A'; });
  const delivery = new PasteDelivery({ permission: () => permission.promise, verify: lease => owner.verify(lease), activate: async () => { sent++; return { ok: true }; }, dismiss: () => { dismissed++; } });
  const pending = delivery.deliver({ paste: true, pasteTarget: 'application', target, lease: receipt.lease });
  current = 'Newer foreign B'; version++; permission.resolve({ accessibility: true });
  const result = await pending; assert.equal(result.ok, false); assert.equal(result.copied, true); assert.match(result.error, /其他复制替换/);
  assert.equal(sent, 0); assert.equal(dismissed, 0); assert.equal(current, 'Newer foreign B');
});
test('unverifiable ownership fails closed and a native-stage race recovers with the correct message', async () => {
  let activations = 0, recovered = 0;
  const delivery = new PasteDelivery({ permission: async () => ({ accessibility: true }), verify: async () => ({ ok: false }),
    activate: async () => { activations++; return { ok: false, error: 'clipboard-changed' }; }, dismiss() {}, recover: async () => { recovered++; } });
  const context = { paste: true, pasteTarget: 'application', target, lease: { version: 1, token } };
  assert.match((await delivery.deliver(context)).error, /无法确认剪贴板归属/); assert.equal(activations, 0);
  delivery.verify = async () => ({ ok: true }); assert.match((await delivery.deliver(context)).error, /其他复制替换/); assert.equal(activations, 1); assert.equal(recovered, 1);
  delivery.verify = async () => { throw Error('verify failed'); }; assert.match((await delivery.deliver(context)).error, /无法确认剪贴板归属/); assert.equal(activations, 1);
});
test('atomic text and plain writes carry metadata without changing payload identity or stored originals', async () => {
  let entries;
  const service = new ClipboardService({ clipboard: { write: async values => { entries = values; } }, ClipboardItem: class { constructor(values) { this.values = values; } } });
  const item = { type: 'text', body: '中文 A', html: '<b>中文 A</b>', rtf: '{\\rtf1 A}' }, original = structuredClone(item);
  for (const plain of [false, true]) {
    assert.equal(await service.write(item, { plain, writeID: token }), textSignature(item.body, plain ? '' : item.html, plain ? '' : item.rtf));
    assert.equal(entries.length, 1); assert.equal(await entries[0].values[WRITE_ID_MIME].text(), token);
    assert.equal(entries[0].values['text/html'], plain ? undefined : item.html); assert.equal(entries[0].values['text/rtf'], plain ? undefined : item.rtf);
    assert.deepEqual(item, original);
  }
  await service.write(item); assert.equal(entries[0].values[WRITE_ID_MIME], undefined);
  await assert.rejects(service.write(item, { writeID: 'invalid' }), /identity/);
});
test('image and multi-file writes attach metadata to the actual item, preserving order and native URL delegation', async () => {
  let entries, args;
  const service = new ClipboardService({ clipboard: { write: async values => { entries = values; } }, ClipboardItem: class { constructor(values) { this.values = values; } },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.from([1, 2, 3, 4]) }) } });
  await service.write({ type: 'image' }, { image: Buffer.from('synthetic PNG bytes'), writeID: token });
  assert.equal(await entries[0].values[WRITE_ID_MIME].text(), token); assert.equal(entries.length, 1);
  const files = ['file:///tmp/a%20b.txt', 'file:///tmp/c.txt'];
  await service.write({ type: 'file', body: files.join('\n') }, { writeID: token });
  assert.equal(entries.length, 2); assert.equal(await entries[0].values[WRITE_ID_MIME].text(), token); assert.equal(entries[1].values[WRITE_ID_MIME], undefined);
  service.fileBridge = { write: async (...values) => { args = values; return { ok: true }; } };
  await service.write({ type: 'file', body: files.join('\n') }, { writeID: token }); assert.deepEqual(args, [files, { writeID: token }]);
});
