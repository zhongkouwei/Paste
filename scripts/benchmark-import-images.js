const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('@playwright/test');
const executablePath = path.resolve(__dirname, '../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy');
async function launch(directory) {
  const app = await electron.launch({ executablePath, colorScheme: null, args: ['--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  try { const page = await app.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true'); return app; }
  catch (error) { await app.close(); throw error; }
}
async function checks(app) {
  return app.evaluate(() => {
    const { store, hash } = globalThis.__pasteTest;
    return store.data.items.map(item => ({ id: item.id, current: hash(store.readAsset(item.asset)), original: hash(store.readAsset(item.originalAsset)),
      foreground: hash(store.readAsset(item.foregroundAsset)), turns: item.imageTurns, background: item.backgroundRemoved }));
  });
}
async function run() {
  const edge = Number(process.argv[2] || 2048);
  if (!Number.isInteger(edge) || edge < 64 || edge > 4096 || edge % 4) throw new Error('Expected width divisible by 4, from 64 to 4096');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-image-import-benchmark-')), file = path.join(directory, 'backup.json');
  fs.chmodSync(directory, 0o700); let app;
  try {
    app = await launch(path.join(directory, 'seed'));
    await app.evaluate(async ({ nativeImage }, { edge, file }) => {
      const { store, hash, imageProcessor, thumbnail } = globalThis.__pasteTest, width = edge, height = edge * 3 / 4;
      const pixels = Buffer.alloc(width * height * 4), masked = Buffer.alloc(pixels.length);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        pixels[i] = (53 * x + 29 * y) % 256; pixels[i + 1] = (17 * x + 37 * y) % 256; pixels[i + 2] = (7 * x + 11 * y) % 256; pixels[i + 3] = 255;
        masked[i] = pixels[i]; masked[i + 1] = pixels[i + 1]; masked[i + 2] = pixels[i + 2]; masked[i + 3] = x % 127 < 30 ? 0 : 128 + y % 128;
      }
      const original = nativeImage.createFromBitmap(pixels, { width, height }).toPNG(), foreground = nativeImage.createFromBitmap(masked, { width, height }).toPNG();
      store.settings({ retentionDays: 0, paused: true });
      for (const background of [false, true]) for (let turns = 0; turns < 4; turns++) {
        const base = background ? foreground : original, buffer = turns ? (await imageProcessor.rotate(base, turns)).buffer : base;
        const image = nativeImage.createFromBuffer(buffer), size = image.getSize(), signature = hash(Buffer.concat([Buffer.from(`image:${size.width}x${size.height}:`), image.toBitmap()]));
        const asset = store.putAsset(buffer), item = store.add({ type: 'image', body: asset, asset, signature, signatureFormat: 'pixels-v1', title: `Synthetic ${Number(background)}:${turns}` });
        store.replaceImage(item.id, { buffer, original, foreground, turns, size, signature, preview: thumbnail(image), backgroundRemoved: background });
        store.setOCR(item.id, signature, { status: 'none', text: '', lines: [], engine: 'synthetic-no-text' });
      }
      await store.exportTo(file);
    }, { edge, file });
    const expected = await checks(app); assert.equal(expected.length, 8); await app.close(); app = null;
    const library = path.join(directory, 'restore'); app = await launch(library);
    const result = await app.evaluate(async (_electron, file) => {
      const { importService } = globalThis.__pasteTest;
      const memory = () => { const m = process.memoryUsage(); return { rssMiB: +(m.rss / 1048576).toFixed(1), heapUsedMiB: +(m.heapUsed / 1048576).toFixed(1), peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1) }; };
      const before = memory(); let ticks = 0, maxGap = 0, last = performance.now();
      const timer = setInterval(() => { const now = performance.now(); ticks++; maxGap = Math.max(maxGap, now - last); last = now; }, 2);
      const gap = () => { maxGap = Math.max(maxGap, performance.now() - last); return +maxGap.toFixed(2); };
      try {
        let start = performance.now(); const state = await importService.prepare(file), prepareMs = +(performance.now() - start).toFixed(2), prepared = memory();
        const prepareTicks = ticks, prepareMaxGapMs = gap(); ticks = 0; maxGap = 0; last = performance.now();
        start = performance.now(); const restored = await importService.apply(state.token, { mode: 'replace', restoreSettings: true }), applyMs = +(performance.now() - start).toFixed(2);
        return { prepareMs, applyMs, prepareTicks, applyTicks: ticks, prepareMaxGapMs, applyMaxGapMs: gap(), before, prepared, applied: memory(), warning: restored.warning };
      } finally { clearInterval(timer); }
    }, file);
    assert.deepEqual(await checks(app), expected); await app.close(); app = null;
    app = await launch(library); assert.deepEqual(await checks(app), expected); await app.close(); app = null;
    console.log(JSON.stringify({ nodeDriver: process.versions.node, platform: `${process.platform}-${process.arch}`, width: edge, height: edge * 3 / 4,
      items: 8, sourceBytes: fs.statSync(file).size, note: 'Actual packaged app; separate seed/import/restart processes. Main RSS includes Workers but not renderer/GPU/native helper peaks. Two-ms main heartbeat and longest gaps; single synthetic run, no GC/cache flush. OCR cached as none to isolate restore; no system clipboard access. Checksums of all three PNG variants and state verified after import and restart.', result }, null, 2));
  } finally { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
