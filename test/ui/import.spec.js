const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, settings, directory, input;
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); settings = await opened;
  await settings.locator('[data-page="data"]').click(); await expect(settings.locator('#importData')).toBeEnabled();
}
test.beforeEach(async () => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-import-ui-')); input = path.join(directory, 'input.json'); await launch(); });
test.afterEach(async () => { if (application) await application.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); application = page = settings = directory = input = null; });
const record = (id, body = id) => ({ id, body, title: id, type: 'text', boardIds: [], createdAt: '2026-10-22T00:00:00.000Z' });
test('portable restore validates real PNG variants and OCR, previews without writes, confirms replacement and survives restart', async () => {
  const expected = await application.evaluate(async ({ nativeImage }, file) => {
    const { store, hash } = globalThis.__pasteTest, body = '完整正文\0🧪\uD800 "\\\n'.repeat(3000);
    const text = store.add({ type: 'text', body, html: '<p>Original <strong>rich</strong></p>', rtf: '{\\rtf1 Original}', title: 'Full original' });
    const board = store.saveBoard({ name: 'Imported board', color: '#ef6259' }); store.pinItems([text.id], board.id); store.reorderBoardItems(board.id, [text.id]);
    const png = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG(), asset = store.putAsset(png);
    const signature = hash(Buffer.concat([Buffer.from('image:1x1:'), nativeImage.createFromBuffer(png).toBitmap()]));
    const image = store.add({ type: 'image', body: asset, asset, signature, signatureFormat: 'pixels-v1', title: 'Pixel original' });
    store.replaceImage(image.id, { buffer: png, original: png, foreground: png, turns: 1, size: { width: 1, height: 1 }, signature, backgroundRemoved: true, preview: globalThis.__pasteTest.thumbnail(nativeImage.createFromBuffer(png)) });
    store.setOCR(image.id, signature, { status: 'ready', text: 'Original OCR', lines: [{ text: 'Original OCR', box: { x: 0, y: 0, width: 1, height: 1 }, words: [] }] });
    store.settings({ paused: true, retentionDays: 0 }); await store.exportTo(file); const expected = store.exportData();
    store.mutate(() => { store.data.items = []; store.data.boards = []; }); store.settings({ theme: 'light' }); store.add({ type: 'text', body: 'Pre-import library', title: 'Current original' });
    globalThis.__pasteTest.imageText.onChanged();
    return expected;
  }, input);
  const before = fs.readFileSync(path.join(directory, 'library.json'));
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await expect(settings.locator('#importSummary')).toContainText('2 项'); expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  await settings.screenshot({ path: 'test-results/settings-import-preview.png' });
  await settings.locator('[name=importMode][value=replace]').check(); await expect(settings.locator('#applyImport')).toBeDisabled();
  await settings.locator('#confirmReplace').check(); await settings.locator('#restoreSettings').check(); await settings.locator('#applyImport').click();
  await expect(settings.locator('#settingsStatus')).toHaveText('备份已恢复，恢复前备份已保留');
  expect(await application.evaluate(() => globalThis.__pasteTest.store.exportData())).toEqual(expected);
  const checkpoint = await settings.evaluate(() => window.paste.revealImportBackup());
  expect(JSON.parse(fs.readFileSync(checkpoint)).items[0].body).toBe('Pre-import library'); expect(fs.statSync(checkpoint).mode & 0o777).toBe(0o600);
  await settings.screenshot({ path: 'test-results/settings-import-complete.png' });
  await application.close(); application = null; await launch(); expect(await application.evaluate(() => globalThis.__pasteTest.store.exportData())).toEqual(expected);
});
test('merge keeps current renamed content, adds board membership and remaps a conflicting ID', async () => {
  const id = await application.evaluate(() => { const { store } = globalThis.__pasteTest; const item = store.add({ type: 'text', body: 'same', title: 'Original' }); store.update(item.id, { title: 'My name' }); return item.id; });
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: [{ ...record('duplicate', 'same'), boardIds: ['b'] }, record(id, 'new body')], boards: [{ id: 'b', name: 'Backup board', color: '#ef6259', itemOrder: ['duplicate'] }] }));
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await expect(settings.locator('#importSummary')).toContainText('重复 1 项'); await settings.locator('#applyImport').click();
  await expect(settings.locator('#settingsStatus')).toContainText('备份已恢复');
  const data = await application.evaluate(() => globalThis.__pasteTest.store.exportData());
  expect(data.items).toHaveLength(2); expect(data.items[0]).toMatchObject({ id, body: 'same', title: 'My name', boardIds: ['b'] }); expect(data.items[1].id).not.toBe(id);
});
test('corrupt PNG, path references and stale previews cannot overwrite current history', async () => {
  await application.evaluate(() => globalThis.__pasteTest.store.add({ type: 'text', body: 'Protected original' })); const before = fs.readFileSync(path.join(directory, 'library.json'));
  const png = await application.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG().subarray(0, 33).toString('base64'));
  for (const value of [{ ...record('bad'), contentAsset: '../secret.json' }, { ...record('bad'), type: 'image', body: `data:image/png;base64,${png}` }]) {
    fs.writeFileSync(input, JSON.stringify({ version: 2, items: [value] })); await settings.locator('#importData').click();
    await expect(settings.locator('#settingsStatus')).toBeVisible(); await expect(settings.locator('#importData')).toBeEnabled();
    expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  }
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: [record('valid')] })); await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await application.evaluate(() => globalThis.__pasteTest.store.add({ type: 'text', body: 'Concurrent capture' }));
  await settings.locator('#applyImport').click(); await expect(settings.locator('#settingsStatus')).toContainText('当前库已变化');
  expect(await application.evaluate(() => globalThis.__pasteTest.store.data.items.length)).toBe(2);
});
test('picker cancellation, preview discard and validation cancellation release controls and keep data untouched', async () => {
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true }); });
  await settings.locator('#importData').click(); await expect(settings.locator('#importData')).toBeEnabled();
  expect((await settings.evaluate(() => window.paste.getImportState())).phase).toBe('idle');
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: [record('preview')] }));
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible(); await settings.locator('#cancelImport').click();
  await expect(settings.locator('#importPreview')).toBeHidden(); await expect(settings.locator('#exportData')).toBeEnabled();
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: Array.from({ length: 1000 }, (_, n) => record(String(n), 'x'.repeat(50000))) }));
  await settings.locator('#importData').click(); await expect(settings.locator('#importProgress')).toBeVisible(); await settings.locator('#cancelImport').click();
  await expect(settings.locator('#settingsStatus')).toHaveText('恢复已取消'); await expect(settings.locator('#importData')).toBeEnabled();
  expect(await application.evaluate(() => globalThis.__pasteTest.store.data.items.length)).toBe(0);
  expect(fs.readdirSync(directory).some(name => name.startsWith('import-'))).toBe(false);
});
test('a delayed initial import-state reply cannot reopen a discarded preview', async () => {
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: [record('preview')] }));
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await application.evaluate(({ ipcMain }) => {
    const state = globalThis.__pasteTest.importService.state(); ipcMain.removeHandler('library:importState');
    ipcMain.handle('library:importState', () => new Promise(resolve => { globalThis.__releaseImportState = () => resolve(state); }));
  });
  await settings.reload(); await settings.locator('[data-page="data"]').click();
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseImportState)).toBe('function');
  await application.evaluate(() => globalThis.__pasteTest.importService.cancel()); await expect(settings.locator('#importPreview')).toBeHidden();
  await application.evaluate(() => globalThis.__releaseImportState());
  await settings.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(settings.locator('#importPreview')).toBeHidden(); await expect(settings.locator('#importData')).toBeEnabled();
});
