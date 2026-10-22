const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
let application, page, directory, ids;

test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-copy-source-ui-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  ids = await application.evaluate(async () => {
    const hooks = globalThis.__pasteTest; globalThis.__writes = []; globalThis.__deliveries = [];
    hooks.clip.read = () => { throw Error('Unexpected system clipboard read'); };
    hooks.clip.write = async (item, options) => {
      globalThis.__writes.push({ item: structuredClone(item), plain: options.plain });
      return hooks.textSignature(item.body, item.html || '', item.rtf || '');
    };
    hooks.pasteTargets.read = async () => ({ pid: 111, bundleId: 'test.source.target', launchTime: 123 }); await hooks.showPanel();
    hooks.pasteDelivery.simulate = false; hooks.pasteDelivery.permission = async () => ({ accessibility: true });
    hooks.pasteOwnership.readVersion = async () => 0; hooks.pasteOwnership.check = async () => ({ ok: true });
    hooks.pasteDelivery.activate = async () => { globalThis.__deliveries.push(true); return { ok: true }; };
    const ids = ['First', 'Second', 'Third'].map(body => hooks.store.add({ type: 'text', body, title: body }).id);
    hooks.imageText.onChanged(); return ids;
  });
});
test.afterEach(async () => {
  if (application) { await application.evaluate(() => globalThis.__releaseVersion?.()).catch(() => {}); await application.close(); }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = ids = null;
});
const writes = () => application.evaluate(() => globalThis.__writes);
async function holdVersion() {
  await application.evaluate(() => {
    globalThis.__pasteTest.pasteOwnership.readVersion = () => new Promise(resolve => {
      globalThis.__releaseVersion = () => { globalThis.__pasteTest.pasteOwnership.readVersion = async () => 1; resolve(0); };
    });
  });
}
async function startCopy(ids) {
  await page.evaluate(ids => {
    window.__copy = (ids.length === 1 ? window.paste.copy(ids[0], { paste: true }) : window.paste.copySelection(ids, { paste: true })).catch(error => ({ error: error.message }));
  }, ids);
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseVersion)).toBe('function');
}
async function finishCopy() { await application.evaluate(() => globalThis.__releaseVersion()); return page.evaluate(() => window.__copy); }

test('editing a single source during the ownership wait cancels before writing; retry copies the saved version', async () => {
  await holdVersion(); await startCopy([ids[0]]);
  await page.evaluate(id => window.paste.updateItem(id, { body: 'Saved replacement' }), ids[0]);
  expect((await finishCopy()).error).toContain('改变或删除'); expect(await writes()).toEqual([]);
  expect(await application.evaluate(() => globalThis.__deliveries)).toEqual([]);
  await application.evaluate(() => globalThis.__pasteTest.showPanel());
  expect(await page.evaluate(id => window.paste.copy(id, { paste: true }), ids[0])).toMatchObject({ ok: true });
  expect((await writes()).map(value => value.item.body)).toEqual(['Saved replacement']);
});
test('deleting the pending Stack source never writes it or consumes the successor', async () => {
  await page.evaluate(async ids => { await window.paste.toggleStack(); for (const id of ids) await window.paste.addToStack(id); }, ids.slice(0, 2));
  await holdVersion(); await page.evaluate(() => { window.__copy = window.paste.nextInStack().catch(error => ({ error: error.message })); });
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseVersion)).toBe('function');
  await page.evaluate(id => window.paste.deleteItems([id]), ids[0]);
  expect((await finishCopy()).error).toContain('改变或删除'); expect(await writes()).toEqual([]);
  expect((await page.evaluate(() => window.paste.getStack())).entries.map(entry => entry.item.id)).toEqual([ids[1]]);
  expect(await application.evaluate(() => globalThis.__deliveries)).toEqual([]);
});
test('renaming and pinning during the wait do not invalidate unchanged content or its copy preferences', async () => {
  await holdVersion(); await startCopy([ids[0]]);
  await page.evaluate(async id => {
    const board = await window.paste.saveBoard({ name: 'Source board', color: '#62c68d' });
    await window.paste.updateItem(id, { title: 'New label' }); await window.paste.pinItems([id], board.id);
    await window.paste.saveSettings({ plainText: true });
  }, ids[0]);
  expect(await finishCopy()).toMatchObject({ ok: true });
  expect((await writes()).map(value => ({ body: value.item.body, plain: value.plain }))).toEqual([{ body: 'First', plain: false }]);
});
test('an image replaced during the wait cannot write the old pixels', async () => {
  const imageID = await application.evaluate(({ nativeImage }) => {
    const hooks = globalThis.__pasteTest, png = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG(), asset = hooks.store.putAsset(png);
    const item = hooks.store.add({ type: 'image', body: asset, asset, signature: 'original-red', title: 'Source image', size: { width: 1, height: 1 } }); hooks.imageText.onChanged(); return item.id;
  });
  await holdVersion(); await startCopy([imageID]);
  await application.evaluate(({ nativeImage }, id) => {
    const hooks = globalThis.__pasteTest, png = nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 }).toPNG();
    hooks.store.replaceImage(id, { buffer: png, original: png, size: { width: 1, height: 1 }, signature: 'replacement-blue', turns: 0 }); hooks.imageText.onChanged();
  }, imageID);
  expect((await finishCopy()).error).toContain('改变或删除'); expect(await writes()).toEqual([]);
  expect(await application.evaluate(() => globalThis.__deliveries)).toEqual([]);
});
test('Return from a chosen search result shows the cancellation without selecting or copying a different result', async () => {
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('First');
  await expect(page.locator('.clip-card')).toHaveCount(1); await page.getByRole('searchbox', { name: '搜索剪贴板' }).press('Enter');
  await holdVersion(); await page.keyboard.press('Enter');
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseVersion)).toBe('function');
  await page.evaluate(id => window.paste.updateItem(id, { body: 'First revised' }), ids[0]);
  await application.evaluate(() => globalThis.__releaseVersion());
  await expect(page.locator('#status')).toContainText('改变或删除'); expect(await writes()).toEqual([]);
  await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', ids[0]);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(390, 332));
  expect(await page.locator('#status').evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && node.scrollWidth <= node.clientWidth; })).toBe(true);
  await page.screenshot({ path: 'test-results/copy-source-error-narrow.png' });
});
for (const multiple of [false, true]) test(`${multiple ? 'multiple' : 'single'} file sources disappearing during the wait leave the clipboard untouched`, async () => {
  const file = path.join(directory, 'library.json.bak'), fileID = await application.evaluate((_electron, body) => {
    const hooks = globalThis.__pasteTest, item = hooks.store.add({ type: 'file', body, title: 'Temporary source' }); hooks.imageText.onChanged(); return item.id;
  }, pathToFileURL(file).href);
  const fileIDs = [fileID];
  if (multiple) fileIDs.push(await application.evaluate((_electron, body) => {
    const hooks = globalThis.__pasteTest, item = hooks.store.add({ type: 'file', body, title: 'Other source' }); hooks.imageText.onChanged(); return item.id;
  }, pathToFileURL(path.join(directory, 'library.json')).href));
  await holdVersion(); await startCopy(fileIDs); fs.unlinkSync(file);
  expect((await finishCopy()).error).toContain('移动或删除'); expect(await writes()).toEqual([]);
  expect(await application.evaluate(() => globalThis.__deliveries)).toEqual([]);
});
