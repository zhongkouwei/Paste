const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClipStore, textSignature } = require('../src/store');
const { SearchService } = require('../src/search-service');
const { SearchIndex } = require('../src/search');
const body = 'Aa中文🧪\0\uD800 full original\n'.repeat(2000) + 'unique-full-tail';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-lazy-content-'));
  const store = new ClipStore(directory); t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return store;
}
const clip = value => ({ type: 'text', body: value, title: value.slice(0, 80), preview: value, html: `<p>${value}</p>` });
test('commits and reopens keep only immutable references and detached display summaries, while detail and export preserve every UTF-16 unit', t => {
  const store = fixture(t), item = store.add(clip(body));
  assert.equal(store.data.items[0].body, undefined); assert.ok(store.data.items[0].contentAsset);
  const reopened = new ClipStore(store.directory); t.after(() => reopened.close());
  assert.equal(reopened.data.items[0].body, undefined);
  assert.equal(reopened.get(item.id).body, body); assert.equal(reopened.get(item.id).html, `<p>${body}</p>`);
  assert.equal(reopened.get(item.id).contentAsset, undefined); assert.equal(reopened.data.items[0].body, undefined);
  assert.equal(reopened.snapshot().items[0].characterCount, [...body].length);
  assert.equal(reopened.snapshot().items[0].preview, body.slice(0, 2000)); assert.equal(reopened.exportData().items[0].body, body);
  assert.ok([...reopened.contents.summaries.values()].every(value => value.body.length <= 2000 && value.preview.length <= 2000));
  const short = 'small\0\uD800🧪', second = reopened.add({ ...clip(short), html: '<p>large format</p>'.repeat(3000) });
  assert.equal(reopened.getMetadata(second.id).body, undefined); assert.equal(reopened.snapshot().items[0].body, short);
});
test('snapshots, rename, pinboard and settings changes never reopen payloads or rewrite them after startup validation', t => {
  const store = fixture(t), item = store.add(clip(body)), reopened = new ClipStore(store.directory); t.after(() => reopened.close());
  const before = fs.readdirSync(reopened.contents.directory), read = reopened.contents.read;
  reopened.contents.read = () => { throw new Error('Unexpected payload read'); };
  reopened.contents.write = () => { throw new Error('Unexpected payload write'); };
  const board = reopened.saveBoard({ name: 'Pinned', color: '#ef6259' }); reopened.pinItems([item.id], board.id);
  reopened.update(item.id, { title: 'Renamed' }); reopened.settings({ retentionDays: 0 }); reopened.deleteBoard(board.id);
  const compact = reopened.snapshot().items[0]; assert.equal(compact.title, 'Renamed'); assert.equal(compact.characterCount, [...body].length);
  assert.deepEqual(fs.readdirSync(reopened.contents.directory), before); reopened.contents.read = read;
  assert.equal(reopened.get(item.id).body, body);
});
test('editing referenced text and large OCR preserves unrelated payload fields, metadata and recopy identity', t => {
  const store = fixture(t), item = store.add(clip(body)), board = store.saveBoard({ name: 'Pinned', color: '#ef6259' }); store.pinItems([item.id], board.id);
  store.update(item.id, { body: `${body} changed`, html: '<p>Saved HTML</p>', title: 'Keep title' });
  assert.equal(store.get(item.id).signature, textSignature(`${body} changed`, '<p>Saved HTML</p>'));
  const recopy = store.add({ ...clip(`${body} changed`), html: '<p>Saved HTML</p>' }); assert.equal(recopy.id, item.id);
  assert.deepEqual(store.get(item.id).boardIds, [board.id]); assert.equal(store.get(item.id).title, 'Keep title');
  const image = store.add({ type: 'image', body: 'Original image reference', signature: 'pixels' });
  const result = { status: 'ready', text: '识别文字'.repeat(10000), lines: [{ text: '识别文字', words: [] }] };
  store.setOCR(image.id, image.signature, result); store.update(image.id, { title: 'Renamed image' });
  assert.equal(store.getMetadata(image.id).ocr, undefined); assert.equal(store.snapshot().items[0].ocr.hasText, true);
  assert.equal(store.get(image.id).body, 'Original image reference'); assert.equal(store.get(image.id).ocr.text, result.text);
  const reopened = new ClipStore(store.directory); t.after(() => reopened.close()); assert.deepEqual(reopened.get(image.id).ocr.lines, result.lines);
  assert.deepEqual(reopened.search('识别文字').ids, [image.id]);
});
test('workers receive only content references, keep full-tail search and reconcile later edits without main-thread payload reads', async t => {
  const store = fixture(t), createdAt = new Date().toISOString();
  store.mutate(() => { store.data.items = Array.from({ length: 12 }, (_, n) => ({ ...clip(`${body} needle-${n}`), id: String(n), signature: textSignature(`${body} needle-${n}`, `<p>${body} needle-${n}</p>`), createdAt, boardIds: [] })); });
  const service = new SearchService({ directory: store.directory }); t.after(() => service.close()); service.start();
  const messages = [], post = service.worker.postMessage.bind(service.worker); service.worker.postMessage = message => { messages.push(message); return post(message); };
  const read = store.contents.read; store.contents.read = () => { throw new Error('Search read a payload on the main thread'); };
  assert.deepEqual((await service.search(store.data.items, store.revision, 'needle-11')).ids, ['11']);
  const transfer = messages.find(message => message.updates); assert.equal(transfer.updates.length, 12);
  assert.ok(transfer.updates.every(value => value.contentAsset && !Object.hasOwn(value, 'body') && !value.ocr));
  assert.ok(Buffer.byteLength(JSON.stringify(transfer)) < Buffer.byteLength(body) * 12 / 20);
  store.update('11', { title: 'Renamed descriptor' }); assert.deepEqual((await service.search(store.data.items, store.revision, 'renamed descriptor needle-11')).ids, ['11']);
  store.contents.read = read; store.update('11', { body: `${body} new-tail-only` });
  assert.deepEqual((await service.search(store.data.items, store.revision, 'needle-11')).ids, []);
  assert.deepEqual((await service.search(store.data.items, store.revision, 'new-tail-only')).ids, ['11']);
});
test('cached results cannot bypass missing or corrupt immutable source files; failures preserve the manifest and allow verified retry', async t => {
  const store = fixture(t), item = store.add(clip(body)), service = new SearchService({ directory: store.directory }); t.after(() => service.close());
  await service.search(store.data.items, store.revision, 'unique-full-tail'); await service.close();
  const reopened = new ClipStore(store.directory); t.after(() => reopened.close()); const record = reopened.getMetadata(item.id);
  const file = path.join(store.contents.directory, record.contentAsset), raw = fs.readFileSync(file), manifest = fs.readFileSync(store.file);
  const next = new SearchService({ directory: store.directory }); t.after(() => next.close());
  fs.writeFileSync(file, 'Corrupt after startup'); assert.throws(() => reopened.get(item.id), /checksum/);
  await assert.rejects(next.search(reopened.data.items, reopened.revision, 'unique-full-tail'), /checksum/);
  fs.unlinkSync(file); assert.throws(() => reopened.get(item.id), /ENOENT/); assert.deepEqual(fs.readFileSync(store.file), manifest);
  fs.writeFileSync(file, raw); assert.deepEqual((await next.search(reopened.data.items, reopened.revision, 'unique-full-tail')).ids, [item.id]);
});
test('a failed source resolver rolls back all earlier delta writes and leaves the previous index revision intact', t => {
  const index = new SearchIndex(); t.after(() => index.close()); index.sync([{ id: 'a', body: 'Original' }], 1);
  assert.throws(() => index.apply([{ id: 'a', body: 'Changed' }, { id: 'b' }], [], 2, false, item => {
    if (item.id === 'b') throw new Error('Immutable source failed'); return item;
  }), /Immutable source failed/);
  assert.equal(index.revision, 1); assert.equal(index.written, 1); assert.deepEqual(index.find('original'), ['a']); assert.deepEqual(index.find('changed'), []);
});
test('failed manifest commits restore referenced metadata and summaries without retaining uncommitted payload versions', t => {
  const store = fixture(t), item = store.add(clip(body)), original = fs.readFileSync(store.file), rename = fs.renameSync;
  const asset = store.getMetadata(item.id).contentAsset;
  fs.renameSync = (from, to) => { if (to === store.file) throw new Error('Injected manifest failure'); return rename(from, to); };
  try { for (let n = 0; n < 3; n++) assert.throws(() => store.update(item.id, { body: `${body} failed-${n}` }), /Injected manifest/); }
  finally { fs.renameSync = rename; }
  assert.equal(store.getMetadata(item.id).contentAsset, asset); assert.equal(store.get(item.id).body, body);
  assert.equal(store.snapshot().items[0].characterCount, [...body].length); assert.equal(store.contents.summaries.size, 1);
  assert.deepEqual(fs.readFileSync(store.file), original);
});
