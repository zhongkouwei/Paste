const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel, callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('paste', {
  getLibrary: () => invoke('library:get'), getItem: id => invoke('item:get', id),
  copy: (id, options) => invoke('item:copy', id, options),
  updateItem: (id, changes) => invoke('item:update', id, changes), deleteItems: ids => invoke('item:delete', ids),
  clearHistory: () => invoke('history:clear'), saveBoard: board => invoke('board:save', board), deleteBoard: id => invoke('board:delete', id),
  saveSettings: changes => invoke('settings:save', changes), openSettings: () => invoke('settings:open'),
  getPermission: () => invoke('permission:get'), openPermission: () => invoke('permission:open'), hide: () => invoke('panel:hide'),
  toggleStack: () => invoke('stack:toggle'), addToStack: id => invoke('stack:add', id), nextInStack: () => invoke('stack:next'),
  exportLibrary: () => invoke('library:export'),
  onChanged: callback => listen('library:changed', callback), onShown: callback => listen('panel:shown', callback)
});
