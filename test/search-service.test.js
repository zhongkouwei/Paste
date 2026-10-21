const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { SearchService } = require('../src/search-service');

test('search workers index full originals without blocking the caller and return revision-tagged results', async t => {
  const service = new SearchService(); t.after(() => service.close());
  const items = Array.from({ length: 100 }, (_, n) => ({ id: String(n), body: 'synthetic content '.repeat(5000) + ` full-tail-${n}` }));
  let finished = false;
  const pending = service.search(items, 1, 'full-tail-99').finally(() => { finished = true; });
  await nextTurn(); assert.equal(finished, false);
  assert.deepEqual(await pending, { revision: 1, ids: ['99'] });
  const older = service.search(items, 1, 'full-tail-99'), newer = service.search([{ id: 'new', body: 'replacement body' }], 2, 'replacement');
  assert.deepEqual(await older, { revision: 1, ids: ['99'] }); assert.deepEqual(await newer, { revision: 2, ids: ['new'] });
  assert.deepEqual((await service.search([{ id: 'new', body: 'replacement body' }], 2, 'full-tail-99')).ids, []);
});
test('worker failure rejects live callers and the next request rebuilds from authoritative items', async t => {
  const service = new SearchService(); t.after(() => service.close());
  const result = service.search([{ id: 'a', body: 'Recovered content' }], 1, 'Recovered');
  const rejected = assert.rejects(result, /搜索进程已退出/); await service.worker.terminate(); await rejected;
  assert.deepEqual((await service.search([{ id: 'a', body: 'Recovered content' }], 1, 'Recovered')).ids, ['a']);
});
test('shutdown rejects pending work, terminates the worker and refuses new requests', async () => {
  const service = new SearchService();
  const pending = assert.rejects(service.search([{ id: 'a', body: 'Pending' }], 1, 'Pending'), /搜索已停止/);
  await service.close(); await pending; assert.equal(service.pending.size, 0); assert.equal(service.worker, null);
  await assert.rejects(service.search([], 2, ''), /搜索已停止/);
});
test('image search indexes current text but never private asset filenames or base64 bodies', async t => {
  const service = new SearchService(); t.after(() => service.close());
  const items = [{ id: 'image', type: 'image', body: 'private-asset-key.png', title: 'Photo', signature: 'pixels', ocr: { signature: 'pixels', text: 'Recognized invoice' } }];
  assert.deepEqual((await service.search(items, 1, 'private-asset-key')).ids, []);
  assert.deepEqual((await service.search(items, 1, 'Recognized invoice')).ids, ['image']);
});
