const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let application, page, directory;
test.describe.configure({ mode: 'serial' });
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
}
// These fixtures use the store and nativeImage only, never the system clipboard.
test.beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-media-ui-')); await launch();
});
test.afterAll(async () => { if (application) await application.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

test('media-heavy catalogs transfer only references and load the visible range with shared bounded thumbnails', async () => {
  const measurements = await application.evaluate(({ nativeImage }, fixture) => {
    const hooks = globalThis.__pasteTest, { thumbnail } = hooks;
    const sourceImage = nativeImage.createFromPath(fixture), preview = sourceImage.resize({ width: 480 }), size = preview.getSize();
    const source = { name: 'Synthetic Image App', bundleId: 'test.media.source', color: '#4f80ed', icon: thumbnail(sourceImage, 64) };
    const base = preview.toBitmap();
    hooks.store.mutate(() => {
      hooks.store.data.items = Array.from({ length: 70 }, (_, index) => {
        const pixels = Buffer.from(base); pixels[0] = index; pixels[1] = index * 3; pixels[2] = index * 2; pixels[3] = 255;
        const image = nativeImage.createFromBitmap(pixels, size), body = image.toDataURL();
        return { id: `media-${index}`, type: 'image', body, preview: body, title: `Media sample ${index}`, source,
          signature: hooks.hash(pixels), signatureFormat: 'pixels-v1', createdAt: new Date().toISOString(), boardIds: [], size };
      });
    });
    const compact = hooks.store.snapshot(), legacy = { ...compact, items: compact.items.map(item => {
      const { previewKey: _key, ...metadata } = item; return { ...metadata, preview: hooks.store.get(item.id).preview, source };
    }) };
    const read = hooks.mediaService.read; globalThis.__mediaReads = [];
    hooks.mediaService.read = function(requests) { globalThis.__mediaReads.push(structuredClone(requests)); return read.call(this, requests); };
    hooks.imageText.onChanged();
    return { compactBytes: Buffer.byteLength(JSON.stringify(compact)), legacyBytes: Buffer.byteLength(JSON.stringify(legacy)) };
  }, path.resolve(__dirname, '../fixtures/foreground-mug.png'));
  expect(measurements.compactBytes).toBeLessThan(measurements.legacyBytes / 50);
  await expect(page.locator('[data-id="media-0"] .image-preview img')).toBeVisible();
  await expect(page.locator('[data-id="media-0"] .source-icon')).toBeVisible();
  expect(await page.evaluate(() => [...document.images].every(image => image.complete && image.naturalWidth > 0 && image.naturalWidth <= 480 && image.naturalHeight <= 480))).toBe(true);
  const initial = await application.evaluate(() => globalThis.__mediaReads);
  expect(new Set(initial.flat().map(request => request.id)).size).toBeLessThan(25);
  expect(initial.flat().some(request => request.id === 'media-69')).toBe(false);
  expect(initial.flat().filter(request => request.iconKey).length).toBe(1);
  await page.evaluate(async () => { const { settings } = await window.paste.getLibrary(); await window.paste.saveSettings({ theme: settings.theme }); });
  expect((await application.evaluate(() => globalThis.__mediaReads)).length).toBe(initial.length);
  const catalog = await page.evaluate(() => window.paste.getLibrary());
  expect(JSON.stringify(catalog).includes('base64,')).toBe(false); expect(catalog.items).toHaveLength(70);
  await page.locator('#timeline').evaluate(node => { node.scrollLeft = node.scrollWidth; });
  await expect(page.locator('[data-id="media-69"] .image-preview img')).toBeVisible();
  await expect.poll(() => application.evaluate(() => globalThis.__mediaReads.flat().some(request => request.id === 'media-69'))).toBe(true);
  const cache = await application.evaluate(() => ({ entries: globalThis.__pasteTest.mediaService.cache.size, bytes: globalThis.__pasteTest.mediaService.bytes }));
  expect(cache.entries).toBeLessThanOrEqual(96); expect(cache.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  await page.screenshot({ path: 'test-results/media-visible-range.png' });
  console.log('Media catalog bytes:', JSON.stringify(measurements));
});

test('delayed old media replies cannot replace newer image pixels, including portrait and shared icon changes', async () => {
  const samples = await page.evaluate(() => ['#d23b48', '#238b66'].map(color => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 3200;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 80, 3200); return canvas.toDataURL();
  }));
  await page.locator('#timeline').evaluate(node => { node.scrollLeft = 0; });
  const before = await application.evaluate((_electron, sample) => {
    const hooks = globalThis.__pasteTest, service = hooks.mediaService;
    hooks.store.mutate(() => { Object.assign(hooks.store.edit('media-0'), { preview: sample, body: sample, size: { width: 80, height: 3200 } }); });
    const key = hooks.store.media.get(hooks.store.get('media-0')).previewKey, read = service.read;
    globalThis.__mediaBeforeRace = read;
    service.read = function(requests) {
      const result = read.call(this, requests);
      if (requests.some(request => request.previewKey === key) && !globalThis.__releaseOldMedia) return new Promise(resolve => { globalThis.__releaseOldMedia = () => resolve(result); });
      return result;
    };
    hooks.imageText.onChanged(); return key;
  }, samples[0]);
  try {
    await expect.poll(() => application.evaluate(() => !!globalThis.__releaseOldMedia)).toBe(true);
    const expected = await application.evaluate(({ nativeImage }, sample) => {
      const hooks = globalThis.__pasteTest, { thumbnail } = hooks;
      const icon = nativeImage.createFromDataURL(sample).resize({ width: 64, height: 64 }).toDataURL();
      hooks.store.mutate(() => { const item = hooks.store.edit('media-0'); Object.assign(item, { preview: sample, body: sample, source: { ...item.source, icon } }); });
      hooks.imageText.onChanged(); return { preview: thumbnail(nativeImage.createFromDataURL(sample)), icon };
    }, samples[1]);
    await expect(page.locator('[data-id="media-0"] .image-preview img')).toHaveAttribute('src', expected.preview);
    await expect(page.locator('[data-id="media-0"] .source-icon')).toHaveAttribute('src', expected.icon);
    expect(await page.locator('[data-id="media-0"] .image-preview img').evaluate(image => [image.naturalWidth, image.naturalHeight])).toEqual([12, 480]);
    await application.evaluate(() => globalThis.__releaseOldMedia());
    await expect.poll(() => page.evaluate(key => mediaCache.has(key), before)).toBe(true);
    await expect(page.locator('[data-id="media-0"] .image-preview img')).toHaveAttribute('src', expected.preview);
    expect((await page.evaluate(() => window.paste.getItem('media-0'))).body).toBe(samples[1]);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setBounds({ width: 390, height: 332 }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/media-portrait-narrow.png' });
  } finally {
    await application.evaluate(() => { globalThis.__releaseOldMedia?.(); globalThis.__pasteTest.mediaService.read = globalThis.__mediaBeforeRace; delete globalThis.__releaseOldMedia; delete globalThis.__mediaBeforeRace; });
  }
});

test('OCR highlights survive a thumbnail reply that arrives after the recognition boxes', async () => {
  await application.evaluate(({ nativeImage }) => {
    const hooks = globalThis.__pasteTest, item = hooks.store.get('media-0');
    hooks.store.mutate(() => { hooks.store.edit(item.id).preview = nativeImage.createFromDataURL(item.body).resize({ width: 16, height: 640 }).toDataURL(); });
    const box = { x: .1, y: .2, width: .7, height: .1 };
    hooks.store.setOCR(item.id, item.signature, { status: 'ready', text: 'MediaOCRneedle', lines: [{ text: 'MediaOCRneedle', box, words: [{ text: 'MediaOCRneedle', box }] }] });
    const key = hooks.store.media.get(hooks.store.get(item.id)).previewKey, read = hooks.mediaService.read;
    globalThis.__beforeOcrMedia = read;
    hooks.mediaService.read = function(requests) {
      const result = read.call(this, requests);
      if (requests.some(request => request.previewKey === key) && !globalThis.__releaseOcrMedia) return new Promise(resolve => { globalThis.__releaseOcrMedia = () => resolve(result); });
      return result;
    };
    hooks.imageText.onChanged();
  });
  try {
    await expect.poll(() => application.evaluate(() => !!globalThis.__releaseOcrMedia)).toBe(true);
    await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('MediaOCRneedle');
    await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.ocr-match')).toHaveCount(1);
    await expect(page.locator('.image-preview img')).toHaveCount(0);
    await application.evaluate(() => globalThis.__releaseOcrMedia());
    await expect(page.locator('.image-preview img')).toBeVisible(); await expect(page.locator('.ocr-match')).toHaveCount(1);
  } finally {
    await application.evaluate(() => { globalThis.__releaseOcrMedia?.(); globalThis.__pasteTest.mediaService.read = globalThis.__beforeOcrMedia; delete globalThis.__releaseOcrMedia; delete globalThis.__beforeOcrMedia; });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  }
});
test('corrupt thumbnail data retains the original, shows an unavailable state and can still open the full image', async () => {
  const before = await page.evaluate(() => window.paste.getItem('media-0'));
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest; hooks.store.mutate(() => { hooks.store.edit('media-0').preview = 'data:image/png;base64,YmFk'; }); hooks.imageText.onChanged();
  });
  await expect(page.locator('[data-id="media-0"]').getByRole('img', { name: '图片预览不可用', exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.paste.getItem('media-0'))).body).toBe(before.body);
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.openPreview('media-0')); const preview = await opened;
  await expect(preview.locator('#previewContent img')).toBeVisible();
  expect(await preview.locator('#previewContent img').evaluate(image => [image.naturalWidth, image.naturalHeight])).toEqual([80, 3200]);
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '关闭预览' }).click(); await closed;
  await application.close(); application = null;
  const disk = JSON.parse(fs.readFileSync(path.join(directory, 'library.json')));
  expect(disk.items).toHaveLength(70);
  await launch();
  expect((await page.evaluate(() => window.paste.getItem('media-0'))).body).toBe(before.body);
  await expect(page.locator('[data-id="media-0"]').getByRole('img', { name: '图片预览不可用', exact: true })).toBeVisible();
});

