const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, directory, ids;

test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-flow-ui-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  ids = await application.evaluate(() => {
    const hooks = globalThis.__pasteTest;
    globalThis.__writes = []; globalThis.__failCopy = false; globalThis.__holdCopy = false;
    // Exercise the real IPC and copy queue without reading or writing the system clipboard.
    hooks.clip.read = () => { throw new Error('Unexpected system clipboard read'); };
    hooks.clip.write = async (item, options) => {
      globalThis.__writes.push({ id: item.id, body: item.body, plain: options.plain });
      if (globalThis.__holdCopy) { globalThis.__holdCopy = false; await new Promise(resolve => { globalThis.__releaseCopy = resolve; }); }
      if (globalThis.__failCopy) throw new Error('Injected clipboard failure');
      return `synthetic-copy:${item.id}`;
    };
    const ids = ['First', 'Second', 'Third'].map(name => hooks.store.add({ type: 'text', body: `${name} workflow item`, title: name }).id);
    hooks.imageText.onChanged(); return ids;
  });
  await page.evaluate(async ids => { await window.paste.toggleStack(); for (const id of ids) await window.paste.addToStack(id); }, ids.slice(0, 2));
  await expect(page.locator('#stackCount')).toHaveText('2');
});
test.afterEach(async () => {
  if (application) {
    await application.evaluate(() => globalThis.__releaseCopy?.()).catch(() => {});
    await application.close();
  }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = ids = null;
});
const writes = () => application.evaluate(() => globalThis.__writes.map(value => value.id));
const count = () => page.evaluate(() => window.paste.getLibrary()).then(value => value.status.stackCount);
async function hold() { await application.evaluate(() => { globalThis.__holdCopy = true; }); }
async function started() { await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseCopy)).toBe('function'); }
async function release() { await application.evaluate(() => { globalThis.__releaseCopy(); delete globalThis.__releaseCopy; }); }

test('the normal preview-close flow returns to the panel repeatedly without rewriting the item', async () => {
  const original = await page.evaluate(id => window.paste.getItem(id), ids[0]);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), ids[0]);
    const preview = await opened; await expect(preview.getByRole('textbox', { name: '剪贴板内容' })).toBeVisible();
    const closed = preview.waitForEvent('close'); await page.evaluate(() => window.paste.closePreview()); await closed;
    expect((await page.evaluate(() => window.paste.getLibrary())).items).toHaveLength(3);
  }
  expect(await page.evaluate(id => window.paste.getItem(id), ids[0])).toEqual(original);
});

test('rapid preview destruction returns to a live panel without focusing inside native destruction', async () => {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), ids[0]);
    const preview = await opened; await expect(preview.getByRole('textbox', { name: '剪贴板内容' })).toBeVisible();
    const reentrant = await application.evaluate(({ BrowserWindow }) => {
      const panel = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
      const preview = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html'));
      let destroying = true, reentrant = 0;
      const focus = panel.focus; globalThis.__deferredFocus = 0;
      panel.focus = function () {
        if (destroying) { reentrant += 1; return; }
        globalThis.__deferredFocus += 1; return focus.call(this);
      };
      globalThis.__restorePanelFocus = () => { panel.focus = focus; };
      try { preview.destroy(); } finally { destroying = false; }
      return reentrant;
    });
    expect(reentrant).toBe(0);
    // The suite does not own global desktop focus; verify the real native request's timing.
    await expect.poll(() => application.evaluate(() => globalThis.__deferredFocus)).toBe(1);
    await application.evaluate(() => globalThis.__restorePanelFocus());
    expect((await page.evaluate(() => window.paste.getLibrary())).items).toHaveLength(3);
  }
});

