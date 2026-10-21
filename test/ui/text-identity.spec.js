const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hash, htmlPayload, textSignature } = require('../../src/store');
const { ContentFiles } = require('../../src/content-files');
let application, page, directory;
const pair = prefix => [{ body: `${prefix}\nhtml:<p>Alpha</p>`, html: '<p>Beta</p>', rtf: '' }, { body: prefix, html: '<p>Alpha</p>\nhtml:<p>Beta</p>', rtf: '' }];
const legacySignature = (body, html = '', rtf = '') => hash(`text:${body}\nhtml:${htmlPayload(html)}\nrtf:${rtf}`);
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
}
test.beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-text-identity-ui-')); });
test.afterEach(async () => { if (application) await application.close(); fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = null; });
// Isolated synthetic profiles only. These tests do not use the system clipboard.
test('portable restore and repeated merge keep all field-collision and surrogate originals, IDs and board order across restart', async () => {
  const fields = [...pair('Portable identity'), { body: 'orphan-\uD800' }, { body: 'orphan-\uD801' }], file = path.join(directory, 'input.json');
  const items = fields.map((value, n) => ({ ...value, id: `item-${n}`, type: 'text', title: `Original ${n}`, createdAt: new Date().toISOString(), boardIds: ['work'], signature: legacySignature(value.body, value.html, value.rtf) }));
  const backup = { version: 2, items, boards: [{ id: 'work', name: 'Keep originals', color: '#ef6259', itemOrder: items.map(item => item.id).reverse() }] };
  fs.writeFileSync(file, JSON.stringify(backup)); await launch();
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); const settings = await opened;
  await settings.locator('[data-page=data]').click(); await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await expect(settings.locator('#importSummary')).toContainText('合并新增 4 项，重复 0 项');
  await settings.locator('#applyImport').click(); await expect(settings.locator('#settingsStatus')).toContainText('备份已恢复');
  const expected = await application.evaluate(() => globalThis.__pasteTest.store.exportData()); expect(expected.items).toHaveLength(4);
  for (let n = 0; n < 4; n++) {
    const item = expected.items.find(value => value.id === `item-${n}`); for (const key of ['body', 'html', 'rtf']) expect(item[key]).toBe(fields[n][key]);
    expect(item.signature).toBe(textSignature(fields[n].body, fields[n].html, fields[n].rtf));
  }
  await settings.locator('#importData').click(); await expect(settings.locator('#importSummary')).toContainText('合并新增 0 项，重复 4 项');
  await settings.locator('#applyImport').click(); await expect(settings.locator('#importData')).toBeEnabled();
  expect(await application.evaluate(() => globalThis.__pasteTest.store.exportData())).toEqual(expected);
  await application.close(); application = null; await launch(); expect(await application.evaluate(() => globalThis.__pasteTest.store.exportData())).toEqual(expected);
  await page.locator('[data-board=work]').click(); await expect(page.locator('.clip-card')).toHaveCount(4);
  expect(await page.locator('.clip-card').evaluateAll(nodes => nodes.map(node => node.dataset.id))).toEqual(['item-3', 'item-2', 'item-1', 'item-0']);
});
test('old checksummed sidecars normalize identities on load without changing payloads, backups, manual order or reusable search rows', async () => {
  const fields = pair('Original '.repeat(3000) + ' identity-tail'), contents = new ContentFiles(directory);
  const items = fields.map((value, n) => contents.record({ ...value, id: `legacy-${n}`, type: 'text', title: `Old ${n}`, renamed: true,
    createdAt: new Date().toISOString(), signature: legacySignature(value.body, value.html, value.rtf), boardIds: ['work'], isFavorite: true }));
  const raw = JSON.stringify({ version: 3, items, boards: [{ id: 'work', name: 'Old board', color: '#ef6259', itemOrder: ['legacy-1', 'legacy-0'] }], settings: { retentionDays: 0 } });
  fs.writeFileSync(path.join(directory, 'library.json'), raw, { mode: 0o600 }); const originals = items.map(item => fs.readFileSync(path.join(contents.directory, item.contentAsset)));
  await launch(); expect(fs.readFileSync(path.join(directory, 'library.json'), 'utf8')).toBe(raw);
  const data = await application.evaluate(() => globalThis.__pasteTest.store.exportData()); expect(new Set(data.items.map(item => item.signature)).size).toBe(2);
  expect((await page.evaluate(() => window.paste.search('identity-tail'))).ids.sort()).toEqual(['legacy-0', 'legacy-1']);
  await page.evaluate(() => window.paste.updateItem('legacy-0', { title: 'Renamed original' }));
  expect((await page.evaluate(() => window.paste.search('renamed identity-tail'))).ids).toEqual(['legacy-0']);
  expect(fs.readFileSync(path.join(directory, 'library.json.bak'), 'utf8')).toBe(raw);
  for (let n = 0; n < 2; n++) expect(fs.readFileSync(path.join(contents.directory, items[n].contentAsset))).toEqual(originals[n]);
  await application.close(); application = null; await launch();
  expect((await page.evaluate(() => window.paste.search('identity-tail'))).ids.sort()).toEqual(['legacy-0', 'legacy-1']);
  const stats = await application.evaluate(() => globalThis.__pasteTest.searchService.diagnostics()); expect(stats.written).toBe(0); expect(stats.reused).toBe(2);
  for (let n = 0; n < 2; n++) { const value = await page.evaluate(id => window.paste.getItem(id), `legacy-${n}`); expect(value.body).toBe(fields[n].body); expect(value.html).toBe(fields[n].html); }
  expect((await page.evaluate(() => window.paste.getItem('legacy-0'))).title).toBe('Renamed original');
  await page.locator('[data-board=work]').click(); expect(await page.locator('.clip-card').evaluateAll(nodes => nodes.map(node => node.dataset.id))).toEqual(['legacy-1', 'legacy-0']);
});
test('editing and recopy preserve both rich originals rather than overwriting a renamed pinned item', async () => {
  const fields = pair('Edited identity'); await launch();
  const first = await application.evaluate(() => {
    const { store } = globalThis.__pasteTest, item = store.add({ type: 'text', body: 'Before edit' }), board = store.saveBoard({ name: 'Keep edits', color: '#ef6259' });
    store.update(item.id, { title: 'My original', boardIds: [board.id] }); globalThis.__pasteTest.imageText.onChanged(); return { id: item.id, board: board.id };
  });
  await page.evaluate(({ id, value }) => window.paste.updateItem(id, value), { id: first.id, value: fields[0] });
  const second = await application.evaluate((_electron, value) => { const item = globalThis.__pasteTest.store.add({ ...value, type: 'text' }); globalThis.__pasteTest.imageText.onChanged(); return item.id; }, fields[1]);
  expect(second).not.toBe(first.id); expect((await page.evaluate(id => window.paste.getItem(id), first.id)).body).toBe(fields[0].body);
  const again = await application.evaluate((_electron, value) => { const hooks = globalThis.__pasteTest, id = hooks.store.add({ ...value, type: 'text' }).id; hooks.imageText.onChanged(); return id; }, fields[0]); expect(again).toBe(first.id);
  expect(await page.evaluate(id => window.paste.getItem(id), first.id)).toMatchObject({ title: 'My original', boardIds: [first.board], html: fields[0].html });
  await expect(page.locator('.clip-card')).toHaveCount(2); await page.screenshot({ path: 'test-results/text-identity-separate-cards.png' });
});
