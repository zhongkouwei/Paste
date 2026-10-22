const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
let application, page, directory, ids;
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-rename-ui-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  ids = await application.evaluate(() => {
    const hooks = globalThis.__pasteTest; globalThis.__writes = [];
    hooks.clip.read = () => { throw Error('Unexpected system clipboard read'); };
    hooks.clip.write = async item => { globalThis.__writes.push(item.id); return item.signature; };
    const ids = ['First', 'Second', 'Third'].map(body => hooks.store.add({ type: 'text', body, title: body }).id); hooks.imageText.onChanged(); return ids;
  });
});
test.afterEach(async () => {
  if (application) { await application.evaluate(() => globalThis.__releaseRename?.()).catch(() => {}); await application.close(); }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = ids = null;
});
const card = id => page.locator(`.clip-card[data-id="${id}"]`);
const input = () => page.getByRole('textbox', { name: '项目名称', exact: true });
async function begin(id) { await card(id).locator('.clip-label').click(); await expect(input()).toBeFocused(); }
test('clicking the card label renames in place, persists and becomes searchable without changing the payload or opening a preview', async () => {
  const before = await page.evaluate(id => window.paste.getItem(id), ids[0]);
  await begin(ids[0]); await input().fill('Reusable label'); await input().press('Enter'); await expect(input()).toHaveCount(0);
  await expect(card(ids[0]).locator('.clip-footer')).toHaveText('Reusable label');
  expect(await page.evaluate(id => window.paste.getItem(id), ids[0])).toEqual({ ...before, title: 'Reusable label', renamed: true });
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.webContents.getURL()).filter(url => url.endsWith('/preview.html')))).toEqual([]);
  expect(await application.evaluate(() => globalThis.__writes)).toEqual([]);
  await page.reload(); await expect(card(ids[0]).locator('.clip-footer')).toHaveText('Reusable label');
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('Reusable label');
  await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', ids[0]);
});
test('background captures preserve the connected IME input, composition, selection and draft until explicit confirmation', async () => {
  await begin(ids[0]); await input().fill('Draft label');
  await input().evaluate(node => { window.__renameInput = node; window.__renameBlur = 0; node.addEventListener('blur', () => window.__renameBlur++); node.setSelectionRange(2, 5); node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest; hooks.store.add({ type: 'text', body: 'Background capture', title: 'Background capture' }); hooks.imageText.onChanged();
  });
  await page.evaluate(() => window.paste.saveSettings({ theme: 'light' }));
  expect(await input().evaluate(node => ({ same: node === window.__renameInput, connected: node.isConnected, focused: node === document.activeElement, blur: window.__renameBlur, start: node.selectionStart, end: node.selectionEnd }))).toEqual({ same: true, connected: true, focused: true, blur: 0, start: 2, end: 5 });
  await input().evaluate(node => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); });
  await expect(input()).toHaveValue('Draft label'); expect((await page.evaluate(id => window.paste.getItem(id), ids[0])).title).toBe('First');
  await input().evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await input().press('Enter'); await expect(card(ids[0]).locator('.clip-footer')).toHaveText('Draft label');
  expect(await application.evaluate(() => globalThis.__writes)).toEqual([]);
});
test('Escape cancels without saving or hiding the panel, and double-clicking a label never pastes', async () => {
  const before = await page.evaluate(id => window.paste.getItem(id), ids[0]);
  await card(ids[0]).locator('.clip-label').dblclick(); await expect(input()).toBeFocused();
  await input().fill('Not saved'); await input().press('Escape'); await expect(input()).toHaveCount(0);
  expect(await page.evaluate(id => window.paste.getItem(id), ids[0])).toEqual(before);
  expect(await application.evaluate(() => globalThis.__writes)).toEqual([]); await expect(page.locator('#timeline')).toBeFocused();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(true);
});
test('a blank or failed save retains the input and retries without losing updated content or pinning', async () => {
  await begin(ids[0]); await input().fill(' '); await input().press('Enter'); await expect(input()).toHaveAttribute('aria-invalid', 'true');
  await input().fill('Persistent label');
  await application.evaluate(() => { const store = globalThis.__pasteTest.store; globalThis.__renamePersist = store.persist; store.persist = () => { throw Error('Injected rename disk failure'); }; });
  await input().press('Enter'); await expect(input()).toHaveValue('Persistent label'); await expect(page.locator('#status')).toContainText('disk failure');
  expect((await page.evaluate(id => window.paste.getItem(id), ids[0])).title).toBe('First');
  await application.evaluate((_electron, id) => {
    const hooks = globalThis.__pasteTest; hooks.store.persist = globalThis.__renamePersist;
    hooks.store.update(id, { body: 'Updated while naming', html: '<b>Updated while naming</b>' }); const board = hooks.store.saveBoard({ name: 'Pinned', color: '#62c68d' }); hooks.store.pinItems([id], board.id); hooks.imageText.onChanged();
  }, ids[0]);
  await input().press('Enter'); await expect(input()).toHaveCount(0);
  const item = await page.evaluate(id => window.paste.getItem(id), ids[0]); expect(item.title).toBe('Persistent label'); expect(item.body).toBe('Updated while naming'); expect(item.html).toBe('<b>Updated while naming</b>'); expect(item.boardIds).toHaveLength(1);
});
test('a newer name or deleted source is not overwritten; the old draft remains cancellable and never moves to another card', async () => {
  await begin(ids[0]); await input().fill('Old draft'); await page.evaluate(id => window.paste.updateItem(id, { title: 'Newer name' }), ids[0]);
  await input().press('Enter'); await expect(page.locator('#status')).toContainText('名称已改变'); await expect(input()).toHaveValue('Old draft');
  expect((await page.evaluate(id => window.paste.getItem(id), ids[0])).title).toBe('Newer name');
  await input().press('Escape'); await begin(ids[0]); await input().fill('After deletion');
  await page.evaluate(id => window.paste.deleteItems([id]), ids[0]); await input().press('Enter');
  await expect(page.locator('#status')).toContainText('已被删除'); await expect(input()).toHaveValue('After deletion');
  expect((await page.evaluate(id => window.paste.getItem(id), ids[1])).title).toBe('Second');
  await input().press('Escape'); await expect(card(ids[0])).toHaveCount(0); expect(await application.evaluate(() => globalThis.__writes)).toEqual([]);
});
test('outside pointer confirmation commits once, repeated Enter is ignored and a native blur alone does not save', async () => {
  await application.evaluate(() => {
    const store = globalThis.__pasteTest.store, rename = store.rename.bind(store); globalThis.__renameCalls = 0;
    store.rename = (...args) => { globalThis.__renameCalls++; return rename(...args); };
  });
  await begin(ids[0]); await input().fill('One confirmation'); await input().evaluate(node => node.dispatchEvent(new FocusEvent('blur')));
  expect(await application.evaluate(() => globalThis.__renameCalls)).toBe(0);
  await input().evaluate(node => { for (const repeat of [false, false, true]) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat, bubbles: true, cancelable: true })); });
  await expect(input()).toHaveCount(0); expect(await application.evaluate(() => globalThis.__renameCalls)).toBe(1);
  await begin(ids[1]); await input().fill('Outside confirmation'); await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(input()).toHaveCount(0); expect((await page.evaluate(id => window.paste.getItem(id), ids[1])).title).toBe('Outside confirmation');
  await expect(page.getByRole('searchbox', { name: '搜索剪贴板' })).toBeFocused(); expect(await application.evaluate(() => globalThis.__renameCalls)).toBe(2);
});
test('clicking another card selects that exact item before saving the old name, without copying either item', async () => {
  await begin(ids[0]); await input().fill('Named first'); await card(ids[1]).locator('.clip-body').click();
  await expect(input()).toHaveCount(0); await expect(card(ids[1])).toHaveAttribute('aria-selected', 'true');
  await expect(card(ids[0])).toHaveAttribute('aria-selected', 'false'); expect((await page.evaluate(id => window.paste.getItem(id), ids[0])).title).toBe('Named first');
  expect(await application.evaluate(() => globalThis.__writes)).toEqual([]);
});
test('image and file labels preserve assets and long labels fit light and dark narrow cards without covering the pin', async () => {
  const values = await application.evaluate(({ nativeImage }, { uri, png }) => {
    const hooks = globalThis.__pasteTest, buffer = Buffer.from(png, 'base64'), bitmap = nativeImage.createFromBuffer(buffer), asset = hooks.store.putAsset(buffer);
    const image = hooks.store.add({ type: 'image', body: asset, asset, signature: 'rename-image', title: 'Image', size: bitmap.getSize(), preview: hooks.thumbnail(bitmap) });
    const file = hooks.store.add({ type: 'file', body: uri, title: 'Files' });
    const board = hooks.store.saveBoard({ name: 'Pinned', color: '#62c68d' }); hooks.store.pinItems([image.id, file.id], board.id); hooks.imageText.onChanged(); return [image.id, file.id];
  }, { uri: pathToFileURL(directory).href, png: fs.readFileSync(path.resolve(__dirname, '../fixtures/foreground-mug.png')).toString('base64') });
  await expect(card(values[0]).locator('.image-preview img')).toBeVisible();
  expect(await card(values[0]).locator('.image-preview img').evaluate(node => node.complete && node.naturalWidth > 0)).toBe(true);
  const before = await page.evaluate(ids => Promise.all(ids.map(id => window.paste.getItem(id))), values);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(390, 332));
  for (const [index, id] of values.entries()) {
    await begin(id); const title = (index ? 'File-' : 'Image-') + 'LongLabel'.repeat(20); await input().fill(title);
    await page.evaluate(theme => window.paste.saveSettings({ theme }), index ? 'dark' : 'light');
    await expect(input()).toBeFocused();
    expect(await input().evaluate(node => { const input = node.getBoundingClientRect(), card = node.closest('.clip-card').getBoundingClientRect(), pin = node.closest('.clip-card').querySelector('.clip-pin').getBoundingClientRect(); return input.left > card.left && input.right < pin.left && input.bottom <= card.bottom && document.documentElement.scrollWidth <= innerWidth; })).toBe(true);
    await page.screenshot({ path: `test-results/rename-${index ? 'dark' : 'light'}-narrow.png` });
    await input().press('Enter'); await expect(input()).toHaveCount(0);
    expect(await page.evaluate(id => window.paste.getItem(id), id)).toEqual({ ...before[index], title, renamed: true });
    expect(await card(id).locator('.clip-label').evaluate(node => node.clientWidth < node.scrollWidth)).toBe(true);
  }
});
test('background arrivals that shift a name beyond the virtual slice keep its live input visible and cancellable', async () => {
  await begin(ids[0]); await input().fill('Still editing');
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest; for (let n = 0; n < 30; n++) hooks.store.add({ type: 'text', body: `Arrival ${n}`, title: `Arrival ${n}` }); hooks.imageText.onChanged();
  });
  await expect(input()).toBeFocused(); await expect(input()).toHaveValue('Still editing');
  expect(await input().evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && node.isConnected && document.querySelectorAll('.clip-card').length < 20; })).toBe(true);
  await input().press('Escape'); await expect(input()).toHaveCount(0);
});
