const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('selectionComposer', {
  onRequest: callback => ipcRenderer.on('selection:request', (_event, data) => callback(data)),
  complete: (id, result, error) => ipcRenderer.send('selection:result', { id, result, error })
});