test('rapid Stack requests consume distinct heads in order rather than copying one head twice', async () => {
  await hold(); await page.evaluate(() => { window.__pendingCopies = Promise.all([window.paste.nextInStack(), window.paste.nextInStack()]); }); await started();
  await release(); const results = await page.evaluate(() => window.__pendingCopies);
  expect(results.every(result => result.ok)).toBe(true); expect(await writes()).toEqual(ids.slice(0, 2)); expect(await count()).toBe(0);
  expect(await page.evaluate(() => window.paste.nextInStack())).toMatchObject({ ok: false, error: 'Stack 为空' });
});
test('deleting an in-flight head never consumes its still-unpasted successor', async () => {
  await hold(); await page.evaluate(() => { window.__pendingCopy = window.paste.nextInStack(); }); await started();
  await page.evaluate(id => window.paste.deleteItems([id]), ids[0]); expect(await count()).toBe(1);
  await release(); expect(await page.evaluate(() => window.__pendingCopy)).toMatchObject({ ok: true });
  expect(await count()).toBe(1); expect(await writes()).toEqual([ids[0]]);
  await page.evaluate(() => window.paste.nextInStack()); expect(await writes()).toEqual(ids.slice(0, 2)); expect(await count()).toBe(0);
});
test('resetting Stack invalidates queued old requests and protects the new queue from an old completion', async () => {
  await hold();
  await page.evaluate(() => { window.__pendingCopies = Promise.all([window.paste.nextInStack(), window.paste.nextInStack()]); }); await started();
  await page.evaluate(async id => { await window.paste.toggleStack(); await window.paste.toggleStack(); await window.paste.addToStack(id); }, ids[2]);
  await release(); const results = await page.evaluate(() => window.__pendingCopies);
  expect(results[0]).toMatchObject({ ok: true }); expect(results[1]).toMatchObject({ ok: false });
  expect(await count()).toBe(1); expect(await writes()).toEqual([ids[0]]);
  await page.evaluate(() => window.paste.nextInStack()); expect(await writes()).toEqual([ids[0], ids[2]]); expect(await count()).toBe(0);
});
test('failed copies preserve the head and do not poison later Stack or ordinary copy operations', async () => {
  await application.evaluate(() => { globalThis.__failCopy = true; });
  expect(await page.evaluate(() => window.paste.nextInStack().catch(error => error.message))).toContain('Injected clipboard failure');
  expect(await count()).toBe(2);
  await application.evaluate(() => { globalThis.__failCopy = false; });
  const results = await page.evaluate(id => Promise.all([window.paste.nextInStack(), window.paste.copy(id, { plain: true }), window.paste.nextInStack()]), ids[2]);
  expect(results.every(result => result.ok)).toBe(true); expect(await writes()).toEqual([ids[0], ids[0], ids[2], ids[1]]); expect(await count()).toBe(0);
  expect(await application.evaluate(() => globalThis.__writes[2].plain)).toBe(true);
});
test('both Stack controls surface a structured paste failure instead of silently appearing to do nothing', async () => {
  await application.evaluate(({ ipcMain }) => { ipcMain.removeHandler('stack:next'); ipcMain.handle('stack:next', () => ({ ok: false, copied: true, error: 'Synthetic accessibility permission required' })); });
  await page.locator('#stackButton').click(); await expect(page.locator('#status')).toContainText('Synthetic accessibility permission required');
  await page.evaluate(() => { document.querySelector('#status').hidden = true; });
  await page.locator('#moreButton').click(); await page.getByRole('menuitem', { name: '粘贴 Stack 下一项' }).click();
  await expect(page.locator('#status')).toBeVisible(); await expect(page.locator('#status')).toContainText('Synthetic accessibility permission required'); expect(await count()).toBe(2);
  await page.screenshot({ path: 'test-results/stack-paste-failure.png' });
});

test('create, pin, reload, search and select-to-paste preserve the same Pinboard item', async () => {
  await page.evaluate(() => window.paste.toggleStack());
  await page.getByRole('button', { name: '创建 Pinboard', exact: true }).click();
  const name = 'Core workflow board', input = page.getByRole('textbox', { name: 'Pinboard 名称' });
  await input.fill(name); await input.press('Enter');
  await page.locator(`.clip-card[data-id="${ids[0]}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name, exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', ids[0]);
  await page.reload(); await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', ids[0]);
  await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('First workflow item');
  await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false'); await expect(page.locator('.clip-card')).toHaveCount(1);
  await search.press('Enter'); await expect(page.locator('#timeline')).toBeFocused(); expect(await writes()).toEqual([]);
  await page.keyboard.press('Enter'); await expect.poll(writes).toEqual([ids[0]]);
  const library = await page.evaluate(() => window.paste.getLibrary()), board = library.boards.find(board => board.name === name);
  expect(library.items).toHaveLength(3); expect(library.items.find(item => item.id === ids[0]).boardIds).toContain(board.id);
});
