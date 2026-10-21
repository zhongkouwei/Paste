const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { ClipStore, textSignature } = require('../src/store');
const { SearchService } = require('../src/search-service');

function memory() {
  const value = process.memoryUsage();
  return { rssMiB: +(value.rss / 1048576).toFixed(1), mainHeapUsedMiB: +(value.heapUsed / 1048576).toFixed(1),
    externalMiB: +(value.external / 1048576).toFixed(1), peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1) };
}
async function probe(directory, count) {
  const phases = { beforeOpen: memory() }; let start = performance.now();
  const store = new ClipStore(directory), openMs = performance.now() - start, service = new SearchService({ directory });
  try {
    phases.afterOpen = memory(); start = performance.now(); const snapshot = store.snapshot(); const snapshotMs = performance.now() - start;
    phases.afterSnapshot = memory(); start = performance.now();
    const result = await service.search(store.data.items, store.revision, `unique-tail-${count - 1}-end`), firstSearchMs = performance.now() - start;
    if (result.ids.join(',') !== String(count - 1)) throw new Error('Full-tail restart search mismatch');
    phases.afterSearch = memory();
    const worker = service.diagnostics ? await service.diagnostics() : null;
    return { openMs: +openMs.toFixed(2), snapshotMs: +snapshotMs.toFixed(2), firstSearchMs: +firstSearchMs.toFixed(2),
      snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)), phases, worker };
  } finally { await service.close(); store.close(); }
}
function child(directory, count) {
  return new Promise((resolve, reject) => {
    const process = fork(__filename, ['--probe', directory, String(count)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let report, error = ''; const timer = setTimeout(() => process.kill('SIGTERM'), 120000);
    process.stdout.resume(); process.stderr.on('data', chunk => { error += chunk; }); process.on('message', value => { report = value; });
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('exit', code => { clearTimeout(timer); code === 0 && report ? resolve(report) : reject(new Error(error || `Probe exited ${code}`)); });
  });
}
async function run() {
  if (process.argv[2] === '--probe') { process.send(await probe(process.argv[3], Number(process.argv[4]))); return; }
  const count = Number(process.argv[2] || 1000);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Expected item count from 1 to 10000');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-restart-benchmark-'));
  try {
    const store = new ClipStore(directory), body = 'abc剪贴板Text '.repeat(6000), createdAt = new Date().toISOString();
    let seedMs, fullTextBytes = 0;
    try {
      store.data.settings.retentionDays = 0;
      store.data.items = Array.from({ length: count }, (_, n) => {
        const text = `${body} unique-tail-${n}-end`;
        fullTextBytes += Buffer.byteLength(text);
        return { id: String(n), type: 'text', body: text, title: `Synthetic ${n}`, signature: textSignature(text), createdAt, boardIds: [], preview: text.slice(0, 2000) };
      });
      const start = performance.now(); store.persist(); seedMs = performance.now() - start;
    } finally { store.close(); }
    const first = await child(directory, count), second = await child(directory, count);
    console.log(JSON.stringify({ node: process.versions.node, sqlite: process.versions.sqlite, platform: `${process.platform}-${process.arch}`,
      items: count, fullTextBytes, seedMs: +seedMs.toFixed(2),
      note: 'Fresh OS processes; filesystem caches are not flushed; worker-thread RSS is process-wide, not additive; no forced GC.', first, second }, null, 2));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
