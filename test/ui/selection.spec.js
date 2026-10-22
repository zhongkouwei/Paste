const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
let application, page, directory, ids;
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-selection-ui-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  ids = await application.evaluate(() => {
    const hooks = globalThis.__pasteTest; globalThis.__writes = [];
    hooks.clip.read = () => { throw Error('Unexpected system clipboard read'); };
    hooks.clip.write = async (item, options) => { globalThis.__writes.push({ item: structuredClone(item), plain: options.plain }); return hooks.textSignature(item.body, item.html || '', item.rtf || ''); };
    const ids = ['Alpha', 'Beta', 'Gamma'].map((body, i) => hooks.store.add({ type: 'text', body, title: body, createdAt: new Date(1000 + i).toISOString() }).id);
    hooks.imageText.onChanged(); return ids;
  });
});
test.afterEach(async () => {
  if (application) { await application.evaluate(() => { globalThis.__releaseCompose?.(); globalThis.__releaseVersion?.(); }).catch(() => {}); await application.close(); }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = ids = null;
});
const writes = () => application.evaluate(() => globalThis.__writes);
async function select(values) {
  for (const [index, id] of values.entries()) await page.locator(`.clip-card[data-id="${id}"]`).click({ modifiers: index ? ['Meta'] : [] });
}
test('Command-C copies every selected item once in displayed order without altering history', async () => {
  const before = await page.evaluate(() => window.paste.getLibrary());
  await select([ids[0], ids[2], ids[1]]); await page.keyboard.press('Meta+c');
  await expect.poll(writes).toHaveLength(1); expect((await writes())[0].item.body).toBe('Gamma\nBeta\nAlpha');
  expect((await page.evaluate(() => window.paste.getLibrary())).items).toEqual(before.items);
});
test('Return merges separately scoped rich documents and Shift-Return copies all plain text without conversion', async () => {
  await application.evaluate((_electron, ids) => {
    const hooks = globalThis.__pasteTest;
    hooks.store.update(ids[0], { body: 'Alpha', html: '<style>.same{font-weight:bold;color:rgb(200,30,20)}</style><p class="same">Alpha</p>' });
    hooks.store.update(ids[1], { body: 'Beta', html: '<style>.same{font-style:italic;color:rgb(20,40,190)}</style><p class="same">Beta</p>' }); hooks.imageText.onChanged();
  }, ids);
  await select(ids.slice(0, 2)); await page.keyboard.press('Enter'); await expect.poll(writes).toHaveLength(1);
  const first = (await writes())[0].item; expect(first.body).toBe('Beta\nAlpha'); expect(first.rtf).toMatch(/^\{\\rtf/);
  const styles = await page.evaluate(html => [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('p')].map(node => ({ text: node.textContent, weight: node.style.fontWeight, italic: node.style.fontStyle, color: node.style.color })), first.html);
  expect(styles).toEqual([{ text: 'Beta', weight: '', italic: 'italic', color: 'rgb(20, 40, 190)' }, { text: 'Alpha', weight: '700', italic: '', color: 'rgb(200, 30, 20)' }]);
  await page.keyboard.press('Shift+Enter'); await expect.poll(writes).toHaveLength(2); expect((await writes())[1]).toMatchObject({ item: { body: 'Beta\nAlpha' }, plain: true }); expect((await writes())[1].item.html).toBeUndefined();
});
test('multiple images mixed with text yield one HTML and RTFD payload containing all original images', async () => {
  const images = await application.evaluate(({ nativeImage }) => {
    const hooks = globalThis.__pasteTest;
    const images = [[0, 0, 255, 255], [255, 0, 0, 255]].map((pixel, i) => {
      const png = nativeImage.createFromBitmap(Buffer.from(pixel), { width: 1, height: 1 }).toPNG();
      const asset = hooks.store.putAsset(png); return hooks.store.add({ type: 'image', body: asset, asset, title: `Image ${i + 1}`, signature: `image-fixture-${i}`, size: { width: 1, height: 1 } }).id;
    }); hooks.imageText.onChanged(); return images;
  });
  await select([ids[0], ...images]); await page.keyboard.press('Meta+c'); await expect.poll(writes).toHaveLength(1);
  const item = (await writes())[0].item; expect(item.rtfd.length).toBeGreaterThan(100); expect(item.rtf).toBeUndefined();
  expect(await page.evaluate(html => [...new DOMParser().parseFromString(html, 'text/html').images].map(image => image.alt), item.html)).toEqual(['Image 2', 'Image 1']); expect(item.body).toBe('Image 2\nImage 1\nAlpha');
});
test('file selections retain every ordered file URL while mixed files reject before writing anything', async () => {
  const source = path.join(directory, 'library.json'), other = path.join(directory, 'library.json.bak');
  const fileIDs = await application.evaluate((_electron, urls) => {
    const hooks = globalThis.__pasteTest;
    const ids = urls.map((body, i) => hooks.store.add({ type: 'file', body, title: `File ${i}` }).id); hooks.imageText.onChanged(); return ids;
  }, [pathToFileURL(source).href, pathToFileURL(other).href]);
  await select(fileIDs); await page.keyboard.press('Enter'); await expect.poll(writes).toHaveLength(1);
  expect((await writes())[0].item).toEqual({ type: 'file', body: [pathToFileURL(other).href, pathToFileURL(source).href].join('\n') });
  await select([fileIDs[0], ids[0]]); await page.keyboard.press('Enter'); await expect(page.locator('#status')).toContainText('请分别选择'); expect(await writes()).toHaveLength(1);
});
test('context-menu copies include the entire opened selection rather than the clicked item alone', async () => {
  await select(ids.slice(0, 2)); await page.locator(`.clip-card[data-id="${ids[0]}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制', exact: true }).click(); await expect.poll(writes).toHaveLength(1); expect((await writes())[0].item.body).toBe('Beta\nAlpha');
});
test('a changed item during composition aborts the full write and a later retry succeeds', async () => {
  await application.evaluate((_electron, id) => {
    const hooks = globalThis.__pasteTest; hooks.store.update(id, { body: 'Alpha', html: '<b>Alpha</b>' });
    const compose = hooks.selectionService.composeHTML;
    hooks.selectionService.composeHTML = async parts => { await new Promise(resolve => { globalThis.__releaseCompose = resolve; }); return compose(parts); }; hooks.imageText.onChanged();
  }, ids[0]);
  await select(ids.slice(0, 2)); await page.keyboard.press('Enter'); await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseCompose)).toBe('function');
  await page.evaluate(id => window.paste.updateItem(id, { body: 'Changed later' }), ids[0]); await application.evaluate(() => globalThis.__releaseCompose());
  await expect(page.locator('#status')).toContainText('合并期间所选内容已改变'); expect(await writes()).toEqual([]);
  await application.evaluate(() => { const hooks = globalThis.__pasteTest; hooks.selectionService.composeHTML = parts => hooks.selectionComposer.compose(parts); });
  await page.keyboard.press('Enter'); await expect.poll(writes).toHaveLength(1); expect((await writes())[0].item.body).toContain('Changed later');
});
test('Stack receives the whole displayed selection atomically and Quick Paste still addresses one numbered item', async () => {
  await page.evaluate(() => window.paste.toggleStack()); await select([ids[0], ids[2], ids[1]]); await page.keyboard.press('Enter');
  expect((await page.evaluate(() => window.paste.getStack())).entries.map(entry => entry.item.body)).toEqual(['Gamma', 'Beta', 'Alpha']);
  await page.evaluate(() => window.paste.toggleStack()); await page.keyboard.press('Meta+2'); await expect.poll(writes).toHaveLength(1); expect((await writes())[0].item.body).toBe('Beta');
});
test('deleted members never cause partial copying and errors fit a narrow panel', async () => {
  const before = await page.evaluate(() => window.paste.getLibrary());
  await expect(page.evaluate(ids => window.paste.copySelection([ids[0], 'deleted', ids[1]]), ids)).rejects.toThrow('删除'); expect(await writes()).toEqual([]);
  await select(ids.slice(0, 2)); await page.locator(`.clip-card[data-id="${ids[0]}"]`).click({ button: 'right' });
  await page.evaluate(id => window.paste.deleteItems([id]), ids[0]); await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  await expect(page.locator('#status')).toContainText('删除'); expect(await writes()).toEqual([]);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(390, 332));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/selection-error-narrow.png' });
  expect(before.items).toHaveLength(3);
});
test('RTF-only notes and embedded HTML images merge through the actual native conversion without dropping attachments', async () => {
  await application.evaluate(({ nativeImage }, ids) => {
    const hooks = globalThis.__pasteTest;
    hooks.store.update(ids[0], { body: 'Alpha', rtf: '{\\rtf1\\ansi{\\b Alpha}}' });
    const png = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG().toString('base64');
    hooks.store.update(ids[1], { body: 'Beta', html: `<p>Beta<img src="data:image/png;base64,${png}"></p>` }); hooks.imageText.onChanged();
  }, ids);
  await select(ids.slice(0, 2)); await page.keyboard.press('Enter');
  await expect.poll(writes).toHaveLength(1); const item = (await writes())[0].item; expect(item.rtfd.length).toBeGreaterThan(100); expect(item.body).toBe('Beta\nAlpha'); expect(item.html).toContain('<img');
});
test('batch target and preferences bind before slow composition; edits during ownership lookup still abort before writing', async () => {
  await application.evaluate(async (_electron, ids) => {
    const hooks = globalThis.__pasteTest; globalThis.__sent = [];
    hooks.store.update(ids[0], { body: 'Alpha', html: '<b>Alpha</b>' });
    hooks.pasteTargets.read = async () => ({ pid: 111, bundleId: 'test.selection.A', launchTime: 123 }); await hooks.showPanel();
    hooks.pasteDelivery.simulate = false; hooks.pasteDelivery.permission = async () => ({ accessibility: true });
    hooks.pasteOwnership.readVersion = async () => 0; hooks.pasteOwnership.check = async () => ({ ok: true });
    hooks.pasteDelivery.activate = async target => { globalThis.__sent.push(target); return { ok: true }; };
    hooks.selectionService.composeHTML = async parts => { await new Promise(resolve => { globalThis.__releaseCompose = resolve; }); return hooks.selectionComposer.compose(parts); }; hooks.imageText.onChanged();
  }, ids);
  await page.evaluate(ids => { window.__batch = window.paste.copySelection(ids.slice(0, 2), { paste: true }); }, ids);
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseCompose)).toBe('function');
  await application.evaluate(async () => { const hooks = globalThis.__pasteTest; hooks.pasteTargets.read = async () => ({ pid: 222, bundleId: 'test.selection.B', launchTime: 456 }); await hooks.pasteTargets.refresh(); });
  await page.evaluate(() => window.paste.saveSettings({ plainText: true })); await application.evaluate(() => globalThis.__releaseCompose());
  expect(await page.evaluate(() => window.__batch)).toMatchObject({ ok: true }); expect((await writes())[0].plain).toBe(false);
  expect(await application.evaluate(() => globalThis.__sent.map(target => target.pid))).toEqual([111]);
  await application.evaluate(async () => {
    const hooks = globalThis.__pasteTest; hooks.selectionService.composeHTML = parts => hooks.selectionComposer.compose(parts);
    await hooks.pasteTargets.refresh();
    hooks.pasteOwnership.readVersion = () => new Promise(resolve => { globalThis.__releaseVersion = () => resolve(1); });
  });
  await page.evaluate(ids => { window.__batchRace = window.paste.copySelection(ids.slice(0, 2), { paste: true }).catch(error => error.message); }, ids);
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseVersion)).toBe('function');
  await page.evaluate(id => window.paste.updateItem(id, { body: 'Changed during ownership lookup' }), ids[0]); await application.evaluate(() => globalThis.__releaseVersion());
  expect(await page.evaluate(() => window.__batchRace)).toContain('合并期间所选内容已改变'); expect(await writes()).toHaveLength(1);
});
test('unsupported rich resources reject the entire batch with zero external requests', async () => {
  let requests = 0; const server = http.createServer((_request, response) => { requests++; response.end('unexpected'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/private-resource`;
    await application.evaluate((_electron, { id, url }) => { const hooks = globalThis.__pasteTest; hooks.store.update(id, { body: 'Alpha', html: `<style>@import url('${url}');</style><p>Alpha<img src="${url}"></p>` }); hooks.imageText.onChanged(); }, { id: ids[0], url });
    await select(ids.slice(0, 2)); await page.keyboard.press('Enter'); await expect(page.locator('#status')).toContainText('无法完整合并'); expect(await writes()).toEqual([]); expect(requests).toBe(0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
