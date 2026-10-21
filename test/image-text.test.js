const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { ImageTextIndex } = require('../src/image-text');

function fixture(process = async buffer => ({ text: buffer.toString(), lines: [], engine: 'test' })) {
  const items = new Map(['a', 'b', 'c'].map(id => [id, { id, type: 'image', signature: id }])), saved = [], calls = [];
  let changed = 0;
  const store = { get: id => items.get(id), setOCR: (id, signature, result) => {
    const item = items.get(id); if (!item || item.signature !== signature) return false;
    item.ocr = { ...result, signature }; saved.push(id); return true;
  } };
  const index = new ImageTextIndex({ store, processor: { recognize: async (buffer, options) => { calls.push(buffer.toString()); return process(buffer, options); } },
    readImage: item => Buffer.from(item.signature), onChanged: () => { changed += 1; } });
  return { items, saved, calls, store, index, changes: () => changed };
}
test('recognition jobs are serialized, shared by duplicate callers and cached by image signature', async () => {
  let active = 0, peak = 0;
  const f = fixture(async buffer => { active += 1; peak = Math.max(peak, active); await nextTurn(); active -= 1; return { text: buffer.toString(), lines: [] }; });
  const first = f.index.enqueue('a'); assert.equal(f.index.enqueue('a'), first);
  await Promise.all([first, f.index.enqueue('b')]);
  await f.index.enqueue('a'); assert.equal(peak, 1); assert.deepEqual(f.calls, ['a', 'b']); assert.equal(f.changes(), 2);
});
test('an explicit request promotes its queued job without interrupting active recognition', async () => {
  let finish;
  const f = fixture(buffer => buffer.toString() === 'a' ? new Promise(resolve => { finish = () => resolve({ text: 'a', lines: [] }); }) : { text: buffer.toString(), lines: [] });
  const first = f.index.enqueue('a'), second = f.index.enqueue('b'), third = f.index.enqueue('c');
  await nextTurn(); assert.equal(f.index.enqueue('c', { priority: true }), third); finish();
  await Promise.all([first, second, third]); assert.deepEqual(f.calls, ['a', 'c', 'b']);
});
test('stale results cannot overwrite changed or deleted images', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = () => resolve({ text: 'old pixels', lines: [] }); }));
  const pending = f.index.enqueue('a'); await nextTurn(); f.items.get('a').signature = 'changed'; finish(); await pending;
  assert.deepEqual(f.saved, []); assert.equal(f.items.get('a').ocr, undefined);
  const deleted = f.index.enqueue('b'); await nextTurn(); f.items.delete('b'); finish(); await deleted;
  assert.deepEqual(f.saved, []);
});
test('no-text and error results do not repeat automatically; an explicit retry can recover', async () => {
  const f = fixture(async buffer => { if (buffer.toString() === 'a') throw new Error('Vision unavailable'); return { text: '', lines: [] }; });
  await assert.rejects(f.index.enqueue('a'), /Vision unavailable/);
  assert.equal((await f.index.enqueue('a')).status, 'error'); assert.equal(f.calls.length, 1);
  assert.equal((await f.index.enqueue('b')).status, 'none'); await f.index.enqueue('b'); assert.equal(f.calls.length, 2);
  f.index.processor.recognize = async () => ({ text: 'Recovered', lines: [] });
  assert.equal((await f.index.enqueue('a', { force: true })).status, 'ready');
});
test('disk failures remain retryable instead of being marked as a completed recognition', async () => {
  const f = fixture(), save = f.store.setOCR;
  f.store.setOCR = () => { throw new Error('disk full'); };
  await assert.rejects(f.index.enqueue('a'), /disk full/); assert.equal(f.items.get('a').ocr, undefined);
  f.store.setOCR = save; await f.index.enqueue('a'); assert.equal(f.items.get('a').ocr.status, 'ready');
});
test('shutdown cancels active work, resolves queued callers and never persists cancelled text', async () => {
  const f = fixture((_buffer, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
  const a = f.index.enqueue('a'), b = f.index.enqueue('b'); await nextTurn();
  await f.index.close(); await Promise.all([a, b]); assert.equal(f.index.stopped, true); assert.deepEqual(f.saved, []);
  await assert.rejects(f.index.enqueue('c'), /已停止/);
});
