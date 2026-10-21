const { parentPort, workerData } = require('node:worker_threads');
const { SearchIndex } = require('./search');
const index = new SearchIndex(workerData || {});
parentPort.on('message', ({ id, kind, updates, deleted, revision, query, complete }) => {
  try {
    if (kind === 'diagnostics') { parentPort.postMessage({ id, result: index.diagnostics() }); return; }
    index.apply(updates, deleted, revision, complete);
    parentPort.postMessage({ id, result: { revision, ids: index.find(query) } });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
