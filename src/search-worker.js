const { parentPort } = require('node:worker_threads');
const { SearchIndex } = require('./search');
const index = new SearchIndex(), items = new Map();
parentPort.on('message', ({ id, updates, deleted, revision, query }) => {
  try {
    for (const item of updates) items.set(item.id, item);
    for (const key of deleted) items.delete(key);
    index.sync([...items.values()], revision);
    parentPort.postMessage({ id, result: { revision, ids: index.find(query) } });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
