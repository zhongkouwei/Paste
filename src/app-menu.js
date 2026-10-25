const { shortcutMatches, PAUSE_OPTIONS } = require('./model');

function applicationMenuTemplate(openSettings, platform = process.platform, newText = () => {}, capture = {}, openItem = () => {}) {
  return [
    ...(platform === 'darwin' ? [{ label: 'Paste Easy', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: '设置…', accelerator: 'CommandOrControl+,', click: openSettings },
      { id: 'capture-toggle', label: '暂停记录', accelerator: 'CommandOrControl+T', click: capture.toggle || (() => {}) },
      { label: '暂停时长', submenu: PAUSE_OPTIONS.map(([duration, label]) => ({ label, click: () => capture.pauseFor?.(duration) })) },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }
    ] }] : []),
    { role: 'fileMenu', submenu: [
      { id: 'new-text', label: '新建文本', accelerator: 'CommandOrControl+N', click: newText },
      { id: 'open-item', label: '打开', accelerator: 'CommandOrControl+O', click: openItem },
      { type: 'separator' }, { role: 'close' }
    ] }, { role: 'editMenu' }, { role: 'windowMenu' }
  ];
}
function previewShortcut(input, platform = process.platform) {
  if (input.type !== 'keyDown' || input.isComposing) return null;
  const event = { key: input.key || '', metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift };
  if (shortcutMatches(event, 'CommandOrControl+E', platform)) return 'edit';
  if (shortcutMatches(event, 'CommandOrControl+R', platform)) return 'rename';
  if (shortcutMatches(event, 'CommandOrControl+O', platform)) return 'open';
  return null;
}
function newTextShortcut(input, platform = process.platform) {
  return input.type === 'keyDown' && !input.isComposing && shortcutMatches({ key: input.key || '', metaKey: input.meta,
    ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }, 'CommandOrControl+N', platform);
}
function pauseShortcut(input, platform = process.platform) {
  return input.type === 'keyDown' && !input.isComposing && shortcutMatches({ key: input.key || '', metaKey: input.meta,
    ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }, 'CommandOrControl+T', platform);
}
module.exports = { applicationMenuTemplate, previewShortcut, newTextShortcut, pauseShortcut };
