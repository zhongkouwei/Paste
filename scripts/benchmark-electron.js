const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { _electron: electron } = require('@playwright/test');
const { ClipStore, textSignature } = require('../src/store');

const count = Number(process.argv[2] || 1000);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Expected item count from 1 to 10000');
async function metrics(application) {
  return application.evaluate(({ app }) => {
    const memory = process.memoryUsage();
    return { mainRssMiB: +(memory.rss / 1048576).toFixed(1), mainHeapUsedMiB: +(memory.heapUsed / 1048576).toFixed(1),
      mainPeakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
      processes: app.getAppMetrics().map(value => ({ pid: value.pid, type: value.type,
        workingSetMiB: +(value.memory.workingSetSize / 1024).toFixed(1), peakWorkingSetMiB: +(value.memory.peakWorkingSetSize / 1024).toFixed(1) })) };
  });
}
async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-electron-benchmark-')); let application;
  try {
    const store = new ClipStore(directory), body = 'abc剪贴板Text '.repeat(6000), createdAt = new Date().toISOString(); let fullTextBytes = 0;
    try {
      store.data.settings.retentionDays = 0;
      store.data.items = Array.from({ length: count }, (_, n) => {
        const text = `${body} unique-tail-${n}-end`; fullTextBytes += Buffer.byteLength(text);
        return { id: String(n), type: 'text', body: text, title: `Synthetic ${n}`, preview: text.slice(0, 2000), signature: textSignature(text), createdAt, boardIds: [] };
      }); store.persist();
    } finally { store.close(); }
    const observations = [];
    for (let run = 0; run < 2; run++) {
      const start = performance.now();
      application = await electron.launch({ colorScheme: null,
        executablePath: path.resolve(__dirname, '../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy'),
        args: ['--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
      const page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
      const panelReadyMs = +(performance.now() - start).toFixed(2), beforeSearch = await metrics(application), queryStart = performance.now();
      const result = await page.evaluate(query => window.paste.search(query), `unique-tail-${count - 1}-end`);
      const firstSearchMs = +(performance.now() - queryStart).toFixed(2); assert.deepEqual(result.ids, [String(count - 1)]);
      const afterSearch = await metrics(application);
      const worker = await application.evaluate(() => globalThis.__pasteTest.searchService.diagnostics());
      observations.push({ panelReadyMs, firstSearchMs, beforeSearch, afterSearch, worker });
      await application.close(); application = null;
    }
    console.log(JSON.stringify({ items: count, fullTextBytes, mode: 'Packaged Electron, isolated synthetic profile, no system clipboard operations',
      note: 'Fresh app launches, no forced GC or OS filesystem-cache flush; process working sets include shared pages and must not be summed as unique RAM.', observations }, null, 2));
  } finally { if (application) await application.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
