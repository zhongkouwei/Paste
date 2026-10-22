const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, settings, directory;
const textEdit = '/System/Applications/TextEdit.app';
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); settings = await opened;
  await settings.locator('[data-page=privacy]').click();
}
test.beforeEach(async () => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-applications-ui-')); await launch(); });
test.afterEach(async () => { if (application) await application.close(); fs.rmSync(directory, { recursive: true, force: true }); application = page = settings = directory = null; });
async function picker(value) {
  await application.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async (_owner, options) => { globalThis.__applicationDialog = options; return value; }; }, value);
}
const ids = () => settings.evaluate(() => window.paste.getLibrary()).then(value => value.settings.excludedApps);
// Only app metadata and synthetic settings: no launching selected apps or system clipboard access.
test('native application selection adds names/icons by stable ID, deduplicates and survives restart without persisting paths or artwork', async () => {
  expect(await page.evaluate(() => window.paste.chooseExcludedApplications().catch(error => error.message))).toContain('隐私设置');
  await picker({ canceled: false, filePaths: [textEdit, textEdit] }); await settings.getByRole('button', { name: '添加应用程序', exact: true }).click();
  const row = settings.locator('[data-bundle-id="com.apple.TextEdit"]'); await expect(row).toContainText('TextEdit');
  await expect.poll(() => row.locator('img').evaluate(image => image.complete && image.naturalWidth === 64)).toBe(true);
  const after = await ids(); expect(after.filter(value => value === 'com.apple.TextEdit')).toHaveLength(1);
  expect(await application.evaluate(() => [globalThis.__pasteTest.isIgnored(['text/plain'], { bundleId: 'com.apple.TextEdit' }), globalThis.__pasteTest.isIgnored(['text/plain'], { bundleId: 'not.excluded' })])).toEqual([true, false]);
  await application.evaluate(() => {
    const catalog = globalThis.__pasteTest.applicationCatalog, read = catalog.read; catalog.cache.clear();
    catalog.read = request => request.identifiers ? Promise.resolve({ ok: true, applications: request.identifiers.map(bundleId => ({ bundleId, name: bundleId, available: false })) }) : read(request);
  });
  await settings.reload(); await settings.locator('[data-page=privacy]').click(); await expect(settings.locator('[data-bundle-id="com.apple.TextEdit"]')).toContainText('未安装或无法定位');
  await settings.getByRole('button', { name: '添加应用程序', exact: true }).click();
  await expect(settings.locator('[data-bundle-id="com.apple.TextEdit"] .excluded-name')).toHaveText('TextEdit');
  expect(await ids()).toEqual(after);
  const options = await application.evaluate(() => globalThis.__applicationDialog); expect(options).toMatchObject({ defaultPath: '/Applications', properties: ['openFile', 'multiSelections'], filters: [{ name: '应用程序', extensions: ['app'] }] });
  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'library.json'))).settings; expect(stored.excludedApps).toEqual(after);
  expect(JSON.stringify(stored)).not.toContain(textEdit); expect(JSON.stringify(stored)).not.toContain('data:image/');
  await application.close(); application = null; await launch(); await expect(settings.locator('[data-bundle-id="com.apple.TextEdit"]')).toContainText('TextEdit'); expect(await ids()).toEqual(after);
});
test('cancelled, invalid and overlapping pickers preserve current rules and release the action', async () => {
  await settings.evaluate(() => window.paste.changeExcludedApplication('protected.app')); const before = fs.readFileSync(path.join(directory, 'library.json'));
  for (const value of [{ canceled: true, filePaths: [] }, { canceled: false, filePaths: [directory] }]) {
    await picker(value); await settings.getByRole('button', { name: '添加应用程序', exact: true }).click();
    await expect(settings.getByRole('button', { name: '添加应用程序', exact: true })).toBeEnabled(); expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  }
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = () => new Promise(resolve => { globalThis.__finishApplicationPicker = () => resolve({ canceled: true, filePaths: [] }); }); });
  await settings.getByRole('button', { name: '添加应用程序', exact: true }).click(); await expect.poll(() => application.evaluate(() => typeof globalThis.__finishApplicationPicker)).toBe('function');
  expect(await settings.evaluate(() => window.paste.chooseExcludedApplications().catch(error => error.message))).toContain('已打开');
  await application.evaluate(() => globalThis.__finishApplicationPicker()); await expect(settings.getByRole('button', { name: '添加应用程序', exact: true })).toBeEnabled();
  expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
});
test('late application selection and rapid identifier changes merge with the latest settings rather than resurrecting removed rules', async () => {
  await settings.evaluate(() => window.paste.saveSettings({ excludedApps: ['old.app', 'remove.app'] }));
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => new Promise(resolve => { globalThis.__finishApplicationPicker = () => resolve({ canceled: false, filePaths: [file] }); }); }, textEdit);
  await settings.getByRole('button', { name: '添加应用程序', exact: true }).click(); await expect.poll(() => application.evaluate(() => typeof globalThis.__finishApplicationPicker)).toBe('function');
  await settings.evaluate(() => Promise.all([window.paste.changeExcludedApplication('new.app'), window.paste.changeExcludedApplication('old.app', true), window.paste.changeExcludedApplication('remove.app', true), window.paste.saveSettings({ sound: true })]));
  await application.evaluate(() => globalThis.__finishApplicationPicker()); await expect(settings.getByRole('button', { name: '添加应用程序', exact: true })).toBeEnabled();
  expect(await ids()).toEqual(['new.app', 'com.apple.TextEdit']); expect((await settings.evaluate(() => window.paste.getLibrary())).settings.sound).toBe(true);
  await settings.evaluate(() => Promise.all([window.paste.changeExcludedApplication('new.app', true), window.paste.changeExcludedApplication('com.apple.TextEdit', true)]));
  expect(await ids()).toEqual([]); await expect(settings.locator('#excludedApps')).toHaveText('没有项目');
});
test('stale metadata cannot resurrect a removed rule or change exclusion identity', async () => {
  await settings.evaluate(() => window.paste.saveSettings({ excludedApps: ['delayed.app'] }));
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('settings:excludedApplications'); ipcMain.handle('settings:excludedApplications', (_event, ids) => new Promise(resolve => {
      globalThis.__finishApplicationMetadata = () => resolve(ids.map(bundleId => ({ bundleId, name: 'Late removed display name', available: true })));
    }));
  });
  await settings.reload(); await settings.locator('[data-page=privacy]').click(); await expect.poll(() => application.evaluate(() => typeof globalThis.__finishApplicationMetadata)).toBe('function');
  await settings.getByRole('button', { name: '移除 delayed.app', exact: true }).click(); await expect(settings.locator('#excludedApps')).toHaveText('没有项目');
  await application.evaluate(() => globalThis.__finishApplicationMetadata()); await settings.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(settings.locator('#excludedApps')).toHaveText('没有项目'); expect(await ids()).toEqual([]);
});
test('failed settings writes leave rules intact, while normal selection and legacy identifiers remain usable in the privacy layout', async () => {
  await settings.evaluate(() => window.paste.changeExcludedApplication('protected.app')); const before = fs.readFileSync(path.join(directory, 'library.json'));
  await picker({ canceled: false, filePaths: [textEdit] });
  await application.evaluate(() => { const store = globalThis.__pasteTest.store; globalThis.__persistBeforeApplicationPicker = store.persist; store.persist = () => { throw new Error('Injected application-rule write failure'); }; });
  await settings.getByRole('button', { name: '添加应用程序', exact: true }).click(); await expect(settings.locator('#settingsStatus')).toContainText('Injected application-rule write failure');
  await expect(settings.getByRole('button', { name: '添加应用程序', exact: true })).toBeEnabled(); expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  await application.evaluate(() => { globalThis.__pasteTest.store.persist = globalThis.__persistBeforeApplicationPicker; });
  await settings.getByRole('button', { name: '添加应用程序', exact: true }).click(); await expect(settings.locator('[data-bundle-id="com.apple.TextEdit"]')).toContainText('TextEdit');
  await expect(settings.locator('#settingsStatus')).toBeHidden();
  await settings.getByText('按标识添加', { exact: true }).click(); const legacy = `legacy.${'a'.repeat(180)}`;
  await settings.getByRole('textbox', { name: '忽略应用的 Bundle ID' }).fill(legacy); await settings.getByRole('button', { name: '添加忽略应用', exact: true }).click();
  await expect(settings.locator('[data-bundle-id="'+legacy+'"]')).toContainText('未安装或无法定位');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/settings.html')).setBounds({ width: 620, height: 520 }));
  expect(await settings.evaluate(() => [...document.querySelectorAll('.excluded-group, #excludedApps li, .excluded-label, #excludeForm')].every(node => node.scrollWidth <= node.clientWidth))).toBe(true);
  await settings.screenshot({ path: 'test-results/settings-excluded-applications.png' });
  await settings.getByRole('button', { name: '移除 TextEdit', exact: true }).click(); expect(await ids()).not.toContain('com.apple.TextEdit');
  expect(await application.evaluate(() => globalThis.__pasteTest.isIgnored(['text/plain'], { bundleId: 'com.apple.TextEdit' }))).toBe(false);
});
test('the real native catalog rejects malformed, oversized and non-application requests without changing any rules', async () => {
  const bad = path.join(directory, 'Invalid.app'); fs.mkdirSync(path.join(bad, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>../invalid</string></dict></plist>');
  const before = await ids(), results = await application.evaluate(async (_electron, { file, bad }) => {
    const read = globalThis.__pasteTest.applicationCatalog.read, results = [];
    for (const request of [{}, { identifiers: [null] }, { identifiers: Array(33).fill('com.apple.TextEdit') }, { paths: ['relative.app'] },
      { paths: [file], identifiers: [] }, { paths: [bad] }]) results.push(await read(request));
    return results;
  }, { file: textEdit, bad });
  expect(results.every(value => value.ok === false)).toBe(true); expect(await ids()).toEqual(before);
  expect(await settings.evaluate(() => window.paste.getExcludedApplications(Array(33).fill('com.apple.keychainaccess')).catch(error => error.message))).toContain('无效');
});
