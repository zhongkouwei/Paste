const { test } = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const { getSchema } = await import('@tiptap/core');
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { TableKit, Table } = await import('@tiptap/extension-table');
  const { CellSelection } = await import('@tiptap/pm/tables');
  const { TextSelection, NodeSelection, AllSelection } = await import('@tiptap/pm/state');
  const { RichOrderedList, RichBulletList, RichListItem } = await import('../src/rich-lists.mjs');
  const { selectedTableText } = await import('../src/rich-content.mjs');
  const copy = await import('../src/rich-copy.mjs');
  const schema = getSchema([StarterKit.configure({ orderedList: false, bulletList: false, listItem: false }),
    RichOrderedList, RichBulletList, RichListItem, TableKit.configure({ table: false }), Table.extend({ renderText: selectedTableText })]);
  const p = text => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
  const item = (text, attrs = {}, rest = []) => schema.nodes.listItem.create(attrs, [p(text), ...rest]);
  const ol = (children, attrs = {}) => schema.nodes.orderedList.create(attrs, children);
  const cell = (text, attrs = {}) => schema.nodes.tableCell.create(attrs, p(text));
  const row = children => schema.nodes.tableRow.create(null, children);
  const doc = children => schema.nodes.doc.create(null, children);
  const table = rows => schema.nodes.table.create(null, rows.map(row));
  const positions = node => {
    const result = new Map(); node.descendants((child, pos) => { if (child.isText) result.set(child.text, pos); }); return result;
  };
  const selection = (node, first, last = first, length = last.length) => {
    const found = positions(node); return TextSelection.create(node, found.get(first), found.get(last) + length);
  };
  const text = (node, selected) => copy.clipboardText(selected.content(), { state: { doc: node, selection: selected, schema } });
  return { ...copy, schema, p, item, ol, cell, doc, table, positions, selection, text, TextSelection, NodeSelection, AllSelection, CellSelection };
}
test('table text serializers clip to the actual text selection instead of returning the entire table', async () => {
  const { cell, table, doc, selection, text } = await fixture();
  const node = doc([table([[cell('Visible word'), cell('Secret neighbor')], [cell('Private row'), cell('Private cell')]])]);
  assert.equal(text(node, selection(node, 'Visible word', 'Visible word', 7)), 'Visible');
  assert.equal(text(node, selection(node, 'Visible word', 'Secret neighbor', 6)), 'Visible word\tSecret');
});
test('text ranges spanning nonrectangular table ends keep blank coordinates without adjacent text', async () => {
  const { cell, table, doc, selection, text } = await fixture();
  const node = doc([table([[cell('Secret left'), cell('Start')], [cell('End'), cell('Secret right')]])]);
  assert.equal(text(node, selection(node, 'Start', 'End')), '\tStart\nEnd\t');
});
test('cell selections serialize their normalized rectangle once, independent of drag direction', async () => {
  const { cell, table, doc, text, CellSelection } = await fixture();
  const node = doc([table([[cell('A'), cell('Private one')], [cell('B'), cell('Private two')]])]);
  const at = new Map(); node.descendants((child, pos) => { if (child.type.name === 'tableCell') at.set(child.textContent, pos); });
  for (const [first, last] of [['A', 'B'], ['B', 'A']]) {
    const selected = new CellSelection(node.resolve(at.get(first)), node.resolve(at.get(last)));
    assert.equal(text(node, selected), 'A\nB');
  }
});
test('every rectangle in a synthetic grid exports exactly its cells and no others', async () => {
  const { cell, table, doc, text, CellSelection } = await fixture();
  const values = Array.from({ length: 3 }, (_, row) => Array.from({ length: 4 }, (_, column) => `R${row}C${column}`));
  const node = doc([table(values.map(row => row.map(value => cell(value))))]);
  const at = new Map(); node.descendants((child, pos) => { if (child.type.name === 'tableCell') at.set(child.textContent, pos); });
  for (let top = 0; top < 3; top++) for (let bottom = top; bottom < 3; bottom++) for (let left = 0; left < 4; left++) for (let right = left; right < 4; right++) {
    const selected = new CellSelection(node.resolve(at.get(values[top][left])), node.resolve(at.get(values[bottom][right])));
    assert.equal(text(node, selected), values.slice(top, bottom + 1).map(row => row.slice(left, right + 1).join('\t')).join('\n'));
  }
});
test('ordinary paragraph clipboard spacing is unchanged by table-specific handling', async () => {
  const { p, doc, text, AllSelection } = await fixture();
  const node = doc([p('First'), p('Second')]); assert.equal(text(node, new AllSelection(node)), 'First\n\nSecond');
});
test('whole-table and empty merged-cell selections retain the original grid', async () => {
  const { cell, table, doc, text, AllSelection, CellSelection } = await fixture();
  const node = doc([table([[cell('Heading', { colspan: 2 })], [cell(''), cell('Ready')]])]);
  assert.equal(text(node, new AllSelection(node)), 'Heading\t\n\tReady');
  assert.equal(text(node, new CellSelection(node.resolve(2))), 'Heading\t');
});
test('partial ordered list copies retain the first selected ordinal, including reversed implicit starts', async () => {
  const { ol, item, doc, selection, copiedListNumbers } = await fixture();
  for (const [attrs, expected] of [[{}, 2], [{ start: 10 }, 11], [{ reversed: true }, 3], [{ reversed: true, start: 10 }, 9]]) {
    const node = doc([ol(['One', 'Two', 'Three', 'Four'].map(value => item(value)), attrs)]), before = node.toJSON();
    const selected = selection(node, 'Two', 'Three'), copied = copiedListNumbers(selected.content(), selected);
    assert.equal(copied.content.firstChild.attrs.start, expected);
    assert.equal(copied.content.firstChild.childCount, 2); assert.deepEqual(node.toJSON(), before);
    assert.equal(copied.openStart, selected.content().openStart); assert.equal(copied.openEnd, selected.content().openEnd);
  }
});
test('copying the start of a reversed list keeps its original count even when the ending items are omitted', async () => {
  const { ol, item, doc, selection, copiedListNumbers } = await fixture();
  const node = doc([ol(['One', 'Two', 'Three', 'Four'].map(value => item(value)), { reversed: true })]);
  const selected = selection(node, 'One', 'Two');
  assert.equal(copiedListNumbers(selected.content(), selected).content.firstChild.attrs.start, 4);
});
test('explicit zero item restarts and nested copied lists use source positions rather than truncated child counts', async () => {
  const { ol, item, doc, selection, copiedListNumbers } = await fixture();
  const nested = ol(['Inner one', 'Inner two', 'Inner three'].map(value => item(value)), { reversed: true });
  const node = doc([ol([item('Outer one'), item('Outer zero', { value: 0 }, [nested]), item('Outer negative')], { reversed: true })]);
  const selected = selection(node, 'Inner two', 'Outer negative'), copy = copiedListNumbers(selected.content(), selected);
  const lists = []; copy.content.descendants(child => { if (child.type.name === 'orderedList') lists.push(child); });
  assert.equal(lists[0].attrs.start, 0); assert.equal(lists[1].attrs.start, 2);
  assert.equal(lists[0].firstChild.attrs.value, 0); assert.equal(copy.content.textBetween(0, copy.content.size, '|'), 'Inner two|Inner three|Outer negative');
});
test('copies crossing multiple lists adjust both clipped boundaries without changing intermediate paragraphs', async () => {
  const { ol, item, p, doc, selection, copiedListNumbers } = await fixture();
  const node = doc([ol([item('A'), item('B')], { start: 8 }), p('Between'), ol([item('C'), item('D'), item('E')], { reversed: true })]);
  const selected = selection(node, 'B', 'D'), copy = copiedListNumbers(selected.content(), selected);
  assert.equal(copy.content.child(0).attrs.start, 9); assert.equal(copy.content.child(1).textContent, 'Between'); assert.equal(copy.content.child(2).attrs.start, 3);
});
test('collapsed, whole-document, node and unrelated slices are not rewritten using incompatible positions', async () => {
  const { ol, item, p, doc, positions, copiedListNumbers, TextSelection, NodeSelection, AllSelection } = await fixture();
  const node = doc([ol([item('A'), item('B')])]);
  for (const selected of [TextSelection.create(node, positions(node).get('A')), new AllSelection(node), NodeSelection.create(node, 0)]) {
    const slice = selected.content(); assert.equal(copiedListNumbers(slice, selected), slice);
  }
  const selected = TextSelection.create(node, positions(node).get('B'), positions(node).get('B') + 1);
  const foreign = doc([p('Other')]).slice(0); assert.equal(copiedListNumbers(foreign, selected), foreign);
});
