const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { ClipStore, textSignature } = require('../src/store');
function memory() { const value = process.memoryUsage(); return { rssMiB: +(value.rss / 1048576).toFixed(1), heapUsedMiB: +(value.heapUsed / 1048576).toFixed(1), peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1) }; }
async function probe(directory, count) {
  const store = new ClipStore(directory), file = path.join(directory, 'export.json'), original = fs.readFileSync(store.file), before = memory();
  let ticks = 0; const timer = setInterval(() => ticks++, 2), start = performance.now();
  try {
    await store.exportTo(file); const exportMs = +(performance.now() - start).toFixed(2), after = memory(); clearInterval(timer);
    const bytes = fs.statSync(file).size, parsed = JSON.parse(fs.readFileSync(file)), prefix = 'abc剪贴板Text '.repeat(6000);
    assert.equal(parsed.version, 2); assert.equal(parsed.items.length, count);
    for (let n = 0; n < count; n++) assert.equal(parsed.items[n].body, `${prefix} unique-tail-${n}-end`);
    assert.deepEqual(fs.readFileSync(store.file), original);
    return { exportMs, heartbeatTicks: ticks, exportedBytes: bytes, before, after, validationPeakRssMiB: memory().peakRssMiB };
  } finally { clearInterval(timer); await store.close(); }
}
async function run() {
  if (process.argv[2] === '--probe') { process.send(await probe(process.argv[3], Number(process.argv[4]))); return; }
  const count = Number(process.argv[2] || 1000); if (!Number.isInteger(count) || count < 1 || count > 2000) throw new Error('Expected item count from 1 to 2000; independent full JSON validation is memory-intensive');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-export-benchmark-'));
  try {
    const store = new ClipStore(directory), body = 'abc剪贴板Text '.repeat(6000), createdAt = new Date().toISOString(); let fullTextBytes = 0;
    try {
      store.data.settings.retentionDays = 0; store.data.items = Array.from({ length: count }, (_, n) => {
        const text = `${body} unique-tail-${n}-end`; fullTextBytes += Buffer.byteLength(text);
        return { id: String(n), type: 'text', body: text, title: `Synthetic ${n}`, preview: text.slice(0, 2000), signature: textSignature(text), createdAt, boardIds: [] };
      }); store.persist();
    } finally { await store.close(); }
    const result = await new Promise((resolve, reject) => {
      const child = fork(__filename, ['--probe', directory, String(count)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let report, error = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
      child.stdout.resume(); child.stderr.on('data', value => { error += value; }); child.on('message', value => { report = value; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 && report ? resolve(report) : reject(new Error(error || `Probe exited ${code}`)); });
    });
    console.log(JSON.stringify({ node: process.versions.node, platform: `${process.platform}-${process.arch}`, items: count, fullTextBytes,
      note: 'Fresh child process; export memory is sampled before independent full JSON validation; validationPeak is separate. No forced GC or filesystem-cache flush. Worker RSS is included, not additive.', result }, null, 2));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
