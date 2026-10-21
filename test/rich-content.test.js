const { test } = require('node:test');
const assert = require('node:assert/strict');

test('embedded image policy permits bounded raster data only, never URLs or SVG', async () => {
  const { embeddedImage, MAX_IMAGE_URL } = await import('../src/rich-content.mjs');
  const headers = { png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), jpeg: Buffer.from([255, 216, 255]), gif: Buffer.from('GIF89a'), webp: Buffer.from('RIFF0000WEBP') };
  for (const [format, header] of Object.entries(headers)) assert.equal(embeddedImage(`data:image/${format};base64,${header.toString('base64')}`), true);
  for (const value of [null, '', 'file:///private/picture.png', 'https://example.com/image.png', 'data:image/svg+xml;base64,YWJj',
    'data:text/html;base64,YWJj', 'data:image/png;base64,YWJjZA==', 'data:image/png;base64,', 'data:image/png;base64,ab\ncd', 'data:image/png;base64,a===',
    `data:image/png;base64,${Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}`,
    `data:image/jpeg;base64,${headers.png.toString('base64')}`,
    `data:image/png;base64,${'a'.repeat(MAX_IMAGE_URL)}`]) assert.equal(embeddedImage(value), false);
});
test('table span limits reject zero, huge or malformed grid allocations before parsing', async () => {
  const { validSpan } = await import('../src/rich-content.mjs');
  for (const value of ['1', '2', '99', '100']) assert.equal(validSpan(value), true);
  for (const value of ['', '0', '-1', '101', '999999', '1.5', '2x', '01']) assert.equal(validSpan(value), false);
});
test('table plaintext uses the proven grid map and keeps merged-cell coordinates rather than concatenating columns', async () => {
  const { tableText } = await import('../src/rich-content.mjs');
  const { getSchema } = await import('@tiptap/core');
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { TableKit } = await import('@tiptap/extension-table');
  const schema = getSchema([StarterKit, TableKit]);
  const cell = (text, attrs = {}) => schema.nodes.tableCell.create(attrs, schema.nodes.paragraph.create(null, text ? schema.text(text) : null));
  const table = schema.nodes.table.create(null, [
    schema.nodes.tableRow.create(null, [cell('Heading', { colspan: 2 })]),
    schema.nodes.tableRow.create(null, [cell('Alpha', { rowspan: 2 }), cell('Ready')]),
    schema.nodes.tableRow.create(null, [cell('Pending')])
  ]);
  assert.equal(tableText(table), 'Heading\t\nAlpha\tReady\n\tPending');
});
