const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, directory, ids;
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-keyboard-nav-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  ids = await application.evaluate(() => {
    const h = globalThis.__pasteTest; globalThis.__writes = [];
    h.clip.read = () => { throw Error('Unexpected system clipboard read'); };
    h.clip.write = async (item, options) => { globalThis.__writes.push({ id: item.id, body: item.body, plain: options.plain }); return h.textSignature(item.body); };
    const list = Array.from({ length: 60 }, (_, n) => h.store.add({ type: n % 2 ? 'link' : 'text', body: n % 2 ? `https://example.com/Needle-${n}` : `Needle item ${n}`, title: `Item ${n}` }).id).reverse();
    const board = h.store.saveBoard({ name: 'Order', color: '#62c68d' }), empty = h.store.saveBoard({ name: 'Empty', color: '#ef6259' });
    h.store.pinItems(list.slice(0, 6), board.id); h.store.reorderBoardItems(board.id, list.slice(0, 6).reverse()); h.imageText.onChanged();
    return { list, board: board.id, empty: empty.id };
  });
  await expect(page.locator('.clip-card')).not.toHaveCount(0);
});
test.afterEach(async () => { if (application) await application.close(); fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = ids = null; });
const selected = () => page.locator('.clip-card.selected').evaluateAll(nodes => nodes.map(node => node.dataset.id));
const writes = () => application.evaluate(() => globalThis.__writes);
async function selectedOne(id) { await expect(page.locator(`.clip-card[data-id="${id}"]`)).toHaveAttribute('aria-selected', 'true'); }
test('Command Up/Down reaches actual first/last across virtualized cards and Home/End still works', async () => {
  await page.locator('#timeline').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Meta+ArrowDown'); await selectedOne(ids.list.at(-1));
  await expect.poll(() => page.evaluate(id => {
    const node = document.querySelector(`.clip-card[data-id="${id}"]`); if (!node) return false;
    const card = node.getBoundingClientRect(), area = document.querySelector('#timeline').getBoundingClientRect();
    return card.left >= area.left && card.right <= area.right;
  }, ids.list.at(-1))).toBe(true);
  await page.keyboard.press('Meta+ArrowUp'); await selectedOne(ids.list[0]); await page.keyboard.press('End'); await selectedOne(ids.list.at(-1));
  await page.keyboard.press('Home'); await selectedOne(ids.list[0]); expect(await writes()).toEqual([]);
});
test('Command Shift boundary selection expands and contracts a stable anchor rather than resetting it', async () => {
  await page.locator('#timeline').focus(); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Meta+Shift+ArrowDown'); await selectedOne(ids.list.at(-1));
  await page.keyboard.press('Meta+c'); await expect.poll(writes).toHaveLength(1); expect((await writes())[0].body.split('\n')).toHaveLength(59);
  await page.keyboard.press('Meta+Shift+ArrowUp'); await selectedOne(ids.list[0]); await expect(page.locator('.clip-card.selected')).toHaveCount(2);
});
test('boundaries use Pinboard custom order and handle an empty board without opening or deleting anything', async () => {
  await page.locator(`[data-board="${ids.board}"]`).click(); await page.locator('#timeline').focus();
  await page.keyboard.press('Meta+ArrowDown'); await selectedOne(ids.list[0]); await page.keyboard.press('Meta+ArrowUp'); await selectedOne(ids.list[5]);
  await page.locator(`[data-board="${ids.empty}"]`).click(); await page.locator('#timeline').focus(); await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.press('Meta+ArrowUp');
  await expect(page.locator('.clip-card')).toHaveCount(0); expect((await page.evaluate(() => window.paste.getLibrary())).items).toHaveLength(60); expect(await writes()).toEqual([]);
});
test('second Command F opens all filters, retains query and conditions and is idempotent from inside the popup', async () => {
  await page.keyboard.press('Meta+f'); await expect(page.locator('#searchInput')).toBeFocused(); await expect(page.locator('#filters')).toBeHidden();
  await page.locator('#searchInput').fill('Needle'); await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false');
  await page.keyboard.press('Meta+f'); await expect(page.locator('#filters')).toBeVisible(); await expect(page.locator('#typeFilters [aria-pressed="true"]')).toBeFocused();
  await page.locator('#typeFilters [data-type="text"]').click(); await page.keyboard.press('Meta+f'); await expect(page.locator('#filters')).toBeVisible();
  await expect(page.locator('#typeFilters [data-type="text"]')).toBeFocused(); await expect(page.locator('#searchInput')).toHaveValue('Needle');
  await page.locator('#sourceFilter').focus(); await page.keyboard.press('Meta+f'); await expect(page.locator('#typeFilters [data-type="text"]')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('#filters')).toBeHidden(); await expect(page.locator('#filterToggle')).toBeFocused();
  await expect(page.locator('#filterTokens')).toContainText('文本'); expect(await writes()).toEqual([]);
});
test('search commands ignore repeat, extra modifiers and IME; native cursor movement inside search text remains native', async () => {
  await page.locator('#timeline').focus();
  await page.locator('#timeline').evaluate(node => {
    for (const flags of [{ repeat: true }, { shiftKey: true }, { altKey: true }, { isComposing: true }, { ctrlKey: true }]) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true, ...flags }));
  });
  await expect(page.locator('#searchBox')).toBeHidden();
  await page.keyboard.press('Meta+f'); await page.locator('#searchInput').fill('Needle'); await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false');
  const before = await selected(); await page.keyboard.press('Meta+ArrowUp'); await page.keyboard.press('Meta+ArrowDown'); expect(await selected()).toEqual(before);
  await page.locator('#searchInput').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, repeat: true, bubbles: true, cancelable: true })));
  await expect(page.locator('#filters')).toBeHidden(); expect(await writes()).toEqual([]);
});
test('held Quick Paste digit never sends repeated copies, but a fresh command still works', async () => {
  await page.locator('#timeline').focus(); await page.locator('#timeline').evaluate(node => {
    for (let n = 0; n < 8; n++) node.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', metaKey: true, repeat: true, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('Meta+1'); await expect.poll(async () => (await writes()).at(-1)?.id).toBe(ids.list[0]);
  expect(await writes()).toHaveLength(1); expect((await writes())[0].id).toBe(ids.list[0]);
});
test('filtered search boundaries select only actual results and pending results never queue Quick Paste or a boundary', async () => {
  await page.keyboard.press('Meta+f'); await page.locator('#searchInput').fill('Needle'); await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#filterToggle').click(); await page.locator('#typeFilters [data-type="text"]').click(); await page.locator('#filterToggle').click();
  await page.locator('#timeline').focus(); await page.keyboard.press('Meta+ArrowUp'); await selectedOne(ids.list[1]);
  await page.keyboard.press('Meta+ArrowDown'); await selectedOne(ids.list.at(-1));
  await application.evaluate(() => {
    const service = globalThis.__pasteTest.searchService, search = service.search.bind(service);
    service.search = (...args) => new Promise(resolve => { globalThis.__searchRelease = async () => resolve(await search(...args)); });
  });
  await page.locator('#searchInput').fill('Needle item'); await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'true');
  await page.locator('#timeline').focus(); await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.press('Meta+1');
  await application.evaluate(() => globalThis.__searchRelease()); await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false');
  await selectedOne(ids.list[1]); expect(await writes()).toEqual([]);
});
test('native boundary keys and keyboard filter controls remain usable at 390pt in light and dark', async () => {
  await page.locator('#timeline').focus();
  await application.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['meta'] }); panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['meta'] });
    panel.setSize(390, 332);
  });
  await selectedOne(ids.list.at(-1));
  await expect.poll(() => page.evaluate(id => {
    const node = document.querySelector(`.clip-card[data-id="${id}"]`); if (!node) return false;
    const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
  }, ids.list.at(-1))).toBe(true);
  await page.keyboard.press('Meta+f'); await page.keyboard.press('Meta+f');
  await expect(page.locator('#filters')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await application.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await page.locator('#typeFilters [data-type="text"]').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#typeFilters [data-type="text"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('#filters').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && node.scrollWidth <= node.clientWidth; })).toBe(true);
    await page.screenshot({ path: `test-results/keyboard-filters-390-${theme}.png` });
  }
  expect(await writes()).toEqual([]);
});
