import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Table, TableCell, TableHeader, TableKit, TableView } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { closeHistory } from '@tiptap/pm/history';
import { createRichContentPolicy, safeStyle, selectedTableText, plainTextSlice } from './rich-content.mjs';
import { RichOrderedList, RichBulletList, RichListItem, plainText } from './rich-lists.mjs';
import { clipboardText, copiedListNumbers } from './rich-copy.mjs';
export { nativeRichHTML } from './native-rich.mjs';

const policy = createRichContentPolicy(window);
export const inspect = html => policy.inspect(html);
export const sanitize = html => inspect(html).html;
export const supports = html => !inspect(html).reason;

const PreservedStyle = Extension.create({
  name: 'preservedStyle',
  addGlobalAttributes() { return [{
    types: ['paragraph', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell', 'tableHeader', 'image', 'textStyle'],
    attributes: { style: { default: null, parseHTML: node => {
      const style = node.ownerDocument.createElement('span').style; style.cssText = safeStyle(node);
      if (node.tagName === 'SPAN') {
        // Formatting marks own these semantics; duplicate CSS would survive toggling a mark off.
        if (/^(bold(er)?|[5-9]\d{2,})$/.test(style.fontWeight)) style.removeProperty('font-weight');
        if (style.fontStyle === 'italic') style.removeProperty('font-style');
        const decoration = style.textDecoration;
        if (/underline|line-through/.test(decoration)) {
          style.removeProperty('text-decoration');
          const rest = decoration.replace(/\b(underline|line-through)\b/g, '').trim();
          if (rest) style.textDecoration = rest;
        }
      }
      return style.cssText || null;
    },
      renderHTML: attributes => attributes.style ? { style: attributes.style } : {} } }
  }]; }
});
class PreservedTableView extends TableView {
  constructor(...args) { super(...args); this.restoreWidth(); }
  restoreWidth() {
    // Tiptap 3.32 TableView clears width even when the node supplies its own style.
    const style = document.createElement('span').style; style.cssText = this.node.attrs.style || '';
    if (style.width) { this.table.style.setProperty('width', style.width, style.getPropertyPriority('width')); this.table.style.minWidth = style.minWidth; }
  }
  update(node) { const accepted = super.update(node); if (accepted) this.restoreWidth(); return accepted; }
}
const RichTable = Table.extend({ renderText: selectedTableText }).configure({ View: PreservedTableView });
const preciseCell = Cell => Cell.extend({
  addAttributes() { return { ...this.parent?.(), colwidth: { default: null,
    parseHTML: cell => cell.hasAttribute('colwidth') ? cell.getAttribute('colwidth').split(',').map(Number) : null } }; }
});
const EmbeddedImage = Image.extend({ renderText: ({ node }) => node.attrs.alt || '' });

export function create(element, { html, text = '', allowImages = true, onUpdate, onSelection, onUnsupported } = {}) {
  let initialDocument;
  const content = html ? sanitize(html) : { type: 'doc', content: text.split('\n').map(line => ({
    type: 'paragraph', content: line ? [{ type: 'text', text: line }] : []
  })) };
  const editor = new Editor({ element, enablePasteRules: false, extensions: [StarterKit.configure({ link: { openOnClick: false },
    orderedList: false, bulletList: false, listItem: false, trailingNode: { notAfter: ['orderedList', 'bulletList'] } }), TextStyleKit,
    RichOrderedList, RichBulletList, RichListItem,
    PreservedStyle, TableKit.configure({ table: false, tableCell: false, tableHeader: false }), RichTable, preciseCell(TableCell), preciseCell(TableHeader),
    EmbeddedImage.configure({ inline: true, allowBase64: true })], content,
    parseOptions: { preserveWhitespace: 'full' },
    editorProps: { attributes: { role: 'textbox', 'aria-label': '剪贴板内容', 'aria-multiline': 'true', class: 'rich-editor' }, transformPastedHTML: sanitize,
      clipboardTextSerializer: clipboardText, clipboardTextParser: plainTextSlice,
      transformCopied: (slice, view) => copiedListNumbers(slice, view.state.selection),
      handlePaste: (_view, event) => {
        const clipboard = event.clipboardData, html = clipboard?.getData('text/html');
        const reason = html ? inspect(html).reason || (!allowImages && new DOMParser().parseFromString(html, 'text/html').querySelector('img') ? '当前RTF转换不能保留内嵌图像，选区未修改。' : '') : clipboard?.files.length ? '请单独复制图片后编辑，当前选区未修改。' : '';
        if (!reason) return false;
        onUnsupported?.(reason); return true;
      } },
    onUpdate: ({ editor }) => { if (initialDocument) onUpdate?.(!editor.state.doc.eq(initialDocument)); },
    onSelectionUpdate: () => onSelection?.(), onTransaction: () => onSelection?.()
  });
  // Settle structural plugins before taking the baseline, not on the first user selection.
  editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  initialDocument = editor.state.doc;
  const commands = { bold: 'toggleBold', italic: 'toggleItalic', underline: 'toggleUnderline', strike: 'toggleStrike', undo: 'undo', redo: 'redo',
    insertTable: 'insertTable', addRowBefore: 'addRowBefore', addRowAfter: 'addRowAfter', deleteRow: 'deleteRow',
    addColumnBefore: 'addColumnBefore', addColumnAfter: 'addColumnAfter', deleteColumn: 'deleteColumn', mergeCells: 'mergeCells', splitCell: 'splitCell',
    toggleHeaderRow: 'toggleHeaderRow', deleteTable: 'deleteTable' };
  const args = name => name === 'insertTable' ? { rows: 3, cols: 3, withHeaderRow: true } : undefined;
  return {
    focus: () => editor.view.focus(), destroy: () => editor.destroy(),
    content: () => ({ body: plainText(editor.state.doc), html: editor.getHTML() }),
    active: name => editor.isActive(name),
    can: name => !!commands[name] && (name !== 'insertTable' || !editor.isActive('table')) && editor.can()[commands[name]](args(name)),
    command: name => {
      if (!commands[name]) return;
      editor.view.focus();
      const editing = !['undo', 'redo'].includes(name);
      if (editing) editor.view.dispatch(closeHistory(editor.state.tr));
      editor.chain()[commands[name]](args(name)).run();
      if (editing) editor.view.dispatch(closeHistory(editor.state.tr));
    }
  };
}
