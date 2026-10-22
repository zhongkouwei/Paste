const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClipStore } = require('../src/store');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-rename-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ClipStore(directory), item = store.add({ type: 'text', body: 'Original body', html: '<b>Original body</b>', title: 'Original title' });
  return { store, item, directory, expected: { title: item.title, renamed: !!item.renamed } };
}
test('a guarded rename changes metadata only, survives restart and preserves the latest body and Pinboard', t => {
  const { store, item, directory, expected } = fixture(t), board = store.saveBoard({ name: 'Pinned', color: '#62c68d' });
  store.pinItems([item.id], board.id); store.update(item.id, { body: 'Later body', html: '<i>Later body</i>' });
  const before = store.get(item.id); store.rename(item.id, '  Useful label  ', expected);
  assert.deepEqual(store.get(item.id), { ...before, title: 'Useful label', renamed: true });
  assert.deepEqual(new ClipStore(directory).get(item.id), store.get(item.id));
});
test('concurrent label changes or a deleted source cannot be silently overwritten by an older draft', t => {
  const { store, item, expected } = fixture(t);
  store.update(item.id, { title: 'Other window label' });
  assert.throws(() => store.rename(item.id, 'Old draft', expected), /名称已改变/); assert.equal(store.get(item.id).title, 'Other window label');
  store.delete([item.id]); assert.throws(() => store.rename(item.id, 'Old draft', expected), /删除/);
});
test('invalid, blank, oversized and unguarded labels fail without a commit; identical names are a no-op', t => {
  const { store, item, expected } = fixture(t), before = fs.readFileSync(store.file);
  for (const title of ['', '  ', 'x'.repeat(201), null, 1]) assert.throws(() => store.rename(item.id, title, expected));
  assert.throws(() => store.rename(item.id, 'New', null)); assert.throws(() => store.rename(item.id, 'New', { title: item.title }));
  assert.ok(fs.readFileSync(store.file).equals(before));
  store.rename(item.id, 'New', expected); const revision = store.revision;
  store.rename(item.id, 'New', { title: 'New', renamed: true }); assert.equal(store.revision, revision);
});
test('failed persistence retains the old label and allows the same draft to retry safely', t => {
  const { store, item, expected } = fixture(t), persist = store.persist.bind(store), before = store.get(item.id);
  store.persist = () => { throw Error('Injected rename disk failure'); };
  assert.throws(() => store.rename(item.id, 'Draft label', expected), /disk failure/); assert.deepEqual(store.get(item.id), before);
  store.persist = persist; store.rename(item.id, 'Draft label', expected); assert.equal(store.get(item.id).title, 'Draft label');
});
test('inline naming cannot overwrite the title of an active preview editor', t => {
  const { store, item, expected } = fixture(t); store.protectedItemId = item.id;
  assert.throws(() => store.rename(item.id, 'Other label', expected), /正在编辑/); assert.equal(store.get(item.id).title, expected.title);
  store.protectedItemId = null; store.rename(item.id, 'Other label', expected); assert.equal(store.get(item.id).title, 'Other label');
});
