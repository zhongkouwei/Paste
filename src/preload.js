const { contextBridge, ipcRenderer } = require('electron');

function historyId(value) {
  return typeof value === 'string' ? value : '';
}

contextBridge.exposeInMainWorld('pasteLike', {
  getHistory: () => ipcRenderer.invoke('history:get'),
  copy: (id, shouldPaste) => ipcRenderer.invoke('history:copy', historyId(id), shouldPaste === true),
  toggleFavorite: (id) => ipcRenderer.invoke('history:toggleFavorite', historyId(id)),
  delete: (id) => ipcRenderer.invoke('history:delete', historyId(id)),
  clear: () => ipcRenderer.invoke('history:clear'),
  hide: () => ipcRenderer.invoke('window:hide'),
  onHistoryChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};

    const listener = (_event, history) => callback(history);
    ipcRenderer.on('history:changed', listener);
    return () => ipcRenderer.removeListener('history:changed', listener);
  }
});
