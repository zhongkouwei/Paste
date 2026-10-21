const { parentPort, workerData } = require('node:worker_threads');
const { exportFile } = require('./export-file');
const controller = new AbortController();
parentPort.on('message', message => { if (message.type === 'cancel') controller.abort(); });
exportFile({ ...workerData, signal: controller.signal, onTemporary: () => parentPort.postMessage({ temporaryOwned: true }), onProgress: itemsDone => parentPort.postMessage({ itemsDone }) })
  .then(result => parentPort.postMessage({ result }))
  .catch(error => parentPort.postMessage({ error: error.name === 'AbortError' ? '备份导出已取消，原有导出未替换。' : error.message, name: error.name }))
  .finally(() => parentPort.close());
