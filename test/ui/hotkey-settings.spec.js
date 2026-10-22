const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const HISTORY = 'CommandOrControl+Shift+V', STACK = 'CommandOrControl+Shift+C', NEXT = 'CommandOrControl+Alt+V';
let application, page, settings, directory;
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await application.evaluate(() => {
    const h = globalThis.__pasteTest; globalThis.__keys = new Map(); globalThis.__keyCalls = []; globalThis.__firedKeys = [];
    h.clip.read = () => { throw Error('Unexpected system clipboard read'); }; h.clip.write = () => { throw Error('Unexpected system clipboard write'); };
    h.hotkeys.registry = {
      unregisterAll() { throw Error('Unexpected unregisterAll'); }, isRegistered: key => globalThis.__keys.has(key),
      register(key, callback) { globalThis.__keyCalls.push(['register', key, [...globalThis.__keys.keys()]]); if (key === globalThis.__blockedKey) return false; globalThis.__keys.set(key, callback); return true; },
      unregister(key) { globalThis.__keyCalls.push(['unregister', key]); if (key === globalThis.__releaseFailure) throw Error('Injected OS release failure'); globalThis.__keys.delete(key); }
    };
    h.hotkeys.callbacks = { history: () => globalThis.__firedKeys.push('history'), stack: () => globalThis.__firedKeys.push('stack') };
    h.hotkeys.disabled = false; h.hotkeys.apply(h.store.data.settings); globalThis.__keyCalls.length = 0;
  });
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); settings = await opened;
  await settings.locator('[data-page="shortcuts"]').click(); await expect(settings.locator('[data-shortcut="hotkey"]')).not.toHaveText('');
}
test.beforeEach(async () => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-hotkey-settings-')); await launch(); });
test.afterEach(async () => { if (application) { await application.evaluate(() => globalThis.__restoreFault?.()).catch(() => {}); await application.close(); } fs.rmSync(directory, { recursive: true, force: true }); application = page = settings = directory = null; });
const keys = () => application.evaluate(() => [...globalThis.__keys.keys()]);
const preferences = () => settings.evaluate(async () => (await window.paste.getLibrary()).settings);
async function save(value) { return settings.evaluate(value => window.paste.saveSettings(value), value); }
async function fault(mode) {
  await application.evaluate((_, mode) => {
    const store = globalThis.__pasteTest.store;
    if (mode === 'before') { const persist = store.persist; store.persist = () => { throw Error('Injected manifest failure'); }; globalThis.__restoreFault = () => { store.persist = persist; }; }
    else {
      const fs = process.getBuiltinModule('fs'), sync = fs.fsyncSync, root = fs.statSync(store.directory); let armed = true;
      fs.fsyncSync = fd => { const stat = fs.fstatSync(fd); if (armed && stat.isDirectory() && stat.ino === root.ino && stat.dev === root.dev) { armed = false; throw Error('Injected committed directory sync'); } return sync(fd); };
      globalThis.__restoreFault = () => { fs.fsyncSync = sync; };
    }
  }, mode);
}
test('a conflicting setting never unregisters working shortcuts and never changes the persisted preferences', async () => {
  await application.evaluate((_, key) => { globalThis.__blockedKey = key; }, NEXT);
  await expect(save({ hotkey: NEXT })).rejects.toThrow('已被占用'); expect((await preferences()).hotkey).toBe(HISTORY); expect(await keys()).toEqual([HISTORY, STACK]);
  expect(await application.evaluate(() => globalThis.__keyCalls)).toEqual([['register', NEXT, [HISTORY, STACK]]]);
  await application.evaluate((_, key) => globalThis.__keys.get(key)(), HISTORY); expect(await application.evaluate(() => globalThis.__firedKeys)).toEqual(['history']);
});
test('pre-commit disk failure releases only staged bindings and preserves old callbacks; retry commits after saving', async () => {
  await fault('before'); await expect(save({ hotkey: NEXT })).rejects.toThrow('Injected manifest'); expect(await keys()).toEqual([HISTORY, STACK]); expect((await preferences()).hotkey).toBe(HISTORY);
  const calls = await application.evaluate(() => globalThis.__keyCalls); expect(calls).toEqual([['register', NEXT, [HISTORY, STACK]], ['unregister', NEXT]]);
  await application.evaluate(() => globalThis.__restoreFault()); await save({ hotkey: NEXT }); expect(await keys()).toEqual([STACK, NEXT]); expect((await preferences()).hotkey).toBe(NEXT);
});
test('a committed sync failure shows a durability warning without rolling back new live shortcuts or the saved UI', async () => {
  await fault('after'); await settings.locator('[data-shortcut="hotkey"]').click(); await settings.keyboard.press('Meta+Alt+v');
  await expect(settings.locator('#settingsStatus')).toContainText('已提交'); await expect(settings.locator('[data-shortcut="hotkey"]')).toHaveText('⌘⌥V');
  await settings.screenshot({ path: 'test-results/hotkey-commit-warning.png' });
  expect((await preferences()).hotkey).toBe(NEXT); expect(await keys()).toEqual([STACK, NEXT]);
  await application.evaluate(() => globalThis.__restoreFault()); await application.close(); application = null; await launch();
  expect((await preferences()).hotkey).toBe(NEXT); expect(await keys()).toEqual([NEXT, STACK]);
});
test('swapping history and Stack reuses both dispatchers and routes each key to its new action without an OS gap', async () => {
  await save({ hotkey: STACK, stackHotkey: HISTORY }); expect(await application.evaluate(() => globalThis.__keyCalls)).toEqual([]);
  await application.evaluate((_, keys) => keys.forEach(key => globalThis.__keys.get(key)()), [HISTORY, STACK]);
  expect(await application.evaluate(() => globalThis.__firedKeys)).toEqual(['stack', 'history']);
  expect(await preferences()).toMatchObject({ hotkey: STACK, stackHotkey: HISTORY });
});
test('clearing during recording cancels the recorder, persists across restart and never revives the default', async () => {
  await settings.locator('[data-shortcut="hotkey"]').click(); await settings.getByRole('button', { name: '清除启动快捷键', exact: true }).click();
  await expect(settings.locator('[data-shortcut="hotkey"]')).toHaveText('未设置'); await settings.keyboard.press('Meta+Alt+v');
  expect((await preferences()).hotkey).toBe(''); expect(await keys()).toEqual([STACK]);
  await application.close(); application = null; await launch(); expect((await preferences()).hotkey).toBe(''); expect(await keys()).toEqual([STACK]);
});
test('resetting while a recorder is active exits capture and restores defaults without a later stray edit', async () => {
  await save({ hotkey: NEXT, stackHotkey: '' }); await settings.locator('[data-shortcut="stackHotkey"]').click(); await settings.locator('#resetHotkey').click();
  await expect(settings.locator('[data-shortcut="stackHotkey"]')).toHaveText('⌘⇧C'); await settings.keyboard.press('Meta+Alt+c');
  expect(await preferences()).toMatchObject({ hotkey: HISTORY, stackHotkey: STACK }); expect(await keys()).toEqual([HISTORY, STACK]);
});
test('an old-key release failure warns after commit, suppresses its callback and a same-settings retry cleans it', async () => {
  await application.evaluate((_, key) => { globalThis.__releaseFailure = key; }, HISTORY);
  await settings.locator('[data-shortcut="hotkey"]').click(); await settings.keyboard.press('Meta+Alt+v'); await expect(settings.locator('#settingsStatus')).toContainText('未能释放');
  expect((await preferences()).hotkey).toBe(NEXT);
  await application.evaluate((_, key) => globalThis.__keys.get(key)(), HISTORY); expect(await application.evaluate(() => globalThis.__firedKeys)).toEqual([]);
  await application.evaluate(() => { globalThis.__releaseFailure = ''; });
  await settings.locator('[data-shortcut="hotkey"]').click(); await settings.keyboard.press('Meta+Alt+v'); await expect.poll(keys).toEqual([STACK, NEXT]);
  await expect(settings.locator('#settingsStatus')).toBeHidden();
});
test('restoring shortcut settings uses the same staging boundary: failure preserves old keys and retry commits the imported mapping', async () => {
  const file = path.join(directory, 'restore.json'); fs.writeFileSync(file, JSON.stringify({ version: 2, items: [], settings: { hotkey: NEXT, stackHotkey: '' } }));
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
  const state = await settings.evaluate(() => window.paste.prepareImport()); await fault('before');
  await expect(settings.evaluate(token => window.paste.applyImport(token, { mode: 'replace', restoreSettings: true }), state.token)).rejects.toThrow('Injected manifest');
  expect(await keys()).toEqual([HISTORY, STACK]); expect((await preferences()).hotkey).toBe(HISTORY);
  await application.evaluate(() => globalThis.__restoreFault()); const result = await settings.evaluate(token => window.paste.applyImport(token, { mode: 'replace', restoreSettings: true }), state.token);
  expect(result.ok).toBe(true); expect(await keys()).toEqual([NEXT]); expect((await preferences()).hotkey).toBe(NEXT);
});
test('a committed restore sync warning keeps imported live shortcuts and settings instead of a false rollback', async () => {
  const file = path.join(directory, 'restore-warning.json'); fs.writeFileSync(file, JSON.stringify({ version: 2, items: [], settings: { hotkey: NEXT, stackHotkey: '' } }));
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
  const state = await settings.evaluate(() => window.paste.prepareImport()); await fault('after');
  const result = await settings.evaluate(token => window.paste.applyImport(token, { mode: 'replace', restoreSettings: true }), state.token);
  expect(result.ok).toBe(true); expect(result.warning).toContain('已提交'); expect(await keys()).toEqual([NEXT]); expect((await preferences()).hotkey).toBe(NEXT);
  await expect(settings.locator('[data-shortcut="hotkey"]')).toHaveText('⌘⌥V');
});
