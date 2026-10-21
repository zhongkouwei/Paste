import { getTextBetween, getTextSerializersFromSchema } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { tableText } from './rich-content.mjs';

export function clipboardText(slice, view) {
  const { selection, schema, doc } = view.state;
  if (selection instanceof CellSelection) {
    // CellSelection already clips spans and pads the selected rectangle; never flatten its disjoint ranges.
    const table = slice.content.firstChild?.type.name === 'table' ? slice.content.firstChild : schema.nodes.table.create(null, slice.content);
    return tableText(table);
  }
  return [...selection.ranges].sort((a, b) => a.$from.pos - b.$from.pos).map(({ $from, $to }) =>
    getTextBetween(doc, { from: $from.pos, to: $to.pos }, {
      blockSeparator: '\n\n', textSerializers: getTextSerializersFromSchema(schema)
    })).join('\n\n');
}

function ordinalAt(list, index) {
  let value = list.attrs.start ?? (list.attrs.reversed ? list.childCount : 1);
  for (let n = 0; n <= index; n++) {
    value = list.child(n).attrs.value ?? value;
    if (n < index) value += list.attrs.reversed ? -1 : 1;
  }
  return value;
}
function numberedFragment(source, fragment, from, to) {
  const children = []; let index = 0;
  source.forEach((original, offset) => {
    if (offset >= to || offset + original.nodeSize <= from) return;
    let copied = fragment.child(index++);
    if (!original.isLeaf) {
      const start = Math.max(0, from - offset - 1), end = Math.min(original.content.size, to - offset - 1);
      copied = copied.copy(numberedFragment(original, copied.content, start, end));
      if (original.type.name === 'orderedList' && copied.childCount) {
        const first = original.content.findIndex(start).index;
        if (first || copied.childCount !== original.childCount) copied = copied.type.create({ ...copied.attrs, start: ordinalAt(original, first) }, copied.content, copied.marks);
      }
    }
    children.push(copied);
  });
  return Fragment.fromArray(children);
}
export function copiedListNumbers(slice, selection) {
  if (!(selection instanceof TextSelection) || selection.empty || !slice.eq(selection.content())) return slice;
  return new Slice(numberedFragment(selection.$from.doc, slice.content, selection.from, selection.to), slice.openStart, slice.openEnd);
}