test('visible decoded images remain stable when their combined data exceeds the media cache byte budget', async () => {
  const size = await application.evaluate(({ BrowserWindow, nativeImage }) => {
    const hooks = globalThis.__pasteTest, pixels = Buffer.alloc(480 * 480 * 4); let seed = 48271;
    for (let index = 0; index < pixels.length; index += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels[index] = seed & 255; pixels[index + 1] = (seed >>> 8) & 255; pixels[index + 2] = (seed >>> 16) & 255; pixels[index + 3] = 255;
    }
    const rows = Array.from({ length: 24 }, (_, index) => {
      pixels[0] = index; const preview = nativeImage.createFromBitmap(pixels, { width: 480, height: 480 }).toDataURL();
      return { id: `noise-${index}`, type: 'image', body: preview, preview, title: `Noise ${index}`, signature: hooks.hash(preview),
        createdAt: new Date().toISOString(), boardIds: [], size: { width: 480, height: 480 } };
    });
    const read = hooks.mediaService.read; globalThis.__noisyMediaReads = 0;
    hooks.mediaService.read = function(requests) { globalThis.__noisyMediaReads += 1; return read.call(this, requests); };
    hooks.store.mutate(() => { hooks.store.data.items = rows; });
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setBounds({ width: 3840, height: 332 });
    hooks.imageText.onChanged(); return rows.reduce((bytes, row) => bytes + row.preview.length, 0);
  });
  expect(size).toBeGreaterThan(16 * 1024 * 1024);
  await expect.poll(() => page.locator('.image-preview img').count()).toBeGreaterThan(20);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.image-preview img')].every(image => image.complete && image.naturalWidth === 480))).toBe(true);
  await expect.poll(() => page.evaluate(() => mediaActive)).toBe(0);
  const state = await page.evaluate(() => ({ entries: mediaCache.size, bytes: mediaBytes }));
  expect(state.bytes).toBeLessThanOrEqual(16 * 1024 * 1024); expect(state.entries).toBeLessThan(23);
  const reads = await application.evaluate(() => globalThis.__noisyMediaReads);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await application.evaluate(() => globalThis.__noisyMediaReads)).toBe(reads);
  await page.evaluate(async () => { const { settings } = await window.paste.getLibrary(); await window.paste.saveSettings({ theme: settings.theme }); });
  await expect.poll(() => page.evaluate(() => mediaActive)).toBe(0);
  await expect.poll(() => page.locator('.image-preview img').count()).toBeGreaterThan(20);
  expect(await application.evaluate(() => globalThis.__noisyMediaReads)).toBeLessThan(reads + 5);
});
