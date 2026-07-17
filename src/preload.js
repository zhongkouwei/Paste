const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pasteLike', {
  getHistory: () => ipcRenderer.invoke('history:get'),
  copy: (id, shouldPaste) => ipcRenderer.invoke('history:copy', id, shouldPaste),
  toggleFavorite: (id) => ipcRenderer.invoke('history:toggleFavorite', id),
  delete: (id) => ipcRenderer.invoke('history:delete', id),
  clear: () => ipcRenderer.invoke('history:clear'),
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('window:quit'),
  onWindowShown: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window:shown', listener);
    return () => ipcRenderer.removeListener('window:shown', listener);
  },
  onHistoryChanged: (callback) => {
    const listener = (_event, history) => callback(history);
    ipcRenderer.on('history:changed', listener);
    return () => ipcRenderer.removeListener('history:changed', listener);
  }
});
