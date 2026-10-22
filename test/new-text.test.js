const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ClipStore, textSignature } = require('../src/store');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-new-text-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ClipStore(directory); t.after(() => store.close()); return store;
}
test('new text and all chosen Pinboard memberships commit together and survive reopening', t => {
  const store = fixture(t), boards = ['One', 'Two'].map(name => store.saveBoard({ name, color: '#ef6259' }));
  const item = store.createText({ body: '中文\nNew note 😀', html: '<p>中文</p><p><b>New note 😀</b></p>' }, boards.map(board => board.id));
  const saved = store.get(item.id); assert.equal(saved.type, 'text'); assert.equal(saved.body, '中文\nNew note 😀'); assert.equal(saved.source, null);
  assert.deepEqual(saved.boardIds, boards.map(board => board.id)); assert.equal(saved.isFavorite, true);
  assert.equal(saved.signature, textSignature(saved.body, saved.html, '')); assert.equal(store.data.items.length, 1);
  const reopened = new ClipStore(store.directory); t.after(() => reopened.close()); assert.deepEqual(reopened.get(item.id), saved);
});
test('identical new text preserves existing ID, labels, source and all memberships without manufacturing a duplicate', t => {
  const store = fixture(t), first = store.saveBoard({ name: 'First', color: '#ef6259' }), second = store.saveBoard({ name: 'Second', color: '#4f80ed' });
  const item = store.add({ type: 'code', body: 'Same', html: '<p>Same</p>', title: 'Original', source: { bundleId: 'test.source', name: 'Source' } });
  store.update(item.id, { title: 'Renamed', boardIds: [first.id] });
  const created = store.createText({ body: 'Same', html: '<p>Same</p>' }, [second.id, second.id]);
  assert.equal(created.id, item.id); assert.equal(store.data.items.length, 1);
  const saved = store.get(item.id); assert.equal(saved.title, 'Renamed'); assert.equal(saved.type, 'code'); assert.equal(saved.source.bundleId, 'test.source');
  assert.deepEqual(saved.boardIds, [first.id, second.id]); assert.equal(saved.firstCopiedAt, item.firstCopiedAt);
});
test('invalid, blank, oversized or deleted-destination input leaves the library unchanged', t => {
  const store = fixture(t); store.add({ type: 'text', body: 'Keep' }); const original = fs.readFileSync(store.file);
  for (const input of [undefined, {}, { body: 4 }, { body: '' }, { body: ' \n\t' }, { body: 'a'.repeat(16 * 1024 * 1024 + 1) }, { body: 'A', html: 'b'.repeat(16 * 1024 * 1024 + 1) }]) assert.throws(() => store.createText(input));
  assert.throws(() => store.createText({ body: 'New' }, ['deleted']), /Pinboard已删除/);
  assert.throws(() => store.createText({ body: 'New' }, 'not an array'));
  assert.deepEqual(fs.readFileSync(store.file), original); assert.equal(store.data.items.length, 1);
});
test('pre-commit failure cannot leave an unpinned new item; retry commits one complete item', t => {
  const store = fixture(t), board = store.saveBoard({ name: 'Work', color: '#ef6259' }), persist = store.persist;
  const original = fs.readFileSync(store.file); store.persist = () => { throw Error('Injected manifest failure'); };
  assert.throws(() => store.createText({ body: 'Retry' }, [board.id]), /manifest failure/);
  assert.equal(store.data.items.length, 0); assert.deepEqual(fs.readFileSync(store.file), original);
  store.persist = persist; const item = store.createText({ body: 'Retry' }, [board.id]); assert.deepEqual(store.get(item.id).boardIds, [board.id]); assert.equal(store.data.items.length, 1);
});
test('new large text follows immutable content storage and backup recovery rather than an inline exception', t => {
  const store = fixture(t), body = 'New large note 中文\n'.repeat(2000), item = store.createText({ body });
  const metadata = store.getMetadata(item.id); assert.match(metadata.contentAsset, /^[0-9a-f]{64}\.json$/); assert.equal(metadata.body, undefined);
  assert.equal(store.get(item.id).body, body); store.settings({ sound: false });
  const reopened = new ClipStore(store.directory); t.after(() => reopened.close()); assert.equal(reopened.get(item.id).body, body);
  const backup = JSON.parse(fs.readFileSync(`${store.file}.bak`)); assert.equal(backup.items.length, 1); assert.equal(backup.items[0].contentAsset, metadata.contentAsset);
});
