const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ClipStore, textSignature } = require('../src/store');
const { SearchService } = require('../src/search-service');

const count = Number(process.argv[2] || 1000);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Expected item count from 1 to 10000');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-benchmark-'));
const store = new ClipStore(directory), service = new SearchService(), measurements = {};
function measure(name, action, iterations = 1) {
  const samples = []; let result;
  for (let n = 0; n < iterations; n++) { const start = performance.now(); result = action(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  measurements[name] = { medianMs: +samples[Math.floor(samples.length / 2)].toFixed(2), maxMs: +samples.at(-1).toFixed(2), iterations }; return result;
}
async function measureAsync(name, action, iterations = 1) {
  const samples = []; let result;
  for (let n = 0; n < iterations; n++) { const start = performance.now(); result = await action(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  measurements[name] = { medianMs: +samples[Math.floor(samples.length / 2)].toFixed(2), maxMs: +samples.at(-1).toFixed(2), iterations }; return result;
}
(async () => { try {
  const body = 'abc剪贴板Text '.repeat(6000), createdAt = new Date().toISOString();
  store.data.settings.retentionDays = 0;
  store.data.items = Array.from({ length: count }, (_, n) => ({ id: String(n), type: 'text', body: `${body}${n}`, title: `Synthetic ${n}`,
    signature: textSignature(`${body}${n}`), createdAt, boardIds: [], preview: body.slice(0, 16000) }));
  measure('initialContentCommit', () => store.persist());
  const compact = measure('coldSnapshot', () => store.snapshot());
  measure('warmSnapshot', () => store.snapshot(), 5);
  let heartbeat = 0; const timer = setInterval(() => { heartbeat += 1; }, 10);
  try { await measureAsync('workerInitialIndexAndQuery', () => service.search(store.data.items, store.revision, 'not-present')); }
  finally { clearInterval(timer); }
  await measureAsync('workerIndexedQueryRoundtrip', () => service.search(store.data.items, store.revision, 'not-present'), 5);
  await measureAsync('shortChineseQuery', () => service.search(store.data.items, store.revision, '板'), 5);
  measure('renameSingleItem', () => store.update(String(Math.floor(count / 2)), { title: 'Renamed' }), 5);
  await measureAsync('queryAfterRename', () => service.search(store.data.items, store.revision, 'Renamed'));
  console.log(JSON.stringify({ node: process.versions.node, platform: `${process.platform}-${process.arch}`, items: count,
    fullTextBytes: Buffer.byteLength(body) * count, compactIPCBytes: Buffer.byteLength(JSON.stringify(compact)), manifestBytes: fs.statSync(store.file).size,
    heartbeatWhileWorkerIndexes: heartbeat, rssMiB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1), measurements }, null, 2));
} finally { await service.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
