const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let application, page, directory;
test.describe.configure({ mode: 'serial' });

// Request scheduling fixtures never read or write the system clipboard.
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-media-requests-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
});
test.afterEach(async () => {
  if (application) { await application.evaluate(() => globalThis.__releaseMediaRequest?.()); await application.close(); }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  application = page = directory = null;
});
async function seed(mode) {
  const body = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#27a479'; context.fillRect(0, 0, 96, 64);
    context.fillStyle = '#de5264'; context.fillRect(8, 8, 24, 24); return canvas.toDataURL();
  });
  return application.evaluate((_electron, { body, mode }) => {
    const hooks = globalThis.__pasteTest, service = hooks.mediaService, read = service.read;
    const item = hooks.store.add({ type: 'image', body, preview: body, title: 'Request fixture', size: { width: 96, height: 64 }, source: { name: 'Fixture App', bundleId: 'test.requests', icon: body } });
    globalThis.__mediaRequestTest = { mode, calls: [], fail: true, original: item, read };
    service.read = function(requests) {
      const state = globalThis.__mediaRequestTest; state.calls.push({ requests: structuredClone(requests), time: Date.now() });
      if (mode === 'hold' && state.calls.length === 1) return new Promise((resolve, reject) => {
        state.requests = requests;
        globalThis.__releaseMediaRequest = () => {
          if (state.reject) reject(new Error('temporary media request failure'));
          else resolve(state.emptyResult || read.call(this, requests));
        };
      });
      if (state.fail && (mode === 'always-fail' || mode === 'fail-once' && state.calls.length === 1)) throw new Error('temporary media request failure');
      return read.call(this, requests);
    };
    hooks.imageText.onChanged(); return { id: item.id, body, ...hooks.store.media.get(item) };
  }, { body, mode });
}
async function pausedClock() {
  const time = new Date(); await page.clock.install({ time }); await page.reload();
  await page.waitForFunction(() => state.revision !== undefined);
  await page.clock.pauseAt(new Date(time.getTime() + 3600000));
}

for (const outcome of ['empty', 'error']) test(`a late ${outcome} reply for a deleted owner cannot suppress a new owner with the same image and icon`, async () => {
  const original = await seed('hold');
  await expect.poll(() => application.evaluate(() => !!globalThis.__releaseMediaRequest)).toBe(true);
  const replacement = await application.evaluate((_electron, outcome) => {
    const hooks = globalThis.__pasteTest, test = globalThis.__mediaRequestTest;
    hooks.store.delete([test.original.id]);
    const item = hooks.store.add({ ...test.original, title: 'Recaptured fixture' });
    test.reject = outcome === 'error'; hooks.imageText.onChanged(); return { id: item.id, ...hooks.store.media.get(item) };
  }, outcome);
  expect(replacement.id).not.toBe(original.id); expect(replacement.previewKey).toBe(original.previewKey); expect(replacement.iconKey).toBe(original.iconKey);
  await expect(page.locator('.clip-card')).toHaveAttribute('data-id', replacement.id);
  await application.evaluate(() => globalThis.__releaseMediaRequest());
  await expect(page.locator('.image-preview img')).toBeVisible(); await expect(page.locator('.source-icon')).toBeVisible();
  expect(await application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(2);
  expect((await page.evaluate(id => window.paste.getItem(id), replacement.id)).body).toBe(original.body);
  if (outcome === 'empty') await page.screenshot({ path: 'test-results/media-owner-replacement.png' });
});

test('an old empty result cannot suppress a restored key on the same item after a newer library revision', async () => {
  const original = await seed('hold');
  await expect.poll(() => application.evaluate(() => !!globalThis.__releaseMediaRequest)).toBe(true);
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest, test = globalThis.__mediaRequestTest;
    hooks.store.mutate(() => { const item = hooks.store.edit(test.original.id); item.preview = ''; item.source = { ...item.source, icon: '' }; });
    test.emptyResult = test.read.call(hooks.mediaService, test.requests);
    if (test.emptyResult.length) throw new Error('Fixture did not produce an actual stale read');
    hooks.store.mutate(() => { const item = hooks.store.edit(test.original.id); item.preview = test.original.preview; item.source = test.original.source; });
    hooks.imageText.onChanged();
  });
  await expect(page.locator('.clip-card')).toHaveAttribute('data-id', original.id);
  await application.evaluate(() => globalThis.__releaseMediaRequest());
  await expect(page.locator('.image-preview img')).toBeVisible(); await expect(page.locator('.source-icon')).toBeVisible();
  expect(await application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(2);
});

