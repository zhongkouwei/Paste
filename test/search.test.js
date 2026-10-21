const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SearchIndex } = require('../src/search');
const { filterItems } = require('../src/model');

test('indexed substring search matches full original text including short Chinese, emoji and literal operators', t => {
  const index = new SearchIndex(); t.after(() => index.close());
  const items = [
    { id: 'one', title: 'A "quoted" title', body: 'İstanbul ABC xyz 剪贴板文字识别 🧪test 100% _sql_ AND OR NEAR foo\0after-null', source: { name: 'Editor' } },
    { id: 'two', title: 'Elsewhere', body: 'abc a"b a*b a:b (xyz) Öäé\n\nLiteral words', note: 'find this note' },
    { id: 'three', type: 'image', title: 'Invoice', body: 'private-asset-key.png', signature: 'pixels', ocr: { signature: 'pixels', text: '2048 中文识别' } },
    { id: 'stale', type: 'image', title: 'Changed', body: '', signature: 'new', ocr: { signature: 'old', text: 'SECRET-STALE' } }
  ];
  index.sync(items, 1);
  assert.deepEqual(index.find('private-asset-key'), []);
  for (const query of ['', 'abc', 'xyz', '板', '剪贴', '剪贴板', '2048 中文', 'quoted', 'a"b', 'a*b', 'a:b', '(xyz)', '100%', '_sql_', 'AND OR', 'editor', 'Öäé', 'note find', '🧪test', '\0after-null', 'after-null', 'İSTANBUL', 'SECRET-STALE', 'not found']) {
    assert.deepEqual(new Set(index.find(query)), new Set(filterItems(items, { query }).map(item => item.id)), query);
  }
  assert.throws(() => index.find('x'.repeat(2049)), /长度/); assert.throws(() => index.find(Array.from({ length: 33 }, (_, n) => n).join(' ')), /过多/);
});
test('incremental index updates text, titles, sources, notes, current OCR and deletions without stale results', t => {
  const index = new SearchIndex(); t.after(() => index.close());
  let items = [{ id: 'a', body: 'first body', title: 'original', source: { name: 'Notes' }, signature: 'one', ocr: { signature: 'one', text: 'ocr first' } }, { id: 'b', body: 'deleted body' }];
  index.sync(items, 1); const first = index.entries.get('a'); index.sync(items, 2);
  assert.deepEqual(index.entries.get('a'), first);
  items = [{ ...items[0], title: 'renamed', body: 'new body', source: { name: 'Editor' }, note: 'new note', signature: 'two' }];
  index.sync(items, 3);
  for (const query of ['first', 'original', 'Notes', 'deleted', 'ocr']) assert.deepEqual(index.find(query), [], query);
  for (const query of ['new body', 'renamed', 'Editor', 'new note']) assert.deepEqual(index.find(query), ['a'], query);
  index.sync([{ ...items[0], ocr: { signature: 'two', text: 'recognized update' } }], 4);
  assert.deepEqual(index.find('recognized update'), ['a']);
});
