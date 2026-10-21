import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';

export function supports(html) {
  const document = new DOMParser().parseFromString(html || '', 'text/html');
  return !document.querySelector('table,img,svg,math,video,audio,object,embed,canvas,sup,sub,dl');
}

export function create(element, { html, text = '', sanitize, onUpdate, onSelection } = {}) {
  const content = html ? sanitize(html) : { type: 'doc', content: text.split('\n').map(line => ({
    type: 'paragraph', content: line ? [{ type: 'text', text: line }] : []
  })) };
  const editor = new Editor({ element, extensions: [StarterKit.configure({ link: { openOnClick: false } }), TextStyleKit], content,
    parseOptions: { preserveWhitespace: 'full' },
    editorProps: { attributes: { role: 'textbox', 'aria-label': '剪贴板内容', 'aria-multiline': 'true', class: 'rich-editor' }, transformPastedHTML: sanitize },
    onUpdate: () => onUpdate?.(), onSelectionUpdate: () => onSelection?.(), onTransaction: () => onSelection?.()
  });
  const commands = { bold: 'toggleBold', italic: 'toggleItalic', underline: 'toggleUnderline', strike: 'toggleStrike', undo: 'undo', redo: 'redo' };
  return {
    focus: () => editor.view.focus(), destroy: () => editor.destroy(),
    content: () => ({ body: editor.getText({ blockSeparator: '\n' }), html: editor.getHTML() }),
    active: name => editor.isActive(name),
    can: name => !!commands[name] && editor.can()[commands[name]](),
    command: name => { if (commands[name]) { editor.view.focus(); editor.chain()[commands[name]]().run(); } }
  };
}
