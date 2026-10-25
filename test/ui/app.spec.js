const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { assertClipboardIsolation } = require('../../scripts/clipboard-test-environment');
const { preserveClipboard } = require('../../scripts/pasteboard-snapshot');
let application, page, directory, originalClipboard;
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

async function seedKeyboardItems(prefix, count = 3) {
  return application.evaluate((_electron, { prefix, count }) => {
    const hooks = globalThis.__pasteTest;
    const items = Array.from({ length: count }, (_, n) => {
      const body = `${prefix} ${n}\nSynthetic keyboard fixture`;
      const item = hooks.store.add({ type: 'text', body, title: `${prefix} ${n}`, preview: body });
      return { id: item.id, body: item.body, title: item.title };
    });
    hooks.imageText.onChanged(); return items;
  }, { prefix, count });
}

async function closePreviewWithKey(preview, key) {
  const closed = preview.waitForEvent('close');
  try { await preview.keyboard.press(key); }
  catch (error) {
    // A successful save can destroy the page before Playwright dispatches key-up.
    if (!preview.isClosed() || !/Target page, context or browser has been closed/.test(error.message)) throw error;
  }
  await closed;
}

async function nativePreviewKey(key, repeat = false) {
  // CDP key dispatch bypasses Electron's native before-input-event hook.
  await application.evaluate(({ BrowserWindow }, { key, repeat }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html'));
    window.focus(); const modifiers = repeat ? ['meta', 'isautorepeat'] : ['meta'];
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['meta'] });
  }, { key, repeat });
}

test.beforeAll(async () => {
  assertClipboardIsolation();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-ui-'));
  originalClipboard = preserveClipboard(directory);
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
});
test.afterAll(async () => {
  try {
    if (application) {
      // Failed editor tests must not leave a native unsaved-draft dialog blocking teardown.
      try { await application.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().endsWith('/preview.html')) window.destroy();
      }); } finally { await application.close(); }
    }
  } finally {
    originalClipboard?.restore();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('real Electron atomic rich/plain/image writes retain their guarded ownership and invalidate after a later copy', async () => {
  const result = await application.evaluate(async ({ nativeImage }) => {
    const hooks = globalThis.__pasteTest;
    // Use a real PNG generated by Chromium, not hand-encoded clipboard bytes.
    const image = nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1, scaleFactor: 1 });
    if (image.isEmpty()) throw Error('Synthetic PNG fixture could not decode');
    const receipts = [];
    for (const options of [{ item: { type: 'text', body: 'Guarded 中文', html: '<b>Guarded 中文</b>', rtf: '{\\rtf1 Guarded}' } },
      { item: { type: 'text', body: 'Guarded plain', html: '<b>Guarded plain</b>' }, plain: true },
      { item: { type: 'image' }, image: image.toPNG() }]) {
      const { item, ...writeOptions } = options;
      const receipt = await hooks.pasteOwnership.write(writeID => hooks.clip.write(item, { ...writeOptions, writeID }));
      const before = await hooks.pasteOwnership.verify(receipt.lease), read = await hooks.clip.read();
      await hooks.clip.write({ type: 'text', body: 'Later synthetic foreign copy' });
      receipts.push({ before, sameSignature: read.signature === receipt.signature, after: await hooks.pasteOwnership.verify(receipt.lease) });
    }
    return receipts;
  });
  for (const receipt of result) { expect(receipt.before).toEqual({ ok: true }); expect(receipt.sameSignature).toBe(true); expect(receipt.after).toEqual({ ok: false, error: 'clipboard-changed' }); }
});

test('real guarded native multi-file clipboard preserves URL items and one-write version', async () => {
  const result = await application.evaluate(async () => {
    const hooks = globalThis.__pasteTest, files = ['file:///tmp/guarded%20a.txt', 'file:///tmp/guarded-b.txt'];
    const receipt = await hooks.pasteOwnership.write(writeID => hooks.clip.write({ type: 'file', body: files.join('\n') }, { writeID }));
    return { verified: await hooks.pasteOwnership.verify(receipt.lease), files: (await hooks.clip.read()).files };
  });
  expect(result).toEqual({ verified: { ok: true }, files: ['file:///tmp/guarded%20a.txt', 'file:///tmp/guarded-b.txt'] });
});
test('real merged selection writes RTFD attachments and HTML in one guarded Electron ClipboardItem', async () => {
  const result = await application.evaluate(async ({ clipboard, nativeImage }) => {
    const hooks = globalThis.__pasteTest, ids = [];
    try {
      ids.push(hooks.store.add({ type: 'text', body: 'Selection 中文', html: '<b>Selection 中文</b>', title: 'Synthetic batch' }).id);
      for (const [i, pixel] of [[0, [0, 0, 255, 255]], [1, [255, 0, 0, 255]]]) {
        const png = nativeImage.createFromBitmap(Buffer.from(pixel), { width: 1, height: 1 }).toPNG(), asset = hooks.store.putAsset(png);
        ids.push(hooks.store.add({ type: 'image', body: asset, asset, title: `Synthetic image ${i}`, size: { width: 1, height: 1 } }).id);
      }
      const { item, references } = await hooks.selectionService.prepare(ids); hooks.selectionService.verify(references);
      const receipt = await hooks.pasteOwnership.write(writeID => hooks.clip.write(item, { writeID }));
      const entries = await clipboard.read(), type = 'electron application/osclipboard;format="com.apple.flat-rtfd"';
      const data = await entries[0].getType(type), read = await hooks.clip.read();
      return { count: entries.length, rtfd: Buffer.from(await data.arrayBuffer()).toString('base64') === item.rtfd,
        text: read.text, htmlImages: (read.html.match(/<img\b/g) || []).length, owned: await hooks.pasteOwnership.verify(receipt.lease) };
    } finally { hooks.store.delete(ids); hooks.imageText.onChanged(); }
  });
  expect(result).toEqual({ count: 1, rtfd: true, text: 'Selection 中文\nSynthetic image 0\nSynthetic image 1', htmlImages: 2, owned: { ok: true } });
});

