import createDOMPurify from 'dompurify';
import { TableMap } from '@tiptap/pm/tables';
import { getSchema, getTextBetween, getTextSerializersFromSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { listProblem, plainText } from './rich-lists.mjs';
import { Fragment, Slice } from '@tiptap/pm/model';

export function plainTextSlice(text, context) {
  const schema = context.doc.type.schema, marks = context.marks();
  return Slice.maxOpen(Fragment.fromArray(text.split(/\r\n?|\n/).map(line =>
    schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : null))));
}

export const MAX_IMAGE_URL = 8 * 1024 * 1024;
export function embeddedImage(value) {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_URL) return false;
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  let header;
  try { header = atob(match[2].slice(0, 32)); } catch { return false; }
  return { png: header.startsWith('\x89PNG\r\n\x1a\n'), jpeg: header.startsWith('\xff\xd8\xff'),
    gif: /^GIF8[79]a/.test(header), webp: header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP' }[match[1]];
}
export function validSpan(value) { return /^[1-9]\d?$|^100$/.test(value || ''); }

export function tableText(node, { from = 0, to = node.content.size } = {}) {
  const map = TableMap.get(node), text = new Map(), visited = new Set(), rows = [];
  let top = map.height, bottom = 0, left = map.width, right = 0;
  map.map.forEach((position, index) => {
    if (!visited.has(position)) {
      visited.add(position);
      const cell = node.nodeAt(position), start = position + 1, end = start + cell.content.size;
      if (to >= start && from <= end) text.set(position, from <= start && to >= end ? plainText(cell) : getTextBetween(cell, {
        from: Math.max(0, from - start), to: Math.min(cell.content.size, to - start)
      }, { blockSeparator: '\n', textSerializers: getTextSerializersFromSchema(cell.type.schema) }));
    }
    if (!text.has(position)) return;
    const row = Math.floor(index / map.width), column = index % map.width;
    top = Math.min(top, row); bottom = Math.max(bottom, row + 1);
    left = Math.min(left, column); right = Math.max(right, column + 1);
  });
  const seen = new Set();
  for (let row = top; row < bottom; row++) {
    const cells = [];
    for (let column = left; column < right; column++) {
      const position = map.map[row * map.width + column];
      cells.push(seen.has(position) ? '' : text.get(position) || '');
      seen.add(position);
    }
    rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}
export function selectedTableText({ node, pos, range }) {
  return tableText(node, { from: Math.max(0, range.from - pos - 1), to: Math.min(node.content.size, range.to - pos - 1) });
}

const STYLE_PROPERTIES = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'text-align', 'text-decoration', 'text-indent', 'white-space', 'vertical-align', 'list-style-type', 'list-style-position',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'border-collapse', 'border-spacing', 'table-layout',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style', 'border-width'
];
export function safeStyle(element) {
  const output = element.ownerDocument.createElement('span').style;
  for (const property of STYLE_PROPERTIES) {
    const value = element.style?.getPropertyValue(property);
    if (value && !/url\s*\(|var\s*\(|\\/i.test(value)) output.setProperty(property, value, element.style.getPropertyPriority(property));
  }
  return output.cssText;
}

export function createRichContentPolicy(window) {
  const purifier = createDOMPurify(window);
  const schema = getSchema([StarterKit, TableKit]);
  let report;
  const unsupported = new Set(['svg', 'math', 'video', 'audio', 'object', 'embed', 'canvas', 'sup', 'sub', 'dl', 'ruby', 'caption', 'iframe', 'form', 'input']);
  const problem = message => { report.reason ||= message; };
  purifier.addHook('uponSanitizeElement', (node, data) => {
    if (unsupported.has(data.tagName)) problem('此内容包含暂不支持编辑的嵌入元素，原文未修改。');
    if (node.nodeType === 1 && ++report.elements > 20000) problem('富文本结构过大，原文未修改。');
    if (data.tagName === 'img' && !embeddedImage(node.getAttribute('src'))) problem('外部图片或此图片格式暂不支持编辑，原文未修改。');
  });
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'src' && (node.tagName !== 'IMG' || !embeddedImage(data.attrValue))) data.keepAttr = false;
    if (data.attrName === 'href' && !/^(https?:|mailto:)/i.test(data.attrValue)) data.keepAttr = false;
    if (['rowspan', 'colspan'].includes(data.attrName) && !validSpan(data.attrValue)) {
      problem('表格跨度超出可编辑范围，原文未修改。'); data.keepAttr = false;
    }
  });
  purifier.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'IMG' && !embeddedImage(node.getAttribute('src'))) { node.remove(); return; }
    if (['OL', 'UL', 'LI'].includes(node.tagName) &&
      ((node.style.listStyleImage && !['none', 'initial'].includes(node.style.listStyleImage)) ||
      ['counter-reset', 'counter-set', 'counter-increment'].some(name => node.style.getPropertyValue(name) && node.style.getPropertyValue(name) !== 'none'))) {
      problem('自定义列表计数器或图片标记暂不支持编辑，原文未修改。');
    }
    if (node.hasAttribute?.('style')) {
      const style = safeStyle(node); if (style) node.setAttribute('style', style); else node.removeAttribute('style');
    }
  });
  return {
    inspect(html) {
      report = { reason: '', elements: 0 };
      if ((html || '').length > 16 * 1024 * 1024) return { html: '', reason: '富文本超过编辑大小限制，原文未修改。' };
      const sanitized = purifier.sanitize(html || '', { USE_PROFILES: { html: true }, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
        ADD_ATTR: ['colwidth'],
        FORBID_TAGS: ['style', 'link', 'base', 'iframe', 'form', 'input', 'button', 'video', 'audio', 'source', 'object', 'embed', 'canvas', 'template'],
        FORBID_ATTR: ['srcset', 'poster', 'background', 'class', 'id', 'contenteditable', 'tabindex', 'autofocus'] });
      const document = new window.DOMParser().parseFromString(sanitized, 'text/html');
      for (const container of document.querySelectorAll('table,thead,tbody,tfoot,tr,colgroup,ol,ul')) {
        for (const child of [...container.childNodes]) if (child.nodeType === 3 && !child.textContent.trim()) child.remove();
      }
      for (const item of document.querySelectorAll('li')) {
        const children = [...item.childNodes];
        if (children.every(child => child.nodeType === 3 ? !child.textContent.trim() : child.nodeType !== 1 || ['P', 'OL', 'UL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'DIV'].includes(child.tagName))) {
          for (const child of children) if (child.nodeType === 3) child.remove();
        }
      }
      const listReason = listProblem(document); if (listReason) problem(listReason);
      let area = 0;
      for (const cell of document.querySelectorAll('td,th')) area += (Number(cell.getAttribute('rowspan')) || 1) * (Number(cell.getAttribute('colspan')) || 1);
      if (area > 20000) problem('表格单元格范围过大，原文未修改。');
      if (!report.reason) for (const table of document.querySelectorAll('table')) {
        if (table.querySelector('table')) { problem('嵌套表格暂不支持编辑，原文未修改。'); break; }
        const rows = [...table.rows], source = [];
        if (!rows.length) { problem('表格没有可编辑的行，原文未修改。'); break; }
        // Reuse TableMap for merged-cell coordinates; DOM cellIndex ignores row/column spans.
        const grid = schema.nodes.table.create(null, rows.map(row => schema.nodes.tableRow.create(null, [...row.cells].map(cell => {
          source.push(cell);
          return schema.nodes.tableCell.create({ colspan: cell.colSpan, rowspan: cell.rowSpan }, schema.nodes.paragraph.create());
        }))));
        const map = TableMap.get(grid);
        if (!map.width || map.width * map.height > 20000 || map.problems?.length) { problem('表格结构不完整或范围过大，原文未修改。'); break; }
        const cellColumns = new Map();
        map.map.forEach((position, index) => { if (!cellColumns.has(position)) cellColumns.set(position, index % map.width); });
        const columns = [];
        for (const col of table.querySelectorAll(':scope > colgroup > col')) {
          const value = col.style.width || col.getAttribute('width') || '';
          if (!validSpan(col.getAttribute('span') || '1') || (value && !/^\d+(?:\.\d+)?(?:px)?$/.test(value))) { problem('此表格列宽暂不支持编辑，原文未修改。'); break; }
          const width = Number.parseFloat(value) || 0;
          if (width > 10000) { problem('此表格列宽超出编辑范围，原文未修改。'); break; }
          for (let n = 0; n < col.span; n++) columns.push(width);
        }
        if (columns.length > map.width) problem('此表格列宽结构暂不支持编辑，原文未修改。');
        if (report.reason) break;
        let index = 0;
        grid.descendants((node, position) => {
          if (node.type.name !== 'tableCell') return;
          const cell = source[index++], value = cell.getAttribute('colwidth');
          if (value && (!/^\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?)*$/.test(value) || value.split(',').length !== cell.colSpan || value.split(',').some(width => Number(width) > 10000))) {
            problem('此表格列宽数据无效，原文未修改。'); return;
          }
          if (!value && columns.length) {
            const column = cellColumns.get(position);
            const widths = Array.from({ length: cell.colSpan }, (_, offset) => columns[column + offset] || 0);
            if (widths.some(Boolean)) cell.setAttribute('colwidth', widths.join(','));
          }
        });
      }
      return { html: document.body.innerHTML, reason: report.reason };
    }
  };
}
