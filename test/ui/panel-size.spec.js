const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
let application, page, directory, ids;
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
}
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-panel-size-ui-')); await launch();
  ids = await application.evaluate(({ nativeImage }, { png, uri }) => {
    const hooks = globalThis.__pasteTest; globalThis.__writes = []; globalThis.__sizeSaves = 0;
    hooks.clip.read = () => { throw Error('Unexpected system clipboard read'); }; hooks.clip.write = async item => { globalThis.__writes.push(item.id); return item.signature; };
    globalThis.__testDisplay = { id: 999, bounds: { x: 0, y: 0, width: 900, height: 900 }, workArea: { x: 0, y: 24, width: 900, height: 850 } };
    hooks.panelSize.display = () => globalThis.__testDisplay; hooks.panelSize.place();
    const save = hooks.panelSize.save; hooks.panelSize.save = height => { globalThis.__sizeSaves++; return save(height); };
    const ids = ['Alpha', 'Beta', 'Gamma'].map(body => hooks.store.add({ type: 'text', body, title: body }).id);
    const buffer = Buffer.from(png, 'base64'), image = nativeImage.createFromBuffer(buffer), asset = hooks.store.putAsset(buffer);
    const signature = hooks.imageSignature(buffer, nativeImage);
    const picture = hooks.store.add({ type: 'image', body: asset, asset, signature, signatureFormat: 'pixels-v1', title: 'Image', preview: hooks.thumbnail(image), size: image.getSize() });
    hooks.store.setOCR(picture.id, signature, { status: 'none', text: '', lines: [], engine: 'fixture' }); ids.push(picture.id);
    ids.push(hooks.store.add({ type: 'file', body: uri, title: 'Files' }).id);
    const board = hooks.store.saveBoard({ name: 'Pinned', color: '#62c68d' }); hooks.store.pinItems(ids.slice(3), board.id); hooks.imageText.onChanged(); return ids;
  }, { png: fs.readFileSync(path.resolve(__dirname, '../fixtures/foreground-mug.png')).toString('base64'), uri: pathToFileURL(directory).href });
  await expect(page.locator('.clip-card')).toHaveCount(5);
});
test.afterEach(async () => { if (application) await application.close(); fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = ids = null; });
const handle = () => page.getByRole('separator', { name: '调整剪贴板高度' });
const bounds = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).getBounds());
async function resize(height) {
  return page.evaluate(async height => { const token = await window.paste.beginPanelResize(0); return window.paste.endPanelResize(token.id, token.height - height); }, height);
}
test('default size retains the measured cards and resizing anchors the native bottom without saving each move', async () => {
  expect((await bounds()).height).toBe(332);
  const before = await page.locator('.clip-card').first().boundingBox(); expect({ width: before.width, height: before.height, top: before.y }).toEqual({ width: 240, height: 240, top: 68 });
  const token = await page.evaluate(() => window.paste.beginPanelResize(568));
  await page.evaluate(id => window.paste.movePanelResize(id, 400), token.id); await expect.poll(() => bounds().then(value => value.height)).toBe(500);
  expect(await application.evaluate(() => globalThis.__sizeSaves)).toBe(0);
  await page.evaluate(id => window.paste.endPanelResize(id, 368), token.id);
  expect(await bounds()).toEqual({ x: 0, y: 368, width: 900, height: 532 });
  expect((await page.evaluate(() => window.paste.getLibrary())).settings.panelHeight).toBe(532); expect(await application.evaluate(() => globalThis.__sizeSaves)).toBe(1);
  await expect(page.locator('.clip-card').first()).toHaveCSS('width', '440px'); await expect(page.locator('.clip-card').first()).toHaveCSS('height', '440px');
});
test('keyboard resizing is bounded, cancel restores the gesture and Enter returns to the default without pasting', async () => {
  await handle().focus(); await page.keyboard.press('ArrowUp'); await expect.poll(() => bounds().then(value => value.height)).toBe(348);
  await page.keyboard.press('Home'); await expect.poll(() => bounds().then(value => value.height)).toBe(180); await expect(page.locator('body')).toHaveClass(/compact/);
  await handle().evaluate(node => {
    for (let n = 0; n < 20000; n++) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, repeat: true, bubbles: true, cancelable: true }));
    node.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
  });
  await expect.poll(() => bounds().then(value => value.height)).toBe(876);
  await page.keyboard.press('End'); await expect.poll(() => bounds().then(value => value.height)).toBe(876);
  await page.keyboard.down('ArrowDown'); await expect.poll(() => bounds().then(value => value.height)).toBe(860);
  await page.keyboard.press('Escape'); await page.keyboard.up('ArrowDown'); await expect.poll(() => bounds().then(value => value.height)).toBe(876);
  await handle().focus(); await page.keyboard.press('Enter'); await expect.poll(() => bounds().then(value => value.height)).toBe(332);
  expect(await application.evaluate(() => globalThis.__writes)).toEqual([]); await expect(handle()).toHaveAttribute('aria-valuenow', '332');
});
test('a quick pointer gesture closes its pending begin session and coalesces updates without any desktop input', async () => {
  await page.locator('#timeline').focus();
  await application.evaluate(() => { const size = globalThis.__pasteTest.panelSize, move = size.move.bind(size); globalThis.__sizeMoves = 0; size.move = (...args) => { globalThis.__sizeMoves++; return move(...args); }; });
  await handle().evaluate(node => {
    // Synthetic own-window coordinates exercise the real event/controller/IPC
    // path; capture is adapted because no physical desktop pointer is held.
    node.setPointerCapture = () => {}; node.hasPointerCapture = () => false;
    const pointer = (type, y, id = 42) => node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, isPrimary: true, button: 0, screenY: y }));
    pointer('pointerdown', 700); pointer('pointercancel', 650, 43); pointer('lostpointercapture', 650, 43);
    for (let n = 0; n < 100; n++) pointer('pointermove', 699 - n); pointer('pointerup', 540);
  });
  await expect.poll(() => bounds().then(value => value.height)).toBe(492);
  await expect.poll(() => application.evaluate(() => globalThis.__pasteTest.panelSize.session)).toBe(null);
  expect(await application.evaluate(() => globalThis.__sizeSaves)).toBe(1); await expect(page.locator('body')).not.toHaveClass(/resizing/);
  expect(await application.evaluate(() => globalThis.__sizeMoves)).toBeLessThanOrEqual(3); await expect(page.locator('#timeline')).toBeFocused();
});
test('whole-window focus loss cancels the resize even if its focused element never receives blur, and reopening stays usable', async () => {
  await handle().evaluate(node => {
    node.setPointerCapture = () => {}; node.hasPointerCapture = () => false;
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 55, isPrimary: true, button: 0, screenY: 700 }));
  });
  await expect.poll(() => application.evaluate(() => !!globalThis.__pasteTest.panelSize.session)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('body')).not.toHaveClass(/resizing/);
  await expect.poll(() => application.evaluate(() => globalThis.__pasteTest.panelSize.session)).toBe(null);
  expect(await application.evaluate(() => globalThis.__sizeSaves)).toBe(0);
  await page.evaluate(() => window.paste.hide()); await application.evaluate(() => globalThis.__pasteTest.showPanel());
  await handle().focus(); await page.keyboard.press('ArrowUp');
  await expect.poll(() => page.evaluate(() => window.paste.getLibrary()).then(value => value.settings.panelHeight)).toBe(348);
});
test('remembered size survives real restart and backup preferences without changing any original item', async () => {
  const before = await page.evaluate(ids => Promise.all(ids.map(id => window.paste.getItem(id))), ids);
  await resize(532); await application.close(); await launch();
  await expect.poll(() => bounds().then(value => value.height)).toBe(532);
  const after = await page.evaluate(ids => Promise.all(ids.map(id => window.paste.getItem(id))), ids);
  for (const [index, item] of after.entries()) {
    const { body, preview, ...metadata } = item, { body: oldBody, preview: oldPreview, ...oldMetadata } = before[index];
    expect(metadata).toEqual(oldMetadata); expect(body === oldBody).toBe(true); expect(preview === oldPreview).toBe(true);
  }
  expect(await application.evaluate(() => globalThis.__pasteTest.store.exportData().settings.panelHeight)).toBe(532);
});
test('hiding or changing display cancels an old resize and late messages cannot move a new panel', async () => {
  const token = await page.evaluate(() => window.paste.beginPanelResize(568)); await page.evaluate(id => window.paste.movePanelResize(id, 400), token.id);
  await page.evaluate(() => window.paste.hide()); expect(await page.evaluate(id => window.paste.movePanelResize(id, 200), token.id)).toEqual({ ok: false });
  await application.evaluate(() => globalThis.__pasteTest.showPanel()); await expect.poll(() => bounds().then(value => value.height)).toBe(332);
  await application.evaluate(() => globalThis.__pasteTest.panelSize.place()); const next = await page.evaluate(() => window.paste.beginPanelResize(568));
  await application.evaluate(() => { globalThis.__testDisplay = { id: 1000, bounds: { x: 0, y: 0, width: 390, height: 600 }, workArea: { y: 24 } }; });
  expect(await page.evaluate(id => window.paste.movePanelResize(id, 100), next.id)).toEqual({ ok: false }); await application.evaluate(() => globalThis.__pasteTest.panelSize.place());
  expect(await bounds()).toEqual({ x: 0, y: 268, width: 390, height: 332 });
});
test('failed size persistence restores the remembered geometry and retry saves without touching content', async () => {
  await application.evaluate(() => { const store = globalThis.__pasteTest.store; globalThis.__sizePersist = store.persist; store.persist = () => { throw Error('Injected size disk failure'); }; });
  await handle().focus(); await page.keyboard.press('ArrowUp'); await expect(page.locator('#status')).toContainText('disk failure');
  await expect.poll(() => bounds().then(value => value.height)).toBe(332);
  expect((await page.evaluate(() => window.paste.getLibrary())).settings.panelHeight).toBe(332);
  await application.evaluate(() => { globalThis.__pasteTest.store.persist = globalThis.__sizePersist; });
  await handle().focus(); await page.keyboard.press('ArrowUp'); await expect.poll(() => page.evaluate(() => window.paste.getLibrary()).then(value => value.settings.panelHeight)).toBe(348);
  expect(await application.evaluate(() => globalThis.__writes)).toEqual([]);
});
test('compact selection, Quick Paste, search and virtual scrolling still refer to the same items after changing height', async () => {
  await resize(212); await expect(page.locator('.clip-card').first()).toHaveCSS('width', '160px'); await expect(page.locator('.clip-card').first()).toHaveCSS('height', '120px');
  await page.locator(`.clip-card[data-id="${ids[1]}"]`).locator('.clip-body').click(); await page.keyboard.press('Meta+c');
  await expect.poll(() => application.evaluate(() => globalThis.__writes)).toEqual([ids[1]]);
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('Gamma'); await expect(page.locator('.clip-card')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '搜索剪贴板' }).press('Enter'); await page.keyboard.press('Meta+1');
  await expect.poll(() => application.evaluate(() => globalThis.__writes)).toEqual([ids[1], ids[2]]);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await application.evaluate(() => { const hooks = globalThis.__pasteTest; for (let n = 0; n < 30; n++) hooks.store.add({ type: 'text', body: `Resize ${n}`, title: `Resize ${n}` }); hooks.imageText.onChanged(); });
  await page.locator('#timeline').focus(); await page.keyboard.press('End'); await expect(page.locator(`.clip-card[data-id="${ids[0]}"]`)).toHaveAttribute('aria-selected', 'true');
  await resize(532); await page.locator('#timeline').focus(); await page.keyboard.press('End'); await expect(page.locator(`.clip-card[data-id="${ids[0]}"]`)).toHaveAttribute('aria-selected', 'true');
  expect(await page.locator('.clip-card').count()).toBeLessThan(20);
});
test('large and compact media layouts render without overlaps at narrow widths and keep inline naming usable', async () => {
  await application.evaluate(() => { globalThis.__testDisplay.bounds.width = 390; globalThis.__pasteTest.panelSize.place(); });
  for (const [theme, height] of [['light', 532], ['dark', 212]]) {
    await page.evaluate(theme => window.paste.saveSettings({ theme }), theme); await resize(height);
    const image = page.locator(`.clip-card[data-id="${ids[3]}"]`); await image.locator('.clip-label').click();
    const input = page.getByRole('textbox', { name: '项目名称', exact: true }); await input.fill('Named image');
    await expect.poll(() => image.locator('.image-preview img').evaluate(node => node.complete && node.naturalWidth > 0)).toBe(true);
    expect(await input.evaluate(node => { const rect = node.getBoundingClientRect(), card = node.closest('.clip-card').getBoundingClientRect(); return rect.left >= card.left && rect.right <= card.right && rect.left >= 0 && rect.right <= innerWidth && card.left >= 0 && card.right <= innerWidth && rect.bottom <= card.bottom && document.documentElement.scrollWidth <= innerWidth; })).toBe(true);
    await page.screenshot({ path: `test-results/panel-${height}-${theme}.png` }); await input.press('Escape');
  }
});
