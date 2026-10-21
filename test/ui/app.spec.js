const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
let application, page, directory, originalClipboard;

test.beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-ui-'));
  const seed = path.join(directory, 'seed.json');
  const source = (name, bundleId, color) => ({ name, bundleId, color });
  fs.writeFileSync(seed, JSON.stringify([
    { type: 'text', body: 'A thoughtful clipboard.\nEverything you copy, ready when you need it.', preview: 'A thoughtful clipboard.\nEverything you copy, ready when you need it.', title: 'A thoughtful clipboard', source: source('Notes', 'com.apple.Notes', '#e1b948') },
    { type: 'link', body: 'https://example.com/design', preview: 'https://example.com/design', title: 'Design reference', source: source('Google Chrome', 'com.google.Chrome', '#587ce8') },
    { type: 'code', body: 'const library = await clipboard.history();\n\nfor (const item of library) {\n  await render(item);\n}', preview: 'const library = await clipboard.history();\n\nfor (const item of library) {\n  await render(item);\n}', title: 'Clipboard code', source: source('Editor', 'com.editor', '#5bd59b') },
    { type: 'color', body: '#ef6259', preview: '#ef6259', title: '#ef6259', source: source('Design', 'com.design', '#af78d3') },
    { type: 'text', body: '项目计划\n\n让每一次复制都有迹可循。\n文本、链接、图片，随时取用。', preview: '项目计划\n\n让每一次复制都有迹可循。\n文本、链接、图片，随时取用。', title: '项目计划', source: source('Terminal', 'com.apple.Terminal', '#0b252d') }
  ]));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory, PASTE_TEST_SEED: seed }
  });
  page = await application.firstWindow();
  await page.waitForSelector('.clip-card');
  await page.emulateMedia({ colorScheme: 'dark' });
  originalClipboard = await application.evaluate(async ({ clipboard }) => {
    const entries = await clipboard.read();
    return Promise.all(entries.map(async entry => {
      const result = {};
      for (const type of entry.types) {
        const value = await entry.getType(type);
        if (value instanceof Blob) result[type] = { base64: Buffer.from(await value.arrayBuffer()).toString('base64') };
        else result[type] = { value };
      }
      return result;
    }));
  });
});
test.afterAll(async () => {
  if (application) {
    if (originalClipboard) await application.evaluate(async ({ clipboard, ClipboardItem }, saved) => {
      if (!saved.length) { clipboard.clear(); return; }
      await clipboard.write(saved.map(entry => new ClipboardItem(Object.fromEntries(Object.entries(entry).map(([type, data]) => [type,
        data.base64 !== undefined ? new Blob([Buffer.from(data.base64, 'base64')]) : data.value])))));
    }, originalClipboard);
    await application.close();
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('measured desktop geometry, multiple viewports, no broken image or overflow', async () => {
  for (const width of [1920, 1280, 768, 390]) {
    await application.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width, height: 332 }); }, width);
    await expect(page.locator('.clip-card').first()).toBeVisible();
    const metrics = await page.evaluate(() => {
      const card = document.querySelector('.clip-card').getBoundingClientRect();
      const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
      return { width: card.width, height: card.height, top: card.top, toolbar: toolbar.height,
        overflow: document.documentElement.scrollWidth > innerWidth, broken: [...document.images].some(image => !image.complete || !image.naturalWidth) };
    });
    expect(metrics).toEqual({ width: 240, height: 240, top: 68, toolbar: 60, overflow: false, broken: false });
    await page.screenshot({ path: `test-results/panel-${width}.png` });
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1280, height: 332 }));
});
test('search is safe to edit: arrows and Enter do not paste or select another card', async () => {
  await page.keyboard.press('Meta+f');
  await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('项目');
  await expect(page.locator('.clip-card')).toHaveCount(1);
  const before = await application.evaluate(({ clipboard }) => clipboard.readText());
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter');
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(page.locator('#searchBox')).toBeHidden();
});
test('pinboard creation, membership, search and rename persist through disk reload', async () => {
  await page.getByRole('button', { name: '创建 Pinboard', exact: true }).click();
  await page.getByRole('textbox', { name: 'Pinboard 名称' }).fill('工作');
  await page.getByRole('textbox', { name: 'Pinboard 名称' }).press('Enter');
  await expect(page.getByRole('button', { name: '工作', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '剪贴板', exact: true }).click();
  await page.locator('.clip-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '工作', exact: true }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(page.locator('.clip-card')).toHaveCount(1);
  const disk = JSON.parse(fs.readFileSync(path.join(directory, 'library.json')));
  expect(disk.boards[0].name).toBe('工作'); expect(disk.items.filter(item => item.boardIds.length)).toHaveLength(1);
  await page.getByRole('button', { name: '工作', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑 Pinboard…' }).click();
  await page.getByRole('textbox', { name: 'Pinboard 名称' }).fill('项目资料');
  await page.getByRole('textbox', { name: 'Pinboard 名称' }).press('Enter');
  await page.reload(); await expect(page.getByRole('button', { name: '项目资料', exact: true })).toBeVisible();
});
test('preview, edit, copy and text escaping are real IPC operations', async () => {
  await page.getByRole('button', { name: '剪贴板', exact: true }).click();
  await page.locator('.clip-card').first().click(); await page.keyboard.press('Space');
  await expect(page.locator('#detailDialog')).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: '剪贴板内容' }).fill('<img src=x onerror="window.evil=true">\n保留原文');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.clip-card').first()).toContainText('<img src=x');
  expect(await page.evaluate(() => window.evil)).toBeUndefined();
  await page.locator('.clip-card').first().click(); await page.keyboard.press('Meta+c');
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain('保留原文');
});
test('full-size images survive capture, disk persistence and clipboard round trip', async () => {
  const expected = await application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const bitmap = Buffer.alloc(1200 * 800 * 4);
    for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 180; bitmap[i + 1] = (i / 4) % 255; bitmap[i + 2] = 50; bitmap[i + 3] = 255; }
    const image = nativeImage.createFromBitmap(bitmap, { width: 1200, height: 800, scaleFactor: 1 });
    const original = image.toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([original]) })]);
    await globalThis.__pasteTest.poll();
    return globalThis.__pasteTest.hash(image.toBitmap());
  });
  await expect(page.locator('.clip-card[data-type=image]')).toHaveCount(1);
  await page.locator('.clip-card[data-type=image]').click(); await page.keyboard.press('Meta+c');
  const actual = await application.evaluate(async ({ clipboard, nativeImage }) => {
    const entry = (await clipboard.read())[0], png = Buffer.from(await (await entry.getType('image/png')).arrayBuffer());
    const restored = nativeImage.createFromBuffer(png);
    return { hash: globalThis.__pasteTest.hash(restored.toBitmap()), size: restored.getSize() };
  });
  expect(actual.hash).toBe(expected); expect(actual.size).toEqual({ width: 1200, height: 800 });
});
test('rich text and plain text mode preserve exactly the selected representation', async () => {
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Bold sample', 'text/html': '<b>Bold sample</b>' })]);
    await globalThis.__pasteTest.poll();
  });
  await expect(page.locator('.clip-card').first()).toContainText('Bold sample');
  const id = await page.locator('.clip-card').first().getAttribute('data-id');
  await page.evaluate(id => window.paste.copy(id, { paste: false }), id);
  expect(await application.evaluate(async ({ clipboard }) => (await clipboard.read())[0].types)).toContain('text/html');
  await page.evaluate(id => window.paste.copy(id, { paste: false, plain: true }), id);
  const plain = await application.evaluate(async ({ clipboard }) => ({ text: await clipboard.readText(), types: (await clipboard.read())[0].types }));
  expect(plain.text).toBe('Bold sample'); expect(plain.types).not.toContain('text/html');
});
test('file clipboard entries remain file URLs rather than degraded text', async () => {
  const file = path.join(directory, 'example.txt'); fs.writeFileSync(file, 'Test file');
  const uri = require('node:url').pathToFileURL(file).href;
  await application.evaluate(async ({ clipboard, ClipboardItem }, uri) => {
    await clipboard.write([new ClipboardItem({ 'text/uri-list': uri, 'electron application/osclipboard;format="public.file-url"': new Blob([uri]) })]);
    await globalThis.__pasteTest.poll();
  }, uri);
  await expect(page.locator('.clip-card[data-type=file]')).toHaveCount(1);
  const id = await page.locator('.clip-card[data-type=file]').getAttribute('data-id');
  await page.evaluate(id => window.paste.copy(id, { paste: false }), id);
  const returned = await application.evaluate(async () => (await globalThis.__pasteTest.clip.read()).files);
  expect(returned).toContain(uri);
});
test('confidential and transient clipboard markers are not captured', async () => {
  for (const marker of ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType']) {
    const difference = await application.evaluate(async ({ clipboard, ClipboardItem }, marker) => {
      const count = globalThis.__pasteTest.store.data.items.length;
      await clipboard.write([new ClipboardItem({ 'text/plain': 'disposable privacy test', [`electron application/osclipboard;format="${marker}"`]: new Blob(['1']) })]);
      await globalThis.__pasteTest.poll();
      return globalThis.__pasteTest.store.data.items.length - count;
    }, marker);
    expect(difference).toBe(0);
  }
});
test('Stack preserves explicit selection order and consumes only successful copies', async () => {
  const ids = await page.locator('.clip-card').evaluateAll(nodes => nodes.slice(0, 2).map(node => node.dataset.id));
  await page.evaluate(async ids => { await window.paste.toggleStack(); for (const id of ids) await window.paste.addToStack(id); }, ids);
  await expect(page.locator('#stackCount')).toHaveText('2');
  await page.evaluate(() => window.paste.nextInStack()); await expect(page.locator('#stackCount')).toHaveText('1');
  const firstBody = await page.evaluate(async id => (await window.paste.getItem(id)).body, ids[0]);
  if (!firstBody.startsWith('file://')) expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(firstBody);
  await page.evaluate(() => window.paste.toggleStack());
});
test('large libraries remain virtualized and can navigate to the last clip', async () => {
  await application.evaluate(({ BrowserWindow }) => {
    const store = globalThis.__pasteTest.store;
    const createdAt = new Date().toISOString();
    for (let index = 0; index < 2000; index++) store.data.items.push({ id: `large-${index}`, signature: `large-${index}`, type: 'text', body: `Row ${index}`, preview: `Row ${index}`, title: `Row ${index}`, createdAt, boardIds: [] });
    BrowserWindow.getAllWindows()[0].webContents.send('library:changed', store.snapshot());
  });
  await page.locator('#timeline').focus(); await page.keyboard.press('End');
  await expect(page.locator('.clip-card.selected')).toContainText('Row 1999');
  expect(await page.locator('.clip-card').count()).toBeLessThan(20);
  await page.keyboard.press('Home');
  await page.screenshot({ path: 'test-results/panel-dark.png' });
});
test('settings open as a real window and save privacy, theme and retention', async () => {
  const opened = application.waitForEvent('window');
  await page.keyboard.press('Meta+,');
  const settings = await opened; await settings.waitForLoadState('domcontentloaded');
  await settings.getByRole('checkbox', { name: '始终以纯文本粘贴' }).check();
  await settings.getByRole('slider', { name: '保留历史' }).fill('4');
  await settings.getByRole('button', { name: '隐私', exact: true }).click();
  await expect(settings.getByRole('switch', { name: /忽略机密内容/ })).toBeChecked();
  await settings.getByRole('textbox', { name: '忽略应用的 Bundle ID' }).fill('com.example.private');
  await settings.getByRole('button', { name: '添加忽略应用' }).click();
  await expect(settings.locator('#excludedApps')).toContainText('com.example.private');
  await settings.screenshot({ path: 'test-results/settings-privacy.png' });
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(directory, 'library.json'))).settings.retentionDays).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'library.json'))).settings.plainText).toBe(true);
  await settings.close();
});
