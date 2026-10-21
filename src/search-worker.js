const { parentPort, workerData } = require('node:worker_threads');
const { SearchIndex } = require('./search');
const { ContentFiles, validOCR } = require('./content-files');
const index = new SearchIndex(workerData || {});
const contents = workerData?.directory ? new ContentFiles(workerData.directory) : null;
function resolve(item) {
  if (!item.contentAsset) return item;
  if (!contents) throw new Error('搜索内容目录不可用');
  const value = { ...item, ...contents.read(item.contentAsset) };
  if (value.ocr && (!validOCR(value.ocr) || value.ocr.signature !== value.signature)) delete value.ocr;
  return value;
}
parentPort.on('message', ({ id, kind, updates, deleted, revision, query, complete }) => {
  try {
    if (kind === 'diagnostics') { parentPort.postMessage({ id, result: index.diagnostics() }); return; }
    index.apply(updates, deleted, revision, complete, resolve);
    parentPort.postMessage({ id, result: { revision, ids: index.find(query) } });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
