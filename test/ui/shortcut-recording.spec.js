const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, settings, directory;
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-shortcut-recorder-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await application.evaluate(() => { globalThis.__pasteTest.clip.read = () => { throw Error('Unexpected system clipboard read'); }; globalThis.__pasteTest.clip.write = () => { throw Error('Unexpected system clipboard write'); }; });
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); settings = await opened;
  await settings.locator('[data-page="shortcuts"]').click(); await expect(settings.locator('[data-shortcut="nextBoardHotkey"]')).not.toHaveText('');
});
test.afterEach(async () => { if (application) { await application.evaluate(() => { globalThis.__resumeBaselineRelease?.(); globalThis.__restoreRecorderFocus?.(); }).catch(() => {}); await application.close(); } fs.rmSync(directory, { recursive: true, force: true }); application = page = settings = directory = null; });
async function start(key = 'nextBoardHotkey') {
  const button = settings.locator(`[data-shortcut="${key}"]`); await button.click(); await expect(button).toHaveClass(/recording/); await expect(button).toHaveAttribute('aria-busy', 'false'); return button;
}
const preferences = () => settings.evaluate(async () => (await window.paste.getLibrary()).settings);
const ownerToken = () => application.evaluate(() => globalThis.__pasteTest.shortcutRecorder.current?.id ?? null);
async function nativeKey(key, modifiers = ['meta'], release = true) {
  await application.evaluate(({ BrowserWindow }, { key, modifiers, release }) => {
    const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/settings.html'));
    owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    if (release) owner.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: [] });
  }, { key, modifiers, release });
}
for (const key of ['T', 'N', 'O']) test(`recording native Command-${key} changes the requested binding without running the product command`, async () => {
  await settings.locator('[data-shortcut="nextBoardHotkey"]').click(); await expect(settings.locator('[data-shortcut="nextBoardHotkey"]')).toHaveClass(/recording/);
  await nativeKey(key);
  await expect.poll(() => settings.evaluate(async () => (await window.paste.getLibrary()).settings.nextBoardHotkey)).toBe(`CommandOrControl+${key}`);
  expect(await application.evaluate(() => globalThis.__pasteTest.store.data.settings.paused)).toBe(false);
  expect(application.windows()).toHaveLength(2);
});
for (const key of ['Q', 'W', 'C', 'V']) test(`recording native Command-${key} suppresses menu accelerators without quitting, closing or accessing the system clipboard`, async () => {
  // Harmless native menu probes replace copy/paste endpoints; no general
  // pasteboard operation is allowed even if accelerator suppression regresses.
  await application.evaluate(({ Menu }) => {
    globalThis.__recordingMenuActions = [];
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Test', submenu: [
      { label: 'Copy probe', accelerator: 'CommandOrControl+C', click: () => globalThis.__recordingMenuActions.push('copy') },
      { label: 'Paste probe', accelerator: 'CommandOrControl+V', click: () => globalThis.__recordingMenuActions.push('paste') }, { role: 'close' }, { role: 'quit' }
    ] }]));
  });
  await start(); await nativeKey(key); await expect.poll(async () => (await preferences()).nextBoardHotkey).toBe(`CommandOrControl+${key}`);
  expect(application.windows()).toHaveLength(2); expect(await application.evaluate(() => globalThis.__recordingMenuActions)).toEqual([]);
});
test('held combinations and repeat inputs do not save or run commands before the full release, then commit once', async () => {
  const before = await settings.evaluate(() => window.paste.getLibrary()), button = await start(); await nativeKey('T', ['meta'], false);
  await expect(button).toHaveText('⌘T'); for (let n = 0; n < 8; n++) await nativeKey('T', ['meta', 'isautorepeat'], false);
  expect((await preferences()).nextBoardHotkey).toBe('CommandOrControl+Right'); expect(await application.evaluate(() => globalThis.__pasteTest.store.data.settings.paused)).toBe(false);
  await settings.screenshot({ path: 'test-results/shortcut-recording-held.png' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/settings.html')).webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['meta'] }));
  expect((await preferences()).nextBoardHotkey).toBe('CommandOrControl+Right'); await settings.keyboard.up('Meta');
  await expect.poll(async () => (await preferences()).nextBoardHotkey).toBe('CommandOrControl+T');
  expect((await settings.evaluate(() => window.paste.getLibrary())).revision).toBe(before.revision + 1); await expect(button).not.toHaveClass(/recording/);
});
test('Escape, Tab, page navigation and outside clicks cancel capture and normal application commands resume', async () => {
  for (const kind of ['Escape', 'Tab', 'page', 'outside']) {
    const button = await start();
    if (kind === 'page') { await settings.locator('[data-page="general"]').click(); await settings.locator('[data-page="shortcuts"]').click(); }
    else if (kind === 'outside') await settings.locator('#pageTitle').click(); else await settings.keyboard.press(kind);
    await expect(button).not.toHaveClass(/recording/); await expect.poll(ownerToken).toBe(null); expect((await preferences()).nextBoardHotkey).toBe('CommandOrControl+Right');
  }
  await nativeKey('T'); await expect.poll(async () => (await preferences()).paused).toBe(true);
});
test('switching fields ignores old tokens and background snapshots preserve the active capture', async () => {
  await start(); const first = await ownerToken(); const button = await start('previousBoardHotkey'), second = await ownerToken(); expect(second).not.toBe(first);
  expect(await settings.evaluate(id => window.paste.cancelShortcut(id), first)).toBe(false); expect(await ownerToken()).toBe(second);
  await settings.evaluate(() => window.paste.saveSettings({ theme: 'dark' })); await expect(button).toHaveClass(/recording/);
  await nativeKey('O'); await expect.poll(async () => (await preferences()).previousBoardHotkey).toBe('CommandOrControl+O'); expect((await preferences()).nextBoardHotkey).toBe('CommandOrControl+Right');
});
test('native blur, document reload and close/reopen release the old owner instead of leaving shortcut handling suppressed', async () => {
  await start(); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/settings.html')).emit('blur'));
  await expect.poll(ownerToken).toBe(null); await expect(settings.locator('[data-shortcut="nextBoardHotkey"]')).not.toHaveClass(/recording/);
  await start(); await settings.reload(); await settings.locator('[data-page="shortcuts"]').click(); await expect.poll(ownerToken).toBe(null);
  await start(); await settings.close(); await expect.poll(ownerToken).toBe(null);
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); settings = await opened; await settings.locator('[data-page="shortcuts"]').click();
  await start(); await nativeKey('T'); await expect.poll(async () => (await preferences()).nextBoardHotkey).toBe('CommandOrControl+T');
});
test('only the current settings main frame may control capture, invalid fields or stale tokens never change another session', async () => {
  const denied = await page.evaluate(async () => { try { await window.paste.beginShortcut('hotkey'); return ''; } catch (error) { return error.message; } }); expect(denied).toContain('设置窗口');
  await start(); const id = await ownerToken();
  const invalid = await settings.evaluate(async () => { try { await window.paste.beginShortcut('paused'); return ''; } catch (error) { return error.message; } }); expect(invalid).toContain('设置窗口');
  const stale = await settings.evaluate(async () => { try { await window.paste.finishShortcut('old-token', 'CommandOrControl+T'); return ''; } catch (error) { return error.message; } }); expect(stale).toContain('录制已结束');
  expect(await ownerToken()).toBe(id); expect((await preferences()).paused).toBe(false);
});
test('a binding changed during capture is not overwritten by an old candidate and the user can retry', async () => {
  await start('hotkey'); await settings.evaluate(() => window.paste.saveSettings({ hotkey: 'CommandOrControl+Alt+X' })); await nativeKey('Z', ['meta', 'alt']);
  await expect(settings.locator('#settingsStatus')).toContainText('另一处改变'); expect((await preferences()).hotkey).toBe('CommandOrControl+Alt+X'); await expect.poll(ownerToken).toBe(null);
  await start('hotkey'); await nativeKey('V', ['meta', 'alt']); await expect.poll(async () => (await preferences()).hotkey).toBe('CommandOrControl+Alt+V');
});
test('already registered global keys survive an ignored IME candidate without activation or re-registration, then resume outside capture', async () => {
  await application.evaluate(({ BrowserWindow }) => {
    const h = globalThis.__pasteTest, owner = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/settings.html')), focused = owner.isFocused;
    globalThis.__recorderFocused = true; owner.isFocused = () => globalThis.__recorderFocused; globalThis.__restoreRecorderFocus = () => { owner.isFocused = focused; };
    globalThis.__recordedGlobals = new Map(); globalThis.__globalOperations = []; globalThis.__globalActions = [];
    h.hotkeys.registry = { register: (key, action) => { globalThis.__globalOperations.push(['register', key]); globalThis.__recordedGlobals.set(key, action); return true; },
      unregister: key => { globalThis.__globalOperations.push(['unregister', key]); globalThis.__recordedGlobals.delete(key); }, isRegistered: key => globalThis.__recordedGlobals.has(key) };
    h.hotkeys.callbacks = { history: () => globalThis.__globalActions.push('history'), stack: () => globalThis.__globalActions.push('stack') };
    h.hotkeys.disabled = false; h.hotkeys.apply(h.store.data.settings); globalThis.__globalOperations.length = 0;
  });
  const before = await settings.evaluate(() => window.paste.getLibrary()), button = await start('hotkey');
  await settings.evaluate(() => { window.__recorderMessages = 0; window.paste.onShortcutRecording(() => { window.__recorderMessages += 1; }); });
  await button.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await application.evaluate(() => globalThis.__recordedGlobals.get('CommandOrControl+Shift+V')());
  await expect.poll(() => settings.evaluate(() => window.__recorderMessages)).toBe(1); await expect(button).toHaveText('按下快捷键');
  await button.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await application.evaluate(() => { for (let n = 0; n < 6; n++) globalThis.__recordedGlobals.get('CommandOrControl+Shift+V')(); });
  await expect(button).toHaveText('⌘⇧V'); expect(await application.evaluate(() => globalThis.__globalActions)).toEqual([]);
  await expect.poll(() => settings.evaluate(() => window.__recorderMessages)).toBe(7);
  await button.evaluate(node => node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }))); await expect(button).not.toHaveClass(/recording/); await expect.poll(ownerToken).toBe(null);
  expect((await settings.evaluate(() => window.paste.getLibrary())).revision).toBe(before.revision + 1);
  expect(await application.evaluate(() => globalThis.__globalOperations)).toEqual([]);
  await application.evaluate(() => globalThis.__recordedGlobals.get('CommandOrControl+Shift+V')()); expect(await application.evaluate(() => globalThis.__globalActions)).toEqual(['history']);
  await start('stackHotkey'); await application.evaluate(() => { globalThis.__recorderFocused = false; globalThis.__recordedGlobals.get('CommandOrControl+Shift+V')(); });
  await expect.poll(ownerToken).toBe(null); expect(await application.evaluate(() => globalThis.__globalActions)).toEqual(['history', 'history']);
});
test('composition and Dead/repeat inputs do not commit a half-entered shortcut or invoke the paused command', async () => {
  const button = await start(); await button.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await nativeKey('T'); expect((await preferences()).paused).toBe(false); expect((await preferences()).nextBoardHotkey).toBe('CommandOrControl+Right');
  await button.evaluate(node => {
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    for (const fields of [{ key: 'Dead' }, { key: 'O', repeat: true }, { key: 'O', isComposing: true }]) node.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, bubbles: true, cancelable: true, ...fields }));
  });
  expect((await preferences()).nextBoardHotkey).toBe('CommandOrControl+Right'); await nativeKey('O'); await expect.poll(async () => (await preferences()).nextBoardHotkey).toBe('CommandOrControl+O');
});
test('Escape cancels a recording completion still waiting behind another settings operation', async () => {
  await settings.evaluate(() => window.paste.pauseCapture(null));
  await application.evaluate(() => {
    const monitor = globalThis.__pasteTest.monitor; let release; const gate = new Promise(resolve => { release = resolve; });
    globalThis.__resumeBaselineRelease = release; monitor.readVersion = async () => { await gate; return 500; };
  });
  await settings.evaluate(() => { window.__resumeDone = window.paste.resumeCapture(); });
  await expect.poll(async () => (await preferences()).paused).toBe(false);
  const button = await start(); await settings.keyboard.press('Meta+Alt+z');
  await expect(button).toHaveAttribute('aria-busy', 'true'); await nativeKey('Escape', []); await expect.poll(ownerToken).toBe(null);
  await application.evaluate(() => globalThis.__resumeBaselineRelease()); await settings.evaluate(() => window.__resumeDone);
  await settings.evaluate(() => window.paste.saveSettings({ theme: 'dark' })); expect((await preferences()).nextBoardHotkey).toBe('CommandOrControl+Right');
});
