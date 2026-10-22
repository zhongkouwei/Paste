const { shortcutMatches } = require('./model');

function applicationMenuTemplate(openSettings, platform = process.platform, newText = () => {}) {
  return [
    ...(platform === 'darwin' ? [{ label: 'Paste Easy', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: '设置…', accelerator: 'CommandOrControl+,', click: openSettings },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }
    ] }] : []),
    { role: 'fileMenu', submenu: [
      { id: 'new-text', label: '新建文本', accelerator: 'CommandOrControl+N', click: newText },
      { type: 'separator' }, { role: 'close' }
    ] }, { role: 'editMenu' }, { role: 'windowMenu' }
  ];
}
function previewShortcut(input, platform = process.platform) {
  if (input.type !== 'keyDown' || input.isComposing) return null;
  const event = { key: input.key || '', metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift };
  if (shortcutMatches(event, 'CommandOrControl+E', platform)) return 'edit';
  if (shortcutMatches(event, 'CommandOrControl+R', platform)) return 'rename';
  return null;
}
function newTextShortcut(input, platform = process.platform) {
  return input.type === 'keyDown' && !input.isComposing && shortcutMatches({ key: input.key || '', metaKey: input.meta,
    ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }, 'CommandOrControl+N', platform);
}
module.exports = { applicationMenuTemplate, previewShortcut, newTextShortcut };
