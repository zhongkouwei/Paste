const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, directory, boards;
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await application.evaluate(({ dialog }) => {
    globalThis.__writes = []; globalThis.__confirmCalls = 0; globalThis.__discard = 1;
    dialog.showMessageBoxSync = () => { globalThis.__confirmCalls++; return globalThis.__discard; };
    const hooks = globalThis.__pasteTest;
    hooks.clip.read = () => { throw Error('Unexpected system clipboard read'); };
    hooks.clip.write = async item => { globalThis.__writes.push({ id: item.id, body: item.body, html: item.html }); return `synthetic:${item.id}`; };
  });
}
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-new-text-ui-')); await launch();
  boards = await page.evaluate(async () => Promise.all(['Draft One', 'Draft Two'].map(name => window.paste.saveBoard({ name, color: '#ef6259' }))));
});
test.afterEach(async () => {
  if (application && application.process().exitCode === null) {
    await application.evaluate(() => { globalThis.__discard = 1; });
    const preview = application.windows().find(window => window.url().endsWith('/preview.html'));
    if (preview && !preview.isClosed()) { const closed = preview.waitForEvent('close'); await page.evaluate(() => window.paste.closePreview()); await closed; }
    await application.close();
  }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = boards = null;
});
async function draft(via = 'shortcut') {
  const opened = application.waitForEvent('window');
  if (via === 'menu') { await page.locator('#moreButton').click(); await page.getByRole('menuitem', { name: '新建文本', exact: true }).click(); }
  else if (via === 'native') await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('new-text').click());
  else if (via === 'api') await page.evaluate(() => window.paste.newText('history'));
  else await page.keyboard.press('Meta+n');
  const preview = await opened; await preview.waitForFunction(() => document.body.dataset.previewReady === 'true');
  expect((await preview.evaluate(() => window.paste.getPreview())).item.signature).toMatch(/^[0-9a-f]{64}$/);
  await expect(preview.locator('#previewTitle')).toHaveText('新建文本'); return preview;
}
const editor = preview => preview.getByRole('textbox', { name: '剪贴板内容' });
const library = () => page.evaluate(() => window.paste.getLibrary());
async function save(preview) { const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed; }
async function discard(preview) { const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '关闭预览' }).click(); await closed; }

