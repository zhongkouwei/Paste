const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { ClipStore } = require('../src/store');
const { ImportService } = require('../src/import-service');
const prefix = 'abc剪贴板Text '.repeat(6000);
const body = n => `${prefix} unique-tail-${n}-end`;
function memory() { const value = process.memoryUsage(); return { rssMiB: +(value.rss / 1048576).toFixed(1), heapUsedMiB: +(value.heapUsed / 1048576).toFixed(1), peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1) }; }
async function probe(directory, count) {
  const store = new ClipStore(path.join(directory, 'library')), service = new ImportService(store), file = path.join(directory, 'backup.json');
  store.add({ type: 'text', body: 'Pre-import original' }); const original = fs.readFileSync(store.file), before = memory();
  let ticks = 0; const timer = setInterval(() => ticks++, 2);
  try {
    let start = performance.now(); const state = await service.prepare(file), prepareMs = +(performance.now() - start).toFixed(2), prepared = memory(), prepareTicks = ticks;
    assert.deepEqual(fs.readFileSync(store.file), original); assert.equal(state.summary.items, count);
    start = performance.now(); const result = await service.apply(state.token, { mode: 'replace' }), applyMs = +(performance.now() - start).toFixed(2), applied = memory(), applyTicks = ticks - prepareTicks;
    clearInterval(timer);
    assert.equal(JSON.parse(fs.readFileSync(result.checkpoint)).items[0].body, 'Pre-import original');
    assert.equal(store.data.items.length, count);
    for (let n = 0; n < count; n++) assert.equal(store.get(String(n)).body, body(n));
    const reopened = new ClipStore(store.directory);
    try { for (let n = 0; n < count; n++) assert.equal(reopened.get(String(n)).body, body(n)); } finally { await reopened.close(); }
    return { prepareMs, applyMs, prepareHeartbeatTicks: prepareTicks, applyHeartbeatTicks: applyTicks, before, prepared, applied,
      validationPeakRssMiB: memory().peakRssMiB, sourceBytes: fs.statSync(file).size };
  } finally { clearInterval(timer); await service.close(); await store.close(); }
}
async function run() {
  if (process.argv[2] === '--probe') { process.send(await probe(process.argv[3], Number(process.argv[4]))); return; }
  const count = Number(process.argv[2] || 1000); if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Expected 1–10000 synthetic items');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-import-benchmark-')); fs.chmodSync(directory, 0o700);
  try {
    const file = path.join(directory, 'backup.json'), fd = fs.openSync(file, 'wx', 0o600); let fullTextBytes = 0;
    try {
      fs.writeSync(fd, '{"version":2,"boards":[],"settings":{},"items":[');
      for (let n = 0; n < count; n++) {
        const text = body(n); fullTextBytes += Buffer.byteLength(text);
        fs.writeSync(fd, `${n ? ',' : ''}${JSON.stringify({ id: String(n), type: 'text', body: text, title: `Synthetic ${n}`, boardIds: [], createdAt: new Date().toISOString() })}`);
      }
      fs.writeSync(fd, ']}'); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const result = await new Promise((resolve, reject) => {
      const child = fork(__filename, ['--probe', directory, String(count)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let report, error = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
      child.stdout.resume(); child.stderr.on('data', value => { error += value; }); child.on('message', value => { report = value; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 && report ? resolve(report) : reject(new Error(error || `Probe exited ${code}`)); });
    });
    console.log(JSON.stringify({ node: process.versions.node, platform: `${process.platform}-${process.arch}`, items: count, fullTextBytes,
      note: 'Fresh child; no full-backup JSON.parse. Per-item originals checked after stage samples and again after restart; validation peak separate. Worker RSS included, not additive; no GC/cache flush. Text-only, not full Electron or large-image qualification.', result }, null, 2));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
