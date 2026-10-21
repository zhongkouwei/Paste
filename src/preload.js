const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel, callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('paste', {
  getLibrary: () => invoke('library:get'), getItem: id => invoke('item:get', id),
  getDetail: id => invoke('item:detail', id),
  copy: (id, options) => invoke('item:copy', id, options),
  updateItem: (id, changes) => invoke('item:update', id, changes), deleteItems: ids => invoke('item:delete', ids),
  clearHistory: () => invoke('history:clear'), saveBoard: board => invoke('board:save', board), deleteBoard: id => invoke('board:delete', id),
  reorderBoards: ids => invoke('board:reorder', ids), reorderBoardItems: (boardId, ids) => invoke('board:reorderItems', boardId, ids),
  pinItems: (ids, boardId, remove = false) => invoke('board:pin', ids, boardId, remove),
  openPreview: (id, options) => invoke('preview:open', id, options), getPreview: () => invoke('preview:get'),
  closePreview: () => invoke('preview:close'), markPreviewDirty: value => invoke('preview:dirty', value),
  savePreview: changes => invoke('preview:save', changes), navigatePreview: delta => invoke('preview:navigate', delta),
  startDrag: ids => invoke('item:drag', ids), shareItem: id => invoke('item:share', id), revealItem: (id, index = 0) => invoke('item:reveal', id, index),
  saveSettings: changes => invoke('settings:save', changes), openSettings: () => invoke('settings:open'),
  getPermission: () => invoke('permission:get'), openPermission: () => invoke('permission:open'), hide: () => invoke('panel:hide'),
  toggleStack: () => invoke('stack:toggle'), addToStack: id => invoke('stack:add', id), nextInStack: () => invoke('stack:next'),
  exportLibrary: () => invoke('library:export'),
  onChanged: callback => listen('library:changed', callback), onShown: callback => listen('panel:shown', callback),
  onPreviewChanged: callback => listen('preview:changed', callback)
});
