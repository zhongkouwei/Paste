import { getText, getTextBetween, getTextSerializersFromSchema, mergeAttributes, wrappingInputRule } from '@tiptap/core';
import { OrderedList, BulletList, ListItem, orderedListInputRegex } from '@tiptap/extension-list';
import * as CounterModule from '@jsamr/counter-style';
import * as PresetModule from '@jsamr/counter-style/lib/cjs/presets/index.js';

const CounterStyle = CounterModule.default?.default || CounterModule.default || CounterModule;
const presets = PresetModule.default || PresetModule;
const counters = new Map(Object.entries(presets).filter(([, value]) => typeof value?.renderMarker === 'function')
  .map(([name, value]) => [name.replace(/^katana/, 'katakana').replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), value]));
// The published square preset predates CSSWG's U+25FE -> U+25AA correction.
counters.set('square', CounterStyle.cyclic('\u25aa').withSuffix(' '));
const types = { '1': 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman', disc: 'disc', circle: 'circle', square: 'square' };
export const LIST_STYLES = new Set([...counters.keys(), 'none']);
export function listInteger(value) {
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value.trim())) return null;
  const number = Number(value); return Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? number : null;
}
export function marker(style, value) {
  if (style === 'none') return '';
  return (counters.get(style) || counters.get('decimal')).renderMarker(value).replace(/\u00a0$/, ' ');
}
function styleFor(node, inherited) {
  return node.attrs.markerStyle || types[node.attrs.type] || inherited;
}
export function plainText(node, listDepth = 0) {
  return getText(node, { blockSeparator: '\n', textSerializers: {
    ...getTextSerializersFromSchema(node.type.schema), image: ({ node }) => node.attrs.alt || '',
    orderedList: ({ node }) => listText(node, listDepth), bulletList: ({ node }) => listText(node, listDepth)
  } });
}
export function selectedListText({ node, pos, range }) {
  if (range.from <= pos && range.to >= pos + node.nodeSize) return listText(node);
  // A serializer is also called for partially selected ancestors. Never copy their unselected children.
  return getTextBetween(node, { from: Math.max(0, range.from - pos - 1), to: Math.min(node.content.size, range.to - pos - 1) }, {
    blockSeparator: '\n', textSerializers: getTextSerializersFromSchema(node.type.schema)
  });
}
export function listText(node, depth = 0) {
  const ordered = node.type.name === 'orderedList', reversed = ordered && node.attrs.reversed;
  let value = ordered ? node.attrs.start ?? (reversed ? node.childCount : 1) : 1;
  const style = styleFor(node, ordered ? 'decimal' : ['disc', 'circle', 'square'][Math.min(depth, 2)]);
  const lines = [];
  node.forEach(item => {
    if (ordered && item.attrs.value !== null && item.attrs.value !== undefined) value = item.attrs.value;
    const text = plainText(item, depth + 1).split('\n'), prefix = marker(styleFor(item, style), value);
    lines.push(prefix + text[0], ...text.slice(1).map(line => `  ${line}`));
    value += reversed ? -1 : 1;
  });
  return lines.join('\n');
}

const markerStyle = { default: null, rendered: false, parseHTML: element => element.style.listStyleType || null };
export const RichOrderedList = OrderedList.extend({
  addAttributes() { return { ...this.parent?.(),
    start: { default: null, parseHTML: element => element.hasAttribute('start') ? listInteger(element.getAttribute('start')) : null },
    type: { default: null, parseHTML: element => element.getAttribute('type') || null },
    reversed: { default: false, parseHTML: element => element.hasAttribute('reversed') }, markerStyle
  }; },
  renderHTML({ HTMLAttributes }) {
    const { start, reversed, type, ...attributes } = HTMLAttributes;
    return ['ol', mergeAttributes(this.options.HTMLAttributes, attributes, {
      ...(start !== null ? { start } : {}), ...(reversed ? { reversed: '' } : {}), ...(type ? { type } : {})
    }), 0];
  },
  renderText: selectedListText,
  addInputRules() {
    return [wrappingInputRule({ find: orderedListInputRegex, type: this.type,
      getAttributes: match => ({ start: Number(match[1]) }),
      joinPredicate: (match, node) => {
        if (node.attrs.reversed || ![null, '1'].includes(node.attrs.type) || ![null, 'decimal'].includes(node.attrs.markerStyle)) return false;
        let next = node.attrs.start ?? 1;
        node.forEach(item => { next = (item.attrs.value ?? next) + 1; });
        return next === Number(match[1]);
      }
    })];
  }
});
export const RichBulletList = BulletList.extend({
  addAttributes() { return { ...this.parent?.(), markerStyle,
    type: { default: null, parseHTML: element => element.getAttribute('type') || null }
  }; },
  renderText: selectedListText
});
export const RichListItem = ListItem.extend({
  addAttributes() { return { ...this.parent?.(), markerStyle,
    value: { default: null, keepOnSplit: false, parseHTML: element => element.hasAttribute('value') ? listInteger(element.getAttribute('value')) : null },
    type: { default: null, parseHTML: element => element.getAttribute('type') || null }
  }; }
});

export function listProblem(document) {
  for (const element of document.querySelectorAll('ol,ul,li')) {
    for (const name of element.tagName === 'OL' ? ['start'] : element.tagName === 'LI' ? ['value'] : []) {
      if (element.hasAttribute(name) && listInteger(element.getAttribute(name)) === null) return '列表编号超出可编辑范围，原文未修改。';
    }
    if (element.hasAttribute('type') && !Object.hasOwn(types, element.getAttribute('type'))) return '此列表标记类型暂不支持编辑，原文未修改。';
    const style = element.style.listStyleType;
    if (style && !LIST_STYLES.has(style)) return '此列表标记样式暂不支持编辑，原文未修改。';
    let depth = 0;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) if (['OL', 'UL'].includes(ancestor.tagName) && ++depth > 32) return '列表嵌套超过编辑范围，原文未修改。';
  }
  return '';
}
