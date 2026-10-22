const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
let application, page, directory, ids;
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-open-ui-'));
  for (const name of ['first.txt', '中文 # second.txt', 'run.command']) fs.writeFileSync(path.join(directory, name), 'fixture', { mode: 0o600 });
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  ids = await application.evaluate((_, uris) => {
    const h = globalThis.__pasteTest; globalThis.__opens = []; globalThis.__confirms = [];
    h.clip.read = () => { throw Error('Unexpected system clipboard read'); }; h.clip.write = () => { throw Error('Unexpected system clipboard write'); };
    h.itemOpener.openURL = async value => globalThis.__opens.push(['url', value]);
    h.itemOpener.openPath = async value => { globalThis.__opens.push(['file', value]); return ''; };
    h.itemOpener.confirm = async value => { globalThis.__confirms.push(value); return false; };
    const link = h.store.add({ type: 'link', body: '\n https://example.com/paste-open\t', title: 'Open link' });
    const files = h.store.add({ type: 'file', body: uris.slice(0, 2).join('\n'), title: 'Open files' });
    const risky = h.store.add({ type: 'file', body: uris[2], title: 'Risky file' });
    const text = h.store.add({ type: 'text', body: 'Ordinary plain text', title: 'Text' });
    const board = h.store.saveBoard({ name: 'Open Pinboard', color: '#62c68d' }); h.store.pinItems([link.id, files.id], board.id); h.imageText.onChanged();
    return { link: link.id, files: files.id, risky: risky.id, text: text.id, board: board.id };
  }, ['first.txt', '中文 # second.txt', 'run.command'].map(name => pathToFileURL(path.join(directory, name)).href));
  await expect(page.locator('.clip-card')).toHaveCount(4);
});
test.afterEach(async () => { if (application) await application.close(); fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = ids = null; });
const card = id => page.locator(`.clip-card[data-id="${id}"]`);
const opens = () => application.evaluate(() => globalThis.__opens);
async function preview(id, mode = 'view') {
  const wait = application.waitForEvent('window'); await page.evaluate(({ id, mode }) => window.paste.openPreview(id, { mode, ids: [id] }), { id, mode });
  const window = await wait; await window.waitForFunction(() => document.querySelector('.preview-shell')?.inert === false); return window;
}
async function nativeOpen(file, repeat = false) {
  // CDP keyboard input cannot exercise before-input-event inside an opaque iframe.
  await application.evaluate(({ BrowserWindow }, { file, repeat }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith(`/${file}`));
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['meta', ...(repeat ? ['isautorepeat'] : [])] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['meta'] });
  }, { file, repeat });
}
test('CmdO opens selected link through real native input, menu/IPC and service without touching clipboard', async () => {
  const before = await page.evaluate(() => window.paste.getLibrary()); await card(ids.link).click(); await nativeOpen('index.html', true); expect(await opens()).toEqual([]); await nativeOpen('index.html');
  await expect.poll(opens).toEqual([['url', 'https://example.com/paste-open']]);
  const after = await page.evaluate(() => window.paste.getLibrary()); expect(after.items).toEqual(before.items);
});
test('native File menu dispatches only to its own product window and ignores settings', async () => {
  await card(ids.link).click();
  await application.evaluate(({ BrowserWindow, Menu }) => {
    const entry = Menu.getApplicationMenu().getMenuItemById('open-item');
    const panel = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')); entry.click(entry, panel);
  });
  await expect.poll(opens).toHaveLength(1);
  const wait = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); await wait;
  await application.evaluate(({ BrowserWindow, Menu }) => {
    const entry = Menu.getApplicationMenu().getMenuItemById('open-item');
    const settings = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/settings.html')); entry.click(entry, settings);
  });
  expect(await opens()).toHaveLength(1);
});
test('multi-select menu opens all files and link once in visible order; unsupported mixed selection is disabled', async () => {
  await card(ids.link).click(); await card(ids.files).click({ modifiers: ['Meta'] });
  const visible = await page.locator('.clip-card.selected').evaluateAll(nodes => nodes.map(node => node.dataset.id));
  await card(ids.files).click({ button: 'right' }); await page.getByRole('menuitem', { name: /^打开/ }).click();
  const expected = visible.flatMap(id => id === ids.link ? [['url', 'https://example.com/paste-open']] : [['file', path.join(directory, 'first.txt')], ['file', path.join(directory, '中文 # second.txt')]]);
  await expect.poll(opens).toEqual(expected);
  await card(ids.link).click(); await card(ids.text).click({ modifiers: ['Meta'] }); await card(ids.text).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /^打开/ })).toBeDisabled(); expect(await opens()).toEqual(expected);
});
test('search and Pinboard select the same stored item, never the first unrelated result', async () => {
  await page.keyboard.press('Meta+f'); await page.locator('#searchInput').fill('Open link');
  await expect(page.locator('.clip-card')).toHaveCount(1); await card(ids.link).click(); await page.keyboard.press('Meta+o'); await expect.poll(opens).toHaveLength(1);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.locator(`[data-board="${ids.board}"]`).click(); await expect(page.locator('.clip-card')).toHaveCount(2);
  await card(ids.files).click(); await page.keyboard.press('Meta+o'); await expect.poll(opens).toHaveLength(3);
});
test('typing, composition, exact modifiers, repeat and pending search never queue an open', async () => {
  await card(ids.link).click();
  await page.locator('#timeline').evaluate(node => {
    for (const fields of [{ repeat: true }, { isComposing: true }, { shiftKey: true }, { altKey: true }]) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', metaKey: true, bubbles: true, cancelable: true, ...fields }));
  });
  await page.keyboard.press('Meta+f'); await page.locator('#searchInput').fill('Open'); await page.keyboard.press('Meta+o');
  await expect(page.locator('#searchInput')).toBeFocused(); expect(await opens()).toEqual([]);
});
test('file preview provides per-row Open and Finder separately and fits narrow light/dark windows', async () => {
  const window = await preview(ids.files); await window.getByRole('button', { name: '打开文件', exact: true }).nth(1).click();
  await expect.poll(opens).toEqual([['file', path.join(directory, '中文 # second.txt')]]);
  await window.getByRole('button', { name: '打开', exact: true }).click(); await expect.poll(opens).toHaveLength(3);
  await expect(window.getByRole('button', { name: '在 Finder 中显示', exact: true })).toHaveCount(2);
  await application.evaluate(({ BrowserWindow, nativeTheme }) => { nativeTheme.themeSource = 'dark'; BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/preview.html')).setSize(320, 450); });
  expect(await window.locator('.preview-shell').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await window.locator('.file-list').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await window.screenshot({ path: 'test-results/open-files-320-dark.png' });
});
test('rich preview native CmdO works inside its sandbox without making HTML links active', async () => {
  await application.evaluate((_, id) => { globalThis.__pasteTest.store.update(id, { body: 'https://example.com/paste-open', html: '<p><a href="https://example.com/paste-open">Open link</a></p>' }); }, ids.link);
  const window = await preview(ids.link); const frame = window.frameLocator('iframe');
  await expect(frame.locator('a')).not.toHaveAttribute('href'); await frame.locator('body').click();
  expect(await window.evaluate(() => document.activeElement.tagName)).toBe('IFRAME');
  await nativeOpen('preview.html', true); expect(await opens()).toEqual([]); await nativeOpen('preview.html');
  await expect.poll(opens).toEqual([['url', 'https://example.com/paste-open']]);
});
test('edit/rename previews and untrusted settings cannot open saved content under a draft', async () => {
  const window = await preview(ids.link, 'rename'); await expect(window.locator('#openPreviewItem')).toBeHidden();
  const failure = await window.evaluate(async id => { try { await window.paste.openItems([id]); return ''; } catch (error) { return error.message; } }, ids.link);
  expect(failure).toContain('当前预览'); await window.keyboard.press('Meta+o'); expect(await opens()).toEqual([]);
  await window.close(); const wait = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); const settings = await wait;
  const rejected = await settings.evaluate(async id => { try { await window.paste.openItems([id]); return ''; } catch (error) { return error.message; } }, ids.link);
  expect(rejected).toContain('主面板'); expect(await opens()).toEqual([]);
});
test('confirmation cancel preserves selection, and late confirmation cannot open an edited source', async () => {
  await card(ids.risky).click(); await page.keyboard.press('Meta+o'); await expect.poll(() => application.evaluate(() => globalThis.__confirms.length)).toBe(1); expect(await opens()).toEqual([]);
  await application.evaluate(() => { globalThis.__pasteTest.itemOpener.confirm = () => new Promise(resolve => { globalThis.__confirmRelease = resolve; }); });
  await page.keyboard.press('Meta+o'); await expect.poll(() => application.evaluate(() => !!globalThis.__confirmRelease)).toBe(true);
  await application.evaluate((_, id) => { globalThis.__pasteTest.store.delete([id]); globalThis.__confirmRelease(true); }, ids.risky);
  await expect(page.locator('#status')).toContainText('已改变'); expect(await opens()).toEqual([]);
});
test('OS failure reports partial opening without consuming Stack or rewriting source items', async () => {
  await application.evaluate(() => { globalThis.__pasteTest.itemOpener.openPath = async value => { globalThis.__opens.push(['file', value]); return globalThis.__opens.length === 2 ? 'OS failure' : ''; }; });
  await card(ids.files).click(); await page.keyboard.press('Meta+o'); await expect(page.locator('#status')).toContainText('其余未打开');
  expect(await opens()).toHaveLength(2); expect((await page.evaluate(id => window.paste.getItem(id), ids.files)).body).toContain('first.txt');
  expect(await application.evaluate(() => globalThis.__pasteTest.stackQueue.entries)).toEqual([]);
});
test('late confirmation cannot open after hiding and reopening the panel', async () => {
  await application.evaluate(() => { globalThis.__pasteTest.itemOpener.confirm = () => new Promise(resolve => { globalThis.__confirmRelease = resolve; }); });
  await card(ids.risky).click(); await page.keyboard.press('Meta+o'); await expect.poll(() => application.evaluate(() => !!globalThis.__confirmRelease)).toBe(true);
  await page.evaluate(() => window.paste.hide()); await application.evaluate(() => globalThis.__pasteTest.showPanel());
  await application.evaluate(() => globalThis.__confirmRelease(true)); await expect(page.locator('#status')).toContainText('窗口已改变');
  expect(await opens()).toEqual([]); await card(ids.link).click(); await page.keyboard.press('Meta+o'); await expect.poll(opens).toHaveLength(1);
});
test('pending search CmdO does not execute when results arrive later', async () => {
  await application.evaluate(() => {
    const service = globalThis.__pasteTest.searchService, search = service.search.bind(service);
    service.search = (...args) => new Promise(resolve => { globalThis.__searchRelease = async () => resolve(await search(...args)); });
  });
  await card(ids.link).click(); await page.keyboard.press('Meta+f'); await page.locator('#searchInput').fill('Open link');
  await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'true'); await page.locator('#timeline').focus(); await page.keyboard.press('Meta+o');
  await application.evaluate(() => globalThis.__searchRelease()); await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false'); expect(await opens()).toEqual([]);
});
test('a metadata-only preview refresh cannot swallow OS opening failure feedback', async () => {
  await application.evaluate(() => { globalThis.__pasteTest.itemOpener.openPath = () => new Promise(resolve => { globalThis.__openRelease = resolve; }); });
  const window = await preview(ids.files); await window.evaluate(() => { window.previousFileList = document.querySelector('.file-list'); });
  await window.getByRole('button', { name: '打开文件', exact: true }).first().click();
  await expect.poll(() => application.evaluate(() => !!globalThis.__openRelease)).toBe(true);
  await application.evaluate(() => globalThis.__pasteTest.imageText.onChanged());
  await window.waitForFunction(() => document.querySelector('.file-list') !== window.previousFileList);
  await application.evaluate(() => globalThis.__openRelease('OS rejected'));
  await expect(window.locator('#previewStatus')).toContainText('系统未能打开'); await expect(window.locator('#previewStatus')).toBeVisible();
  expect(await opens()).toEqual([]);
});
