const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClipStore, hash, textSignature, htmlPayload } = require('../src/store');
const { filterItems, imageTextMatches, prune, DEFAULT_SETTINGS, sanitizeSettings, classifyText } = require('../src/model');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-store-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ClipStore(directory, { now: () => '2026-10-21T12:00:00Z' });
  t.after(() => store.close()); return store;
}
const clip = body => ({ type: 'text', body, preview: body, title: body, signature: hash(body) });

test('re-copy keeps the same item, edited title, and pinboard membership', t => {
  const store = fixture(t), board = store.saveBoard({ name: '工作', color: '#ef6259' });
  const first = store.add(clip('original'));
  store.update(first.id, { title: 'Renamed', boardIds: [board.id] });
  store.add(clip('second'));
  const recopy = store.add(clip('original'));
  assert.equal(recopy.id, first.id); assert.equal(recopy.title, 'Renamed');
  assert.deepEqual(recopy.boardIds, [board.id]); assert.equal(store.data.items.length, 2);
  assert.equal(store.data.items[0].id, first.id);
});
test('atomic writes can be reopened and keep owner-only file permissions', t => {
  const store = fixture(t); store.add(clip('hello'));
  assert.equal(new ClipStore(store.directory).data.items[0].body, 'hello');
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(`${store.file}.bak`));
});
test('damaged primary is preserved and last valid backup is recovered', t => {
  const store = fixture(t); store.add(clip('first')); store.add(clip('second'));
  fs.writeFileSync(store.file, '{broken');
  const recovered = new ClipStore(store.directory);
  assert.equal(recovered.data.items[0].body, 'first'); assert.ok(recovered.recovery);
  assert.ok(fs.readdirSync(store.directory).some(file => file.includes('.corrupt-')));
  assert.equal(JSON.parse(fs.readFileSync(store.file)).items[0].body, 'first');
});
test('damaged library without backup fails closed instead of erasing it', t => {
  const store = fixture(t); fs.writeFileSync(store.file, 'unreadable');
  assert.throws(() => new ClipStore(store.directory), /damaged/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), 'unreadable');
});
test('legacy clipboard history migrates and preserves favorites', t => {
  const store = fixture(t);
  fs.writeFileSync(path.join(store.directory, 'clipboard-history.json'), JSON.stringify([{ ...clip('saved'), id: 'one', createdAt: '2026-10-20', isFavorite: true }]));
  const migrated = new ClipStore(store.directory);
  assert.deepEqual(migrated.data.items[0].boardIds, ['favorites']);
  assert.equal(migrated.data.boards[0].id, 'favorites');
  assert.ok(fs.existsSync(path.join(store.directory, 'clipboard-history.json')));
});
test('retention and capacity never evict pinned items', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const items = [
    { id: 'oldPinned', createdAt: '2020-01-01', boardIds: ['board'] },
    { id: 'old', createdAt: '2020-01-01', boardIds: [] },
    ...Array.from({ length: 3 }, (_, n) => ({ id: n, createdAt: '2026-10-21', boardIds: [] }))
  ];
  assert.deepEqual(prune(items, { retentionDays: 1, maxItems: 2 }, now).map(i => i.id), ['oldPinned', 0, 1]);
});
test('merges older product directories without losing favorites or modifying originals', t => {
  const store = fixture(t), older = path.join(store.directory, 'previous-version'); fs.mkdirSync(older);
  const oldFile = path.join(older, 'clipboard-history.json');
  const raw = JSON.stringify([{ ...clip('same'), id: 'old', createdAt: '2026-01-01', isFavorite: true }, { ...clip('only-old'), id: 'unique', createdAt: '2026-02-01' }]);
  fs.writeFileSync(oldFile, raw);
  fs.writeFileSync(path.join(store.directory, 'clipboard-history.json'), JSON.stringify([{ ...clip('same'), id: 'new', createdAt: '2026-10-01' }]));
  const merged = new ClipStore(store.directory, { legacyDirectories: [older] });
  assert.equal(merged.data.items.length, 2); assert.equal(merged.data.items[0].id, 'new');
  assert.deepEqual(merged.data.items[0].boardIds, ['favorites']); assert.equal(fs.readFileSync(oldFile, 'utf8'), raw);
});
test('clear removes history only, deleting a board preserves its clips', t => {
  const store = fixture(t), board = store.saveBoard({ name: 'Keep', color: '#4f80ed' });
  const saved = store.add(clip('pinned')); store.update(saved.id, { boardIds: [board.id] });
  store.add(clip('unimportant')); store.clear(); assert.equal(store.data.items.length, 1);
  store.deleteBoard(board.id); assert.equal(store.data.items.length, 1);
  assert.deepEqual(store.data.items[0].boardIds, []); assert.equal(store.data.items[0].isFavorite, false);
});
test('image assets are lossless, deduplicated, and cannot traverse directories', t => {
  const store = fixture(t), original = Buffer.from(Array.from({ length: 5000 }, (_, n) => n % 256));
  const asset = store.putAsset(original); assert.equal(store.putAsset(original), asset);
  assert.deepEqual(store.readAsset(asset), original); assert.throws(() => store.readAsset('../library.json'));
});
test('failed persistence rolls back memory, not just the disk', t => {
  const store = fixture(t); store.add(clip('first'));
  store.persist = () => { throw new Error('disk full'); };
  assert.throws(() => store.add(clip('second')), /disk full/);
  assert.deepEqual(store.data.items.map(i => i.body), ['first']);
});
test('search combines terms, pinboard, source, type and date', () => {
  const items = [
    { id: 1, body: 'hello 世界', title: 'hello', type: 'code', source: { name: 'Editor', bundleId: 'editor' }, boardIds: ['work'], createdAt: '2026-10-21' },
    { id: 2, body: 'hello 世界', title: 'hello', type: 'text', boardIds: [], createdAt: '2026-09-01' }
  ];
  assert.deepEqual(filterItems(items, { query: '世界 editor', board: 'work', type: 'text', source: 'editor', after: '2026-10-01' }).map(i => i.id), [1]);
  assert.deepEqual(filterItems(items, { query: 'unknown' }), []);
});
test('settings reject invalid types and retain the last valid values', () => {
  const values = sanitizeSettings({ paused: 'yes', retentionDays: -1, maxItems: Infinity, theme: '<script>', excludedApps: ['valid.app', '../invalid', 9] });
  assert.equal(values.paused, false); assert.equal(values.retentionDays, DEFAULT_SETTINGS.retentionDays);
  assert.deepEqual(values.excludedApps, ['valid.app']);
});
test('changing retention immediately expires history while preserving pinned items', t => {
  const store = fixture(t), board = store.saveBoard({ name: 'Keep', color: '#4f80ed' });
  store.settings({ retentionDays: 0 });
  const old = store.add(clip('old')), pinned = store.add(clip('pinned'));
  store.update(pinned.id, { boardIds: [board.id] });
  for (const item of store.data.items) item.createdAt = '2020-01-01';
  store.settings({ retentionDays: 1 });
  assert.equal(store.get(old.id), undefined); assert.ok(store.get(pinned.id));
});
test('an active editor is protected from deletion, capacity pruning, expiry and history clearing', t => {
  const store = fixture(t), editing = store.add(clip('Editing'));
  store.protectedItemId = editing.id; store.get(editing.id).createdAt = '2020-01-01';
  store.settings({ retentionDays: 1 }); store.add(clip('New copy')); assert.ok(store.get(editing.id));
  assert.throws(() => store.delete([editing.id]), /正在编辑/);
  store.clear(); assert.deepEqual(store.data.items.map(item => item.id), [editing.id]);
  assert.deepEqual(prune([{ id: editing.id, createdAt: '2026-10-21' }, { id: 'new', createdAt: '2026-10-21' }],
    { retentionDays: 0, maxItems: 1 }, Date.parse('2026-10-21'), editing.id).map(item => item.id), [editing.id, 'new']);
  store.protectedItemId = null; store.clear(); assert.equal(store.data.items.length, 0);
});
test('classifies colors, URLs, code and plain text without modifying text', () => {
  assert.equal(classifyText('#af12c0'), 'color'); assert.equal(classifyText('https://example.com'), 'link');
  assert.equal(classifyText('const x = 2'), 'code'); assert.equal(classifyText('  hello\r\nworld  '), 'text');
});
test('pinboards can be reordered atomically and invalid permutations are rejected', t => {
  const store = fixture(t), first = store.saveBoard({ name: 'First', color: '#ef6259' }), second = store.saveBoard({ name: 'Second', color: '#4f80ed' });
  store.reorderBoards([second.id, first.id]);
  assert.deepEqual(new ClipStore(store.directory).data.boards.map(board => board.id), [second.id, first.id]);
  assert.throws(() => store.reorderBoards([first.id, first.id]));
  assert.throws(() => store.reorderBoards([first.id]));
  assert.deepEqual(store.data.boards.map(board => board.id), [second.id, first.id]);
});
test('multi-item pinning is atomic, idempotent and preserves manual pinboard order after recopy', t => {
  const store = fixture(t), board = store.saveBoard({ name: 'Work', color: '#ef6259' });
  const first = store.add(clip('first')), second = store.add(clip('second'));
  store.pinItems([first.id, second.id], board.id); store.pinItems([first.id], board.id);
  store.reorderBoardItems(board.id, [first.id, second.id]); store.add(clip('first'));
  const result = filterItems(store.data.items, { board: board.id, boards: store.data.boards });
  assert.deepEqual(result.map(item => item.id), [first.id, second.id]); assert.deepEqual(store.get(first.id).boardIds, [board.id]);
  assert.throws(() => store.pinItems([first.id, 'not-present'], board.id));
  assert.deepEqual(store.get(first.id).boardIds, [board.id]);
  store.pinItems([first.id], board.id, true);
  assert.deepEqual(store.data.boards[0].itemOrder, [second.id]);
});
test('editing and migration use the same signatures as real clipboard capture', t => {
  const store = fixture(t), item = store.add(clip('before'));
  const board = store.saveBoard({ name: 'Keep', color: '#ef6259' }); store.pinItems([item.id], board.id);
  store.update(item.id, { body: 'after' });
  const reopened = new ClipStore(store.directory), repeated = reopened.add(clip('after'));
  assert.equal(repeated.id, item.id); assert.deepEqual(repeated.boardIds, [board.id]); assert.equal(reopened.data.items.length, 1);
});
test('rich edits retain HTML and pinned identity through reload and recopy', t => {
  const store = fixture(t), board = store.saveBoard({ name: 'Keep', color: '#ef6259' });
  const item = store.add({ ...clip('Before'), html: '<b>Before</b>', rtf: 'old-rtf' });
  store.pinItems([item.id], board.id);
  const html = '<p><strong><em>After</em></strong></p>';
  store.update(item.id, { body: 'After', html });
  const reopened = new ClipStore(store.directory), saved = reopened.get(item.id);
  assert.equal(saved.html, html); assert.equal(saved.rtf, '');
  assert.equal(reopened.add({ ...clip('After'), html }).id, item.id);
  assert.deepEqual(reopened.get(item.id).boardIds, [board.id]);
  assert.throws(() => reopened.update(item.id, { body: 'Bad', html: 'x'.repeat(16 * 1024 * 1024 + 1) }), /HTML exceeds/);
  assert.equal(reopened.get(item.id).body, 'After');
});
test('Electron HTML transport framing never changes content identity or accumulates on writes', () => {
  const prefix = "<meta charset='utf-8'>", html = '<p><b>Clipboard</b></p>';
  assert.equal(textSignature('Clipboard', prefix + html), textSignature('Clipboard', html));
  assert.equal(htmlPayload(prefix + prefix + html), html);
  assert.equal(htmlPayload('<meta name="author" content="Keep">' + html), '<meta name="author" content="Keep">' + html);
  assert.notEqual(textSignature('Clipboard', html), textSignature('Clipboard', '<p>Clipboard</p>'));
});
test('non-destructive image replacement preserves identity and rolls back failed metadata writes', t => {
  const store = fixture(t), original = Buffer.from('original'), rotated = Buffer.from('rotated');
  const asset = store.putAsset(original), board = store.saveBoard({ name: 'Keep', color: '#ef6259' });
  const item = store.add({ type: 'image', body: asset, asset, signature: hash(original), size: { width: 3, height: 2 } });
  store.update(item.id, { title: 'Saved picture', boardIds: [board.id] });
  store.replaceImage(item.id, { buffer: rotated, original, size: { width: 2, height: 3 }, turns: 1, preview: 'thumbnail' });
  const reopened = new ClipStore(store.directory), saved = reopened.get(item.id);
  assert.equal(saved.id, item.id); assert.equal(saved.title, 'Saved picture'); assert.deepEqual(saved.boardIds, [board.id]);
  assert.deepEqual(reopened.readAsset(saved.originalAsset), original); assert.deepEqual(reopened.readAsset(saved.asset), rotated);
  const savedAsset = saved.asset;
  reopened.persist = () => { throw new Error('disk full'); };
  assert.throws(() => reopened.replaceImage(item.id, { buffer: original, original, size: { width: 3, height: 2 }, turns: 0 }), /disk full/);
  assert.equal(reopened.get(item.id).asset, savedAsset); assert.deepEqual(store.readAsset(asset), original);
  assert.equal(new ClipStore(store.directory).get(item.id).asset, savedAsset);
});
test('pixel-signature migration preserves legacy image identities and inaccessible original records', t => {
  const store = fixture(t), asset = store.putAsset(Buffer.from('legacy PNG bytes'));
  const board = store.saveBoard({ name: 'Keep', color: '#ef6259' });
  const image = store.add({ type: 'image', body: asset, asset, signature: hash('legacy') });
  store.pinItems([image.id], board.id);
  const broken = store.add({ type: 'image', body: 'missing', signature: hash('missing') });
  const signature = hash('normalized pixels');
  assert.deepEqual(store.migrateImageSignatures(item => { if (item.id === broken.id) throw new Error('missing'); return signature; }), [broken.id]);
  const restored = new ClipStore(store.directory).get(image.id);
  assert.equal(restored.signature, signature); assert.equal(restored.signatureFormat, 'pixels-v1');
  assert.deepEqual(restored.boardIds, [board.id]); assert.equal(restored.asset, asset); assert.ok(store.get(broken.id));
  assert.equal(store.add({ type: 'image', body: asset, asset, signature, signatureFormat: 'pixels-v1' }).id, image.id);
});
test('image backups embed both current pixels and the restorable original without local paths', async t => {
  const store = fixture(t), original = Buffer.from('original'), current = Buffer.from('current'), asset = store.putAsset(original);
  const item = store.add({ type: 'image', body: asset, asset });
  store.replaceImage(item.id, { buffer: current, original, turns: 1, size: { width: 2, height: 3 } });
  const backup = store.exportData().items[0];
  assert.equal(backup.body, `data:image/png;base64,${current.toString('base64')}`);
  assert.equal(backup.originalBody, `data:image/png;base64,${original.toString('base64')}`);
  assert.equal(backup.asset, undefined); assert.equal(backup.originalAsset, undefined);
  assert.ok(store.get(item.id).asset); assert.ok(store.get(item.id).originalAsset);
  const destination = path.join(store.directory, 'export.json'); fs.writeFileSync(destination, 'old export', { mode: 0o644 });
  await store.exportTo(destination);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination)).items[0], backup);
  fs.unlinkSync(path.join(store.directory, 'assets', store.get(item.id).asset));
  const before = fs.readFileSync(destination, 'utf8'); await assert.rejects(store.exportTo(destination), /ENOENT/);
  assert.equal(fs.readFileSync(destination, 'utf8'), before);
});
test('recognized text is versioned, searchable and not allowed to overwrite newer images', t => {
  const store = fixture(t), asset = store.putAsset(Buffer.from('image'));
  const item = store.add({ type: 'image', body: asset, asset, signature: hash('pixels') });
  const result = { status: 'ready', text: 'Invoice 2048', lines: [{ text: 'Invoice 2048' }], engine: 'test' };
  assert.equal(store.setOCR(item.id, item.signature, result), true);
  assert.deepEqual(store.search('invoice 2048').ids, [item.id]);
  assert.equal(store.snapshot().items[0].ocr.text, undefined); assert.equal(store.snapshot().items[0].ocr.hasText, true);
  assert.equal(store.snapshot().items[0].ocr.lines, undefined); assert.deepEqual(new ClipStore(store.directory).get(item.id).ocr.lines, result.lines);
  const signature = item.signature;
  store.replaceImage(item.id, { buffer: Buffer.from('changed'), original: Buffer.from('image'), turns: 0, backgroundRemoved: true, foreground: Buffer.from('foreground'), size: { width: 3, height: 2 } });
  assert.equal(store.get(item.id).ocr, undefined); assert.equal(store.setOCR(item.id, signature, result), false);
  assert.deepEqual(filterItems(store.snapshot().items, { query: 'invoice' }), []);
  const backup = store.exportData().items[0]; assert.equal(backup.foregroundAsset, undefined);
  assert.equal(backup.foregroundBody, `data:image/png;base64,${Buffer.from('foreground').toString('base64')}`);
});
test('image search uses native word boxes, falls back for phrases and rejects invalid geometry', () => {
  const word = { x: .4, y: .2, width: .1, height: .1 }, line = { x: .1, y: .2, width: .7, height: .1 };
  const ocr = { lines: [{ text: 'Invoice 2048', box: line, words: [{ text: '2048', box: word }] }] };
  assert.deepEqual(imageTextMatches(ocr, '2048 2048'), [word]);
  assert.deepEqual(imageTextMatches(ocr, 'invoice'), [line]);
  assert.deepEqual(imageTextMatches(ocr, ''), []);
  assert.deepEqual(imageTextMatches({ lines: [null, { text: 'bad', box: { x: Infinity, y: 0, width: 1, height: 1 } }] }, 'bad'), []);
});
test('a malformed derived OCR cache is discarded without losing its original image', t => {
  const store = fixture(t), buffer = Buffer.from('original image'), asset = store.putAsset(buffer);
  const item = store.add({ type: 'image', body: asset, asset, signature: hash(buffer) });
  item.ocr = { signature: item.signature, text: { bad: true }, lines: 'invalid', status: 'ready' }; store.persist();
  const reopened = new ClipStore(store.directory);
  assert.equal(reopened.get(item.id).ocr, undefined); assert.deepEqual(reopened.readAsset(reopened.get(item.id).asset), buffer);
});
