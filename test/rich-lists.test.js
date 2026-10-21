const { test } = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const lists = await import('../src/rich-lists.mjs');
  const { getSchema, getTextBetween, getTextSerializersFromSchema } = await import('@tiptap/core');
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { TableKit, Table } = await import('@tiptap/extension-table');
  const { tableText } = await import('../src/rich-content.mjs');
  const schema = getSchema([StarterKit.configure({ orderedList: false, bulletList: false, listItem: false }),
    lists.RichOrderedList, lists.RichBulletList, lists.RichListItem, TableKit.configure({ table: false }), Table.extend({ renderText: ({ node }) => tableText(node) })]);
  const p = text => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
  const item = (text, attrs = {}, children = []) => schema.nodes.listItem.create(attrs, [p(text), ...children]);
  const ol = (children, attrs = {}) => schema.nodes.orderedList.create(attrs, children);
  const ul = (children, attrs = {}) => schema.nodes.bulletList.create(attrs, children);
  const doc = children => schema.nodes.doc.create(null, children);
  return { ...lists, schema, p, item, ol, ul, doc, getTextBetween, getTextSerializersFromSchema };
}

test('HTML list integer attributes accept signed 32-bit values without partial parsing', async () => {
  const { listInteger } = await fixture();
  for (const [input, expected] of [['0', 0], [' +12 ', 12], ['-2147483648', -2147483648], ['2147483647', 2147483647]]) assert.equal(listInteger(input), expected);
  for (const input of [null, undefined, '', '2x', '1.5', '1e2', '2147483648', '-2147483649', '+ 1', 'Infinity']) assert.equal(listInteger(input), null);
});
test('counter library handles long alphabetic, roman range fallback, CJK and standard bullets', async () => {
  const { marker } = await fixture();
  for (const [style, value, expected] of [['upper-alpha', 703, 'AAA. '], ['lower-latin', 27, 'aa. '], ['lower-roman', 19, 'xix. '],
    ['lower-roman', 4000, '4000. '], ['decimal', -2, '-2. '], ['decimal-leading-zero', 3, '03. '], ['cjk-decimal', 42, '四二、'],
    ['disc', 1, '• '], ['circle', 1, '◦ '], ['square', 1, '▪ '], ['none', 1, '']]) assert.equal(marker(style, value), expected);
});
test('reversed implicit starts follow item count while value zero restarts subsequent numbering', async () => {
  const { ol, item, listText } = await fixture();
  assert.equal(listText(ol([item('One'), item('Zero', { value: 0 }), item('Negative')], { reversed: true })), '3. One\n0. Zero\n-1. Negative');
  assert.equal(listText(ol([item('First'), item('Second')], { reversed: true, start: 7, type: 'A' })), 'G. First\nF. Second');
  assert.equal(listText(ol([item('One')], { reversed: true })), '1. One');
});
test('nested lists serialize once with continuation indentation, blank items and sibling paragraphs', async () => {
  const { ol, ul, item, p, doc, plainText } = await fixture();
  const nested = ul([item('Child', {}, [p('Continuation'), ul([item('Deep')])])]);
  assert.equal(plainText(doc([p('Before'), ol([item('Parent', {}, [nested]), item('')], { start: 3, type: 'A' }), p('After')])),
    'Before\nC. Parent\n  ◦ Child\n    Continuation\n    ▪ Deep\nD. \nAfter');
});
test('local item marker style does not change sibling markers', async () => {
  const { ol, item, listText } = await fixture();
  assert.equal(listText(ol([item('Roman', { markerStyle: 'upper-roman' }), item('Decimal')])),'I. Roman\n2. Decimal');
});
test('table cells retain list markers and merged-cell coordinates', async () => {
  const { schema, ol, item, p, doc, plainText } = await fixture();
  const cell = children => schema.nodes.tableCell.create(null, children);
  const table = schema.nodes.table.create(null, [schema.nodes.tableRow.create(null, [cell([ol([item('Task')], { start: 4 })]), cell([p('Ready')])])]);
  assert.equal(plainText(doc([table])), '4. Task\tReady');
});
test('partial list selections cannot serialize unselected siblings or text', async () => {
  const { ol, item, doc, getTextBetween, getTextSerializersFromSchema } = await fixture();
  const node = doc([ol([item('Secret before'), item('Selected word'), item('Secret after')])]);
  let from;
  node.descendants((child, pos) => { if (child.isText && child.text === 'Selected word') from = pos; });
  const options = { blockSeparator: '\n', textSerializers: getTextSerializersFromSchema(node.type.schema) };
  assert.equal(getTextBetween(node, { from, to: from + 8 }, options), 'Selected');
  assert.equal(getTextBetween(node, { from: 0, to: node.content.size }, options), '1. Secret before\n2. Selected word\n3. Secret after');
});
