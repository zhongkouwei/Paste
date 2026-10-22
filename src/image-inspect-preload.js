const { ipcRenderer, nativeImage } = require('electron');
const { inspectPNG } = require('./image-inspect');

// No API is exposed to the document; only the owning main process sends work.
ipcRenderer.on('image-inspect:request', async (_event, { id, file, options }) => {
  try { ipcRenderer.send('image-inspect:result', { id, result: await inspectPNG(file, options, nativeImage) }); }
  catch (error) { ipcRenderer.send('image-inspect:result', { id, error: error.message }); }
});
