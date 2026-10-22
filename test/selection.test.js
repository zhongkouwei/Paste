const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SelectionService, selectionIDs } = require('../src/selection');
function fixture(items) {
  const records = new Map(items.map(item => [item.id, { signature: item.id, ...item }]));
  const service = new SelectionService({ store: { getMetadata: id => records.get(id), get: id => records.get(id) },
    readImage: () => Buffer.from('PNG fixture'), richText: { read: async () => ({ html: '<b>Rich</b>', text: 'Rich' }) },
    composeHTML: async parts => ({ html: '<b>Combined</b>', fragments: parts.map(part => part.html || ''), images: parts.filter(part => part.image).length }),
    composeNative: async segments => ({ ok: true, attachments: segments.filter(part => part.image).length, ...(segments.some(part => part.image) ? { rtfd: 'cnRmZA==' } : { rtf: '{\\rtf1 Combined}' }) }) });
  return { service, records };
}
test('selection validates identities before reading content and never accepts duplicates or an empty request', () => {
  for (const ids of [null, [], ['A', 'A'], [1], [''], ['x'.repeat(257)], Array(10001).fill('A')]) assert.throws(() => selectionIDs(ids));
  const ids = ['A', 'B']; assert.deepEqual(selectionIDs(ids), ids); assert.notEqual(selectionIDs(ids), ids);
});
test('plain selections preserve all scalar text and blank boundaries in requested order without changing originals', async () => {
  const { service, records } = fixture([{ id: 'A', type: 'text', body: 'Alpha\n' }, { id: 'B', type: 'code', body: '\n中文\t\uD800' }]);
  const before = structuredClone([...records]);
  const { item } = await service.prepare(['B', 'A']); assert.equal(item.body, '\n中文\t\uFFFD\nAlpha\n'); assert.equal(item.html, undefined); assert.deepEqual([...records], before);
});
test('rich and image representations combine once while plain mode does not unnecessarily convert formats', async () => {
  const { service } = fixture([{ id: 'A', type: 'text', body: 'Rich', html: '<b>Rich</b>' }, { id: 'B', type: 'image', body: '', title: 'Picture' }]);
  const result = await service.prepare(['A', 'B']); assert.equal(result.item.html, '<b>Combined</b>'); assert.equal(result.item.rtfd, 'cnRmZA=='); assert.equal(result.item.body, 'Rich\nPicture');
  await assert.rejects(service.prepare(['A', 'B'], { plain: true }), /图片或文件/);
  const plain = await service.prepare(['A'], { plain: true }); assert.equal(plain.item.body, 'Rich'); assert.equal(plain.item.html, undefined);
});
test('RTF-only conversion is checked before merge; mismatched or unsupported content fails without a partial result', async () => {
  const { service } = fixture([{ id: 'A', type: 'text', body: 'Rich', rtf: '{\\rtf1 Rich}' }, { id: 'B', type: 'text', body: 'Tail' }]);
  assert.equal((await service.prepare(['A', 'B'])).item.rtf, '{\\rtf1 Combined}');
  service.richText.read = async () => ({ text: 'Wrong', html: '<b>Wrong</b>' }); await assert.rejects(service.prepare(['A', 'B']), /不一致/);
  assert.equal((await service.prepare(['A', 'B'], { plain: true })).item.body, 'Rich\nTail');
});
test('missing, changed, mixed-file, oversized and incomplete attachment selections fail closed', async () => {
  const { service, records } = fixture([{ id: 'A', type: 'text', body: 'A' }, { id: 'F', type: 'file', body: 'file:///missing' }, { id: 'I', type: 'image', body: '' }]);
  await assert.rejects(service.prepare(['missing', 'A']), /删除/); await assert.rejects(service.prepare(['A', 'F']), /分别选择/);
  await assert.rejects(service.prepare(['F']), /移动或删除/);
  records.get('A').body = 'x'.repeat(16 * 1024 * 1024 + 1); await assert.rejects(service.prepare(['A']), /16 MiB/); records.get('A').body = 'A';
  service.composeNative = async () => ({ ok: true, attachments: 0, rtf: '{\\rtf1 Missing}' }); await assert.rejects(service.prepare(['A', 'I']), /完整合并/);
  const result = await service.prepare(['A']); records.get('A').signature = 'new'; assert.throws(() => service.verify(result.references), /改变或删除/);
});
test('shutdown cancels an active native merge and refuses later requests without a write', async () => {
  const { service } = fixture([{ id: 'A', type: 'text', body: 'A', html: '<b>A</b>' }]);
  let started; const ready = new Promise(resolve => { started = resolve; });
  service.composeNative = (_segments, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started(); });
  const operation = service.prepare(['A']); const failed = assert.rejects(operation, /已停止/); await ready; await service.close(); await failed;
  assert.equal(service.jobs.size, 0); await assert.rejects(service.prepare(['A']), /已停止/);
});