test('a transient IPC failure retries with backoff without requiring another library change', async () => {
  await seed('fail-once');
  await expect(page.locator('.image-preview img')).toBeVisible(); await expect(page.locator('.source-icon')).toBeVisible();
  const calls = await application.evaluate(() => globalThis.__mediaRequestTest.calls);
  expect(calls).toHaveLength(2); expect(calls[1].time - calls[0].time).toBeGreaterThanOrEqual(200);
  await expect(page.locator('#status')).toBeHidden();
});

test('persistent failure has a bounded retry budget across background changes and can recover when the panel reopens', async () => {
  await seed('always-fail');
  await expect.poll(() => application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(3);
  await expect(page.getByRole('img', { name: '图片预览不可用', exact: true })).toBeVisible();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setBounds({ width: 390, height: 332 }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const geometry = await page.locator('.media-placeholder').evaluate(node => {
    const placeholder = node.getBoundingClientRect(), icon = node.querySelector('svg').getBoundingClientRect(), card = node.closest('.clip-card').getBoundingClientRect();
    return { width: card.width, height: card.height, dx: Math.abs(icon.x + icon.width / 2 - placeholder.x - placeholder.width / 2), dy: Math.abs(icon.y + icon.height / 2 - placeholder.y - placeholder.height / 2) };
  });
  expect(geometry).toEqual({ width: 240, height: 240, dx: 0, dy: 0 });
  await page.screenshot({ path: 'test-results/media-unavailable-narrow.png' });
  for (let n = 0; n < 3; n++) await page.evaluate(async () => { const { settings } = await window.paste.getLibrary(); await window.paste.saveSettings({ theme: settings.theme }); });
  expect(await application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(3);
  await application.evaluate(({ BrowserWindow }) => {
    globalThis.__mediaRequestTest.fail = false;
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).webContents.send('panel:shown', { target: 'Fixture' });
  });
  await expect(page.locator('.image-preview img')).toBeVisible(); await expect(page.locator('.source-icon')).toBeVisible();
  expect(await application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(4);
  await expect(page.locator('#status')).toBeHidden();
  await page.screenshot({ path: 'test-results/media-recovered-narrow.png' });
});

test('a scheduled retry does not fetch a hidden card and resumes only when the card is visible again', async () => {
  await pausedClock();
  await seed('fail-once');
  await expect.poll(() => application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(1);
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('No matching item');
  await expect(page.locator('.clip-card')).toHaveCount(0); await page.clock.fastForward(5000);
  expect(await application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(1);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(page.locator('.image-preview img')).toBeVisible(); await expect(page.locator('.source-icon')).toBeVisible();
  expect(await application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(2);
});

test('shared image and icon keys keep one backoff budget across multiple live owners', async () => {
  await pausedClock(); await seed('always-fail');
  await expect.poll(() => page.evaluate(() => mediaActive)).toBe(0);
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest, original = globalThis.__mediaRequestTest.original;
    for (const body of ['Second visible owner', 'Third visible owner']) hooks.store.add({ type: 'text', body, source: original.source });
    hooks.imageText.onChanged();
  });
  await expect(page.locator('.clip-card')).toHaveCount(3);
  await page.clock.fastForward(249);
  expect(await application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(1);
  await page.clock.fastForward(1); await expect.poll(() => application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => mediaActive)).toBe(0);
  await page.clock.fastForward(1000); await expect.poll(() => application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(3);
  await expect.poll(() => page.evaluate(() => mediaActive)).toBe(0);
  await page.clock.fastForward(60000);
  for (let n = 0; n < 2; n++) await page.evaluate(async () => { const { settings } = await window.paste.getLibrary(); await window.paste.saveSettings({ theme: settings.theme }); });
  expect(await application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(3);
});

test('a late error from the previous panel session cannot spend the new session retry budget', async () => {
  await pausedClock(); const original = await seed('hold');
  await expect.poll(() => application.evaluate(() => !!globalThis.__releaseMediaRequest)).toBe(true);
  const epoch = await page.evaluate(() => mediaEpoch);
  await application.evaluate(({ BrowserWindow }) => {
    globalThis.__mediaRequestTest.reject = true;
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).webContents.send('panel:shown', { target: 'Fixture' });
  });
  await expect.poll(() => page.evaluate(() => mediaEpoch)).toBe(epoch + 1);
  await application.evaluate(() => globalThis.__releaseMediaRequest());
  await expect(page.locator('.image-preview img')).toBeVisible(); await expect(page.locator('.source-icon')).toBeVisible();
  expect(await application.evaluate(() => globalThis.__mediaRequestTest.calls.length)).toBe(2);
  expect((await page.evaluate(id => window.paste.getItem(id), original.id)).body).toBe(original.body);
  await expect(page.locator('#status')).toBeHidden();
});
