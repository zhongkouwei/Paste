const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, settings, directory, output;
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-export-ui-')); output = path.join(directory, 'backup.json');
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
});
test.afterEach(async () => { if (application) await application.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); application = page = settings = directory = output = null; });
async function openData() {
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); settings = await opened;
  await settings.locator('[data-page="data"]').click(); await expect(settings.locator('#exportData')).toBeEnabled();
}
test('settings exports full originals and image variants through a worker without main-thread materialization', async () => {
  const expected = await application.evaluate(({ nativeImage }) => {
    const hooks = globalThis.__pasteTest, body = '完整正文\0🧪\uD800 "\\\n'.repeat(3000);
    hooks.store.add({ type: 'text', body, html: `<p>${body}</p>`, rtf: '{\\rtf1 Original}', title: 'Full original', preview: body });
    const image = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG();
    const asset = hooks.store.putAsset(image), item = hooks.store.add({ type: 'image', body: asset, asset, signature: 'pixels' });
    hooks.store.replaceImage(item.id, { buffer: image, original: image, foreground: image, turns: 1, size: { width: 1, height: 1 }, signature: 'pixels', backgroundRemoved: true });
    const expected = hooks.store.exportData(); hooks.store.exportData = () => { throw new Error('Whole-library materialization'); };
    hooks.store.get = () => { throw new Error('Main-thread original content read'); }; hooks.imageText.onChanged(); return expected;
  });
  fs.writeFileSync(output, 'Old export', { mode: 0o644 }); await openData(); await settings.locator('#exportData').click();
  await expect(settings.locator('#settingsStatus')).toHaveText('备份已导出');
  expect(JSON.parse(fs.readFileSync(output))).toEqual(expected); expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  await expect(settings.locator('#cancelExport')).toBeHidden(); await expect(settings.locator('#exportData')).toBeEnabled();
  await settings.screenshot({ path: 'test-results/settings-export-complete.png' });
});
test('visible progress stays responsive, cancellation preserves an older backup and the same UI can retry successfully', async () => {
  await application.evaluate(() => {
    const { store } = globalThis.__pasteTest, asset = store.putAsset(Buffer.alloc(1024 * 1024, 127)), createdAt = new Date().toISOString();
    store.mutate(() => { store.data.items = Array.from({ length: 1000 }, (_, n) => ({ id: String(n), type: 'image', title: `Synthetic ${n}`, body: asset, asset, signature: asset, signatureFormat: 'pixels-v1', boardIds: [], preview: '', createdAt })); });
  });
  fs.writeFileSync(output, 'Older backup', { mode: 0o644 }); await openData(); await settings.locator('#exportData').click();
  await expect(settings.locator('#exportProgress')).toBeVisible(); await expect(settings.locator('#exportData')).toBeDisabled();
  expect((await settings.evaluate(() => window.paste.getExportState())).running).toBe(true);
  await settings.screenshot({ path: 'test-results/settings-export-progress.png' });
  await settings.locator('#cancelExport').click(); await expect(settings.locator('#settingsStatus')).toHaveText('导出已取消');
  expect(fs.readFileSync(output, 'utf8')).toBe('Older backup'); expect(fs.statSync(output).mode & 0o777).toBe(0o644);
  expect(fs.readdirSync(directory).some(name => name.includes('.tmp-'))).toBe(false);
  await application.evaluate(() => { const { store } = globalThis.__pasteTest; store.mutate(() => { store.data.items = []; }); store.add({ type: 'text', body: 'Retry full original', title: 'Retry' }); });
  await settings.locator('#exportData').click(); await expect(settings.locator('#settingsStatus')).toHaveText('备份已导出');
  expect(JSON.parse(fs.readFileSync(output)).items[0].body).toBe('Retry full original');
});
test('source corruption reports an error, leaves an older backup intact and releases the controls', async () => {
  const asset = await application.evaluate(() => { const { store } = globalThis.__pasteTest; const asset = store.putAsset(Buffer.from('Original image bytes')); store.add({ type: 'image', body: asset, asset }); return asset; });
  fs.writeFileSync(path.join(directory, 'assets', asset), 'Corrupt image'); fs.writeFileSync(output, 'Older backup'); const before = fs.readFileSync(path.join(directory, 'library.json'));
  await openData(); await settings.locator('#exportData').click(); await expect(settings.locator('#settingsStatus')).toContainText('checksum');
  expect(fs.readFileSync(output, 'utf8')).toBe('Older backup'); expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  await expect(settings.locator('#exportData')).toBeEnabled(); await expect(settings.locator('#cancelExport')).toBeHidden();
});
test('canceling the location picker never starts a job and choosing the live library is rejected without overwriting it', async () => {
  await application.evaluate(() => globalThis.__pasteTest.store.add({ type: 'text', body: 'Protected original', title: 'Protected' }));
  await openData(); await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await settings.locator('#exportData').click(); await expect(settings.locator('#exportData')).toBeEnabled();
  expect(await settings.evaluate(() => window.paste.getExportState())).toMatchObject({ running: false }); expect(fs.existsSync(output)).toBe(false);
  const file = path.join(directory, 'library.json'), before = fs.readFileSync(file);
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
  await settings.locator('#exportData').click(); await expect(settings.locator('#settingsStatus')).toContainText('不能用导出备份覆盖');
  expect(fs.readFileSync(file)).toEqual(before); await expect(settings.locator('#cancelExport')).toBeHidden();
});
test('a delayed cancel-state reply cannot revive controls for an already completed export', async () => {
  await openData(); await expect(settings.locator('#permissionState span')).not.toHaveText('辅助功能');
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/settings.html'));
    ipcMain.removeHandler('library:exportState');
    ipcMain.handle('library:exportState', () => new Promise(resolve => { globalThis.__releaseExportState = () => resolve({ running: true, canceling: true, itemsDone: 1, total: 10, revision: 2 }); }));
    target.webContents.send('export:changed', { running: true, canceling: false, itemsDone: 1, total: 10, revision: 1 });
  });
  await settings.locator('#cancelExport').click();
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseExportState)).toBe('function');
  await application.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/settings.html'));
    target.webContents.send('export:changed', { running: false, canceling: false, itemsDone: 0, total: 0, revision: 3 });
  });
  await expect(settings.locator('#cancelExport')).toBeHidden();
  await application.evaluate(() => globalThis.__releaseExportState());
  await settings.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(settings.locator('#cancelExport')).toBeHidden(); await expect(settings.locator('#exportData')).toBeEnabled();
});