test('Command-N creates an uncommitted rich draft, then save/search/copy and real restart preserve the item', async () => {
  const preview = await draft(); expect((await library()).items).toHaveLength(0);
  await preview.getByRole('button', { name: '保存', exact: true }).click(); await expect(preview.locator('#previewStatus')).toHaveText('请输入文本后再保存。');
  expect((await library()).items).toHaveLength(0);
  await editor(preview).fill('New note 中文 😀'); await editor(preview).press('Meta+a'); await preview.getByRole('button', { name: '粗体', exact: true }).click();
  await expect(preview.locator('#previewStatus')).toBeHidden();
  await preview.screenshot({ path: 'test-results/new-text-draft.png' }); await save(preview);
  const saved = (await library()).items[0], full = await page.evaluate(id => window.paste.getItem(id), saved.id);
  expect(full.body).toBe('New note 中文 😀'); expect(full.html).toMatch(/<strong>New note 中文 😀<\/strong>/); expect(full.boardIds).toEqual([]);
  await expect(page.locator(`.clip-card[data-id="${saved.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('New note');
  await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false'); await expect(page.locator('.clip-card')).toHaveCount(1);
  await page.evaluate(id => window.paste.copy(id, { paste: false }), saved.id);
  expect(await application.evaluate(() => globalThis.__writes)).toEqual([{ id: saved.id, body: full.body, html: full.html }]);
  await application.close(); await launch();
  expect(await page.evaluate(id => window.paste.getItem(id), saved.id)).toEqual(full); expect((await library()).items).toHaveLength(1);
});
test('the More command captures the current Pinboard and draft pinning stays temporary until one save', async () => {
  await page.getByRole('button', { name: boards[0].name, exact: true }).click(); const preview = await draft('menu');
  await editor(preview).fill('Pinned new note');
  expect((await preview.evaluate(() => window.paste.getPreview())).item.boardIds).toEqual([boards[0].id]);
  await preview.getByRole('button', { name: '固定', exact: true }).click();
  await preview.locator('#previewPinboards label').filter({ hasText: boards[1].name }).locator('input').check();
  await preview.locator('#previewPinboards label').filter({ hasText: boards[0].name }).locator('input').uncheck();
  expect((await library()).items).toHaveLength(0); await expect(editor(preview)).toHaveText('Pinned new note');
  await save(preview); const saved = (await library()).items[0]; expect(saved.boardIds).toEqual([boards[1].id]);
  await expect(page.getByRole('button', { name: boards[1].name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`.clip-card[data-id="${saved.id}"]`)).toHaveAttribute('aria-selected', 'true');
});
test('the native File command and exact native shortcut never overwrite a draft or create repeated placeholders', async () => {
  await application.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows()[0];
    panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'n', modifiers: ['meta', 'isautorepeat'] });
    panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'n', modifiers: ['meta'] });
  });
  expect(application.windows()).toHaveLength(1); const preview = await draft('native'); await editor(preview).fill('Keep unsaved draft');
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html'));
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'n', modifiers: ['meta'] }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'n', modifiers: ['meta'] });
    const hooks = globalThis.__pasteTest; hooks.store.add({ type: 'text', body: 'Background copy', title: 'Background' }); hooks.imageText.onChanged();
  });
  await preview.keyboard.press('Meta+n'); expect(application.windows()).toHaveLength(2); await expect(editor(preview)).toHaveText('Keep unsaved draft');
  expect((await library()).items).toHaveLength(1); await discard(preview);
  expect((await library()).items.map(item => item.title)).toEqual(['Background']);
  await page.keyboard.press('Meta+Shift+n'); await expect(page.getByRole('textbox', { name: 'Pinboard 名称' })).toBeVisible(); expect(application.windows()).toHaveLength(1);
});
test('save failure preserves text and uncommitted membership, and retry creates exactly one complete item', async () => {
  await page.getByRole('button', { name: boards[0].name, exact: true }).click(); const preview = await draft(); await editor(preview).fill('Retry note');
  await expect(preview.evaluate(() => window.paste.newText('history'))).rejects.toThrow('请从主面板');
  await application.evaluate(() => { const store = globalThis.__pasteTest.store; globalThis.__persist = store.persist; store.persist = () => { throw Error('Injected new-text failure'); }; });
  await preview.getByRole('button', { name: '保存', exact: true }).click(); await expect(preview.locator('#previewStatus')).toContainText('Injected new-text failure');
  expect((await library()).items).toHaveLength(0); await expect(editor(preview)).toHaveText('Retry note'); await expect(preview.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await application.evaluate(() => { globalThis.__pasteTest.store.persist = globalThis.__persist; }); await save(preview);
  const saved = (await library()).items; expect(saved).toHaveLength(1); expect(saved[0].boardIds).toEqual([boards[0].id]);
});
test('a deleted destination is explicit, keeps the draft, and can be deselected before retrying to history', async () => {
  await page.getByRole('button', { name: boards[0].name, exact: true }).click(); const preview = await draft(); await editor(preview).fill('Destination changed');
  await page.evaluate(id => window.paste.deleteBoard(id), boards[0].id);
  await preview.getByRole('button', { name: '保存', exact: true }).click(); await expect(preview.locator('#previewStatus')).toContainText('Pinboard已删除');
  expect((await library()).items).toHaveLength(0); await expect(editor(preview)).toHaveText('Destination changed');
  await preview.getByRole('button', { name: '固定', exact: true }).click();
  await preview.locator('#previewPinboards label').filter({ hasText: '已删除的 Pinboard' }).locator('input').click();
  await expect(preview.locator('#previewPinboards label').filter({ hasText: '已删除的 Pinboard' })).toHaveCount(0);
  expect((await preview.evaluate(() => window.paste.getPreview())).item.boardIds).toEqual([]);
  await save(preview); expect((await library()).items[0].boardIds).toEqual([]);
});
test('canceling pristine or changed drafts leaves no placeholder; native discard cancellation preserves the editor', async () => {
  const before = fs.readFileSync(path.join(directory, 'library.json'));
  const blank = await draft('api'); await discard(blank); expect(await application.evaluate(() => globalThis.__confirmCalls)).toBe(0);
  const preview = await draft('api'); await editor(preview).fill('Discard safely'); await application.evaluate(() => { globalThis.__discard = 0; });
  await preview.getByRole('button', { name: '关闭预览' }).click(); await expect.poll(() => application.evaluate(() => globalThis.__confirmCalls)).toBe(1);
  expect(preview.isClosed()).toBe(false); await expect(editor(preview)).toHaveText('Discard safely'); expect((await library()).items).toHaveLength(0);
  await application.evaluate(() => { globalThis.__discard = 1; }); await discard(preview);
  expect((await library()).items).toHaveLength(0); expect(fs.readFileSync(path.join(directory, 'library.json')).equals(before)).toBe(true);
});
test('new text from an active search goes to history rather than silently inheriting a search filter', async () => {
  await page.getByRole('button', { name: boards[0].name, exact: true }).click(); await page.keyboard.press('Meta+f');
  await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('No matching old note');
  const preview = await draft(); expect((await preview.evaluate(() => window.paste.getPreview())).item.boardIds).toEqual([]);
  await editor(preview).fill('New from empty search'); await save(preview);
  expect((await library()).items[0].boardIds).toEqual([]); await expect(page.getByRole('button', { name: '剪贴板', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.clip-card')).toHaveCount(1);
});
test('recreating identical text merges memberships without losing an existing label or creating a second item', async () => {
  let preview = await draft(); await editor(preview).fill('Identical note'); await save(preview);
  const id = (await library()).items[0].id;
  await page.evaluate(async ({ id, boardId }) => { await window.paste.updateItem(id, { title: 'Keep label' }); await window.paste.pinItems([id], boardId); }, { id, boardId: boards[0].id });
  await page.getByRole('button', { name: boards[1].name, exact: true }).click(); preview = await draft(); await editor(preview).fill('Identical note'); await save(preview);
  const items = (await library()).items; expect(items).toHaveLength(1); expect(items[0].id).toBe(id); expect(items[0].title).toBe('Keep label');
  expect(items[0].boardIds).toEqual([boards[0].id, boards[1].id]);
});

test('new-draft controls and destination selector fit a narrow preview without hiding the save action', async () => {
  const preview = await draft('menu'); await editor(preview).fill('Narrow draft 中文');
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html'));
    window.setBounds({ ...window.getBounds(), width: 320, height: 400 });
  });
  await preview.getByRole('button', { name: '固定', exact: true }).click();
  await expect(preview.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  expect(await preview.evaluate(() => {
    const nodes = [document.querySelector('.preview-toolbar'), document.querySelector('#previewTitle'), document.querySelector('#savePreview'), document.querySelector('#previewPinboards')];
    return nodes.every(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && node.scrollWidth <= node.clientWidth; });
  })).toBe(true);
  await preview.screenshot({ path: 'test-results/new-text-draft-narrow.png' }); await save(preview);
  expect((await library()).items).toHaveLength(1);
});
