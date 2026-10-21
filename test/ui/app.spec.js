const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
let application, page, directory, originalClipboard, originalFiles = [], canRestoreClipboard = false;
test.describe.configure({ mode: 'serial' });

async function launchApplication() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  return electron.launch({
    colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory, PASTE_TEST_SEED: path.join(directory, 'seed.json') }
  });
}

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
  application = await launchApplication();
  page = await application.firstWindow();
  await page.waitForSelector('.clip-card');
  await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await page.evaluate(() => window.paste.saveSettings({ theme: 'light' }));
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
  originalFiles = await application.evaluate(async () => (await globalThis.__pasteTest.clip.read()).files);
  if (originalClipboard.length > 1 && !originalFiles.length) throw new Error('Existing multi-item clipboard cannot be restored losslessly; tests stopped before modifying it.');
  canRestoreClipboard = true;
});
test.afterAll(async () => {
  if (application) {
    if (canRestoreClipboard && originalFiles.length) {
      await application.evaluate(async (_electron, files) => globalThis.__pasteTest.clip.write({ type: 'file', body: files.join('\n') }), originalFiles);
    } else if (canRestoreClipboard && originalClipboard) await application.evaluate(async ({ clipboard, ClipboardItem }, saved) => {
      if (!saved.length) { clipboard.clear(); return; }
      await clipboard.write(saved.map(entry => new ClipboardItem(Object.fromEntries(Object.entries(entry).map(([type, data]) => [type,
        data.base64 !== undefined ? new Blob([Buffer.from(data.base64, 'base64')]) : data.value])))));
    }, originalClipboard);
    // Failed editor tests must not leave a native unsaved-draft dialog blocking teardown.
    await application.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().endsWith('/preview.html')) window.destroy();
    });
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
  await page.evaluate(() => window.paste.saveSettings({ theme: 'dark' }));
  await expect(page.locator('.panel')).toHaveCSS('background-color', 'rgba(49, 49, 49, 0.98)');
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
  await page.getByRole('textbox', { name: 'Pinboard 名称' }).evaluate(input => input.blur());
  await expect(page.getByRole('textbox', { name: 'Pinboard 名称' })).toHaveValue('工作');
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
  const opened = application.waitForEvent('window');
  await page.locator('.clip-card').first().click(); await page.keyboard.press('Space');
  const preview = await opened; await preview.waitForLoadState('domcontentloaded');
  await expect(preview.locator('#previewContent')).toContainText('项目计划');
  await preview.getByRole('button', { name: '编辑', exact: true }).click();
  await preview.getByRole('textbox', { name: '剪贴板内容' }).fill('<img src=x onerror="window.evil=true">\n保留原文');
  const id = await page.locator('.clip-card').first().getAttribute('data-id');
  const switchAccepted = await page.evaluate(id => window.paste.openPreview(id, { mode: 'rename' }), id);
  expect(switchAccepted).toBe(false);
  await expect(preview.getByRole('textbox', { name: '剪贴板内容' })).toHaveText('<img src=x onerror="window.evil=true">\n保留原文', { useInnerText: true });
  const closed = preview.waitForEvent('close');
  await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  await expect(page.locator('.clip-card').first()).toContainText('<img src=x');
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe('<img src=x onerror="window.evil=true">\n保留原文');
  expect(await page.evaluate(() => window.evil)).toBeUndefined();
  await page.locator('.clip-card').first().click(); await page.keyboard.press('Meta+c');
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain('保留原文');
});
test('dragging clips to pinboards and reordering pinboards persists through reload', async () => {
  await page.getByRole('button', { name: '创建 Pinboard', exact: true }).click();
  await page.getByRole('textbox', { name: 'Pinboard 名称' }).fill('灵感');
  await page.getByRole('textbox', { name: 'Pinboard 名称' }).press('Enter');
  const clip = page.locator('.clip-card').first(), target = page.getByRole('button', { name: '灵感', exact: true });
  const id = await clip.getAttribute('data-id');
  await clip.dragTo(target);
  await expect.poll(async () => (await page.evaluate(() => window.paste.getLibrary())).items.find(item => item.id === id).boardIds.length).toBeGreaterThan(0);
  await target.dragTo(page.getByRole('button', { name: '项目资料', exact: true }), { targetPosition: { x: 2, y: 12 } });
  await expect.poll(async () => (await page.evaluate(() => window.paste.getLibrary())).boards[0].name).toBe('灵感');
  await page.reload(); await expect(page.locator('#boards [data-board]').nth(1)).toHaveText('灵感');
  const library = await page.evaluate(() => window.paste.getLibrary()), board = library.boards.find(entry => entry.name === '灵感');
  const ids = library.items.filter(item => !['image', 'file'].includes(item.type)).slice(0, 3).map(item => item.id);
  await page.evaluate(({ ids, board }) => window.paste.pinItems(ids, board), { ids, board: board.id });
  await page.getByRole('button', { name: '灵感', exact: true }).click();
  const order = await page.locator('.clip-card').evaluateAll(nodes => nodes.map(node => node.dataset.id));
  await page.locator('.clip-card').last().dragTo(page.locator('.clip-card').first(), { targetPosition: { x: 2, y: 60 } });
  await expect.poll(() => page.locator('.clip-card').first().getAttribute('data-id')).toBe(order.at(-1));
  await page.reload(); await page.getByRole('button', { name: '灵感', exact: true }).click();
  await expect(page.locator('.clip-card').first()).toHaveAttribute('data-id', order.at(-1));
  await page.getByRole('button', { name: '剪贴板', exact: true }).click();
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
  const id = await page.locator('.clip-card[data-type=image]').getAttribute('data-id');
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id), id);
  const preview = await opened; await expect(preview.locator('#previewContent img')).toBeVisible();
  expect(await preview.locator('#previewContent img').evaluate(image => [image.naturalWidth, image.naturalHeight])).toEqual([1200, 800]);
  await preview.screenshot({ path: 'test-results/preview-image.png' });
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '关闭预览' }).click(); await closed;
  const exported = await page.evaluate(id => window.paste.startDrag([id]), id);
  expect(exported.files).toHaveLength(1); expect(fs.existsSync(exported.files[0])).toBe(true);
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
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id), id);
  const preview = await opened;
  await expect(preview.frameLocator('iframe').locator('b')).toHaveText('Bold sample');
  expect(await preview.locator('iframe').getAttribute('sandbox')).toBe('');
  await preview.screenshot({ path: 'test-results/preview-rich-text.png' });
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '关闭预览' }).click(); await closed;
  await page.evaluate(id => window.paste.copy(id, { paste: false }), id);
  await page.locator('#timeline').focus(); await page.keyboard.press('Meta+Shift+Digit1');
  expect(await application.evaluate(async ({ clipboard }) => (await clipboard.read())[0].types)).not.toContain('text/html');
});
test('rich editing preserves styled selections, undo/redo, pins and clipboard round trip', async () => {
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Styled clipboard',
      'text/html': '<p><span style="font-size:18px;color:rgb(200, 40, 60);font-family:Georgia"><b>Styled</b> clipboard</span></p>' })]);
    await globalThis.__pasteTest.poll();
  });
  await expect(page.locator('.clip-card').first()).toContainText('Styled clipboard');
  const id = await page.locator('.clip-card').first().getAttribute('data-id');
  const board = (await page.evaluate(() => window.paste.getLibrary())).boards[0] || await page.evaluate(() => window.paste.saveBoard({ name: 'Rich test', color: '#ef6259' }));
  await page.evaluate(({ id, board }) => window.paste.pinItems([id], board), { id, board: board.id });
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' });
  await expect(editor).toHaveText('Styled clipboard');
  await editor.press('Meta+a');
  const editorNode = await editor.elementHandle();
  await preview.getByRole('button', { name: '固定', exact: true }).click();
  await preview.getByRole('checkbox', { name: board.name, exact: true }).uncheck();
  await expect.poll(async () => (await page.evaluate(id => window.paste.getItem(id), id)).boardIds.includes(board.id)).toBe(false);
  await preview.getByRole('checkbox', { name: board.name, exact: true }).check();
  await expect.poll(async () => (await page.evaluate(id => window.paste.getItem(id), id)).boardIds.includes(board.id)).toBe(true);
  expect(await editorNode.evaluate(element => element.isConnected)).toBe(true);
  await preview.getByRole('button', { name: '粗体', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('Styled clipboard');
  await preview.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('Styled');
  await preview.getByRole('button', { name: '重做', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('Styled clipboard');
  for (const name of ['斜体', '下划线', '删除线']) {
    await preview.getByRole('button', { name, exact: true }).click();
    await expect(preview.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(editor.locator('em')).toHaveText('Styled clipboard');
  await expect(editor.locator('u')).toHaveText('Styled clipboard');
  await expect(editor.locator('s')).toHaveText('Styled clipboard');
  await expect(editor.locator('[style]').first()).toHaveCSS('color', 'rgb(200, 40, 60)');
  await preview.screenshot({ path: 'test-results/preview-rich-edit.png' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html')).setBounds({ width: 320, height: 300 }));
  expect(await preview.evaluate(() => {
    const tools = document.querySelector('#editTools').getBoundingClientRect(), content = document.querySelector('#previewContent').getBoundingClientRect(), footer = document.querySelector('.preview-footer').getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth && tools.bottom <= content.top && content.bottom <= footer.top;
  })).toBe(true);
  await preview.screenshot({ path: 'test-results/preview-rich-edit-narrow.png' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html')).setBounds({ width: 720, height: 500 }));
  const closed = preview.waitForEvent('close');
  expect(await preview.evaluate(() => { document.querySelector('#savePreview').click(); return document.querySelector('.preview-shell').inert; })).toBe(true);
  await closed;
  const saved = await page.evaluate(id => window.paste.getItem(id), id);
  expect(saved.body).toBe('Styled clipboard'); expect(saved.html).toContain('<strong>'); expect(saved.html).toContain('<u>');
  expect(saved.html).toContain('font-family: Georgia'); expect(saved.boardIds).toContain(board.id);
  await page.evaluate(id => window.paste.copy(id, { paste: false }), id);
  expect(await application.evaluate(async () => (await globalThis.__pasteTest.clip.read()).html)).toContain('<strong>');
  expect(await application.evaluate(async () => (await globalThis.__pasteTest.clip.read()).signature)).toBe(saved.signature);
  await application.evaluate(async ({ clipboard, ClipboardItem }, saved) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Rich edit interlude' })]); await globalThis.__pasteTest.poll();
    await globalThis.__pasteTest.clip.write(saved); await globalThis.__pasteTest.poll();
  }, saved);
  const matching = (await page.evaluate(() => window.paste.getLibrary())).items.filter(item => item.body === 'Styled clipboard');
  expect(matching).toHaveLength(1); expect(matching[0].id).toBe(id);
});
test('opening an editor without changes never normalizes the original HTML or RTF', async () => {
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'No change', 'text/html': '<div><b>No change</b></div>', 'text/rtf': '{\\rtf1\\ansi No change}' })]);
    await globalThis.__pasteTest.poll();
  });
  await expect(page.locator('.clip-card').first()).toContainText('No change');
  const id = await page.locator('.clip-card').first().getAttribute('data-id'), before = await page.evaluate(id => window.paste.getItem(id), id);
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const preview = await opened; await expect(preview.getByRole('textbox', { name: '剪贴板内容' })).toHaveText('No change');
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  const after = await page.evaluate(id => window.paste.getItem(id), id);
  expect(after.html).toBe(before.html); expect(after.rtf).toBe(before.rtf); expect(after.signature).toBe(before.signature);
});
test('rich paste is sanitized and unsupported embedded documents cannot be silently flattened', async () => {
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Safe editor fixture' })]); await globalThis.__pasteTest.poll();
  });
  await expect(page.locator('.clip-card').first()).toContainText('Safe editor fixture');
  let id = await page.locator('.clip-card').first().getAttribute('data-id');
  let opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  let preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' });
  await editor.press('Meta+a');
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Safe paste',
      'text/html': '<p><b>Safe paste</b><script>window.evil=true</script><img src="https://example.invalid/track" onerror="window.evil=true"><iframe src="https://example.invalid"></iframe></p><form><input value="secret"></form>' })]);
  });
  await editor.press('Meta+v');
  await expect(editor).toHaveText('Safe paste');
  await expect(preview.locator('#previewMeta')).toHaveText('10 个字符');
  await expect(editor.locator('script,iframe,img,form,input,[onerror],[src]')).toHaveCount(0);
  expect(await preview.evaluate(() => window.evil)).toBeUndefined();
  let closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Table cell', 'text/html': '<table><tr><td>Table cell</td></tr></table>' })]); await globalThis.__pasteTest.poll();
  });
  await expect(page.locator('.clip-card').first()).toContainText('Table cell'); id = await page.locator('.clip-card').first().getAttribute('data-id');
  const before = await page.evaluate(id => window.paste.getItem(id), id);
  opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  preview = await opened;
  await expect(preview.getByRole('button', { name: '保存', exact: true })).toBeHidden();
  await expect(preview.frameLocator('iframe').locator('td')).toHaveText('Table cell');
  closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '关闭预览' }).click(); await closed;
  expect((await page.evaluate(id => window.paste.getItem(id), id)).html).toBe(before.html);
});
test('native image editing preserves pixels, originals, pins, failures and restart migration', async () => {
  const original = await application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const bitmap = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 128, 0, 0, 128, 0, 255, 255, 255, 255, 0, 255, 255, 0, 0, 0, 0]);
    const png = nativeImage.createFromBitmap(bitmap, { width: 3, height: 2, scaleFactor: 1 }).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png]) })]); await globalThis.__pasteTest.poll();
    const item = globalThis.__pasteTest.store.data.items[0];
    return { id: item.id, asset: item.asset, signature: item.signature, png: globalThis.__pasteTest.hash(globalThis.__pasteTest.store.readAsset(item.asset)), bitmap: [...bitmap] };
  });
  const board = (await page.evaluate(() => window.paste.getLibrary())).boards[0] || await page.evaluate(() => window.paste.saveBoard({ name: 'Image test', color: '#ef6259' }));
  await page.evaluate(({ id, board }) => window.paste.pinItems([id], board), { id: original.id, board: board.id });
  const open = async () => {
    const opened = application.waitForEvent('window'); await page.evaluate(async id => {
      const ids = (await window.paste.getLibrary()).items.map(item => item.id);
      return window.paste.openPreview(id, { mode: 'edit', ids: [id, ...ids.filter(value => value !== id)] });
    }, original.id);
    const preview = await opened; await expect(preview.locator('#imageTools')).toBeVisible(); return preview;
  };
  const pixels = async preview => application.evaluate(({ nativeImage }, body) => [...nativeImage.createFromDataURL(body).toBitmap()], (await preview.evaluate(() => window.paste.getPreview())).item.body);
  const preview = await open();
  expect(await preview.evaluate(() => window.paste.navigatePreview(1))).toBe(false);
  await expect(page.evaluate(id => window.paste.deleteItems([id]), original.id)).rejects.toThrow(/正在编辑/);
  await preview.getByRole('button', { name: '向右旋转' }).click();
  await expect(preview.locator('#previewMeta')).toHaveText('2 × 3');
  expect(await pixels(preview)).toEqual([3, 0, 4, 1, 5, 2].flatMap(index => original.bitmap.slice(index * 4, index * 4 + 4)));
  await preview.keyboard.press('Meta+z'); await expect(preview.locator('#previewMeta')).toHaveText('3 × 2');
  expect(await pixels(preview)).toEqual(original.bitmap);
  await preview.keyboard.press('Meta+Shift+z'); await expect(preview.locator('#previewMeta')).toHaveText('2 × 3');
  for (let index = 0; index < 3; index++) await preview.getByRole('button', { name: '向右旋转' }).click();
  await expect.poll(() => preview.evaluate(() => window.paste.getPreview().then(value => value.imageEdit.turns))).toBe(0);
  expect(await pixels(preview)).toEqual(original.bitmap);
  await preview.getByRole('button', { name: '向右旋转' }).click();
  await preview.screenshot({ path: 'test-results/preview-image-edit.png' });
  await application.evaluate(() => { const store = globalThis.__pasteTest.store; globalThis.__savedPersist = store.persist; store.persist = () => { throw new Error('disk full fixture'); }; });
  try {
    await preview.getByRole('button', { name: '保存', exact: true }).click();
    await expect(preview.getByRole('status')).toContainText('disk full fixture');
    expect((await page.evaluate(id => window.paste.getItem(id), original.id)).asset).toBe(original.asset);
    await expect(preview.locator('#previewMeta')).toHaveText('2 × 3');
  } finally {
    await application.evaluate(() => { globalThis.__pasteTest.store.persist = globalThis.__savedPersist; delete globalThis.__savedPersist; });
  }
  let closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  const saved = await page.evaluate(id => window.paste.getItem(id), original.id);
  expect(saved.size).toEqual({ width: 2, height: 3 }); expect(saved.originalAsset).toBe(original.asset); expect(saved.boardIds).toContain(board.id);
  expect(saved.preview.startsWith('data:image/png;base64,')).toBe(true);
  await page.evaluate(id => window.paste.copy(id, { paste: false }), original.id);
  await application.evaluate(async () => globalThis.__pasteTest.poll());
  expect((await page.evaluate(() => window.paste.getLibrary())).items.filter(item => item.signature === saved.signature)).toHaveLength(1);
  expect(await application.evaluate(async () => (await globalThis.__pasteTest.clip.read()).signature)).toBe(saved.signature);
  expect(await application.evaluate(async ({ clipboard, nativeImage }) => {
    const entry = (await clipboard.read())[0]; return nativeImage.createFromBuffer(Buffer.from(await (await entry.getType('image/png')).arrayBuffer())).getSize();
  })).toEqual({ width: 2, height: 3 });
  const restored = await open(); await restored.getByRole('button', { name: '恢复原图' }).click();
  await expect(restored.locator('#previewMeta')).toHaveText('3 × 2');
  const restoredHash = await application.evaluate((_electron, body) => globalThis.__pasteTest.hash(Buffer.from(body.split(',')[1], 'base64')), (await restored.evaluate(() => window.paste.getPreview())).item.body);
  expect(restoredHash).toBe(original.png);
  await application.evaluate(({ dialog }) => { globalThis.__savedDialog = dialog.showMessageBoxSync; dialog.showMessageBoxSync = () => 1; });
  try { closed = restored.waitForEvent('close'); await restored.getByRole('button', { name: '关闭预览' }).click(); await closed; }
  finally { await application.evaluate(({ dialog }) => { dialog.showMessageBoxSync = globalThis.__savedDialog; delete globalThis.__savedDialog; }); }
  expect((await page.evaluate(id => window.paste.getItem(id), original.id)).asset).toBe(saved.asset);
  expect(await application.evaluate((_electron, asset) => globalThis.__pasteTest.hash(globalThis.__pasteTest.store.readAsset(asset)), original.asset)).toBe(original.png);
  const reverted = await open(); await reverted.getByRole('button', { name: '恢复原图' }).click();
  await expect(reverted.locator('#previewMeta')).toHaveText('3 × 2');
  closed = reverted.waitForEvent('close'); await reverted.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  const committedOriginal = await page.evaluate(id => window.paste.getItem(id), original.id);
  expect(committedOriginal.asset).toBe(original.asset); expect(committedOriginal.imageTurns).toBe(0);
  expect(committedOriginal.signature).toBe(original.signature); expect(committedOriginal.boardIds).toContain(board.id);
  await application.evaluate((_electron, id) => {
    const { store, hash } = globalThis.__pasteTest, item = store.get(id);
    item.signature = hash(store.readAsset(item.asset)); delete item.signatureFormat; store.persist();
  }, original.id);
  await application.close();
  application = await launchApplication(); page = await application.firstWindow();
  await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  const migrated = await page.evaluate(id => window.paste.getItem(id), original.id);
  expect(migrated.signature).toBe(original.signature); expect(migrated.signatureFormat).toBe('pixels-v1');
  expect(migrated.boardIds).toContain(board.id); expect(migrated.originalAsset).toBe(original.asset);
  expect(await application.evaluate((_electron, asset) => globalThis.__pasteTest.hash(globalThis.__pasteTest.store.readAsset(asset)), original.asset)).toBe(original.png);
});
test('real Vision OCR is indexed automatically, selectable, copyable and searchable', async () => {
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 420;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1200, 420); context.fillStyle = '#111';
    context.font = '64px Arial'; context.fillText('Paste Easy 2048', 60, 140);
    context.font = '64px "PingFang SC", sans-serif'; context.fillText('剪贴板文字识别', 60, 280);
    return canvas.toDataURL('image/png');
  });
  const id = await application.evaluate(async (_electron, body) => {
    await globalThis.__pasteTest.clip.write({ type: 'image', body }); await globalThis.__pasteTest.poll();
    return globalThis.__pasteTest.store.data.items[0].id;
  }, image);
  await expect.poll(async () => (await page.evaluate(id => window.paste.getItem(id), id)).ocr?.status, { timeout: 30000 }).toBe('ready');
  const item = await page.evaluate(id => window.paste.getItem(id), id);
  expect(item.ocr.text).toContain('Paste Easy 2048'); expect(item.ocr.text).toContain('剪贴板文字识别');
  expect((await page.evaluate(asset => window.paste.search(asset), item.asset)).ids).not.toContain(id);
  expect(item.ocr.engine).toBe('apple-vision-text-3'); expect(item.ocr.lines.length).toBeGreaterThanOrEqual(2);
  expect(item.ocr.lines.every(line => line.confidence >= 0 && line.confidence <= 1 && Object.values(line.box).every(value => value >= 0 && value <= 1))).toBe(true);
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id), id);
  const preview = await opened; await preview.getByRole('button', { name: '识别文字', exact: true }).click();
  await expect(preview.getByRole('textbox', { name: '识别结果' })).toHaveValue(item.ocr.text);
  await preview.getByRole('textbox', { name: '识别结果' }).press('Meta+a');
  expect(await preview.locator('#ocrText').evaluate(input => input.selectionEnd - input.selectionStart)).toBe(item.ocr.text.length);
  await preview.getByRole('button', { name: '复制识别文字' }).click();
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe(item.ocr.text);
  const count = (await page.evaluate(() => window.paste.getLibrary())).items.length;
  await application.evaluate(() => globalThis.__pasteTest.poll());
  expect((await page.evaluate(() => window.paste.getLibrary())).items.length).toBe(count);
  await preview.getByRole('button', { name: '重新识别', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(id => window.paste.getItem(id), id)).ocr?.completedAt).not.toBe(item.ocr.completedAt);
  await preview.screenshot({ path: 'test-results/preview-ocr.png' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html')).setBounds({ width: 320, height: 500 }));
  expect(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#ocrText').getBoundingClientRect().height > 20)).toBe(true);
  await preview.screenshot({ path: 'test-results/preview-ocr-narrow.png' });
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '关闭预览' }).click(); await closed;
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('2048');
  await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', id);
  await expect(page.locator('.ocr-match')).toHaveCount(1);
  const overlay = await page.locator('.ocr-match').evaluate(mark => {
    const box = mark.getBoundingClientRect(), body = mark.parentElement.getBoundingClientRect();
    return { inside: box.left >= body.left && box.top >= body.top && box.right <= body.right && box.bottom <= body.bottom, width: box.width };
  });
  expect(overlay.inside).toBe(true); expect(overlay.width).toBeLessThan(70);
  await page.screenshot({ path: 'test-results/search-image-text.png' });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await application.evaluate(async ({ clipboard, ClipboardItem }) => clipboard.write([new ClipboardItem({ 'text/plain': 'Before OCR context-menu copy' })]));
  await page.locator(`[data-id="${id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制图片中的文字', exact: true }).click();
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe(item.ocr.text);
  await application.evaluate(async (_electron, id) => {
    const hooks = globalThis.__pasteTest; await hooks.imageText.idle();
    globalThis.__originalOCR = structuredClone(hooks.store.get(id).ocr); globalThis.__recognize = hooks.imageProcessor.recognize;
    delete hooks.store.get(id).ocr;
    hooks.imageProcessor.recognize = async (_buffer, { signal }) => new Promise((resolve, reject) => {
      globalThis.__finishOCR = () => resolve({ ok: true, text: 'Late OCR result', lines: [] });
      signal.addEventListener('abort', () => reject(new Error('cancelled fixture')), { once: true });
    });
  }, id);
  try {
    await page.evaluate(id => { window.pendingOCRCopy = window.paste.copyImageText(id).then(() => 'copied', error => error.message); }, id);
    await expect.poll(() => application.evaluate(() => !!globalThis.__finishOCR)).toBe(true);
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      await clipboard.write([new ClipboardItem({ 'text/plain': 'Newer external clipboard copy' })]); globalThis.__finishOCR();
    });
    expect(await page.evaluate(() => window.pendingOCRCopy)).toContain('后续复制');
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('Newer external clipboard copy');
  } finally {
    await application.evaluate((_electron, id) => {
      globalThis.__finishOCR?.(); const hooks = globalThis.__pasteTest; hooks.imageProcessor.recognize = globalThis.__recognize;
      hooks.store.get(id).ocr = globalThis.__originalOCR; hooks.store.persist(); hooks.imageText.onChanged();
      delete globalThis.__finishOCR; delete globalThis.__recognize; delete globalThis.__originalOCR;
    }, id);
  }
});
test('real foreground segmentation retains alpha, composes with rotation and restores across saves and restart', async () => {
  const base64 = fs.readFileSync(path.join(__dirname, '../fixtures/foreground-mug.png')).toString('base64');
  const original = await application.evaluate(async (_electron, base64) => {
    const hooks = globalThis.__pasteTest;
    await hooks.clip.write({ type: 'image', body: `data:image/png;base64,${base64}` }); await hooks.poll();
    const item = hooks.store.data.items[0]; return { id: item.id, asset: item.asset, size: item.size, signature: item.signature };
  }, base64);
  const board = (await page.evaluate(() => window.paste.getLibrary())).boards[0] || await page.evaluate(() => window.paste.saveBoard({ name: 'Mask test', color: '#ef6259' }));
  await page.evaluate(({ id, board }) => window.paste.pinItems([id], board), { id: original.id, board: board.id });
  const open = async (mode = 'edit') => {
    const opened = application.waitForEvent('window'); await page.evaluate(({ id, mode }) => window.paste.openPreview(id, { mode }), { id: original.id, mode });
    const preview = await opened; await preview.waitForLoadState('domcontentloaded'); return preview;
  };
  const samples = async preview => application.evaluate(({ nativeImage }, body) => {
    const image = nativeImage.createFromDataURL(body), size = image.getSize(), bitmap = image.toBitmap();
    const at = (x, y) => [...bitmap.subarray((Math.floor(y * size.height) * size.width + Math.floor(x * size.width)) * 4, (Math.floor(y * size.height) * size.width + Math.floor(x * size.width)) * 4 + 4)];
    let transparent = 0, solid = 0;
    for (let n = 3; n < bitmap.length; n += 4) { if (bitmap[n] === 0) transparent += 1; if (bitmap[n] >= 250) solid += 1; }
    return { corner: at(.02, .02), center: at(.45, .55), hole: at(.78, .5), transparent, solid };
  }, (await preview.evaluate(() => window.paste.getPreview())).item.body);
  const preview = await open(), before = await samples(preview);
  await preview.getByRole('button', { name: '移除背景', exact: true }).click();
  await expect(preview.getByRole('button', { name: '恢复背景', exact: true })).toBeEnabled({ timeout: 30000 });
  const cut = await samples(preview);
  expect(cut.corner[3]).toBe(0); expect(cut.hole[3]).toBe(0); expect(cut.center[3]).toBe(255);
  expect(cut.transparent).toBeGreaterThan(original.size.width * original.size.height * .4);
  expect(cut.solid).toBeGreaterThan(original.size.width * original.size.height * .2);
  expect(cut.center.slice(0, 3).every((value, index) => Math.abs(value - before.center[index]) <= 2)).toBe(true);
  await preview.screenshot({ path: 'test-results/preview-foreground.png' });
  await preview.keyboard.press('Meta+z'); await expect(preview.getByRole('button', { name: '移除背景', exact: true })).toBeEnabled();
  expect((await samples(preview)).corner[3]).toBe(255);
  await preview.keyboard.press('Meta+Shift+z'); await expect(preview.getByRole('button', { name: '恢复背景', exact: true })).toBeEnabled();
  await preview.getByRole('button', { name: '向右旋转' }).click();
  await expect.poll(() => preview.evaluate(() => window.paste.getPreview().then(value => value.imageEdit.turns))).toBe(1);
  let closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  const saved = await page.evaluate(id => window.paste.getItem(id), original.id);
  expect(saved.backgroundRemoved).toBe(true); expect(saved.imageTurns).toBe(1); expect(saved.foregroundAsset).toMatch(/^[a-f0-9]{64}\.png$/);
  expect(saved.originalAsset).toBe(original.asset); expect(saved.boardIds).toContain(board.id);
  await page.evaluate(id => window.paste.copy(id, { paste: false }), original.id);
  expect(await application.evaluate(async ({ nativeImage }) => { const value = await globalThis.__pasteTest.clip.read(); return nativeImage.createFromBuffer(value.image).toBitmap()[3]; })).toBe(0);
  const restored = await open(); await restored.getByRole('button', { name: '恢复背景', exact: true }).click();
  await expect(restored.getByRole('button', { name: '移除背景', exact: true })).toBeEnabled();
  expect((await restored.evaluate(() => window.paste.getPreview())).imageEdit.turns).toBe(1);
  expect((await samples(restored)).corner[3]).toBe(255);
  closed = restored.waitForEvent('close'); await restored.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  expect((await page.evaluate(id => window.paste.getItem(id), original.id)).backgroundRemoved).toBe(false);
  const reset = await open(); await reset.getByRole('button', { name: '恢复原图' }).click();
  closed = reset.waitForEvent('close'); await reset.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  expect((await page.evaluate(id => window.paste.getItem(id), original.id)).asset).toBe(original.asset);
  await application.close(); application = await launchApplication(); page = await application.firstWindow();
  await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  const reopened = await page.evaluate(id => window.paste.getItem(id), original.id);
  expect(reopened.asset).toBe(original.asset); expect(reopened.foregroundAsset).toBe(saved.foregroundAsset); expect(reopened.boardIds).toContain(board.id);
  await page.evaluate(id => window.paste.recognizeItem(id), original.id);
  expect((await page.evaluate(id => window.paste.getItem(id), original.id)).ocr.status).toBe('none');
  const clipboardBefore = await application.evaluate(({ clipboard }) => clipboard.readText());
  await expect(page.evaluate(id => window.paste.copyImageText(id), original.id)).rejects.toThrow(/未识别到/);
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(clipboardBefore);
});
test('file clipboard entries remain file URLs rather than degraded text', async () => {
  const files = ['example.txt', 'other file.txt'].map(name => path.join(directory, name));
  files.forEach(file => fs.writeFileSync(file, 'Test file'));
  const uris = files.map(file => require('node:url').pathToFileURL(file).href);
  await application.evaluate(async (_electron, uris) => {
    await globalThis.__pasteTest.clip.write({ type: 'file', body: uris.join('\n') });
    await globalThis.__pasteTest.poll();
  }, uris);
  await expect(page.locator('.clip-card[data-type=file]')).toHaveCount(1);
  const id = await page.locator('.clip-card[data-type=file]').getAttribute('data-id');
  await page.evaluate(id => window.paste.copy(id, { paste: false }), id);
  const returned = await application.evaluate(async () => (await globalThis.__pasteTest.clip.read()).files);
  expect(returned).toEqual(uris);
  expect(await page.evaluate(id => window.paste.shareItem(id), id)).toEqual({ filePaths: files });
  expect(await page.evaluate(id => window.paste.revealItem(id, 1), id)).toBe(files[1]);
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id), id);
  const preview = await opened;
  await expect(preview.locator('.file-list li')).toHaveCount(2);
  await preview.screenshot({ path: 'test-results/preview-files.png' });
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '关闭预览' }).click(); await closed;
  fs.unlinkSync(files[1]);
  await expect(page.evaluate(id => window.paste.startDrag([id]), id)).rejects.toThrow(/移动或删除/);
});
test('rich preview isolates scripts, external resources and parent-window access', async () => {
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    const html = '<b>Safe rich content</b><script>parent.evil=true</script><img src="https://example.invalid/private" onerror="parent.evil=true"><a href="https://example.invalid">Link</a><form action="https://example.invalid"><input name="secret"></form>';
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Safe rich content', 'text/html': html })]);
    await globalThis.__pasteTest.poll();
  });
  const id = await page.locator('.clip-card').first().getAttribute('data-id');
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id), id);
  const preview = await opened, frame = preview.frameLocator('iframe');
  await expect(frame.locator('b')).toHaveText('Safe rich content');
  await expect(frame.locator('script, [onerror], [src], [href], form, input')).toHaveCount(0);
  const isolated = await frame.locator('body').evaluate(() => { try { return !parent.document; } catch (error) { return error.name === 'SecurityError'; } });
  expect(isolated).toBe(true); expect(await preview.evaluate(() => window.evil)).toBeUndefined();
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '关闭预览' }).click(); await closed;
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
    const imageResult = await application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, marker) => {
      const hooks = globalThis.__pasteTest, original = hooks.imageText.enqueue, count = hooks.store.data.items.length; let calls = 0;
      hooks.imageText.enqueue = function (...args) { calls += 1; return original.apply(this, args); };
      try {
        const image = nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 255), { width: 32, height: 32, scaleFactor: 1 }).toPNG();
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image]), [`electron application/osclipboard;format="${marker}"`]: new Blob(['1']) })]);
        await hooks.poll(); return { difference: hooks.store.data.items.length - count, calls };
      } finally { hooks.imageText.enqueue = original; }
    }, marker);
    expect(imageResult).toEqual({ difference: 0, calls: 0 });
  }
});
test('native change counts avoid payload rereads and paused copies are not replayed', async () => {
  const result = await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    const hooks = globalThis.__pasteTest, read = hooks.clip.read;
    let reads = 0;
    hooks.clip.read = async function () { reads += 1; return read.call(this); };
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': 'Counter integration sample' })]); await hooks.poll();
      for (let index = 0; index < 25; index++) await hooks.poll();
      return { reads, count: hooks.store.data.items.filter(item => item.body === 'Counter integration sample').length };
    } finally { hooks.clip.read = read; }
  });
  expect(result).toEqual({ reads: 1, count: 1 });
  const theme = (await page.evaluate(() => window.paste.getLibrary())).settings.theme;
  await page.evaluate(() => Promise.all([window.paste.saveSettings({ paused: true }), window.paste.saveSettings({ theme: 'light' })]));
  expect((await page.evaluate(() => window.paste.getLibrary())).settings.paused).toBe(true);
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Private while paused integration sample' })]); await globalThis.__pasteTest.poll();
  });
  await page.evaluate(() => window.paste.saveSettings({ paused: false }));
  await application.evaluate(async () => globalThis.__pasteTest.poll());
  expect((await page.evaluate(() => window.paste.getLibrary())).items.some(item => item.body === 'Private while paused integration sample')).toBe(false);
  await page.evaluate(theme => window.paste.saveSettings({ theme }), theme);
});
test('Stack preserves explicit selection order and consumes only successful copies', async () => {
  const ids = await page.locator('.clip-card[data-type=text], .clip-card[data-type=code], .clip-card[data-type=link]').evaluateAll(nodes => nodes.slice(0, 2).map(node => node.dataset.id));
  await page.evaluate(async ids => { await window.paste.toggleStack(); for (const id of ids) await window.paste.addToStack(id); }, ids);
  await expect(page.locator('#stackCount')).toHaveText('2');
  await page.evaluate(() => window.paste.nextInStack()); await expect(page.locator('#stackCount')).toHaveText('1');
  const firstBody = await page.evaluate(async id => (await window.paste.getItem(id)).body, ids[0]);
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(firstBody);
  await page.evaluate(() => window.paste.toggleStack());
});
test('large originals remain searchable, copyable, draggable and restorable without flooding catalog IPC', async () => {
  const body = 'Synthetic long clipboard text 🧪\n'.repeat(7000) + 'unique-tail-482709';
  const id = await application.evaluate(async (_electron, body) => {
    const hooks = globalThis.__pasteTest; await hooks.clip.write({ type: 'text', body }); await hooks.poll(); return hooks.store.data.items[0].id;
  }, body);
  let compact = (await page.evaluate(() => window.paste.getLibrary())).items.find(item => item.id === id);
  expect(compact.body).toBe(''); expect(compact.preview.length).toBeLessThanOrEqual(2000); expect(compact.characterCount).toBe([...body].length);
  expect(JSON.stringify(compact)).not.toContain('unique-tail-482709');
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('unique-tail-482709');
  await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', id);
  const drag = await page.locator('.clip-card').evaluate(node => {
    const dataTransfer = new DataTransfer(); node.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    document.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return dataTransfer.getData('text/plain');
  });
  expect(drag).toBe(body);
  await page.evaluate(id => window.paste.copy(id, { paste: false }), id);
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(body);
  const disk = JSON.parse(fs.readFileSync(path.join(directory, 'library.json'))).items.find(item => item.id === id);
  expect(disk.contentAsset).toMatch(/^[a-f0-9]{64}\.json$/); expect(disk.body).toBeUndefined();
  expect(await application.evaluate((_electron, id) => globalThis.__pasteTest.store.exportData().items.find(item => item.id === id).body, id)).toBe(body);
  await application.close(); application = await launchApplication(); page = await application.firstWindow();
  await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe(body);
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('unique-tail-482709');
  await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', id);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('out-of-order search replies cannot replace newer results or paste an obsolete selection', async () => {
  await application.evaluate(() => {
    const service = globalThis.__pasteTest.searchService; globalThis.__searchOriginal = service.search;
    service.search = async function(items, revision, query) {
      const result = await globalThis.__searchOriginal.call(this, items, revision, query);
      if (query === 'delayed-no-results') return new Promise(resolve => { globalThis.__releaseSearch = () => resolve(result); });
      return result;
    };
  });
  try {
    await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('delayed-no-results');
    await expect.poll(() => application.evaluate(() => !!globalThis.__releaseSearch)).toBe(true);
    await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'true');
    const before = await application.evaluate(({ clipboard }) => clipboard.readText());
    await page.locator('#timeline').focus(); await page.keyboard.press('Enter');
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
    await search.fill('unique-tail-482709'); await expect(page.locator('.clip-card')).toHaveCount(1);
    const current = await page.locator('.clip-card').getAttribute('data-id');
    await application.evaluate(() => globalThis.__releaseSearch());
    await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', current);
    await expect(search).toHaveValue('unique-tail-482709');
    await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false');
  } finally {
    await application.evaluate(() => { globalThis.__releaseSearch?.(); globalThis.__pasteTest.searchService.search = globalThis.__searchOriginal; delete globalThis.__releaseSearch; delete globalThis.__searchOriginal; });
  }
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('background library revisions preserve the chosen search result rather than resetting to the first item', async () => {
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest;
    for (const body of ['Selection marker first', 'Selection marker second']) hooks.store.add({ type: 'text', body, title: body, preview: body });
    hooks.imageText.onChanged();
  });
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('Selection marker');
  await expect(page.locator('.clip-card')).toHaveCount(2); await page.locator('.clip-card').nth(1).click();
  const selected = await page.locator('.clip-card.selected').getAttribute('data-id');
  await page.evaluate(async () => {
    const { settings } = await window.paste.getLibrary();
    await Promise.all([window.paste.saveSettings({ theme: settings.theme }), window.paste.saveSettings({ theme: settings.theme })]);
  });
  await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', selected);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('main IPC remains responsive while the worker builds a real large-text index', async () => {
  test.setTimeout(60000);
  await application.evaluate(async () => {
    const hooks = globalThis.__pasteTest; if (hooks.searchService.worker) await hooks.searchService.worker.terminate();
    const body = 'Synthetic large index content '.repeat(32000), createdAt = new Date().toISOString();
    for (let n = 0; n < 100; n++) hooks.store.data.items.push({ id: `stress-${n}`, type: 'text', body: `${body}stress-tail-${n}`,
      signature: hooks.hash(`${body}${n}`), title: `Stress ${n}`, createdAt, boardIds: [], preview: body.slice(0, 2000) });
    hooks.store.persist(); hooks.imageText.onChanged();
  });
  try {
    await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('stress-tail-99');
    const library = await page.evaluate(() => window.paste.getLibrary());
    expect(library.items.some(item => item.id === 'stress-99')).toBe(true);
    expect(await application.evaluate(() => globalThis.__pasteTest.searchService.pending.size)).toBeGreaterThan(0);
    await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', 'stress-99');
  } finally {
    await page.evaluate(() => window.paste.deleteItems(Array.from({ length: 100 }, (_, n) => `stress-${n}`)));
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  }
});
test('large libraries remain virtualized and can navigate to the last clip', async () => {
  await application.evaluate(({ BrowserWindow }) => {
    const store = globalThis.__pasteTest.store;
    const createdAt = new Date().toISOString();
    for (let index = 0; index < 2000; index++) store.data.items.push({ id: `large-${index}`, signature: `large-${index}`, type: 'text', body: `Row ${index}`, preview: `Row ${index}`, title: `Row ${index}`, createdAt, boardIds: [] });
    store.persist(); BrowserWindow.getAllWindows()[0].webContents.send('library:changed', store.snapshot());
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
  await settings.getByRole('switch', { name: '音效', exact: true }).check();
  await settings.getByRole('switch', { name: '后台运行', exact: true }).uncheck();
  await settings.getByRole('slider', { name: '保留历史' }).fill('4');
  await settings.getByRole('button', { name: '隐私', exact: true }).click();
  await expect(settings.getByRole('switch', { name: /忽略机密内容/ })).toBeChecked();
  await settings.getByRole('textbox', { name: '忽略应用的 Bundle ID' }).fill('com.example.private');
  await settings.getByRole('button', { name: '添加忽略应用' }).click();
  await expect(settings.locator('#excludedApps')).toContainText('com.example.private');
  await settings.screenshot({ path: 'test-results/settings-privacy.png' });
  await settings.getByRole('button', { name: '键盘快捷键', exact: true }).click();
  await settings.getByLabel('快速粘贴修饰键').selectOption('Alt');
  await settings.getByLabel('纯文本修饰键').selectOption('Control');
  await settings.getByRole('button', { name: '下一个 Pinboard 快捷键' }).click(); await settings.keyboard.press('Alt+ArrowRight');
  await expect(settings.getByRole('button', { name: '下一个 Pinboard 快捷键' })).toHaveText('⌥→');
  await settings.screenshot({ path: 'test-results/settings-shortcuts.png' });
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(directory, 'library.json'))).settings.retentionDays).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'library.json'))).settings.plainText).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'library.json'))).settings.nextBoardHotkey).toBe('Alt+Right');
  await settings.close();
});