test('real clipboard rich payloads with embedded field delimiters keep separate pinned identities and recopy correctly', async () => {
  const previous = await page.evaluate(() => window.paste.getLibrary()).then(value => value.settings); let cleanup;
  try {
    await page.evaluate(() => window.paste.saveSettings({ paused: false, excludedApps: [] }));
    cleanup = await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const hooks = globalThis.__pasteTest, sources = [{ body: 'Real identity wire\nhtml:<p>Alpha</p>', html: '<p>Beta</p>' },
        { body: 'Real identity wire', html: '<p>Alpha</p>\nhtml:<p>Beta</p>' }], captured = [];
      for (const source of sources) {
        await clipboard.write([new ClipboardItem({ 'text/plain': source.body, 'text/html': source.html })]); await hooks.poll();
        const read = await hooks.clip.read(), item = hooks.store.data.items.find(value => value.signature === read.signature);
        captured.push({ id: item.id, body: hooks.store.get(item.id).body, html: hooks.store.get(item.id).html, signature: item.signature });
        if (captured.length === 1) { const board = hooks.store.saveBoard({ name: 'Identity original', color: '#ef6259' }); hooks.store.update(item.id, { title: 'My pinned original', boardIds: [board.id] }); globalThis.__identityBoard = board.id; }
      }
      await clipboard.write([new ClipboardItem({ 'text/plain': sources[0].body, 'text/html': sources[0].html })]); await hooks.poll();
      const saved = hooks.store.get(captured[0].id); return { captured, board: globalThis.__identityBoard, saved: { body: saved.body, html: saved.html, title: saved.title, boardIds: saved.boardIds },
        count: hooks.store.data.items.filter(value => captured.some(item => value.signature === item.signature)).length };
    });
    const { htmlPayload } = require('../../src/store');
    expect(cleanup.captured[0].id).not.toBe(cleanup.captured[1].id); expect(cleanup.count).toBe(2);
    expect(cleanup.saved).toMatchObject({ body: 'Real identity wire\nhtml:<p>Alpha</p>', title: 'My pinned original', boardIds: [cleanup.board] });
    expect(htmlPayload(cleanup.captured[0].html)).toBe('<p>Beta</p>'); expect(htmlPayload(cleanup.captured[1].html)).toBe('<p>Alpha</p>\nhtml:<p>Beta</p>');
  } finally {
    if (cleanup) await application.evaluate((_electron, value) => { const { store } = globalThis.__pasteTest; store.delete(value.captured.map(item => item.id)); store.deleteBoard(value.board); }, cleanup);
    await page.evaluate(value => window.paste.saveSettings(value), previous);
  }
});
test('self-copy remembers actual Unicode wire content while preserving stored surrogate and nullable originals', async () => {
  const previous = await page.evaluate(() => window.paste.getLibrary()).then(value => value.settings); let created = [];
  try {
    await page.evaluate(() => window.paste.saveSettings({ paused: false, plainText: false, excludedApps: [] }));
    const result = await application.evaluate(async () => {
      const { store } = globalThis.__pasteTest, rows = [{ body: 'Stored surrogate \uD800', html: '<b>Stored \uD801</b>', rtf: '' }, { body: 'Stored nullable formats', html: null, rtf: null }];
      return rows.map(value => ({ id: store.add({ ...value, type: 'text' }).id, ...value }));
    }); created = result.map(item => item.id);
    for (const source of result) {
      const count = await application.evaluate(() => globalThis.__pasteTest.store.data.items.length);
      await page.evaluate(id => window.paste.copy(id), source.id);
      const wire = await application.evaluate(async () => { const hooks = globalThis.__pasteTest; const value = await hooks.clip.read(); await hooks.poll(); return { text: value.text, signature: value.signature, remembered: hooks.monitor.signature, count: hooks.store.data.items.length }; });
      expect(wire.text).toBe(source.body.toWellFormed()); expect(wire.signature).toBe(wire.remembered); expect(wire.count).toBe(count);
      const stored = await page.evaluate(id => window.paste.getItem(id), source.id); expect(stored.body).toBe(source.body); expect(stored.html).toBe(source.html); expect(stored.rtf).toBe(source.rtf);
    }
  } finally {
    if (created.length) await application.evaluate((_electron, ids) => globalThis.__pasteTest.store.delete(ids), created);
    await page.evaluate(value => window.paste.saveSettings(value), previous);
  }
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
  await expect(page.locator('#timeline')).toBeFocused();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
  await page.keyboard.press('Tab'); await expect(page.getByRole('searchbox', { name: '搜索剪贴板' })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#timeline')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('searchbox', { name: '搜索剪贴板' })).toBeFocused();
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
test('edited list numbering and HTML survive real clipboard copy, plain mode and export', async () => {
  const html = '<p>List fixture</p><ol reversed type="A"><li><p>First</p></li><li value="7"><p>Restart</p><ul style="list-style-type:square"><li><p>Nested</p></li></ul></li><li><p>Last</p></li></ol>';
  const id = await application.evaluate(async ({ clipboard, ClipboardItem }, html) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'List fixture', 'text/html': html })]);
    await globalThis.__pasteTest.poll(); return globalThis.__pasteTest.store.data.items[0].id;
  }, html);
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' });
  await preview.waitForFunction(() => document.body.dataset.previewReady === 'true');
  await editor.evaluate(element => { element.editor.commands.setTextSelection(1); element.editor.view.focus(); });
  await preview.keyboard.insertText('Updated ');
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  const expected = 'Updated List fixture\nC. First\nG. Restart\n  ▪ Nested\nF. Last';
  const saved = await page.evaluate(id => window.paste.getItem(id), id); expect(saved.body).toBe(expected);
  await page.evaluate(id => window.paste.copy(id, { paste: false }), id);
  const actual = await application.evaluate(async () => globalThis.__pasteTest.clip.read());
  expect(actual.text).toBe(expected); expect(actual.html).toContain('reversed'); expect(actual.html).toContain('value="7"');
  expect(actual.signature).toBe(saved.signature);
  await page.evaluate(id => window.paste.copy(id, { paste: false, plain: true }), id);
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(expected);
  expect(await application.evaluate(async ({ clipboard }) => (await clipboard.read())[0].types)).not.toContain('text/html');
  const exported = await application.evaluate((_electron, id) => globalThis.__pasteTest.store.exportData().items.find(item => item.id === id), id);
  expect(exported.body).toBe(expected); expect(exported.html).toBe(saved.html);
});
test('real editor clipboard copy respects partial words and noncontiguous table cell ranges', async () => {
  const id = await application.evaluate(() => {
    const hooks = globalThis.__pasteTest, item = hooks.store.add({ type: 'text', body: 'Synthetic selected table',
      html: '<table><tr><td><p>Visible word</p></td><td><p>Private neighbor</p></td></tr><tr><td><p>Other visible</p></td><td><p>Private second</p></td></tr></table>' });
    hooks.imageText.onChanged(); return item.id;
  });
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const preview = await opened; await preview.waitForFunction(() => document.body.dataset.previewReady === 'true');
  const editor = preview.getByRole('textbox', { name: '剪贴板内容' });
  for (const rectangular of [false, true]) {
    await application.evaluate(async () => globalThis.__pasteTest.clip.write({ type: 'text', body: 'Copy sentinel' }));
    await editor.evaluate((element, rectangular) => {
      const engine = element.editor, text = new Map(), cells = new Map();
      engine.state.doc.descendants((node, pos) => {
        if (node.isText) text.set(node.text, pos);
        if (node.type.name === 'tableCell') cells.set(node.textContent, pos);
      });
      if (rectangular) engine.commands.setCellSelection({ anchorCell: cells.get('Other visible'), headCell: cells.get('Visible word') });
      else engine.commands.setTextSelection({ from: text.get('Visible word'), to: text.get('Visible word') + 7 });
      engine.view.focus();
    }, rectangular);
    await preview.keyboard.press('Meta+c');
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe(rectangular ? 'Visible word\nOther visible' : 'Visible');
    const actual = await application.evaluate(async () => globalThis.__pasteTest.clip.read());
    expect(actual.html).not.toContain('Private'); if (!rectangular) expect(actual.html).not.toContain('word');
  }
  await preview.close();
});
test('real plain clipboard paste preserves blank lines, padded ordinals and Markdown punctuation through save and copy', async () => {
  const text = '  001) **literal**\n\n\n\t002) <b>not HTML</b> 🙂\n\n';
  const id = await application.evaluate(() => {
    const hooks = globalThis.__pasteTest, item = hooks.store.add({ type: 'text', body: 'Replace me' }); hooks.imageText.onChanged(); return item.id;
  });
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const preview = await opened; await preview.waitForFunction(() => document.body.dataset.previewReady === 'true');
  const editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await editor.press('Meta+a');
  await application.evaluate(async ({ clipboard, ClipboardItem }, text) => clipboard.write([new ClipboardItem({ 'text/plain': text })]), text);
  await editor.press('Meta+v'); await expect(editor.locator('ol,strong,b')).toHaveCount(0);
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  const saved = await page.evaluate(id => window.paste.getItem(id), id); expect(saved.body).toBe(text); expect(saved.html).not.toContain('<ol');
  await page.evaluate(id => window.paste.copy(id, { paste: false }), id);
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
  const exported = await application.evaluate((_electron, id) => globalThis.__pasteTest.store.exportData().items.find(item => item.id === id), id);
  expect(exported.body).toBe(text);
});
test('real RTF clipboard capture edits and copies regenerated rich formats without losing identity', async () => {
  const previous = (await page.evaluate(() => window.paste.getLibrary())).settings;
  try {
    await page.evaluate(() => window.paste.saveSettings({ paused: false, excludedApps: [], plainText: false }));
    const original = await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const rtf = String.raw`{\rtf1\ansi{\b Real RTF only} sample}`;
      await clipboard.write([new ClipboardItem({ 'text/plain': 'Real RTF only sample', 'text/rtf': rtf })]);
      const hooks = globalThis.__pasteTest; await hooks.poll(); return hooks.store.get(hooks.store.data.items[0].id);
    });
    expect(original.rtf).toContain('rtf1');
    const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), original.id);
    const preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor.locator('strong')).toHaveText('Real RTF only');
    await editor.evaluate(element => { element.editor.commands.focus('end'); element.editor.commands.insertContent('!'); });
    const closed = preview.waitForEvent('close'); await preview.locator('#savePreview').click(); await closed;
    const saved = await page.evaluate(id => window.paste.getItem(id), original.id); expect(saved.body).toBe('Real RTF only sample!'); expect(saved.rtf).not.toBe(original.rtf);
    await page.evaluate(id => window.paste.copy(id, { paste: false }), original.id);
    const copied = await application.evaluate(() => globalThis.__pasteTest.clip.read()); expect(copied.text).toBe(saved.body); expect(copied.rtf).toBe(saved.rtf); expect(copied.html).toContain('<strong>Real RTF only</strong>'); expect(copied.signature).toBe(saved.signature);
    await application.evaluate(() => globalThis.__pasteTest.poll()); expect((await page.evaluate(() => window.paste.getLibrary())).items.filter(item => item.id === original.id)).toHaveLength(1);
    await page.evaluate(id => window.paste.copy(id, { paste: false, plain: true }), original.id);
    const plain = await application.evaluate(async ({ clipboard }) => ({ text: await clipboard.readText(), types: (await clipboard.read())[0].types })); expect(plain.text).toBe(saved.body); expect(plain.types).not.toContain('text/rtf');
  } finally { await page.evaluate(settings => window.paste.saveSettings(settings), previous); }
});
test('opening an editor or undoing all changes never normalizes the original HTML or RTF', async () => {
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'No change', 'text/html': '<div><b>No change</b></div>', 'text/rtf': '{\\rtf1\\ansi No change}' })]);
    await globalThis.__pasteTest.poll();
  });
  await expect(page.locator('.clip-card').first()).toContainText('No change');
  const id = await page.locator('.clip-card').first().getAttribute('data-id'), before = await page.evaluate(id => window.paste.getItem(id), id);
  for (const undoAll of [false, true]) {
    const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
    const preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toHaveText('No change');
    if (undoAll) {
      await editor.press('Meta+a'); await preview.keyboard.insertText('Temporary replacement'); await expect(editor).toHaveText('Temporary replacement');
      await preview.getByRole('button', { name: '撤销', exact: true }).click(); await expect(editor).toHaveText('No change');
    }
    const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
    const after = await page.evaluate(id => window.paste.getItem(id), id);
    expect(after.html).toBe(before.html); expect(after.rtf).toBe(before.rtf); expect(after.signature).toBe(before.signature);
  }
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
  await expect(editor).toHaveText('Safe editor fixture');
  await expect(preview.locator('#previewStatus')).toHaveText(/暂不支持编辑/);
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Safe paste', 'text/html': '<p><b>Safe paste</b><script>window.evil=true</script></p>' })]);
  });
  await editor.press('Meta+v');
  await expect(editor).toHaveText('Safe paste');
  await expect(preview.locator('#previewMeta')).toHaveText('10 个字符');
  await expect(editor.locator('script,iframe,img,form,input,[onerror],[src]')).toHaveCount(0);
  expect(await preview.evaluate(() => window.evil)).toBeUndefined();
  let closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Embedded document', 'text/html': '<p>Embedded document</p><svg><text>Vector label</text></svg>' })]); await globalThis.__pasteTest.poll();
  });
  await expect(page.locator('.clip-card').first()).toContainText('Embedded document'); id = await page.locator('.clip-card').first().getAttribute('data-id');
  const before = await page.evaluate(id => window.paste.getItem(id), id);
  opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  preview = await opened;
  await expect(preview.getByRole('button', { name: '保存', exact: true })).toBeHidden();
  await expect(preview.frameLocator('iframe').locator('p')).toHaveText('Embedded document');
  closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '关闭预览' }).click(); await closed;
  expect((await page.evaluate(id => window.paste.getItem(id), id)).html).toBe(before.html);
});
test('rich tables and embedded raster images retain structure, style, coordinates and exact image bytes through edits and restart', async () => {
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#26a477'; context.fillRect(0, 0, 96, 64); context.fillStyle = '#f6c43d'; context.fillRect(10, 10, 32, 32); return canvas.toDataURL('image/png');
  });
  const html = `<p>Table fixture</p><table style="width:360px;border-collapse:collapse"><colgroup><col width="140" style="width:140.25px"><col style="width:219.75px"></colgroup><tbody>
    <tr><th colspan="2" style="background-color:rgb(234,245,252);text-align:center"><p>Schedule</p></th></tr>
    <tr><td rowspan="2" style="background-color:rgb(250,240,210);vertical-align:middle"><p>Alpha</p></td><td style="text-align:right"><p>Ready</p></td></tr>
    <tr><td><p>Pending</p></td></tr></tbody></table><p>Embedded <img src="${image}" width="96" height="64" alt="Synthetic bitmap"> tail</p>`;
  const id = await application.evaluate(async ({ clipboard, ClipboardItem }, html) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Table fixture\nSchedule\nAlpha\tReady\n\tPending\nEmbedded Synthetic bitmap tail', 'text/html': html })]);
    await globalThis.__pasteTest.poll(); return globalThis.__pasteTest.store.data.items[0].id;
  }, html);
  const before = await page.evaluate(id => window.paste.getItem(id), id);
  let opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  let preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' });
  await expect(editor.locator('table')).toHaveCount(1); await expect(editor.locator('tr')).toHaveCount(3);
  expect(await editor.locator('table').evaluate(table => table.style.width)).toBe('360px');
  expect(await editor.locator('col').evaluateAll(cols => cols.map(col => col.style.width))).toEqual(['140.25px', '219.75px']);
  await expect(editor.locator('th')).toHaveAttribute('colwidth', '140.25,219.75'); await expect(editor.locator('td').last()).toHaveAttribute('colwidth', '219.75');
  await expect(editor.locator('th')).toHaveAttribute('colspan', '2'); await expect(editor.locator('td').first()).toHaveAttribute('rowspan', '2');
  await expect(editor.locator('td').first()).toHaveCSS('background-color', 'rgb(250, 240, 210)');
  await expect(editor.locator('td').nth(1)).toHaveCSS('text-align', 'right');
  await expect.poll(() => editor.locator('img').evaluate(img => img.complete && img.naturalWidth === 96 && img.naturalHeight === 64)).toBe(true);
  await expect(editor.locator('img')).toHaveAttribute('src', image);
  const theme = (await page.evaluate(() => window.paste.getLibrary())).settings.theme;
  for (const value of ['light', 'dark']) {
    await page.evaluate(theme => window.paste.saveSettings({ theme }), value);
    await expect(editor).toHaveCSS('color', 'rgb(34, 34, 34)'); await expect(preview.locator('#previewContent')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  }
  await page.evaluate(theme => window.paste.saveSettings({ theme }), theme);
  await closePreviewWithKey(preview, 'Meta+s');
  const unchanged = await page.evaluate(id => window.paste.getItem(id), id); expect(unchanged.html).toBe(before.html); expect(unchanged.signature).toBe(before.signature);
  opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  preview = await opened; editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor.locator('table')).toHaveCount(1);
  await editor.getByText('Ready', { exact: true }).dblclick(); await preview.keyboard.insertText('Reviewed');
  await expect(editor.locator('td').nth(1)).toHaveText('Reviewed');
  await preview.getByRole('button', { name: '表格', exact: true }).click(); await preview.getByRole('menuitem', { name: '在下方插入行', exact: true }).click();
  await expect(editor.locator('tr')).toHaveCount(4); await preview.getByRole('button', { name: '撤销', exact: true }).click(); await expect(editor.locator('tr')).toHaveCount(3);
  await preview.getByRole('button', { name: '重做', exact: true }).click(); await expect(editor.locator('tr')).toHaveCount(4);
  await preview.getByRole('button', { name: '撤销', exact: true }).click(); await expect(editor.locator('tr')).toHaveCount(3);
  await editor.locator('th p').click(); await preview.getByRole('button', { name: '表格', exact: true }).click();
  await preview.getByRole('menuitem', { name: '拆分单元格', exact: true }).click(); await expect(editor.locator('th')).toHaveCount(2);
  await preview.getByRole('button', { name: '撤销', exact: true }).click(); await expect(editor.locator('th')).toHaveCount(1);
  await preview.screenshot({ path: 'test-results/preview-table-edit.png' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html')).setBounds({ width: 320, height: 400 }));
  await preview.getByRole('button', { name: '表格', exact: true }).click();
  expect(await preview.evaluate(() => {
    const menu = document.querySelector('#tableMenu'), tools = document.querySelector('#editTools'), content = document.querySelector('#previewContent');
    return document.documentElement.scrollWidth <= innerWidth && menu.getBoundingClientRect().right <= innerWidth && tools.getBoundingClientRect().bottom <= content.getBoundingClientRect().top;
  })).toBe(true);
  await preview.screenshot({ path: 'test-results/preview-table-narrow.png' }); await preview.keyboard.press('Escape'); await expect(editor).toBeFocused();
  await closePreviewWithKey(preview, 'Meta+s');
  let saved = await page.evaluate(id => window.paste.getItem(id), id);
  expect(saved.body).toContain('Schedule\t\nAlpha\tReviewed\n\tPending'); expect(saved.body).toContain('Embedded Synthetic bitmap tail');
  expect(saved.body).not.toContain('data:image'); expect(saved.html).toContain(image); expect(saved.id).toBe(before.id);
  await page.evaluate(id => window.paste.copy(id, { paste: false }), id);
  const copied = await application.evaluate(async () => globalThis.__pasteTest.clip.read());
  expect(require('../../src/store').htmlPayload(copied.html)).toBe(saved.html); expect(copied.text).toBe(saved.body); expect(copied.signature).toBe(saved.signature);
  await application.close(); application = await launchApplication(); page = await application.firstWindow(); await page.waitForSelector('.clip-card');
  saved = await page.evaluate(id => window.paste.getItem(id), id); expect(saved.html).toContain(image); expect(saved.html).toContain('rowspan="2"');
  opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id), id); preview = await opened;
  const frame = preview.frameLocator('iframe'); await expect(frame.locator('td').nth(1)).toHaveText('Reviewed');
  await expect(frame.locator('th')).toHaveAttribute('colwidth', '140.25,219.75'); await expect(frame.locator('td').last()).toHaveAttribute('colwidth', '219.75');
  await expect(frame.locator('img')).toHaveAttribute('src', image); await expect.poll(() => frame.locator('img').evaluate(img => img.naturalWidth)).toBe(96);
  await closePreviewWithKey(preview, 'Escape');
});
test('table commands support real insertion, columns, row headers, cell selection and deletion without losing surrounding text', async () => {
  const [item] = await seedKeyboardItems('TableCommands', 1);
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), item.id);
  const preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeFocused();
  const command = async name => { await preview.getByRole('button', { name: '表格', exact: true }).click(); await preview.getByRole('menuitem', { name, exact: true }).click(); };
  await command('插入表格'); await expect(editor.locator('tr')).toHaveCount(3); await expect(editor.locator('th')).toHaveCount(3);
  await command('在右侧插入列'); await expect(editor.locator('tr').first().locator('th')).toHaveCount(4);
  await command('删除列'); await expect(editor.locator('th')).toHaveCount(3);
  await command('切换标题行'); await expect(editor.locator('th')).toHaveCount(0);
  await editor.locator('td').first().click();
  const first = await editor.locator('td').nth(0).boundingBox(), second = await editor.locator('td').nth(1).boundingBox();
  await preview.mouse.move(first.x + first.width / 2, first.y + first.height / 2); await preview.mouse.down();
  await preview.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 10 }); await preview.mouse.up();
  await expect(editor.locator('.selectedCell')).toHaveCount(2); await command('合并单元格'); await expect(editor.locator('td[colspan="2"]')).toHaveCount(1);
  await command('拆分单元格'); await expect(editor.locator('td[colspan="2"]')).toHaveCount(0);
  await editor.locator('td').first().click(); await preview.keyboard.insertText('Cell one'); await preview.keyboard.press('Tab'); await preview.keyboard.insertText('Cell two');
  await expect(editor.locator('td').nth(0)).toHaveText('Cell one'); await expect(editor.locator('td').nth(1)).toHaveText('Cell two');
  await preview.keyboard.press('Shift+Tab'); expect(await preview.evaluate(() => getSelection().toString())).toBe('Cell one');
  await preview.keyboard.insertText('Revised cell one'); await expect(editor.locator('td').first()).toHaveText('Revised cell one');
  await command('删除表格'); await expect(editor.locator('table')).toHaveCount(0); await expect(editor).toContainText('Synthetic keyboard fixture');
  await preview.getByRole('button', { name: '撤销', exact: true }).click(); await expect(editor.locator('table')).toHaveCount(1); await expect(editor).toContainText('Cell two');
  await expect(editor.locator('td').first()).toHaveText('Revised cell one');
  await closePreviewWithKey(preview, 'Meta+s'); expect((await page.evaluate(id => window.paste.getItem(id), item.id)).body).toContain('Revised cell one\tCell two');
});
test('real rich clipboard paste retains editable tables and embedded images instead of flattening the selection', async () => {
  const [item] = await seedKeyboardItems('RichTablePaste', 1), image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 8; const context = canvas.getContext('2d');
    context.fillStyle = '#e85464'; context.fillRect(0, 0, 16, 8); return canvas.toDataURL();
  });
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), item.id);
  const preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeFocused(); await editor.press('Meta+a');
  await application.evaluate(async ({ clipboard, ClipboardItem }, image) => {
    await clipboard.write([new ClipboardItem({ 'text/plain': 'Left\tRight\nPasted embedded image',
      'text/html': `<table><tr><td><p>Left</p></td><td><p>Right</p></td></tr></table><p>Pasted <img src="${image}" alt="embedded image"></p>` })]);
  }, image);
  await editor.press('Meta+v'); await expect(editor.locator('table')).toHaveCount(1); await expect(editor.locator('td')).toHaveCount(2);
  await expect(editor.getByRole('img', { name: 'embedded image', exact: true })).toHaveAttribute('src', image);
  await expect.poll(() => editor.getByRole('img', { name: 'embedded image', exact: true }).evaluate(img => img.naturalWidth)).toBe(16);
  await preview.getByRole('button', { name: '撤销', exact: true }).click(); await expect(editor.locator('table,img')).toHaveCount(0); await expect(editor).toHaveText(item.body.replace(/\n/g, ''));
  await preview.getByRole('button', { name: '重做', exact: true }).click(); await expect(editor.locator('td')).toHaveCount(2);
  await expect(editor.getByRole('img', { name: 'embedded image', exact: true })).toHaveAttribute('src', image);
  await closePreviewWithKey(preview, 'Meta+s'); const saved = await page.evaluate(id => window.paste.getItem(id), item.id);
  expect(saved.body).toContain('Left\tRight'); expect(saved.body).toContain('Pasted embedded image'); expect(saved.html).toContain(image);
  expect(saved.body).not.toContain('RichTablePaste');
});
test('unsupported rich pastes preserve selection and original bytes while preview and editor never fetch external resources', async () => {
  let requests = 0;
  const server = require('node:http').createServer((_request, response) => { requests++; response.end('unexpected resource request'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/tracker`;
    const html = `<p style="position:fixed;background-image:url('${url}');color:rgb(40,80,120)">Private rich fixture</p><img src="${url}"><a href="file:///etc/passwd">Blocked local link</a>`;
    const id = await application.evaluate(async ({ clipboard, ClipboardItem }, html) => {
      await clipboard.write([new ClipboardItem({ 'text/plain': 'Private rich fixture', 'text/html': html })]); await globalThis.__pasteTest.poll(); return globalThis.__pasteTest.store.data.items[0].id;
    }, html);
    let opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id), id);
    let preview = await opened;
    await expect(preview.frameLocator('iframe').locator('p')).toHaveText('Private rich fixture');
    await expect(preview.frameLocator('iframe').locator('[src],[href]')).toHaveCount(0);
    const cleaned = await preview.frameLocator('iframe').locator('p').getAttribute('style'); expect(cleaned).not.toMatch(/position|url/i);
    expect(cleaned).toContain('color: rgb(40, 80, 120)'); await closePreviewWithKey(preview, 'Escape');
    const [item] = await seedKeyboardItems('ProtectedRichPaste', 1), before = await page.evaluate(id => window.paste.getItem(id), item.id);
    opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), item.id); preview = await opened;
    const editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeFocused(); await editor.press('Meta+a');
    const initial = await editor.innerHTML(), selection = await preview.evaluate(() => getSelection().toString());
    for (const unsupported of [html, '<p>Bad span</p><table><tr><td colspan="999999">Lost?</td></tr></table>',
      '<p>Math</p><math><mi>x</mi></math>', '<table><caption>Caption</caption><tr><td>Cell</td></tr></table>',
      '<table><tr><td>Outer<table><tr><td>Inner</td></tr></table></td></tr></table>',
      '<table><tr><td>A</td><td>B</td></tr><tr><td>Missing cell</td></tr></table>',
      '<table><colgroup><col width="20%"></colgroup><tr><td>Relative column</td></tr></table>']) {
      const blocked = await editor.evaluate((element, html) => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/html', html); clipboardData.setData('text/plain', 'Must not replace the current selection');
        const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }); element.dispatchEvent(event); return event.defaultPrevented;
      }, unsupported);
      expect(blocked).toBe(true); expect(await editor.innerHTML()).toBe(initial); expect(await preview.evaluate(() => getSelection().toString())).toBe(selection);
      await expect(preview.locator('#previewStatus')).toHaveText(/原文未修改/);
    }
    await closePreviewWithKey(preview, 'Meta+s');
    const after = await page.evaluate(id => window.paste.getItem(id), item.id);
    expect(after.body).toBe(before.body); expect(after.html).toBe(before.html); expect(after.signature).toBe(before.signature); expect(requests).toBe(0);
  } finally { await new Promise(resolve => server.close(resolve)); }
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
test('search keyboard flow requires a fresh Return to paste and ignores repeat or empty results', async () => {
  const items = await seedKeyboardItems('ReturnFlow');
  await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('ReturnFlow');
  await expect(page.locator('.clip-card')).toHaveCount(3);
  const ids = await page.locator('.clip-card').evaluateAll(nodes => nodes.map(node => node.dataset.id));
  const before = await application.evaluate(({ clipboard }) => clipboard.readText());
  await search.press('Enter'); await expect(page.locator('#timeline')).toBeFocused();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
  await page.keyboard.press('ArrowRight'); await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', ids[1]);
  await page.keyboard.press('Enter');
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe(items.find(item => item.id === ids[1]).body);
  await application.evaluate(async ({ clipboard, ClipboardItem }) => clipboard.write([new ClipboardItem({ 'text/plain': 'Repeat key sentinel' })]));
  await page.locator('#timeline').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })));
  await page.locator('#timeline').evaluate(node => { for (const key of ['Delete', 'Backspace', ' ']) node.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true, cancelable: true })); });
  await page.evaluate(() => window.paste.getLibrary()); expect(application.windows().length).toBe(1);
  expect((await page.evaluate(id => window.paste.getItem(id), ids[1])).body).toBe(items.find(item => item.id === ids[1]).body);
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('Repeat key sentinel');
  await page.keyboard.press('Meta+f'); await search.fill('ReturnFlow no-matching-result'); await expect(page.locator('.clip-card')).toHaveCount(0);
  await search.press('Enter'); await page.keyboard.press('Enter');
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('Repeat key sentinel');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('Return during an in-flight search focuses results without queuing a delayed paste', async () => {
  const items = await seedKeyboardItems('PendingReturn');
  await application.evaluate(() => {
    const service = globalThis.__pasteTest.searchService; globalThis.__pendingSearchOriginal = service.search;
    service.search = async function(items, revision, query) {
      const result = await globalThis.__pendingSearchOriginal.call(this, items, revision, query);
      if (query === 'PendingReturn') return new Promise(resolve => { globalThis.__finishPendingSearch = () => resolve(result); });
      return result;
    };
  });
  try {
    await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('PendingReturn');
    await expect.poll(() => application.evaluate(() => !!globalThis.__finishPendingSearch)).toBe(true);
    const before = await application.evaluate(({ clipboard }) => clipboard.readText());
    await search.press('Enter'); await expect(page.locator('#timeline')).toBeFocused(); await page.keyboard.press('Enter');
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
    await application.evaluate(() => globalThis.__finishPendingSearch()); await expect(page.locator('.clip-card')).toHaveCount(3);
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
    const id = await page.locator('.clip-card.selected').getAttribute('data-id'); await page.keyboard.press('Enter');
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe(items.find(item => item.id === id).body);
  } finally {
    await application.evaluate(() => { globalThis.__finishPendingSearch?.(); globalThis.__pasteTest.searchService.search = globalThis.__pendingSearchOriginal; delete globalThis.__finishPendingSearch; delete globalThis.__pendingSearchOriginal; });
  }
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('global search finds items outside the current pinboard and Show in restores their exact list position', async () => {
  const items = await seedKeyboardItems('GlobalLocate', 2), board = await page.evaluate(() => window.paste.saveBoard({ name: 'Navigation board', color: '#4f80ed' }));
  await seedKeyboardItems('LocateFiller', 35);
  await page.evaluate(({ id, board }) => window.paste.pinItems([id], board), { id: items[0].id, board: board.id });
  await page.getByRole('button', { name: board.name, exact: true }).click(); await expect(page.locator('.clip-card')).toHaveCount(1);
  const before = await application.evaluate(({ clipboard }) => clipboard.readText());
  await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('GlobalLocate');
  await expect(page.locator('.clip-card')).toHaveCount(2);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.getByRole('button', { name: board.name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Meta+f'); await search.fill('GlobalLocate'); await expect(page.locator('.clip-card')).toHaveCount(2);
  await page.locator(`[data-id="${items[1].id}"]`).click(); await page.keyboard.press('Meta+g');
  await expect(page.locator('#searchBox')).toBeHidden(); await expect(page.getByRole('button', { name: '剪贴板', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', items[1].id);
  await expect(page.locator('.clip-card.selected')).toBeInViewport(); expect(await page.locator('#timeline').evaluate(node => node.scrollLeft)).toBeGreaterThan(1000);
  await page.keyboard.press('Meta+f'); await search.fill('GlobalLocate'); await expect(page.locator('.clip-card')).toHaveCount(2);
  await page.locator(`[data-id="${items[0].id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: `在${board.name}中显示`, exact: true }).click();
  await expect(page.locator('#searchBox')).toBeHidden(); await expect(page.locator('.clip-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: board.name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', items[0].id);
  await page.locator('.clip-card').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '在剪贴板中显示', exact: true })).toHaveAttribute('aria-keyshortcuts', 'Meta+G');
  await expect(page.getByRole('menuitem', { name: `在${board.name}中显示`, exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '在剪贴板中显示', exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
  await page.keyboard.press('Meta+f'); await search.fill('GlobalLocate'); await expect(page.locator('.clip-card')).toHaveCount(2);
  await search.press('Enter'); await page.keyboard.press('Meta+a'); await expect(page.locator('.clip-card.selected')).toHaveCount(2);
  const windows = application.windows().length; await page.keyboard.press('Meta+g'); await page.keyboard.press('Meta+e'); await page.keyboard.press('Meta+r');
  await page.evaluate(() => window.paste.getLibrary()); expect(application.windows().length).toBe(windows); await expect(search).toHaveValue('GlobalLocate');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const longName = 'L'.repeat(60); await page.evaluate(board => window.paste.saveBoard(board), { ...board, name: longName });
  await page.keyboard.press('Meta+f'); await search.fill('GlobalLocate'); await expect(page.locator('.clip-card')).toHaveCount(2);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setBounds({ width: 390, height: 332 }));
  try {
    await page.locator(`[data-id="${items[0].id}"]`).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: `在${longName}中显示`, exact: true })).toBeVisible();
    expect(await page.locator('#menu').evaluate(menu => menu.scrollWidth <= menu.clientWidth && menu.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/show-in-narrow.png' });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  } finally {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setBounds({ width: 1280, height: 332 }));
  }
});
test('Command-E and Command-R edit in place without browser reload or replacing an active draft', async () => {
  const [item] = await seedKeyboardItems('ShortcutRecord', 1);
  const roles = await application.evaluate(({ Menu }) => {
    const collect = menu => menu.items.flatMap(item => [item.role || '', ...(item.submenu ? collect(item.submenu) : [])]); return collect(Menu.getApplicationMenu());
  });
  expect(roles.some(role => /reload|devtools/i.test(role))).toBe(false); expect(roles).toContain('editmenu');
  await page.locator(`[data-id="${item.id}"]`).click(); await page.evaluate(() => { window.documentMarker = 'same-main-document'; });
  let opened = application.waitForEvent('window'); await page.keyboard.press('Meta+r'); let preview = await opened;
  const name = preview.getByRole('textbox', { name: '项目名称' }); await expect(name).toHaveValue(item.title);
  await expect(name).toBeFocused();
  expect(await name.evaluate(input => input.selectionEnd - input.selectionStart)).toBe(item.title.length);
  await preview.keyboard.insertText('键盘标签'); await expect(name).toHaveValue('键盘标签'); await closePreviewWithKey(preview, 'Enter');
  expect(await page.evaluate(() => window.documentMarker)).toBe('same-main-document');
  expect((await page.evaluate(id => window.paste.getItem(id), item.id)).title).toBe('键盘标签');
  await page.locator(`[data-id="${item.id}"]`).click(); opened = application.waitForEvent('window'); await page.keyboard.press('Meta+e'); preview = await opened;
  const editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeFocused();
  await editor.fill('Edited by Command-E'); await closePreviewWithKey(preview, 'Meta+s');
  expect((await page.evaluate(id => window.paste.getItem(id), item.id)).body).toBe('Edited by Command-E');
  opened = application.waitForEvent('window'); await page.keyboard.press('Space'); preview = await opened;
  await preview.waitForFunction(() => document.body.dataset.previewReady === 'true');
  await preview.frameLocator('iframe[title="富文本预览"]').locator('body').click();
  expect(await preview.evaluate(() => document.activeElement.tagName)).toBe('IFRAME');
  await nativePreviewKey('R', true); expect((await preview.evaluate(() => window.paste.getPreview())).mode).toBe('view');
  await nativePreviewKey('R');
  const draft = preview.getByRole('textbox', { name: '项目名称' }); await expect(draft).toBeVisible();
  await draft.fill('未提交标签'); await preview.evaluate(() => { window.previewMarker = 'same-preview-document'; });
  await preview.keyboard.press('Meta+r'); await preview.keyboard.press('Meta+e');
  await expect(draft).toHaveValue('未提交标签'); expect(await preview.evaluate(() => window.previewMarker)).toBe('same-preview-document');
  await draft.evaluate(input => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input.value = '组合输入标签'; input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
  await draft.press('Enter'); await expect(draft).toBeVisible();
  expect((await page.evaluate(id => window.paste.getItem(id), item.id)).title).toBe('键盘标签');
  await draft.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await closePreviewWithKey(preview, 'Enter');
  expect((await page.evaluate(id => window.paste.getItem(id), item.id)).title).toBe('组合输入标签');
  const signature = (await page.evaluate(id => window.paste.getItem(id), item.id)).signature;
  opened = application.waitForEvent('window'); await page.keyboard.press('Space'); preview = await opened;
  await preview.frameLocator('iframe[title="富文本预览"]').locator('body').click();
  expect(await preview.evaluate(() => document.activeElement.tagName)).toBe('IFRAME'); await nativePreviewKey('E');
  await expect(preview.getByRole('textbox', { name: '剪贴板内容' })).toHaveText('Edited by Command-E');
  await closePreviewWithKey(preview, 'Meta+s'); expect((await page.evaluate(id => window.paste.getItem(id), item.id)).signature).toBe(signature);
  const fileId = await application.evaluate(() => {
    const hooks = globalThis.__pasteTest, file = hooks.store.add({ type: 'file', body: 'file:///missing-keyboard-fixture', title: 'File keyboard fixture' }); hooks.imageText.onChanged(); return file.id;
  });
  await page.locator(`[data-id="${fileId}"]`).click(); await page.keyboard.press('Meta+e'); await page.evaluate(() => window.paste.getLibrary());
  expect(application.windows().length).toBe(1);
  opened = application.waitForEvent('window'); await page.keyboard.press('Meta+r'); preview = await opened;
  await expect(preview.getByRole('textbox', { name: '项目名称' })).toHaveValue('File keyboard fixture');
  await closePreviewWithKey(preview, 'Escape');
});
test('IME composition and process/dead keys never submit search, dismiss it or paste a candidate', async () => {
  await seedKeyboardItems('输入法键盘', 2); await page.locator('#timeline').focus();
  const before = await application.evaluate(({ clipboard }) => clipboard.readText());
  await page.locator('#timeline').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true })));
  const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await expect(search).toBeFocused();
  await search.evaluate(input => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input.value = '输入法键盘'; input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
  await search.press('Enter'); await expect(search).toBeFocused(); await search.press('Escape'); await expect(search).toBeVisible();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
  await search.evaluate(input => { input.value = '输入法键盘'; input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
  await expect(page.locator('.clip-card')).toHaveCount(2); await search.press('Enter'); await expect(page.locator('#timeline')).toBeFocused();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.locator('#timeline').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', altKey: true, bubbles: true, cancelable: true })));
  await expect(search).toBeFocused(); await search.fill('dead-key-unmatched'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('range navigation keeps a separate active item and stable anchor through asynchronous results and reordering', async () => {
  await seedKeyboardItems('RangeSelection', 5); await page.keyboard.press('Meta+f');
  const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('RangeSelection'); await expect(page.locator('.clip-card')).toHaveCount(5);
  await search.press('Enter'); await page.keyboard.press('End'); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.locator('.clip-card.selected')).toHaveCount(3); await page.keyboard.press('Shift+ArrowRight'); await expect(page.locator('.clip-card.selected')).toHaveCount(2);
  await page.keyboard.press('Shift+Home'); await expect(page.locator('.clip-card.selected')).toHaveCount(5);
  await page.keyboard.press('ArrowRight'); await expect(page.locator('.clip-card.selected')).toHaveCount(1);
  const selected = await page.locator('.clip-card.selected').getAttribute('data-id');
  let active = await page.locator('#timeline').getAttribute('aria-activedescendant');
  await expect(page.locator(`[id="${active}"]`)).toHaveAttribute('data-id', selected);
  await expect(page.locator(`[id="${active}"]`)).toHaveAttribute('aria-posinset', '2'); await expect(page.locator(`[id="${active}"]`)).toHaveAttribute('aria-setsize', '5');
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest; hooks.store.add({ type: 'text', body: 'RangeSelection new arrival', title: 'RangeSelection new arrival' }); hooks.imageText.onChanged();
  });
  await expect(page.locator('.clip-card')).toHaveCount(6); await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', selected);
  await page.keyboard.press('Shift+ArrowLeft'); await expect(page.locator('.clip-card.selected')).toHaveCount(2);
  await page.keyboard.press('ArrowRight'); await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', selected);
  await page.keyboard.press('Shift+F10'); await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).hover(); await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menuitem', { name: '在剪贴板中显示', exact: true })).toBeFocused();
  expect(await page.locator('#menu button').evaluateAll(buttons => buttons.filter(button => getComputedStyle(button).backgroundColor === 'rgb(66, 122, 243)').length)).toBe(1);
  await page.screenshot({ path: 'test-results/search-location-menu.png' });
  await page.keyboard.press('Escape'); await expect(search).toHaveValue('RangeSelection');
  await page.screenshot({ path: 'test-results/keyboard-search-results.png' });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('menu commands retain their original item ownership when background changes move the selection', async () => {
  for (const activation of ['mouse', 'Backspace', 'Delete', 'Enter']) {
    const items = await seedKeyboardItems(`MenuOwnership-${activation}`, 2);
    await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill(`MenuOwnership-${activation}`);
    await expect(page.locator('.clip-card')).toHaveCount(2);
    await page.locator(`[data-id="${items[0].id}"]`).click({ button: 'right' });
    if (activation === 'Enter') await page.getByRole('menuitem', { name: '删除', exact: true }).hover();
    await application.evaluate((_electron, id) => { const hooks = globalThis.__pasteTest; hooks.store.delete([id]); hooks.imageText.onChanged(); }, items[0].id);
    await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', items[1].id);
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Meta+a');
    await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', items[1].id);
    await expect(page.getByRole('menu')).toBeVisible();
    const count = (await page.evaluate(() => window.paste.getLibrary())).items.length;
    if (activation === 'mouse') await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    else await page.keyboard.press(activation);
    const library = await page.evaluate(() => window.paste.getLibrary());
    expect(library.items.some(item => item.id === items[1].id)).toBe(true); expect(library.items.length).toBe(count);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  }
  const board = await page.evaluate(() => window.paste.saveBoard({ name: 'Menu ownership board', color: '#4f80ed' }));
  const items = await seedKeyboardItems('MenuOwnership-pin', 2);
  await page.keyboard.press('Meta+f'); await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('MenuOwnership-pin');
  await expect(page.locator('.clip-card')).toHaveCount(2); await page.locator(`[data-id="${items[0].id}"]`).click({ button: 'right' });
  await application.evaluate((_electron, id) => { const hooks = globalThis.__pasteTest; hooks.store.delete([id]); hooks.imageText.onChanged(); }, items[0].id);
  await expect(page.locator('.clip-card.selected')).toHaveAttribute('data-id', items[1].id);
  await page.getByRole('menuitem', { name: board.name, exact: true }).click();
  await expect(page.locator('#status')).toHaveText(/Invalid clipboard selection/);
  expect((await page.evaluate(id => window.paste.getItem(id), items[1].id)).boardIds).not.toContain(board.id);
  for (const remove of [false, true]) {
    await page.locator(`[data-id="${items[1].id}"]`).click({ button: 'right' });
    // The displayed add/remove intent must not invert if another action changes membership.
    await page.evaluate(({ id, board, remove }) => window.paste.pinItems([id], board, remove), { id: items[1].id, board: board.id, remove });
    await page.getByRole('menuitem', { name: `${remove ? '✓ ' : ''}${board.name}`, exact: true }).click();
    expect((await page.evaluate(id => window.paste.getItem(id), items[1].id)).boardIds.includes(board.id)).toBe(!remove);
  }
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('filter controls keep Enter, Space and deletion inside the control rather than activating a clipboard item', async () => {
  await seedKeyboardItems('FilterControlKeys', 2); await page.keyboard.press('Meta+f');
  await page.getByRole('searchbox', { name: '搜索剪贴板' }).fill('FilterControlKeys'); await expect(page.locator('.clip-card')).toHaveCount(2);
  const before = await application.evaluate(({ clipboard }) => clipboard.readText()), count = (await page.evaluate(() => window.paste.getLibrary())).items.length;
  await page.getByRole('button', { name: '筛选', exact: true }).press('Enter'); await expect(page.getByRole('region', { name: '筛选条件' })).toBeVisible();
  await page.locator('#typeFilters').getByRole('button', { name: '文本', exact: true }).press('Enter');
  await page.keyboard.press('Delete'); await page.keyboard.press('Backspace');
  expect((await page.evaluate(() => window.paste.getLibrary())).items.length).toBe(count);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '筛选', exact: true }).press('Space');
  await expect(page.getByRole('region', { name: '筛选条件' })).toBeVisible(); expect(application.windows().length).toBe(1);
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('visible filter tokens combine type, app, calendar and pinboard without changing the text query or deleting clips', async () => {
  const board = await page.evaluate(() => window.paste.saveBoard({ name: 'Filter project', color: '#4f80ed' }));
  const items = await application.evaluate((_electron, board) => {
    const hooks = globalThis.__pasteTest, today = new Date(); today.setHours(0, 0, 0, 0);
    const rows = [['text', 'FilterCombo note', 'Test Mail', 'test.filter.mail'], ['code', 'FilterCombo const code', 'Test Mail', 'test.filter.mail'],
      ['link', 'https://filter.example/FilterCombo', 'Test Mail', 'test.filter.mail'], ['text', 'FilterCombo chrome', 'Test Chrome', 'test.filter.chrome'],
      ['text', 'FilterCombo yesterday', 'Test Mail', 'test.filter.mail']];
    const items = rows.map(([type, body, name, bundleId]) => hooks.store.add({ type, body, title: body, source: { name, bundleId } }));
    hooks.store.pinItems([items[0].id, items[1].id, items[4].id], board);
    hooks.store.mutate(() => items.forEach((item, index) => { hooks.store.edit(item.id).createdAt = new Date(today.getTime() + (index === 4 ? -1 : 0)).toISOString(); }));
    hooks.imageText.onChanged(); return items.map(item => item.id);
  }, board.id);
  await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('FilterCombo');
  await expect(page.locator('.clip-card')).toHaveCount(5); await page.getByRole('button', { name: '筛选', exact: true }).click();
  await page.locator('#typeFilters').getByRole('button', { name: '文本', exact: true }).click();
  await page.getByLabel('来源应用', { exact: true }).selectOption('test.filter.mail');
  await page.getByLabel('复制日期', { exact: true }).selectOption('today'); await page.getByLabel('所属 Pinboard', { exact: true }).selectOption(board.id);
  await expect(page.locator('.clip-card')).toHaveCount(2); expect(new Set(await page.locator('.clip-card').evaluateAll(nodes => nodes.map(node => node.dataset.id)))).toEqual(new Set(items.slice(0, 2)));
  await expect(page.locator('#filterTokens button')).toHaveCount(4); await expect(page.locator('#filterCount')).toHaveText('4'); await expect(search).toHaveValue('FilterCombo');
  await page.keyboard.press('Escape'); await page.screenshot({ path: 'test-results/search-active-filters.png' });
  const theme = (await page.evaluate(() => window.paste.getLibrary())).settings.theme;
  await page.evaluate(() => window.paste.saveSettings({ theme: 'dark' })); await expect(page.locator('.panel')).toHaveCSS('background-color', 'rgba(49, 49, 49, 0.98)');
  await expect(search).toHaveCSS('color', 'rgb(232, 232, 232)'); await expect(page.locator('.clip-card')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/search-active-filters-dark.png' }); await page.getByRole('button', { name: '筛选', exact: true }).click();
  await page.locator('#filters').evaluate(panel => { panel.scrollTop = 0; }); await page.screenshot({ path: 'test-results/search-filter-panel.png' });
  await page.keyboard.press('Escape'); await page.evaluate(theme => window.paste.saveSettings({ theme }), theme);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setBounds({ width: 390, height: 332 }));
  try {
    await search.focus();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#searchBox').getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/search-active-filters-narrow.png' });
    await page.getByRole('button', { name: '移除应用筛选：Test Mail', exact: true }).click(); await expect(page.getByLabel('来源应用', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '移除Pinboard筛选：Filter project', exact: true }).click(); await expect(page.locator('.clip-card')).toHaveCount(3);
    await page.getByRole('button', { name: '移除类型筛选：文本', exact: true }).click(); await expect(page.locator('.clip-card')).toHaveCount(4);
    await page.getByRole('button', { name: '筛选', exact: true }).click(); await page.getByRole('button', { name: '重置筛选', exact: true }).click();
    await expect(page.locator('.clip-card')).toHaveCount(5); await expect(search).toHaveValue('FilterCombo'); await expect(page.locator('#filterTokens button')).toHaveCount(0);
    await page.locator('#typeFilters').getByRole('button', { name: '文本', exact: true }).click(); await search.fill('');
    const count = (await page.evaluate(() => window.paste.getLibrary())).items.length;
    await search.press('Backspace'); await expect(page.getByRole('button', { name: '移除类型筛选：文本', exact: true })).toBeFocused();
    await page.keyboard.press('Backspace'); await expect(page.locator('#filterTokens button')).toHaveCount(0);
    expect((await page.evaluate(() => window.paste.getLibrary())).items.length).toBe(count);
    await page.keyboard.press('Escape');
  } finally { await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setBounds({ width: 1280, height: 332 })); }
});
test('metadata suggestions are explicit, keyboard selectable and stale callbacks never rewrite a newer query', async () => {
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest;
    hooks.store.add({ type: 'link', body: 'https://example.com/meeting/slides-one', title: 'meeting slides one', source: { name: 'Mail', bundleId: 'test.suggestion.mail' } });
    hooks.store.add({ type: 'link', body: 'https://example.com/meeting/slides-two', title: 'meeting slides two', source: { name: 'Mail', bundleId: 'test.suggestion.mail' } });
    hooks.imageText.onChanged();
  });
  await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('mail link meeting slides');
  await expect(page.locator('.clip-card')).toHaveCount(0);
  const before = await application.evaluate(({ clipboard }) => clipboard.readText());
  await page.getByRole('button', { name: '来自 Mail', exact: true }).click(); await expect(search).toHaveValue('link meeting slides');
  await expect(page.getByRole('button', { name: '类型：链接', exact: true })).toBeVisible();
  await search.press('ArrowDown'); await expect(page.getByRole('button', { name: '类型：链接', exact: true })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(search).toHaveValue('meeting slides'); await expect(page.locator('.clip-card')).toHaveCount(2);
  await expect(page.locator('#filterTokens button')).toHaveCount(2); expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(before);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+f'); await search.fill('mail');
  const stale = await page.getByRole('button', { name: '来自 Mail', exact: true }).elementHandle();
  await search.fill('new-literal-query'); await stale.evaluate(button => button.click());
  await expect(search).toHaveValue('new-literal-query'); await expect(page.locator('#filterTokens button')).toHaveCount(0);
  await search.fill('https://example.com/mail'); await expect(page.getByRole('group', { name: '筛选建议', exact: true })).toBeHidden();
  await search.fill('mail'); const composingCandidate = await page.getByRole('button', { name: '来自 Mail', exact: true }).elementHandle();
  await search.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await expect(page.getByRole('group', { name: '筛选建议', exact: true })).toBeHidden();
  await composingCandidate.evaluate(button => button.click()); await expect(search).toHaveValue('mail'); await expect(page.locator('#filterTokens button')).toHaveCount(0);
  await application.evaluate(() => {
    const service = globalThis.__pasteTest.searchService; globalThis.__imeFilterSearch = service.search; globalThis.__imeFilterQueries = [];
    service.search = function(items, revision, query) { globalThis.__imeFilterQueries.push(query); return globalThis.__imeFilterSearch.call(this, items, revision, query); };
  });
  try {
    await search.evaluate(input => { input.value = 'mail候选'; input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
    await page.evaluate(async () => { const { settings } = await window.paste.getLibrary(); await window.paste.saveSettings({ theme: settings.theme }); });
    await expect.poll(() => application.evaluate(() => globalThis.__imeFilterQueries.length)).toBeGreaterThan(0);
    expect((await application.evaluate(() => globalThis.__imeFilterQueries)).every(query => query === 'mail')).toBe(true);
    await expect(search).toHaveValue('mail候选');
  } finally {
    await application.evaluate(() => { globalThis.__pasteTest.searchService.search = globalThis.__imeFilterSearch; delete globalThis.__imeFilterSearch; delete globalThis.__imeFilterQueries; });
  }
  await expect(page.getByRole('group', { name: '筛选建议', exact: true })).toBeHidden();
  await search.press('Enter'); await expect(search).toHaveValue('mail候选');
  await search.evaluate(input => { input.value = 'mail'; });
  await search.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await expect(page.getByRole('group', { name: '筛选建议', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/search-filter-suggestions.png' });
  await search.press('Escape'); await search.press('Escape');
  await application.evaluate(() => {
    const service = globalThis.__pasteTest.searchService; globalThis.__filterSearchOriginal = service.search;
    service.search = async function(items, revision, query) {
      const result = await globalThis.__filterSearchOriginal.call(this, items, revision, query);
      if (query === 'mail') return new Promise(resolve => { globalThis.__releaseFilterSearch = () => resolve(result); });
      return result;
    };
  });
  try {
    await page.keyboard.press('Meta+f'); await search.fill('mail');
    await expect.poll(() => application.evaluate(() => !!globalThis.__releaseFilterSearch)).toBe(true);
    await search.press('ArrowDown'); await page.keyboard.press('Escape'); await search.press('ArrowDown');
    await application.evaluate(() => globalThis.__releaseFilterSearch()); await expect(page.locator('#timeline')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('group', { name: '筛选建议', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '来自 Mail', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await search.press('Escape'); await search.press('Escape');
  } finally {
    await application.evaluate(() => { globalThis.__releaseFilterSearch?.(); globalThis.__pasteTest.searchService.search = globalThis.__filterSearchOriginal; delete globalThis.__filterSearchOriginal; delete globalThis.__releaseFilterSearch; });
  }
});
test('active metadata filters survive renames and deletion without silently widening the search', async () => {
  const board = await page.evaluate(() => window.paste.saveBoard({ name: 'Stable filter board', color: '#62c68d' }));
  const ids = await application.evaluate((_electron, board) => {
    const hooks = globalThis.__pasteTest;
    const one = hooks.store.add({ type: 'text', body: 'MetadataFilter one', source: { name: 'Stable Mail', bundleId: 'test.stable.mail' } });
    const two = hooks.store.add({ type: 'text', body: 'MetadataFilter other', source: { name: 'Other App', bundleId: 'test.stable.other' } });
    hooks.store.pinItems([one.id], board); hooks.imageText.onChanged(); return [one.id, two.id];
  }, board.id);
  await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('MetadataFilter');
  await page.getByRole('button', { name: '筛选', exact: true }).click(); await page.getByLabel('来源应用', { exact: true }).selectOption('test.stable.mail');
  await page.getByLabel('所属 Pinboard', { exact: true }).selectOption(board.id); await page.keyboard.press('Escape'); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', ids[0]);
  const token = await page.getByRole('button', { name: '移除应用筛选：Stable Mail', exact: true }).elementHandle();
  await page.evaluate(board => window.paste.saveBoard(board), { ...board, name: 'Renamed board' });
  await application.evaluate((_electron, id) => {
    const hooks = globalThis.__pasteTest; hooks.store.mutate(() => { hooks.store.edit(id).source = { name: 'Mail <img src=x>', bundleId: 'test.stable.mail' }; }); hooks.imageText.onChanged();
  }, ids[0]);
  await expect(page.getByRole('button', { name: '移除应用筛选：Mail <img src=x>', exact: true })).toBeVisible(); expect(await token.evaluate(button => button.isConnected)).toBe(true);
  await expect(page.getByRole('button', { name: '移除Pinboard筛选：Renamed board', exact: true })).toBeVisible(); await expect(page.locator('#filterTokens img')).toHaveCount(0);
  await page.evaluate(id => window.paste.deleteItems([id]), ids[0]); await page.evaluate(id => window.paste.deleteBoard(id), board.id);
  await expect(page.locator('.clip-card')).toHaveCount(0); await expect(page.locator('#filterTokens button')).toHaveCount(2);
  await expect(page.getByLabel('来源应用', { exact: true })).toHaveValue('test.stable.mail'); await expect(page.getByLabel('所属 Pinboard', { exact: true })).toHaveValue(board.id);
  await page.getByRole('button', { name: '筛选', exact: true }).click(); await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await expect(page.locator('.clip-card')).toHaveAttribute('data-id', ids[1]); await expect(search).toHaveValue('MetadataFilter');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});
test('today excludes the previous evening and updates at local midnight without another copy or query', async () => {
  const time = await page.evaluate(() => new Date(2026, 9, 22, 0, 1).toISOString());
  const ids = await application.evaluate(() => {
    const hooks = globalThis.__pasteTest, today = new Date(2026, 9, 22), tomorrow = new Date(2026, 9, 23);
    const items = ['CalendarClip yesterday', 'CalendarClip today', 'CalendarClip tomorrow'].map(body => hooks.store.add({ type: 'text', body, title: body }));
    const dates = [new Date(today.getTime() - 30000), today, tomorrow];
    hooks.store.mutate(() => items.forEach((item, index) => { hooks.store.edit(item.id).createdAt = dates[index].toISOString(); })); hooks.imageText.onChanged(); return items.map(item => item.id);
  });
  try {
    await page.clock.install({ time: new Date(time) }); await page.reload(); await page.waitForSelector('.clip-card');
    await page.keyboard.press('Meta+f'); const search = page.getByRole('searchbox', { name: '搜索剪贴板' }); await search.fill('CalendarClip');
    await expect(page.locator('.clip-card')).toHaveCount(3); await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByLabel('复制日期', { exact: true }).selectOption('today'); await page.keyboard.press('Escape');
    await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', ids[1]);
    await page.clock.fastForward(86400000 - 60000);
    await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toHaveAttribute('data-id', ids[2]);
    await expect(search).toHaveValue('CalendarClip'); await expect(page.getByRole('button', { name: '移除日期筛选：今天', exact: true })).toBeVisible();
  } finally { await application.close(); application = await launchApplication(); page = await application.firstWindow(); await page.waitForSelector('.clip-card'); }
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
test('portrait capture bounds only the thumbnail while clipboard copy and exported original retain full pixels', async () => {
  const body = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 3200;
    const context = canvas.getContext('2d'); context.fillStyle = '#35a078'; context.fillRect(0, 0, 80, 3200);
    context.fillStyle = '#e5634c'; context.fillRect(8, 3000, 64, 160); return canvas.toDataURL();
  });
  const captured = await application.evaluate(async ({ nativeImage }, body) => {
    const hooks = globalThis.__pasteTest; await hooks.clip.write({ type: 'image', body }); await hooks.poll();
    const item = hooks.store.data.items[0], original = nativeImage.createFromDataURL(body);
    return { id: item.id, originalHash: hooks.hash(original.toBitmap()), previewSize: nativeImage.createFromDataURL(item.preview).getSize(), size: item.size };
  }, body);
  expect(captured.previewSize).toEqual({ width: 12, height: 480 }); expect(captured.size).toEqual({ width: 80, height: 3200 });
  await expect(page.locator(`[data-id="${captured.id}"] .image-preview img`)).toBeVisible();
  await page.evaluate(id => window.paste.copy(id), captured.id);
  const copied = await application.evaluate(async ({ clipboard, nativeImage }, id) => {
    const entry = (await clipboard.read())[0], png = Buffer.from(await (await entry.getType('image/png')).arrayBuffer());
    const image = nativeImage.createFromBuffer(png), hooks = globalThis.__pasteTest;
    const exported = hooks.store.exportData().items.find(item => item.id === id), full = nativeImage.createFromDataURL(exported.body);
    return { size: image.getSize(), hash: hooks.hash(image.toBitmap()), exportedHash: hooks.hash(full.toBitmap()) };
  }, captured.id);
  expect(copied.size).toEqual({ width: 80, height: 3200 }); expect(copied.hash).toBe(captured.originalHash); expect(copied.exportedHash).toBe(captured.originalHash);
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
  await settings.getByText('按标识添加', { exact: true }).click();
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
