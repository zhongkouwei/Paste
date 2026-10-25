const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, directory;
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await application.evaluate(({ dialog }) => {
    const hooks = globalThis.__pasteTest;
    dialog.showMessageBoxSync = () => 1;
    globalThis.__pauseNow = Date.now(); globalThis.__version = 1; globalThis.__reads = 0; globalThis.__versionReads = 0; globalThis.__snapshot = null;
    hooks.capturePause.now = () => globalThis.__pauseNow;
    hooks.monitor.readVersion = async () => { globalThis.__versionReads++; if (globalThis.__counterFailure) throw Error('Injected counter unavailable'); return globalThis.__version; };
    hooks.monitor.readSnapshot = async () => { globalThis.__reads++; return globalThis.__snapshot; };
    hooks.clip.read = hooks.clip.write = () => { throw Error('Unexpected system clipboard access'); };
    if (!hooks.store.data.items.length) hooks.store.add({ type: 'text', body: 'Existing history', title: 'Existing history' }); hooks.imageText.onChanged();
  });
}
test.beforeEach(async () => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-capture-pause-')); await launch(); });
test.afterEach(async () => {
  if (application) { await application.evaluate(() => { globalThis.__releaseSnapshot?.(); globalThis.__restoreTray?.(); }).catch(() => {}); await application.close(); }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = null;
});
const library = () => page.evaluate(() => window.paste.getLibrary());
const captured = () => library().then(value => value.items.map(item => item.body));
async function collect(body) {
  await application.evaluate(async (_electron, body) => { const hooks = globalThis.__pasteTest; globalThis.__version++;
    globalThis.__snapshot = { type: 'text', body, title: body, signature: hooks.textSignature(body) }; await hooks.poll(); }, body);
}
test('pause works without a counter helper; failed resume stays visibly gated and never reads private payloads', async () => {
  await application.evaluate(() => { globalThis.__counterFailure = true; });
  expect((await page.evaluate(() => window.paste.pauseCapture(null))).settings.paused).toBe(true);
  expect(await application.evaluate(() => globalThis.__versionReads)).toBe(0); await expect(page.getByRole('button', { name: '继续记录', exact: true })).toBeVisible();
  await collect('Private while helper unavailable'); expect(await application.evaluate(() => globalThis.__reads)).toBe(0);
  const resumed = await page.evaluate(() => window.paste.resumeCapture()); expect(resumed.status.capture.resuming).toBe(true); await expect(page.locator('#captureLabel')).toHaveText('恢复中');
  expect(await application.evaluate(() => globalThis.__reads)).toBe(0);
  await application.evaluate(async () => { globalThis.__counterFailure = false; await globalThis.__pasteTest.poll(); });
  await expect(page.locator('#captureButton')).toBeHidden(); expect(await captured()).toEqual(['Existing history']);
  await collect('Public after baseline'); expect(await captured()).toEqual(['Public after baseline', 'Existing history']);
});
test('Command-T toggles once, native menu shares the action, and auto-repeat cannot oscillate the state', async () => {
  await page.keyboard.press('Meta+t'); await expect.poll(async () => (await library()).status.capture.paused).toBe(true);
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['meta', 'isautorepeat'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['meta'] });
  });
  expect((await library()).status.capture.paused).toBe(true);
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('capture-toggle').click());
  await expect.poll(async () => (await library()).status.capture.paused).toBe(false); expect(await application.evaluate(() => globalThis.__reads)).toBe(0);
});
test('duration menu persists a deadline, expiry skips the paused clipboard and Stack only collects subsequent copies', async () => {
  await page.evaluate(() => window.paste.toggleStack());
  await page.locator('#moreButton').click(); await page.getByRole('menuitem', { name: '15分钟', exact: true }).click();
  const until = (await library()).settings.pausedUntil; expect(until).toBe(await application.evaluate(() => globalThis.__pauseNow + 900000));
  await collect('Private during timed pause'); expect((await page.evaluate(() => window.paste.getStack())).entries).toEqual([]);
  await application.evaluate(async () => { globalThis.__pauseNow += 900001; await globalThis.__pasteTest.capturePause.check(); });
  expect((await library()).settings.paused).toBe(false); expect(await captured()).toEqual(['Existing history']);
  await collect('Public Stack'); expect((await page.evaluate(() => window.paste.getStack())).entries.map(entry => entry.item.body)).toEqual(['Public Stack']);
});
for (const [label, duration] of [['30分钟', 1800000], ['3小时', 10800000], ['8小时', 28800000]]) test(`observed ${label} preset is available in the panel and native menus with the same exact deadline`, async () => {
  if (label === '8小时') await application.evaluate(({ BrowserWindow, nativeTheme }) => {
    nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(390, 332);
  });
  await page.locator('#moreButton').click(); await expect(page.getByRole('menuitem', { name: '5分钟', exact: true })).toHaveCount(0);
  const option = page.getByRole('menuitem', { name: label, exact: true }); await option.scrollIntoViewIfNeeded();
  if (label === '8小时') {
    expect(await option.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
    await page.screenshot({ path: 'test-results/capture-pause-presets-narrow.png' });
  }
  await option.click();
  let until = (await library()).settings.pausedUntil; expect(until).toBe(await application.evaluate((_electron, duration) => globalThis.__pauseNow + duration, duration));
  await collect('Private in observed pause'); expect(await captured()).toEqual(['Existing history']);
  await application.evaluate(async (_electron, until) => { globalThis.__pauseNow = until; await globalThis.__pasteTest.capturePause.check(); }, until);
  expect((await library()).status.capture.paused).toBe(false); expect(await application.evaluate(() => globalThis.__reads)).toBe(0);
  await application.evaluate(({ Menu }, label) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === '暂停时长').submenu.items.find(item => item.label === label).click(), label);
  until = (await library()).settings.pausedUntil; expect(until).toBe(await application.evaluate((_electron, duration) => globalThis.__pauseNow + duration, duration));
});
test('the tray context menu uses the same observed presets and routes them through the real pause controller', async () => {
  await page.evaluate(() => window.paste.saveSettings({ showInMenuBar: false }));
  await application.evaluate(({ Tray }) => {
    const on = Tray.prototype.on, popup = Tray.prototype.popUpContextMenu;
    Tray.prototype.on = function(event, listener) { if (event === 'right-click') globalThis.__observedTray = this; return on.call(this, event, listener); };
    Tray.prototype.popUpContextMenu = function(menu) { globalThis.__observedTrayMenu = menu; };
    globalThis.__restoreTray = () => { Tray.prototype.on = on; Tray.prototype.popUpContextMenu = popup; };
  });
  await page.evaluate(() => window.paste.saveSettings({ showInMenuBar: true }));
  const labels = await application.evaluate(() => {
    globalThis.__observedTray.emit('right-click');
    const menu = globalThis.__observedTrayMenu.items.find(item => item.label === '暂停时长').submenu;
    menu.items.find(item => item.label === '8小时').click(); return menu.items.map(item => item.label);
  });
  expect(labels).toEqual(['15分钟', '30分钟', '1小时', '3小时', '8小时', '直到手动恢复']);
  await expect.poll(async () => (await library()).settings.pausedUntil).toBe(await application.evaluate(() => globalThis.__pauseNow + 28800000));
});
test('an in-flight snapshot invalidated by pause cannot enter history or later reappear on resume', async () => {
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest;
    hooks.monitor.readSnapshot = () => new Promise(resolve => { globalThis.__releaseSnapshot = () => resolve({ type: 'text', body: 'Late private', signature: hooks.textSignature('Late private') }); });
    globalThis.__oldPoll = hooks.poll();
  });
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseSnapshot)).toBe('function');
  await page.evaluate(() => window.paste.pauseCapture(null)); await application.evaluate(async () => { globalThis.__releaseSnapshot(); await globalThis.__oldPoll; });
  expect(await captured()).toEqual(['Existing history']); await page.evaluate(() => window.paste.resumeCapture()); expect(await captured()).toEqual(['Existing history']);
});
test('failed persistence keeps a runtime privacy hold, exposes the failure and can recover without backfill', async () => {
  await application.evaluate(() => { const store = globalThis.__pasteTest.store; globalThis.__saveSettings = store.settings; store.settings = () => { throw Error('Injected pause disk full'); }; });
  await expect(page.evaluate(() => window.paste.pauseCapture(300000))).rejects.toThrow('Injected pause disk full');
  expect((await library()).settings.paused).toBe(false); expect((await library()).status.capture.paused).toBe(true); expect((await library()).status.capture.error).toContain('当前会话仍停止记录');
  await collect('Private during disk failure'); expect(await captured()).toEqual(['Existing history']);
  await application.evaluate(() => { globalThis.__pasteTest.store.settings = globalThis.__saveSettings; });
  await page.getByRole('button', { name: '继续记录', exact: true }).click(); await expect(page.locator('#captureButton')).toBeHidden(); expect(await captured()).toEqual(['Existing history']);
});
test('real restart restores timed state; controlled expired-startup check does not capture content copied while closed', async () => {
  await page.evaluate(() => window.paste.pauseCapture(300000)); const until = (await library()).settings.pausedUntil;
  await application.close(); await launch(); expect((await library()).settings.pausedUntil).toBe(until);
  await application.evaluate(async (_electron, until) => {
    const hooks = globalThis.__pasteTest; globalThis.__pauseNow = until + 1; globalThis.__snapshot = { type: 'text', body: 'Private while closed', signature: hooks.textSignature('Private while closed') };
    await hooks.capturePause.check();
  }, until);
  expect((await library()).status.capture.paused).toBe(false); expect(await application.evaluate(() => globalThis.__reads)).toBe(0);
  await collect('Public after restart'); expect(await captured()).toEqual(['Public after restart', 'Existing history']);
});
test('native Command-T in an unsaved preview leaves the draft intact and paused state fits light/narrow panels', async () => {
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.newText('history')); const preview = await opened;
  await preview.waitForFunction(() => document.body.dataset.previewReady === 'true'); const editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await editor.fill('Unsaved text remains');
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html'));
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['meta'] }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['meta'] });
  });
  await expect.poll(async () => (await library()).status.capture.paused).toBe(true); await expect(editor).toHaveText('Unsaved text remains'); expect(preview.isClosed()).toBe(false);
  await application.evaluate(({ BrowserWindow, nativeTheme }) => { nativeTheme.themeSource = 'light'; BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(320, 332); });
  expect(await page.evaluate(() => document.querySelector('.navigation').getBoundingClientRect().right <= document.querySelector('.toolbar-end').getBoundingClientRect().left)).toBe(true);
  await page.screenshot({ path: 'test-results/capture-paused-narrow.png' });
});
test('restoring a timed preference uses the same gate and resume barrier as normal pause', async () => {
  const settings = (await library()).settings, until = await application.evaluate(() => globalThis.__pauseNow + 300000);
  const file = path.join(directory, 'timed-backup.json'); fs.writeFileSync(file, JSON.stringify({ version: 2, items: [], boards: [], settings: { ...settings, paused: true, pausedUntil: until } }));
  const token = await application.evaluate(async (_electron, file) => { await globalThis.__pasteTest.importService.prepare(file); return globalThis.__pasteTest.importService.state().token; }, file);
  await page.evaluate(token => window.paste.applyImport(token, { mode: 'merge', restoreSettings: true }), token);
  expect((await library()).settings.pausedUntil).toBe(until); await collect('Private during restored pause'); expect(await captured()).toEqual(['Existing history']);
  await application.evaluate(async (_electron, until) => { globalThis.__pauseNow = until + 1; await globalThis.__pasteTest.poll(); }, until);
  expect((await library()).status.capture.paused).toBe(false); expect(await captured()).toEqual(['Existing history']);
});
