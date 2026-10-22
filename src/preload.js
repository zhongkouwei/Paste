const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  try { return await ipcRenderer.invoke(channel, ...args); }
  catch (error) {
    const prefix = `Error invoking remote method '${channel}': `;
    if (typeof error?.message === 'string' && error.message.startsWith(prefix)) {
      const message = error.message.slice(prefix.length);
      error.message = message.startsWith('Error: ') ? message.slice(7) : message;
    }
    throw error;
  }
};
const listen = (channel, callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('paste', {
  getLibrary: () => invoke('library:get'), getItem: id => invoke('item:get', id),
  getPanelSize: () => invoke('panel:size'), beginPanelResize: y => invoke('panel:resizeStart', y),
  movePanelResize: (id, y) => invoke('panel:resizeMove', id, y), endPanelResize: (id, y, cancel = false) => invoke('panel:resizeEnd', id, y, cancel),
  onPanelSize: callback => listen('panel:size', callback),
  search: query => invoke('library:search', query), dragText: ids => ipcRenderer.sendSync('item:dragText', ids),
  getMedia: requests => invoke('item:media', requests),
  getDetail: id => invoke('item:detail', id),
  copy: (id, options) => invoke('item:copy', id, options),
  copySelection: (ids, options) => invoke('item:copySelection', ids, options),
  openItems: (ids, options) => invoke('item:open', ids, options), onOpenCommand: callback => listen('item:openCommand', callback),
  newText: boardId => invoke('item:new', boardId), requestNewText: () => invoke('item:requestNew'),
  recognizeItem: (id, retry = false) => invoke('item:recognize', id, retry), copyImageText: id => invoke('item:copyText', id),
  getOCR: id => invoke('item:ocr', id),
  updateItem: (id, changes) => invoke('item:update', id, changes), deleteItems: ids => invoke('item:delete', ids),
  renameItem: (id, title, expected) => invoke('item:rename', id, title, expected),
  clearHistory: () => invoke('history:clear'), saveBoard: board => invoke('board:save', board), deleteBoard: id => invoke('board:delete', id),
  reorderBoards: ids => invoke('board:reorder', ids), reorderBoardItems: (boardId, ids) => invoke('board:reorderItems', boardId, ids),
  pinItems: (ids, boardId, remove = false) => invoke('board:pin', ids, boardId, remove),
  openPreview: (id, options) => invoke('preview:open', id, options), getPreview: () => invoke('preview:get'),
  getRichText: (id, signature) => invoke('preview:richText', id, signature),
  closePreview: () => invoke('preview:close'), markPreviewDirty: value => invoke('preview:dirty', value),
  pinDraft: (boardId, remove) => invoke('preview:pinDraft', boardId, remove),
  savePreview: changes => invoke('preview:save', changes), navigatePreview: delta => invoke('preview:navigate', delta),
  editImage: action => invoke('preview:image', action),
  startDrag: ids => invoke('item:drag', ids), shareItem: id => invoke('item:share', id), revealItem: (id, index = 0) => invoke('item:reveal', id, index),
  saveSettings: changes => invoke('settings:save', changes), openSettings: () => invoke('settings:open'),
  beginShortcut: key => invoke('settings:shortcutBegin', key), cancelShortcut: id => invoke('settings:shortcutCancel', id),
  finishShortcut: (id, accelerator) => invoke('settings:shortcutFinish', id, accelerator), onShortcutRecording: callback => listen('shortcut:recording', callback),
  toggleCapture: () => invoke('capture:toggle'), pauseCapture: duration => invoke('capture:pause', duration), resumeCapture: () => invoke('capture:resume'),
  getExcludedApplications: ids => invoke('settings:excludedApplications', ids), chooseExcludedApplications: () => invoke('settings:chooseExcludedApplications'),
  changeExcludedApplication: (id, remove = false) => invoke('settings:changeExcludedApplication', id, remove),
  getPermission: () => invoke('permission:get'), openPermission: () => invoke('permission:open'), hide: () => invoke('panel:hide'),
  toggleStack: () => invoke('stack:toggle'), addToStack: id => invoke('stack:add', id), nextInStack: () => invoke('stack:next'),
  addSelectionToStack: ids => invoke('stack:addSelection', ids),
  getStack: () => invoke('stack:get'), reverseStack: () => invoke('stack:reverse'), removeFromStack: id => invoke('stack:remove', id),
  stopStack: () => invoke('stack:stop'), retryStack: () => invoke('stack:retry'), onStackChanged: callback => listen('stack:changed', callback),
  exportLibrary: () => invoke('library:export'),
  getExportState: () => invoke('library:exportState'), cancelExport: () => invoke('library:cancelExport'),
  onExportChanged: callback => listen('export:changed', callback),
  prepareImport: () => invoke('library:prepareImport'), applyImport: (token, options) => invoke('library:applyImport', token, options),
  getImportState: () => invoke('library:importState'), cancelImport: () => invoke('library:cancelImport'), revealImportBackup: () => invoke('library:revealImportBackup'),
  onImportChanged: callback => listen('import:changed', callback),
  onChanged: callback => listen('library:changed', callback), onShown: callback => listen('panel:shown', callback),
  onNewText: callback => listen('item:new', callback), onItemCreated: callback => listen('item:created', callback),
  onPreviewChanged: callback => listen('preview:changed', callback),
  onPreviewCommand: callback => listen('preview:command', callback)
});
