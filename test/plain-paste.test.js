const { test } = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const { getSchema } = await import('@tiptap/core');
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { plainTextSlice } = await import('../src/rich-content.mjs');
  const { plainText, listInput } = await import('../src/rich-lists.mjs');
  const schema = getSchema([StarterKit]);
  const context = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('Context'))).resolve(1);
  return { schema, context, plainTextSlice, plainText, listInput };
}
test('plain paste preserves every paragraph break, whitespace and literal markup character', async () => {
  const { schema, context, plainTextSlice, plainText } = await fixture();
  for (const value of ['', '\n', '\n\n', '\nA\n\n\nB\n\n', '  001)  First\n\n\t002) Second', '**literal** ~~strike~~ <b>not HTML</b> & tail', '🙂中文e\u0301\t\u2028尾']) {
    const slice = plainTextSlice(value, context), node = schema.nodes.doc.create(null, slice.content);
    assert.equal(plainText(node), value); assert.equal(slice.content.childCount, value.split('\n').length);
    assert.equal(slice.openStart, 1); assert.equal(slice.openEnd, 1);
  }
});
test('new plain paste normalizes CRLF and CR to LF without compressing adjacent breaks', async () => {
  const { schema, context, plainTextSlice, plainText } = await fixture();
  const slice = plainTextSlice('\r\nA\r\n\rB\n\r\n', context);
  assert.equal(plainText(schema.nodes.doc.create(null, slice.content)), '\nA\n\nB\n\n');
});
test('plain inserted paragraphs retain the insertion context marks without parsing Markdown', async () => {
  const { schema, plainTextSlice } = await fixture(), bold = schema.marks.bold.create();
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('Bold context', [bold])));
  const slice = plainTextSlice('**literal**\nSecond', doc.resolve(3));
  slice.content.forEach(paragraph => assert.ok(paragraph.firstChild.marks[0].eq(bold)));
  assert.equal(slice.content.firstChild.textContent, '**literal**');
});
test('typed automatic-list rules accept only canonical in-range ordinals', async () => {
  const { listInput } = await fixture();
  for (const value of ['0', '1', '999', '2147483647']) assert.deepEqual(listInput(`${value}. `), { index: 0, text: `${value}. `, replaceWith: value });
  for (const value of ['01. ', '000. ', '2147483648. ', '-1. ', '1. Text', 'Date 1. ', '1) ', '1e3. ', 'a. ']) assert.equal(listInput(value), null);
});
test('overflow and nonfinite numeric candidates never reach the list wrapping rule', async () => {
  const { listInput } = await fixture();
  for (const value of ['9'.repeat(20), '9'.repeat(400), '9'.repeat(10000)]) assert.equal(listInput(`${value}. `), null);
});
