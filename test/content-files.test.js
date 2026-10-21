const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClipStore, textSignature } = require('../src/store');
const body = '合成正文🧪 actual full text\n'.repeat(4000) + 'needle-at-end';
const clip = (value = body) => ({ type: 'text', title: 'Synthetic text', body: value, html: `<p>${value}</p>`, rtf: `{\\rtf1 ${value}}`, preview: value });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-content-test-'));
  const store = new ClipStore(directory); t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return store;
}
const manifest = store => JSON.parse(fs.readFileSync(store.file));
test('large payloads use checksummed private immutable files and reopen losslessly', t => {
  const store = fixture(t), item = store.add(clip()), saved = manifest(store).items[0];
  assert.equal(manifest(store).version, 3); assert.match(saved.contentAsset, /^[a-f0-9]{64}\.json$/);
  for (const field of ['body', 'html', 'rtf']) assert.equal(saved[field], undefined);
  assert.ok(fs.statSync(store.file).size < 4000); const file = path.join(store.directory, 'contents', saved.contentAsset);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const reopened = new ClipStore(store.directory); t.after(() => reopened.close());
  for (const field of ['body', 'html', 'rtf']) assert.equal(reopened.get(item.id)[field], item[field]);
  assert.equal(reopened.get(item.id).signature, item.signature); assert.equal(reopened.get(item.id).contentAsset, undefined);
});
test('metadata-only writes reuse payloads even after restart and keep old versions for backup', t => {
  const store = fixture(t), item = store.add(clip()), saved = manifest(store).items[0], file = path.join(store.directory, 'contents', saved.contentAsset);
  const before = fs.statSync(file), reopened = new ClipStore(store.directory); t.after(() => reopened.close());
  let writes = 0; reopened.contents.write = () => { writes += 1; throw new Error('must not rewrite large body'); };
  const board = reopened.saveBoard({ name: 'Pinned', color: '#ef6259' }); reopened.update(item.id, { title: 'Renamed' }); reopened.pinItems([item.id], board.id);
  assert.equal(writes, 0); assert.equal(manifest(reopened).items[0].contentAsset, saved.contentAsset);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs); assert.equal(reopened.get(item.id).body, body);
});
test('legacy inline libraries migrate on commit while their full original backup and pinned identity survive', t => {
  const store = fixture(t), item = { ...clip(), id: 'legacy', signature: textSignature(body), boardIds: ['work'], createdAt: '2026-10-21', isFavorite: true };
  const raw = JSON.stringify({ version: 2, settings: { retentionDays: 0 }, boards: [{ id: 'work', name: 'Work', color: '#ef6259', itemOrder: ['legacy'] }], items: [item] });
  fs.writeFileSync(store.file, raw);
  const migrated = new ClipStore(store.directory); t.after(() => migrated.close());
  assert.equal(fs.readFileSync(store.file, 'utf8'), raw); migrated.update('legacy', { title: 'Updated title' });
  assert.equal(fs.readFileSync(path.join(store.directory, fs.readdirSync(store.directory).find(name => /^library-v2-/.test(name))), 'utf8'), raw);
  const backup = JSON.parse(fs.readFileSync(`${store.file}.bak`)); assert.equal(backup.version, 3); assert.equal(backup.items[0].title, item.title);
  assert.throws(() => { if (backup.version > 2) throw new Error('Unsupported clipboard library'); }, /Unsupported/);
  assert.equal(manifest(migrated).version, 3);
  assert.deepEqual(migrated.get('legacy').boardIds, ['work']); assert.deepEqual(migrated.data.boards[0].itemOrder, ['legacy']); assert.equal(migrated.get('legacy').body, body);
});
test('failed content creation preserves memory, existing library and original content', t => {
  const store = fixture(t), item = store.add(clip()), before = fs.readFileSync(store.file, 'utf8'), write = store.contents.write;
  store.contents.write = () => { throw new Error('disk full'); };
  assert.throws(() => store.update(item.id, { body: `${body} changed` }), /disk full/);
  assert.equal(store.get(item.id).body, body); assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  store.contents.write = write; store.update(item.id, { body: `${body} changed` }); assert.equal(store.get(item.id).body, `${body} changed`);
});
test('failed manifest commit leaves immutable orphan content harmless and rolls back every changed item and board', t => {
  const store = fixture(t), item = store.add(clip()), board = store.saveBoard({ name: 'Keep', color: '#ef6259' });
  store.pinItems([item.id], board.id); const before = fs.readFileSync(store.file, 'utf8'), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === store.file) throw new Error('manifest commit failed'); return rename(from, to); };
  try {
    assert.throws(() => store.update(item.id, { body: `${body} new` }), /manifest commit/);
    assert.throws(() => store.deleteBoard(board.id), /manifest commit/);
    assert.throws(() => store.saveBoard({ ...board, name: 'Broken' }), /manifest commit/);
    assert.throws(() => store.pinItems([item.id], board.id, true), /manifest commit/);
    assert.throws(() => store.reorderBoardItems(board.id, [item.id]), /manifest commit/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(store.file, 'utf8'), before); assert.equal(store.get(item.id).body, body);
  assert.deepEqual(store.get(item.id).boardIds, [board.id]); assert.equal(store.data.boards[0].name, 'Keep'); assert.equal(store.data.boards[0].itemOrder, undefined);
  assert.equal(fs.readdirSync(store.directory).some(name => name.includes('.tmp-')), false);
});
test('corrupt current content recovers a valid earlier version and preserves diagnostics', t => {
  const store = fixture(t), item = store.add(clip()); store.update(item.id, { body: `${body} edited` });
  const current = manifest(store).items[0], file = path.join(store.directory, 'contents', current.contentAsset); fs.writeFileSync(file, 'corrupt');
  const recovered = new ClipStore(store.directory); t.after(() => recovered.close());
  assert.equal(recovered.get(item.id).body, body); assert.match(recovered.recovery, /备份/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt'); assert.ok(fs.readdirSync(store.directory).some(name => name.includes('.corrupt-')));
});
test('missing content in both manifests fails closed without erasing either manifest', t => {
  const store = fixture(t); store.add(clip()); const before = fs.readFileSync(store.file, 'utf8');
  fs.unlinkSync(path.join(store.directory, 'contents', manifest(store).items[0].contentAsset));
  assert.throws(() => new ClipStore(store.directory)); assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  assert.equal(fs.readFileSync(`${store.file}.bak`, 'utf8'), before);
});
test('compact metadata cannot truncate full search, export, detail or Unicode character counts', t => {
  const store = fixture(t), item = store.add(clip()), compact = store.snapshot().items[0];
  assert.equal(compact.body, ''); assert.equal(compact.preview.length, 2000);
  assert.equal(compact.characterCount, [...body].length); assert.equal(compact.html, undefined); assert.equal(compact.rtf, undefined);
  assert.deepEqual(store.search('needle-at-end').ids, [item.id]); assert.equal(store.get(item.id).body, body);
  const exported = store.exportData(); assert.equal(exported.version, 2); assert.equal(exported.items[0].body, body); assert.equal(exported.items[0].contentAsset, undefined);
});
test('failure after atomic rename keeps memory aligned with the committed file and reports uncertain durability', t => {
  const store = fixture(t), item = store.add(clip()), sync = fs.fsyncSync, revision = store.revision;
  fs.fsyncSync = descriptor => { if (fs.fstatSync(descriptor).isDirectory()) throw new Error('directory sync fixture'); sync(descriptor); };
  try { assert.throws(() => store.update(item.id, { title: 'Committed title' }), /清单已提交/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(store.get(item.id).title, 'Committed title'); assert.equal(manifest(store).items[0].title, 'Committed title');
  assert.equal(store.revision, revision + 1); assert.equal(store.get(item.id).body, body);
});
test('large OCR geometry is stored with its versioned content while snapshots keep only availability', t => {
  const store = fixture(t), item = store.add({ type: 'image', body: 'image body', signature: 'pixels', title: 'OCR test' });
  const text = '识别文字'.repeat(10000), lines = Array.from({ length: 100 }, (_, n) => ({ text: `${text.slice(0, 400)}${n}`, words: [], box: { x: 0, y: 0, width: 1, height: .01 } }));
  store.setOCR(item.id, 'pixels', { status: 'ready', text, lines });
  const disk = manifest(store).items[0]; assert.ok(disk.contentAsset); assert.equal(disk.ocr, undefined);
  const reopened = new ClipStore(store.directory); t.after(() => reopened.close()); assert.deepEqual(reopened.get(item.id).ocr.lines, lines);
  const compact = reopened.snapshot().items[0]; assert.equal(compact.ocr.hasText, true); assert.equal(compact.ocr.lines, undefined); assert.equal(compact.ocr.text, undefined);
  assert.deepEqual(reopened.search('识别文字').ids, [item.id]);
});
test('cached character counts handle surrogate pairs and unmatched UTF-16 units exactly', t => {
  const store = fixture(t), value = 'a🧪\uD800b\uDC00中', item = store.add(clip(value));
  assert.equal(store.snapshot().items[0].characterCount, [...value].length); store.update(item.id, { body: `${value}🧪` });
  assert.equal(store.snapshot().items[0].characterCount, [...`${value}🧪`].length);
});
test('future library versions never roll back to an older readable backup', t => {
  const store = fixture(t); store.add(clip('before future upgrade'));
  const future = JSON.stringify({ version: 4, items: [] }); fs.writeFileSync(store.file, future);
  assert.throws(() => new ClipStore(store.directory), /newer application/); assert.equal(fs.readFileSync(store.file, 'utf8'), future);
});
test('legacy nullable formats survive content storage and invalid new payloads cannot commit unreadable records', t => {
  const store = fixture(t), item = store.add({ ...clip(), html: null, rtf: null });
  const reopened = new ClipStore(store.directory); t.after(() => reopened.close()); assert.equal(reopened.get(item.id).html, null); assert.equal(reopened.get(item.id).rtf, null);
  const before = fs.readFileSync(store.file, 'utf8'); assert.throws(() => store.add({ ...clip(), body: `${body} invalid`, html: 42 }), /Invalid clipboard content/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), before); assert.equal(store.data.items.length, 1);
});
