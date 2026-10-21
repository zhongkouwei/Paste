const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClipStore, hash } = require('../src/store');
const { filterItems, prune, DEFAULT_SETTINGS, sanitizeSettings, classifyText } = require('../src/model');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-store-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new ClipStore(directory, { now: () => '2026-10-21T12:00:00Z' });
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
test('classifies colors, URLs, code and plain text without modifying text', () => {
  assert.equal(classifyText('#af12c0'), 'color'); assert.equal(classifyText('https://example.com'), 'link');
  assert.equal(classifyText('const x = 2'), 'code'); assert.equal(classifyText('  hello\r\nworld  '), 'text');
});
