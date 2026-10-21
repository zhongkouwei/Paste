const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { SearchIndex } = require('../src/search');
const { SearchService } = require('../src/search-service');

function directory(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-search-cache-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }
test('private persisted indexes reuse unchanged text and reconcile stale deleted, renamed and updated items after restart', t => {
  const root = directory(t), items = [{ id: 'a', body: 'Full original tail', title: 'Original' }, { id: 'b', body: 'Deleted item' }];
  let index = new SearchIndex({ directory: root }); index.sync(items, 1);
  assert.equal(index.mode, 'disk'); assert.equal(index.written, 2);
  assert.equal(fs.statSync(path.join(root, 'search-cache')).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(path.join(root, 'search-cache'))) assert.equal(fs.statSync(path.join(root, 'search-cache', file)).mode & 0o777, 0o600);
  index.close(); index = new SearchIndex({ directory: root });
  try {
    index.sync(items, 0); assert.equal(index.written, 0); assert.equal(index.reused, 2);
    assert.ok([...index.entries.values()].every(value => /^[a-f0-9]{64}$/.test(value)));
    index.sync([{ ...items[0], title: 'Renamed', body: 'New complete tail' }], 1);
    for (const query of ['original', 'deleted']) assert.deepEqual(index.find(query), []);
    assert.deepEqual(index.find('new complete renamed'), ['a']); assert.equal(index.deleted, 1);
  } finally { index.close(); }
});
test('full synchronization with an empty authoritative library removes all persisted results', t => {
  const root = directory(t); let index = new SearchIndex({ directory: root }); index.sync([{ id: 'old', body: 'Old secret' }], 1); index.close();
  index = new SearchIndex({ directory: root }); try { index.sync([], 0); assert.deepEqual(index.find(''), []); assert.equal(index.entries.size, 0); } finally { index.close(); }
});
test('persisted text is checked against authoritative source bytes even if a stale fingerprint and consistent FTS look valid', t => {
  const root = directory(t), items = [{ id: 'a', title: 'Known', body: 'Authoritative original\0after-null' }];
  let index = new SearchIndex({ directory: root }); index.sync(items, 1);
  index.db.prepare('UPDATE docs SET text=? WHERE id=?').run('known\nwrong cached value\n\n\n', 'a'); index.close();
  index = new SearchIndex({ directory: root });
  try {
    index.sync(items, 0); assert.deepEqual(index.find('authoritative original'), ['a']);
    assert.deepEqual(index.find('wrong cached'), []); assert.deepEqual(index.find('\0after-null'), ['a']); assert.equal(index.written, 1);
  } finally { index.close(); }
});
test('an interrupted empty cache bootstrap can initialize on retry without being mistaken for a future database', t => {
  const root = directory(t), folder = path.join(root, 'search-cache'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'index.sqlite'), '');
  const index = new SearchIndex({ directory: root });
  try { assert.equal(index.mode, 'disk'); index.sync([{ id: 'a', body: 'Retry initialization' }], 0); assert.deepEqual(index.find('retry'), ['a']); } finally { index.close(); }
});
test('invalid SQLite and damaged FTS postings rebuild only the disposable cache', t => {
  const root = directory(t), file = path.join(root, 'search-cache/index.sqlite'), original = path.join(root, 'library.json');
  fs.writeFileSync(original, 'Original library sentinel'); let index = new SearchIndex({ directory: root }); index.close();
  for (const damage of ['header', 'fts', 'trigger']) {
    if (damage === 'header') fs.writeFileSync(file, 'Not a SQLite database');
    else {
      const db = new DatabaseSync(file);
      db.exec(damage === 'fts' ? "INSERT INTO terms(terms) VALUES('delete-all')" : 'DROP TRIGGER edited'); db.close();
    }
    index = new SearchIndex({ directory: root });
    try {
      assert.equal(index.mode, 'disk'); assert.equal(index.recovered, true, damage);
      index.sync([{ id: 'ready', body: 'Recover complete original' }], 0); assert.deepEqual(index.find('complete original'), ['ready']);
    } finally { index.close(); }
    assert.equal(fs.readFileSync(original, 'utf8'), 'Original library sentinel');
  }
});
test('future cache versions are left untouched and a functional memory index is used', t => {
  const root = directory(t); let index = new SearchIndex({ directory: root }); const file = index.file; index.close();
  const db = new DatabaseSync(file); db.exec('PRAGMA user_version=999'); db.close(); const before = fs.readFileSync(file);
  index = new SearchIndex({ directory: root });
  try { assert.equal(index.mode, 'memory'); index.sync([{ id: 'new', body: 'Still searchable' }], 1); assert.deepEqual(index.find('searchable'), ['new']); } finally { index.close(); }
  assert.deepEqual(fs.readFileSync(file), before);
});
test('cache path failures and symlinks never affect search or touch the linked file', t => {
  const root = directory(t), folder = path.join(root, 'search-cache'), sentinel = path.join(root, 'sentinel'); fs.writeFileSync(sentinel, 'Preserved');
  fs.symlinkSync(sentinel, folder);
  let index = new SearchIndex({ directory: root });
  try { assert.equal(index.mode, 'memory'); index.sync([{ id: 'a', body: 'Fallback text' }], 0); assert.deepEqual(index.find('fallback'), ['a']); } finally { index.close(); }
  fs.unlinkSync(folder); fs.mkdirSync(folder); fs.symlinkSync(sentinel, path.join(folder, 'index.sqlite'));
  index = new SearchIndex({ directory: root }); try { assert.equal(index.mode, 'memory'); } finally { index.close(); }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Preserved');
});
test('a busy database is never mistaken for corruption or deleted while another connection holds it', t => {
  const root = directory(t); let index = new SearchIndex({ directory: root }); const file = index.file; index.close();
  const lock = new DatabaseSync(file); lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
  const inode = fs.statSync(file).ino;
  try {
    index = new SearchIndex({ directory: root });
    try { assert.equal(index.mode, 'memory'); assert.equal(index.recovered, false); assert.equal(fs.statSync(file).ino, inode); } finally { index.close(); }
  } finally { lock.exec('ROLLBACK'); lock.close(); }
});
test('failed delta transactions do not advance fingerprints, counters or revision', t => {
  const index = new SearchIndex(); t.after(() => index.close());
  index.sync([{ id: 'a', body: 'Original' }], 1); const previous = new Map(index.entries);
  index.db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON docs BEGIN SELECT RAISE(ABORT,'Injected failure'); END");
  assert.throws(() => index.apply([{ id: 'a', body: 'Changed' }], [], 2), /Injected failure/);
  assert.deepEqual(index.entries, previous); assert.equal(index.revision, 1); assert.equal(index.written, 1); assert.deepEqual(index.find('original'), ['a']);
  index.db.exec('DROP TRIGGER fail_update'); index.apply([{ id: 'a', body: 'Changed' }], [], 2); assert.deepEqual(index.find('changed'), ['a']);
});
test('worker restart reuses persisted rows without retaining a second authoritative item collection', async t => {
  const root = directory(t); let service = new SearchService({ directory: root });
  const items = [{ id: 'a', body: 'Long original '.repeat(3000) + 'tail-one' }, { id: 'b', body: 'Old deletion' }];
  await service.search(items, 1, 'tail-one'); assert.equal((await service.diagnostics()).written, 2); await service.close();
  service = new SearchService({ directory: root });
  try {
    assert.deepEqual((await service.search(items, 0, 'tail-one')).ids, ['a']); const stats = await service.diagnostics();
    assert.equal(stats.mode, 'disk'); assert.equal(stats.written, 0); assert.equal(stats.reused, 2); assert.equal(stats.pageCacheKiB, 8192);
    assert.deepEqual((await service.search([{ ...items[0], body: 'New replacement' }], 1, 'old deletion')).ids, []);
    await service.worker.terminate();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await service.search([{ id: 'new', body: 'Recovered after worker exit' }], 2, 'recovered')).ids, ['new']);
  } finally { await service.close(); }
});
