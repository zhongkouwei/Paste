const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { RichTextService } = require('../../src/rich-text');
let application, page, directory;
const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\colortbl;\red200\green30\blue40;}\f0\fs32\cf1{\b Bold} plain\par {\i\ul Next}}`;
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
}
test.beforeEach(async () => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-rtf-ui-')); await launch(); });
test.afterEach(async () => {
  if (application) {
    await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().endsWith('/preview.html')) window.destroy(); });
    await application.close();
  }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = null;
});
async function seed(value = {}) {
  return application.evaluate((_electron, value) => {
    const { store, imageText } = globalThis.__pasteTest, item = store.add({ type: 'text', body: 'Bold plain\nNext', rtf: value.rtf, ...value });
    const board = store.saveBoard({ name: 'Keep RTF', color: '#ef6259' }); store.update(item.id, { title: 'Rich original', boardIds: [board.id] }); imageText.onChanged(); return store.get(item.id);
  }, { rtf, ...value });
}
async function open(id, mode = 'edit', ids = []) {
  const opened = application.waitForEvent('window'); await page.evaluate(({ id, mode, ids }) => window.paste.openPreview(id, { mode, ids }), { id, mode, ids });
  const preview = await opened; await preview.waitForFunction(() => document.body.dataset.previewReady === 'true'); return preview;
}
async function save(preview) { const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed; }
async function item(id) { return page.evaluate(id => window.paste.getItem(id), id); }
// Synthetic profiles only, no system clipboard access.
test('RTF-only preview and editor show native bold, italic, underline, font size and color without writing the library', async () => {
  const original = await seed(), raw = fs.readFileSync(path.join(directory, 'library.json'), 'utf8'); const preview = await open(original.id, 'view');
  await expect(preview.locator('#editPreview')).toBeEnabled(); const frame = preview.frameLocator('#previewContent iframe');
  await expect(frame.locator('b')).toHaveText('Bold'); await expect(frame.locator('i')).toHaveText('Next');
  await expect(frame.locator('p').first()).toHaveCSS('font-size', '16px'); await expect(frame.locator('p').first()).toHaveCSS('color', 'rgb(200, 30, 40)');
  await preview.locator('#editPreview').click(); const editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible();
  await expect(editor.locator('strong')).toHaveText('Bold'); await expect(editor.locator('em')).toHaveText('Next'); await expect(editor.locator('u')).toHaveText('Next');
  await preview.setViewportSize({ width: 390, height: 500 }); await preview.screenshot({ path: 'test-results/rtf-edit-narrow.png' });
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true); await save(preview);
  expect(await item(original.id)).toEqual(original); expect(fs.readFileSync(path.join(directory, 'library.json'), 'utf8')).toBe(raw);
});
test('edit then undo all keeps literal RTF, absent HTML, signature and manifest bytes', async () => {
  const original = await seed(), raw = fs.readFileSync(path.join(directory, 'library.json'), 'utf8'), preview = await open(original.id);
  const editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible(); await editor.press('Meta+End'); await preview.keyboard.type('!');
  await preview.keyboard.press('Meta+z'); await expect(editor).toHaveText('Bold plainNext'); await save(preview);
  expect(await item(original.id)).toEqual(original); expect(fs.readFileSync(path.join(directory, 'library.json'), 'utf8')).toBe(raw);
});
test('actual edit regenerates RTF alongside HTML, retains pinned identity and survives restart', async () => {
  const original = await seed(), preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible();
  await editor.evaluate(element => { element.editor.commands.focus('end'); element.editor.commands.insertContent('! 中文🙂'); }); await save(preview);
  const value = await item(original.id); expect(value.body).toBe('Bold plain\nNext! 中文🙂'); expect(value.rtf).not.toBe(original.rtf); expect(value.html).toContain('<strong>Bold</strong>');
  expect(value).toMatchObject({ id: original.id, boardIds: original.boardIds, title: original.title });
  expect(value.html).toContain('rgb(200, 30, 40)');
  const service = new RichTextService(); try { const converted = await service.read(value.rtf); expect(converted.text).toBe(value.body + '\n'); expect(converted.html).toContain('<b>Bold</b>'); expect(converted.html).toContain('underline'); expect(converted.html).toContain('Arial'); } finally { await service.close(); }
  await application.close(); application = null; await launch(); expect(await item(original.id)).toEqual(value);
});
test('invalid or mismatched RTF is read-only with the stored original intact', async () => {
  for (const value of [{ rtf: 'not RTF' }, { body: 'Different original' }, { rtf: '{\\rtf1 Before{\\pict opaque}After}', body: 'BeforeAfter' }]) {
    const original = await seed(value), preview = await open(original.id);
    await expect(preview.locator('#previewStatus')).toContainText(/格式或大小|不一致|附件或文档结构/); await expect(preview.getByRole('textbox', { name: '剪贴板内容' })).toHaveCount(0);
    await expect(preview.locator('#savePreview')).toBeHidden(); await expect(preview.locator('#copyPreview')).toBeVisible(); expect(await item(original.id)).toEqual(original);
    const closed = preview.waitForEvent('close'); await preview.locator('#closePreview').click(); await closed;
  }
});
test('failed native save keeps the editable draft and original; retry saves correctly', async () => {
  const original = await seed(), preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible();
  await editor.evaluate(element => { element.editor.commands.focus('end'); element.editor.commands.insertContent('!'); });
  await application.evaluate(() => { const service = globalThis.__pasteTest.richTextService; service.savedRun = service.run; service.run = async () => { throw new Error('Synthetic conversion failure'); }; });
  await preview.locator('#savePreview').click(); await expect(preview.locator('#previewStatus')).toContainText('Synthetic conversion failure');
  expect(await item(original.id)).toEqual(original); await expect(editor).toContainText('Next!'); await expect(preview.locator('.preview-shell')).not.toHaveAttribute('inert');
  await application.evaluate(() => { const service = globalThis.__pasteTest.richTextService; service.run = service.savedRun; }); await save(preview); expect((await item(original.id)).body).toContain('Next!');
});
test('mismatched paragraph terminators do not silently trim source text', async () => {
  const original = await seed({ body: 'Bold plain\nNext\n' }), preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' });
  // This source has no terminal paragraph, so the extra plain-text LF cannot be assumed equivalent.
  await expect(preview.locator('#previewStatus')).toContainText('不一致'); await expect(editor).toHaveCount(0); expect(await item(original.id)).toEqual(original);
});
test('a genuine native terminal paragraph survives edits without becoming an extra blank paragraph', async () => {
  const service = new RichTextService(); let native;
  try { native = await service.write('<p><b>First</b></p><p>Last</p>', 'First\nLast'); } finally { await service.close(); }
  const original = await seed({ rtf: native, body: 'First\nLast\n' }), preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' });
  await expect(editor.locator('p')).toHaveCount(2); await editor.evaluate(element => { element.editor.commands.focus('end'); element.editor.commands.insertContent('!'); });
  await save(preview); expect((await item(original.id)).body).toBe('First\nLast!\n');
});
test('native formatting toggles actually remove bold, italic and underline rather than leaving duplicate CSS', async () => {
  const original = await seed(), preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible();
  await editor.evaluate(element => element.editor.commands.selectAll());
  await preview.locator('[data-command=bold]').click(); await preview.locator('[data-command=bold]').click();
  await preview.locator('[data-command=italic]').click(); await preview.locator('[data-command=italic]').click();
  await preview.locator('[data-command=underline]').click(); await preview.locator('[data-command=underline]').click();
  const styles = await editor.locator('p, p *').evaluateAll(nodes => nodes.map(node => { const css = getComputedStyle(node); return { html: node.outerHTML, weight: css.fontWeight, italic: css.fontStyle, decoration: css.textDecorationLine }; }));
  expect(styles.filter(style => Number(style.weight) >= 600 || style.italic !== 'normal' || style.decoration.includes('underline'))).toEqual([]);
  await save(preview); const service = new RichTextService(); try { const result = await service.read((await item(original.id)).rtf); expect(result.html).not.toMatch(/<b>|<i>|underline/); } finally { await service.close(); }
});
test('ordinary HTML style spans also use one editable representation for formatting marks', async () => {
  const original = await seed({ rtf: '', body: 'Styled', html: '<p><span style="font-weight:700;font-style:italic;text-decoration:underline line-through;color:rgb(200,30,40)">Styled</span></p>' });
  const preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible(); await editor.evaluate(element => element.editor.commands.selectAll());
  for (const command of ['bold', 'italic', 'underline', 'strike']) await preview.locator(`[data-command=${command}]`).click();
  await expect(editor.locator('strong,em,u,s')).toHaveCount(0); await expect(editor.locator('span')).toHaveCSS('color', 'rgb(200, 30, 40)');
  const styles = await editor.locator('span').evaluateAll(nodes => nodes.map(node => { const css = getComputedStyle(node); return [css.fontWeight, css.fontStyle, css.textDecorationLine]; })); expect(styles).toEqual([['400', 'normal', 'none']]);
  await save(preview); expect((await item(original.id)).body).toBe('Styled');
});
test('late RTF view replies cannot replace navigation or typed rename drafts', async () => {
  const original = await seed(); const other = await application.evaluate(() => { const { store, imageText } = globalThis.__pasteTest; const item = store.add({ type: 'text', body: 'Other item' }); imageText.onChanged(); return item.id; });
  await application.evaluate(() => {
    const service = globalThis.__pasteTest.richTextService; service.actualRead = service.read.bind(service);
    service.read = (...args) => new Promise((resolve, reject) => { service.releaseRead = async () => { try { resolve(await service.actualRead(...args)); } catch (error) { reject(error); } }; });
  });
  const preview = await open(original.id, 'view', [original.id, other]); await expect(preview.locator('#previewStatus')).toContainText('正在读取');
  await preview.evaluate(() => window.paste.navigatePreview(1)); await expect(preview.locator('#previewContent')).toHaveText('Other item');
  await application.evaluate(() => globalThis.__pasteTest.richTextService.releaseRead());
  await expect(preview.locator('#previewContent')).toHaveText('Other item');
  await preview.evaluate(id => window.paste.openPreview(id, { mode: 'view' }), original.id);
  await expect(preview.locator('#previewStatus')).toContainText('正在读取');
  await preview.evaluate(id => window.paste.openPreview(id, { mode: 'rename' }), original.id); const input = preview.getByRole('textbox', { name: '项目名称' }); await input.fill('Typed while loading');
  await application.evaluate(() => globalThis.__pasteTest.richTextService.releaseRead());
  await expect(input).toHaveValue('Typed while loading'); await save(preview); expect((await item(original.id)).title).toBe('Typed while loading'); expect((await item(original.id)).rtf).toBe(original.rtf);
});
test('native inliner resolves CSS cascade but never runs scripts or requests external resources', async () => {
  let requests = 0; const server = http.createServer((_request, response) => { requests++; response.end('unexpected'); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const original = await seed(), preview = await open(original.id); await expect(preview.getByRole('textbox', { name: '剪贴板内容' })).toBeVisible();
    const result = await preview.evaluate(async port => {
      const url = `http://127.0.0.1:${port}/resource`;
      const result = await PasteEditor.nativeRichHTML(`<html><head><style>@import url('${url}'); p{color:blue}p.p1{color:rgb(200,30,40);font:16px Arial;background-image:url('${url}')}</style></head><body><script>parent.nativeRan=true</script><p class="p1">Safe</p><img src="${url}" onerror="parent.nativeRan=true"></body></html>`);
      await new Promise(resolve => setTimeout(resolve, 100)); return { ...result, ran: !!window.nativeRan, frames: document.querySelectorAll('iframe[hidden]').length };
    }, server.address().port);
    expect(result.html).toContain('rgb(200, 30, 40)'); expect(result.html).not.toMatch(/<script|onerror|resource|<style/); expect(result.reason).toBeTruthy(); expect(result.ran).toBe(false); expect(result.frames).toBe(0); expect(requests).toBe(0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('changing content during conversion cannot commit a late save result', async () => {
  const original = await seed(), preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible();
  await application.evaluate(() => { const service = globalThis.__pasteTest.richTextService; service.actualWrite = service.write.bind(service); service.write = (...args) => new Promise(resolve => { service.releaseWrite = () => resolve(service.actualWrite(...args)); }); });
  const pending = preview.evaluate(() => window.paste.savePreview({ body: 'Changed', html: '<p>Changed</p>' }).then(() => 'saved', error => error.message));
  await expect.poll(() => application.evaluate(() => !!globalThis.__pasteTest.richTextService.releaseWrite)).toBe(true);
  await page.evaluate(id => window.paste.updateItem(id, { body: 'Newer content', html: '<p>Newer content</p>' }), original.id);
  await application.evaluate(() => globalThis.__pasteTest.richTextService.releaseWrite()); expect(await pending).toContain('已改变'); expect((await item(original.id)).body).toBe('Newer content');
});
test('pasting images into RTF never silently loses the image on native save', async () => {
  const original = await seed(), preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible();
  await editor.evaluate(element => {
    element.editor.commands.selectAll();
    const data = new DataTransfer(); data.setData('text/html', '<p>Replacement<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII="></p>');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(preview.locator('#previewStatus')).toContainText('不能保留内嵌图像'); await expect(editor).toHaveText('Bold plainNext'); await save(preview); expect(await item(original.id)).toEqual(original);
});
test('RTF with Cocoa-generated HTML preserves stylesheet formatting rather than stripping class styles', async () => {
  const service = new RichTextService(); let html; try { html = (await service.read(rtf)).html; } finally { await service.close(); }
  const original = await seed({ html }), preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible();
  await expect(editor.locator('p').first()).toHaveCSS('font-size', '16px'); await expect(editor.locator('p').first()).toHaveCSS('color', 'rgb(200, 30, 40)');
  await save(preview); expect(await item(original.id)).toEqual(original);
});
test('code, links and colors with RTF cannot bypass the rich editor and silently discard RTF', async () => {
  for (const [type, body] of [['code', 'const value = 1;'], ['link', 'https://example.invalid/'], ['color', '#ef6259']]) {
    const original = await seed({ type, body, rtf: `{\\rtf1\\ansi{\\b ${body}}}` }), preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' });
    await expect(editor.locator('strong')).toHaveText(body); await expect(preview.locator('#editTools')).toBeVisible(); await save(preview); expect(await item(original.id)).toEqual(original);
  }
});
test('an HTML representation cannot bypass the opaque source RTF guard on save', async () => {
  const original = await seed({ rtf: '{\\rtf1 Before{\\pict opaque}After}', body: 'BeforeAfter', html: '<p>BeforeAfter</p>' });
  const preview = await open(original.id), editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible();
  await editor.evaluate(element => { element.editor.commands.focus('end'); element.editor.commands.insertContent('!'); });
  await preview.locator('#savePreview').click(); await expect(preview.locator('#previewStatus')).toContainText('附件或文档结构');
  await expect(editor).toHaveText('BeforeAfter!'); expect(await item(original.id)).toEqual(original);
});
