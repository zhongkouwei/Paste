const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, settings, directory, input;
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.openSettings()); settings = await opened;
  await settings.locator('[data-page="data"]').click(); await expect(settings.locator('#importData')).toBeEnabled();
}
test.beforeEach(async () => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-import-ui-')); input = path.join(directory, 'input.json'); await launch(); });
test.afterEach(async () => { if (application) await application.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); application = page = settings = directory = input = null; });
const record = (id, body = id) => ({ id, body, title: id, type: 'text', boardIds: [], createdAt: '2026-10-22T00:00:00.000Z' });
test('portable restore validates real PNG variants and OCR, previews without writes, confirms replacement and survives restart', async () => {
  const expected = await application.evaluate(async ({ nativeImage }, file) => {
    const { store, hash } = globalThis.__pasteTest, body = '完整正文\0🧪\uD800 "\\\n'.repeat(3000);
    const text = store.add({ type: 'text', body, html: '<p>Original <strong>rich</strong></p>', rtf: '{\\rtf1 Original}', title: 'Full original' });
    const board = store.saveBoard({ name: 'Imported board', color: '#ef6259' }); store.pinItems([text.id], board.id); store.reorderBoardItems(board.id, [text.id]);
    const png = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG(), asset = store.putAsset(png);
    const signature = hash(Buffer.concat([Buffer.from('image:1x1:'), nativeImage.createFromBuffer(png).toBitmap()]));
    const image = store.add({ type: 'image', body: asset, asset, signature, signatureFormat: 'pixels-v1', title: 'Pixel original' });
    store.replaceImage(image.id, { buffer: png, original: png, foreground: png, turns: 1, size: { width: 1, height: 1 }, signature, backgroundRemoved: true, preview: globalThis.__pasteTest.thumbnail(nativeImage.createFromBuffer(png)) });
    store.setOCR(image.id, signature, { status: 'ready', text: 'Original OCR', lines: [{ text: 'Original OCR', box: { x: 0, y: 0, width: 1, height: 1 }, words: [] }] });
    store.settings({ paused: true, retentionDays: 0 }); await store.exportTo(file); const expected = store.exportData();
    store.mutate(() => { store.data.items = []; store.data.boards = []; }); store.settings({ theme: 'light' }); store.add({ type: 'text', body: 'Pre-import library', title: 'Current original' });
    globalThis.__pasteTest.imageText.onChanged();
    return expected;
  }, input);
  const before = fs.readFileSync(path.join(directory, 'library.json'));
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await expect(settings.locator('#importSummary')).toContainText('2 项'); expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  await settings.screenshot({ path: 'test-results/settings-import-preview.png' });
  await settings.locator('[name=importMode][value=replace]').check(); await expect(settings.locator('#applyImport')).toBeDisabled();
  await settings.locator('#confirmReplace').check(); await settings.locator('#restoreSettings').check(); await settings.locator('#applyImport').click();
  await expect(settings.locator('#settingsStatus')).toHaveText('备份已恢复，恢复前备份已保留');
  expect(await application.evaluate(() => globalThis.__pasteTest.store.exportData())).toEqual(expected);
  const checkpoint = await settings.evaluate(() => window.paste.revealImportBackup());
  expect(JSON.parse(fs.readFileSync(checkpoint)).items[0].body).toBe('Pre-import library'); expect(fs.statSync(checkpoint).mode & 0o777).toBe(0o600);
  await settings.screenshot({ path: 'test-results/settings-import-complete.png' });
  await application.close(); application = null; await launch(); expect(await application.evaluate(() => globalThis.__pasteTest.store.exportData())).toEqual(expected);
});
test('merge keeps current renamed content, adds board membership and remaps a conflicting ID', async () => {
  const id = await application.evaluate(() => { const { store } = globalThis.__pasteTest; const item = store.add({ type: 'text', body: 'same', title: 'Original' }); store.update(item.id, { title: 'My name' }); return item.id; });
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: [{ ...record('duplicate', 'same'), boardIds: ['b'] }, record(id, 'new body')], boards: [{ id: 'b', name: 'Backup board', color: '#ef6259', itemOrder: ['duplicate'] }] }));
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await expect(settings.locator('#importSummary')).toContainText('重复 1 项'); await settings.locator('#applyImport').click();
  await expect(settings.locator('#settingsStatus')).toContainText('备份已恢复');
  const data = await application.evaluate(() => globalThis.__pasteTest.store.exportData());
  expect(data.items).toHaveLength(2); expect(data.items[0]).toMatchObject({ id, body: 'same', title: 'My name', boardIds: ['b'] }); expect(data.items[1].id).not.toBe(id);
});
test('corrupt PNG, path references and stale previews cannot overwrite current history', async () => {
  await application.evaluate(() => globalThis.__pasteTest.store.add({ type: 'text', body: 'Protected original' })); const before = fs.readFileSync(path.join(directory, 'library.json'));
  const png = await application.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG().subarray(0, 33).toString('base64'));
  for (const value of [{ ...record('bad'), contentAsset: '../secret.json' }, { ...record('bad'), type: 'image', body: `data:image/png;base64,${png}` }]) {
    fs.writeFileSync(input, JSON.stringify({ version: 2, items: [value] })); await settings.locator('#importData').click();
    await expect(settings.locator('#settingsStatus')).toBeVisible(); await expect(settings.locator('#importData')).toBeEnabled();
    expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  }
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: [record('valid')] })); await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await application.evaluate(() => globalThis.__pasteTest.store.add({ type: 'text', body: 'Concurrent capture' }));
  await settings.locator('#applyImport').click(); await expect(settings.locator('#settingsStatus')).toContainText('当前库已变化');
  expect(await application.evaluate(() => globalThis.__pasteTest.store.data.items.length)).toBe(2);
});
test('picker cancellation, preview discard and validation cancellation release controls and keep data untouched', async () => {
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true }); });
  await settings.locator('#importData').click(); await expect(settings.locator('#importData')).toBeEnabled();
  expect((await settings.evaluate(() => window.paste.getImportState())).phase).toBe('idle');
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: [record('preview')] }));
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible(); await settings.locator('#cancelImport').click();
  await expect(settings.locator('#importPreview')).toBeHidden(); await expect(settings.locator('#exportData')).toBeEnabled();
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: Array.from({ length: 1000 }, (_, n) => record(String(n), 'x'.repeat(50000))) }));
  await settings.locator('#importData').click(); await expect(settings.locator('#importProgress')).toBeVisible(); await settings.locator('#cancelImport').click();
  await expect(settings.locator('#settingsStatus')).toHaveText('恢复已取消'); await expect(settings.locator('#importData')).toBeEnabled();
  expect(await application.evaluate(() => globalThis.__pasteTest.store.data.items.length)).toBe(0);
  expect(fs.readdirSync(directory).some(name => name.startsWith('import-'))).toBe(false);
});
test('a delayed initial import-state reply cannot reopen a discarded preview', async () => {
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: [record('preview')] }));
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await application.evaluate(({ ipcMain }) => {
    const state = globalThis.__pasteTest.importService.state(); ipcMain.removeHandler('library:importState');
    ipcMain.handle('library:importState', () => new Promise(resolve => { globalThis.__releaseImportState = () => resolve(state); }));
  });
  await settings.reload(); await settings.locator('[data-page="data"]').click();
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseImportState)).toBe('function');
  await application.evaluate(() => globalThis.__pasteTest.importService.cancel()); await expect(settings.locator('#importPreview')).toBeHidden();
  await application.evaluate(() => globalThis.__releaseImportState());
  await settings.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(settings.locator('#importPreview')).toBeHidden(); await expect(settings.locator('#importData')).toBeEnabled();
});
test('restored Pinboards cannot shadow history and unsafe IDs remain selectable through the real panel', async () => {
  const id = 'broken\0item';
  fs.writeFileSync(input, JSON.stringify({ version: 2, items: [{ ...record(id, 'Pinned original'), boardIds: ['history'] }, record('stable', 'Other original')],
    boards: [{ id: 'history', name: 'Imported board', color: '#ef6259', itemOrder: [id] }] }));
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await expect(settings.locator('#importSummary')).toContainText('已修复 2 个标识');
  expect(await settings.locator('#importPreview').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await settings.screenshot({ path: 'test-results/settings-repaired-identities.png' }); await settings.locator('#applyImport').click();
  await expect(settings.locator('#settingsStatus')).toContainText('备份已恢复');
  const data = await application.evaluate(() => globalThis.__pasteTest.store.data), board = data.boards[0], pinned = data.items.find(value => value.body === 'Pinned original');
  expect(board.id).not.toBe('history'); expect(pinned.id).not.toBe(id); expect(data.items.find(value => value.body === 'Other original').id).toBe('stable');
  await expect(page.locator('[data-board=history]')).toHaveCount(1); await page.locator(`[data-board="${board.id}"]`).click();
  await expect(page.locator('.clip-card')).toHaveCount(1); await expect(page.locator('.clip-card')).toContainText('Pinned original');
  const opened = application.waitForEvent('window'); await page.locator('.clip-card').click(); await page.keyboard.press('Space'); const preview = await opened;
  await expect.poll(() => preview.evaluate(() => window.paste.getPreview()).then(value => value.item.id)).toBe(pinned.id);
  await page.evaluate(() => window.paste.closePreview());
});
test('image variants with a false edit state are rejected before preview or replacement', async () => {
  await application.evaluate(() => globalThis.__pasteTest.store.add({ type: 'text', body: 'Protected original' })); const before = fs.readFileSync(path.join(directory, 'library.json'));
  const images = await application.evaluate(async ({ nativeImage }) => {
    const original = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0, 255, 255]), { width: 3, height: 2 }).toPNG();
    const other = nativeImage.createFromBitmap(Buffer.alloc(24, 255), { width: 3, height: 2 }).toPNG();
    const rotated = await globalThis.__pasteTest.imageProcessor.rotate(original, 1);
    return { original: `data:image/png;base64,${original.toString('base64')}`, other: `data:image/png;base64,${other.toString('base64')}`, rotated: `data:image/png;base64,${rotated.buffer.toString('base64')}` };
  });
  for (const fields of [{ body: images.other, imageTurns: 0 }, { body: images.original, imageTurns: 1 }, { body: images.other, imageTurns: 2 },
    { body: images.rotated, foregroundBody: images.rotated, imageTurns: 1, backgroundRemoved: true }]) {
    fs.writeFileSync(input, JSON.stringify({ version: 2, items: [{ ...record('bad'), type: 'image', originalBody: images.original, ...fields }] }));
    await settings.locator('#importData').click(); await expect(settings.locator('#importData')).toBeEnabled();
    await expect(settings.locator('#settingsStatus')).toContainText('图片编辑状态'); await expect(settings.locator('#importPreview')).toBeHidden();
    expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  }
});
async function editedBackup() {
  return application.evaluate(async ({ nativeImage }) => {
    const { imageProcessor } = globalThis.__pasteTest;
    const original = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0, 255, 255]), { width: 3, height: 2 }).toPNG();
    const foreground = nativeImage.createFromBitmap(Buffer.from([0, 0, 0, 0, 0, 255, 0, 255, 255, 0, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 255, 0, 255, 64]), { width: 3, height: 2 }).toPNG();
    const uri = bytes => `data:image/png;base64,${bytes.toString('base64')}`, items = [];
    for (const removed of [false, true]) for (let turns = 0; turns < 4; turns++) {
      const base = removed ? foreground : original, current = turns ? (await imageProcessor.rotate(base, turns)).buffer : base;
      items.push({ id: `image-${Number(removed)}-${turns}`, title: `State ${Number(removed)}:${turns}`, type: 'image', body: uri(current), originalBody: uri(original),
        foregroundBody: uri(foreground), foregroundAsset: null, imageTurns: turns, backgroundRemoved: removed, boardIds: [], createdAt: new Date().toISOString() });
    }
    return { version: 2, items, boards: [], settings: { paused: true, retentionDays: 0 } };
  });
}
test('all eight valid edited image states restore unchanged and keep original, foreground, undo and subsequent editing usable', async () => {
  const backup = await editedBackup(); fs.writeFileSync(input, JSON.stringify(backup));
  await settings.locator('#importData').click(); await expect(settings.locator('#importPreview')).toBeVisible();
  await settings.locator('#restoreSettings').check(); await settings.locator('#applyImport').click(); await expect(settings.locator('#settingsStatus')).toContainText('备份已恢复');
  const data = await application.evaluate(async () => { await globalThis.__pasteTest.imageText.idle(); return globalThis.__pasteTest.store.exportData(); });
  for (const source of backup.items) { const actual = data.items.find(value => value.id === source.id); for (const field of ['body', 'originalBody', 'foregroundBody', 'imageTurns', 'backgroundRemoved']) expect(actual[field], `${source.id}:${field}`).toEqual(source[field]); }
  const id = 'image-1-1', expected = backup.items.find(value => value.id === id), opened = application.waitForEvent('window');
  await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id); const preview = await opened;
  await expect(preview.locator('[data-image=restore]')).toBeEnabled(); await preview.locator('[data-image=restore]').click();
  await expect.poll(() => preview.evaluate(() => window.paste.getPreview()).then(value => value.item.body)).toBe(expected.originalBody);
  await preview.locator('[data-image=undo]').click(); await expect.poll(() => preview.evaluate(() => window.paste.getPreview()).then(value => value.item.body)).toBe(expected.body);
  await preview.screenshot({ path: 'test-results/preview-restored-image-state.png' });
  await preview.locator('[data-image=right]').click(); await expect.poll(() => preview.evaluate(() => window.paste.getPreview()).then(value => value.item.body)).toBe(backup.items.find(value => value.id === 'image-1-2').body);
  await preview.locator('[data-image=undo]').click(); await page.evaluate(() => window.paste.closePreview());
  await application.close(); application = null; await launch();
  const reopened = await application.evaluate(() => globalThis.__pasteTest.store.exportData()); expect(reopened).toEqual(data);
});
test('canceling a restore aborts and waits for the in-flight image-state validator before cleaning its staging directory', async () => {
  const backup = await editedBackup(); backup.items = [backup.items.find(value => value.id === 'image-0-1')]; fs.writeFileSync(input, JSON.stringify(backup));
  await application.evaluate(() => {
    const processor = globalThis.__pasteTest.imageProcessor;
    globalThis.__rotationBeforeImport = processor.rotateFile;
    processor.rotateFile = (_file, _turns, _inspect, { signal }) => new Promise((_resolve, reject) => {
      globalThis.__rotationValidating = true;
      signal.addEventListener('abort', () => { setTimeout(() => { globalThis.__rotationCanceled = true; reject(signal.reason); }, 120); }, { once: true });
    });
  });
  await settings.locator('#importData').click(); await expect.poll(() => application.evaluate(() => globalThis.__rotationValidating)).toBe(true);
  await settings.locator('#cancelImport').click(); await expect(settings.locator('#settingsStatus')).toHaveText('恢复已取消');
  expect(await application.evaluate(() => globalThis.__rotationCanceled)).toBe(true);
  await expect(settings.locator('#importData')).toBeEnabled(); expect(fs.readdirSync(directory).some(name => name.startsWith('import-'))).toBe(false);
  expect(await application.evaluate(() => globalThis.__pasteTest.store.data.items.length)).toBe(0);
});
test('image restore uses identical canonical pixels and previews without reading or decoding PNGs on the main thread', async () => {
  const backup = await editedBackup(); fs.writeFileSync(input, JSON.stringify(backup));
  const result = await application.evaluate(async ({ nativeImage }, file) => {
    const fs = process.getBuiltinModule('node:fs'), hooks = globalThis.__pasteTest;
    const source = JSON.parse(fs.readFileSync(file)), expected = source.items.map(item => {
      const buffer = Buffer.from(item.body.slice(22), 'base64'), image = nativeImage.createFromBuffer(buffer);
      const size = image.getSize(), signature = hooks.hash(Buffer.concat([Buffer.from(`image:${size.width}x${size.height}:`), image.toBitmap()]));
      return { id: item.id, signature, preview: hooks.thumbnail(image), size };
    });
    const read = fs.readFileSync, decode = nativeImage.createFromBuffer;
    try {
      fs.readFileSync = function(file, ...args) { if (String(file).endsWith('.png')) throw new Error('Unexpected main-thread PNG read'); return read.call(this, file, ...args); };
      nativeImage.createFromBuffer = () => { throw new Error('Unexpected main-thread decode'); };
      const state = await hooks.importService.prepare(file), actual = hooks.importService.preview.data.items;
      return { phase: state.phase, actual: actual.map(({ id, signature, preview, size }) => ({ id, signature, preview, size })), expected,
        hidden: !hooks.imageInspector.window.isVisible(), preferences: hooks.imageInspector.window.webContents.getLastWebPreferences() };
    } finally { fs.readFileSync = read; nativeImage.createFromBuffer = decode; hooks.importService.cancel(); }
  }, input);
  expect(result.phase).toBe('ready'); expect(result.actual).toEqual(result.expected); expect(result.hidden).toBe(true);
  expect(result.preferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: false });
  expect(fs.readdirSync(directory).some(name => name.startsWith('image-edit-') || name.startsWith('import-'))).toBe(false);
});
test('image inspector timeout, crash and cancellation reject work, preserve history and allow a fresh verified retry', async () => {
  const backup = await editedBackup(); backup.items = backup.items.slice(0, 1); fs.writeFileSync(input, JSON.stringify(backup));
  const source = await application.evaluate(async (_electron, file) => {
    const { importService } = globalThis.__pasteTest; await importService.prepare(file);
    return process.getBuiltinModule('node:path').join(importService.preview.stage, 'assets', importService.preview.data.items[0].asset);
  }, input);
  for (const mode of ['timeout', 'crash', 'cancel']) {
    const result = await application.evaluate(async (_electron, { file, mode }) => {
      const inspector = globalThis.__pasteTest.imageInspector; await inspector.inspect(file); clearTimeout(inspector.idleTimer);
      let beats = 0; const timer = setInterval(() => { beats++; }, 2), controller = new AbortController();
      try {
        inspector.timeout = 150;
        const debuggerAPI = inspector.window.webContents.debugger;
        debuggerAPI.attach('1.3'); await debuggerAPI.sendCommand('Debugger.enable'); await debuggerAPI.sendCommand('Debugger.pause');
        const promise = inspector.inspect(file, { signal: controller.signal });
        if (mode === 'crash') setTimeout(() => inspector.window.webContents.forcefullyCrashRenderer(), 20);
        if (mode === 'cancel') setTimeout(() => controller.abort(), 20);
        let message; try { await promise; } catch (error) { message = error.message; }
        inspector.timeout = 30000; const next = await inspector.inspect(file);
        return { message, beats, signature: next.signature, expected: globalThis.__pasteTest.importService.preview.data.items[0].signature };
      } finally { inspector.timeout = 30000; clearInterval(timer); }
    }, { file: source, mode });
    expect(result.message, mode).toBeTruthy(); expect(result.signature).toBe(result.expected); expect(result.beats).toBeGreaterThan(0);
    expect(await application.evaluate(() => globalThis.__pasteTest.store.data.items.length)).toBe(0);
  }
  await application.evaluate(() => globalThis.__pasteTest.importService.cancel());
  expect(fs.readdirSync(directory).some(name => name.startsWith('import-') || name.startsWith('image-edit-'))).toBe(false);
});
test('a crashed image validator fails the real restore, cleans its staging area and preserves the previous manifest before retry', async () => {
  const backup = await editedBackup(); fs.writeFileSync(input, JSON.stringify(backup));
  await application.evaluate(() => globalThis.__pasteTest.store.add({ type: 'text', body: 'Protected before validator crash' }));
  const before = fs.readFileSync(path.join(directory, 'library.json'));
  await application.evaluate(async (_electron, file) => {
    const { imageInspector, importService } = globalThis.__pasteTest; await imageInspector.ready();
    const api = imageInspector.window.webContents.debugger; api.attach('1.3'); await api.sendCommand('Debugger.enable'); await api.sendCommand('Debugger.pause');
    globalThis.__crashedRestore = importService.prepare(file).then(() => ({ accepted: true }), error => ({ error: error.message }));
  }, input);
  await expect.poll(() => application.evaluate(() => !!globalThis.__pasteTest.imageInspector.pending)).toBe(true);
  const failure = await application.evaluate(async () => { globalThis.__pasteTest.imageInspector.window.webContents.forcefullyCrashRenderer(); return globalThis.__crashedRestore; });
  expect(failure.accepted).not.toBe(true); expect(failure.error).toContain('图片校验进程');
  expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  expect(fs.readdirSync(directory).some(name => name.startsWith('import-') || name.startsWith('image-edit-'))).toBe(false);
  expect((await settings.evaluate(() => window.paste.getImportState())).phase).toBe('idle');
  const next = await application.evaluate(async (_electron, file) => globalThis.__pasteTest.importService.prepare(file), input);
  expect(next.phase).toBe('ready'); expect(next.summary.added).toBe(8);
  const inspectorPID = await application.evaluate(() => {
    const { imageInspector, importService } = globalThis.__pasteTest, pid = imageInspector.window.webContents.getOSProcessId();
    importService.cancel(); return pid;
  });
  await expect.poll(() => application.evaluate(({ app }, pid) => ({ released: !globalThis.__pasteTest.imageInspector.window, present: app.getAppMetrics().some(value => value.pid === pid) }), inspectorPID), { timeout: 5000 }).toEqual({ released: true, present: false });
  expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
});
