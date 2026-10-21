const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let application, page, directory;

async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
}
// Rich list fixtures and synthetic paste/copy events never access the system clipboard.
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-rich-lists-')); await launch();
});
test.afterEach(async () => {
  if (application) {
    await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().endsWith('/preview.html')) window.destroy(); });
    await application.close();
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = null;
});
async function open(html, body = 'Synthetic list fixture') {
  const id = await application.evaluate((_electron, { html, body }) => {
    const hooks = globalThis.__pasteTest, item = hooks.store.add({ type: 'text', html, body, title: 'Synthetic list fixture' });
    hooks.imageText.onChanged(); return item.id;
  }, { html, body });
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await preview.waitForFunction(() => document.body.dataset.previewReady === 'true'); await expect(editor).toBeVisible();
  return { id, preview, editor };
}
async function save(preview) { const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed; }
async function prepend(preview, editor) {
  await editor.evaluate(element => {
    const editor = element.editor; let from;
    editor.state.doc.descendants((node, pos) => { if (node.isText && from === undefined) from = pos; });
    editor.commands.setTextSelection(from); editor.view.focus();
  });
  await preview.keyboard.insertText('Updated ');
}
async function reopen(id) {
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const preview = await opened, editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await preview.waitForFunction(() => document.body.dataset.previewReady === 'true'); await expect(editor).toBeVisible();
  return { preview, editor };
}
test('descending ordered lists retain their implicit start, explicit item values and nested list attributes', async () => {
  const html = '<p>Before</p><ol reversed type="A"><li><p>First</p></li><li value="7"><p>Restart</p><ol reversed start="3" type="i"><li><p>Nested</p></li><li><p>Nested next</p></li></ol></li><li><p>Last</p></li></ol><p>After</p>';
  const { id, preview, editor } = await open(html);
  await expect(editor.locator('ol').first()).toHaveAttribute('reversed', '');
  await expect(editor.locator('ol').first()).not.toHaveAttribute('start');
  await expect(editor.locator('ol').first()).toHaveAttribute('type', 'A');
  await expect(editor.locator('li[value="7"]')).toHaveCount(1);
  await expect(editor.locator('ol ol')).toHaveAttribute('start', '3'); await expect(editor.locator('ol ol')).toHaveAttribute('reversed', '');
  await prepend(preview, editor); await save(preview);
  const item = await page.evaluate(id => window.paste.getItem(id), id);
  expect(item.body).toBe('Updated Before\nC. First\nG. Restart\n  iii. Nested\n  ii. Nested next\nF. Last\nAfter');
  expect(item.html).toContain('reversed'); expect(item.html).toContain('value="7"');
  await application.close(); await launch();
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe(item.body);
  const reopened = await reopen(id);
  await expect(reopened.editor.locator('ol').first()).toHaveAttribute('reversed', '');
  await expect(reopened.editor.locator('li[value="7"]')).toHaveCount(1);
});
test('editing a list retains plain-text numbering, nested bullets and continuation indentation', async () => {
  const html = '<p>Before</p><ol start="3" type="A"><li><p>Parent</p><ul style="list-style-type:square"><li><p>Child</p><p>Continuation</p></li></ul></li><li><p>Next</p></li></ol><p>After</p>';
  const { id, preview, editor } = await open(html);
  await prepend(preview, editor); await save(preview);
  const item = await page.evaluate(id => window.paste.getItem(id), id);
  expect(item.body).toBe('Updated Before\nC. Parent\n  ▪ Child\n    Continuation\nD. Next\nAfter');
});
test('splitting a restarted reversed item does not duplicate its value and updates the implicit start', async () => {
  const { id, preview, editor } = await open('<ol reversed><li><p>First</p></li><li value="7"><p>Restart</p></li><li><p>Last</p></li></ol>');
  await editor.evaluate(element => {
    const editor = element.editor; let end;
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Restart') end = pos + node.text.length; });
    editor.commands.setTextSelection(end); editor.view.focus();
  });
  await preview.keyboard.press('Enter');
  await preview.keyboard.insertText('Inserted');
  await expect(editor.locator('li')).toHaveCount(4); await expect(editor.locator('li[value="7"]')).toHaveCount(1);
  await expect(editor.locator('ol')).not.toHaveAttribute('start'); await save(preview);
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe('4. First\n7. Restart\n6. Inserted\n5. Last');
});
test('unchanged and fully undone list documents preserve original HTML and RTF bytes', async () => {
  const html = '<ol reversed type="I">\n  <li value="12"><p>Original</p></li>\n</ol>', rtf = '{\\rtf1 Synthetic list fixture}';
  const { id, preview, editor } = await open(html, 'Original supplied plaintext');
  await application.evaluate((_electron, { id, rtf }) => { const hooks = globalThis.__pasteTest; hooks.store.mutate(() => { hooks.store.edit(id).rtf = rtf; }); }, { id, rtf });
  // Reopen so the preview baseline includes every representation.
  await preview.close();
  let opened = await reopen(id); await save(opened.preview);
  let saved = await page.evaluate(id => window.paste.getItem(id), id);
  expect(saved.html).toBe(html); expect(saved.rtf).toBe(rtf); expect(saved.body).toBe('Original supplied plaintext');
  opened = await reopen(id); await prepend(opened.preview, opened.editor); await opened.preview.keyboard.press('Meta+z');
  await expect(opened.editor).toHaveText('Original'); await save(opened.preview);
  saved = await page.evaluate(id => window.paste.getItem(id), id);
  expect(saved.html).toBe(html); expect(saved.rtf).toBe(rtf); expect(saved.body).toBe('Original supplied plaintext');
});
test('HTML paste retains list style, inside positioning, whitespace and per-item marker overrides', async () => {
  const { id, preview, editor } = await open('<p>Replace me</p>'); await editor.press('Meta+a');
  await editor.evaluate(element => {
    const data = new DataTransfer(); data.setData('text/html', '<ol start="8" style="list-style:upper-roman inside">\n<li style="list-style-type:lower-alpha"><p>Alpha</p></li>\n<li><p>Roman</p></li></ol><p><span>two</span> <span>words</span></p>');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator('li')).toHaveCount(2);
  await expect(editor.locator('ol')).toHaveCSS('list-style-type', 'upper-roman'); await expect(editor.locator('ol')).toHaveCSS('list-style-position', 'inside');
  await expect(editor.locator('li').first()).toHaveCSS('list-style-type', 'lower-alpha');
  await save(preview);
  const saved = await page.evaluate(id => window.paste.getItem(id), id);
  expect(saved.body).toBe('h. Alpha\nIX. Roman\ntwo words'); expect(saved.html).toContain('list-style-position: inside');
});
test('synthetic copy serializes only the selected list text, never unselected siblings', async () => {
  const { preview, editor } = await open('<ol start="4"><li><p>Selected secret</p></li><li><p>Unselected sibling</p></li></ol>');
  await editor.evaluate(element => {
    const editor = element.editor; let from;
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Selected secret') from = pos; });
    editor.commands.setTextSelection({ from, to: from + 8 }); editor.view.focus();
  });
  expect(await preview.evaluate(() => window.getSelection().toString())).toBe('Selected');
  const copy = () => editor.evaluate(element => {
    const data = new DataTransfer(); element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { text: data.getData('text/plain'), html: data.getData('text/html') };
  });
  const part = await copy(); expect(part.text).toBe('Selected'); expect(part.html).not.toContain('Unselected'); expect(part.html).not.toContain('secret');
  await editor.press('Meta+a'); expect((await copy()).text).toBe('4. Selected secret\n5. Unselected sibling');
});
test('typing the next ordinal joins an implicit-start list and Enter twice exits it', async () => {
  const { id, preview, editor } = await open('<ol><li><p>One</p></li><li><p>Two</p></li></ol><p></p>');
  await editor.evaluate(element => { element.editor.commands.setTextSelection(element.editor.state.doc.content.size - 1); element.editor.view.focus(); });
  await preview.keyboard.type('3. Three'); await expect(editor.locator('ol')).toHaveCount(1); await expect(editor.locator('li')).toHaveCount(3);
  await preview.keyboard.press('Enter'); await preview.keyboard.press('Enter'); await preview.keyboard.insertText('After');
  await save(preview); expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe('1. One\n2. Two\n3. Three\nAfter');
});
test('unsupported custom counters cannot replace a selected document and list markers stay visible at narrow widths', async () => {
  const { preview, editor } = await open('<ol reversed start="12" type="I"><li><p>Long synthetic list item wraps across the available document width.</p><ul><li><p>Nested item</p></li></ul></li></ol>');
  await editor.press('Meta+a'); const before = await editor.innerHTML();
  await editor.evaluate(element => {
    const data = new DataTransfer(); data.setData('text/html', '<ol style="counter-reset:custom 10"><li>Custom counter</li></ol>');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect(await editor.innerHTML()).toBe(before);
  await expect(preview.locator('#previewStatus')).toContainText('自定义列表');
  for (const [width, theme] of [[720, 'light'], [320, 'dark']]) {
    await page.evaluate(theme => window.paste.saveSettings({ theme }), theme);
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/preview.html')).setBounds({ width, height: 500 }), width);
    await expect(editor.locator('ol')).toHaveCSS('list-style-type', 'upper-roman'); await expect(editor.locator('ul')).toHaveCSS('list-style-type', 'circle');
    expect(await preview.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const bounds = await editor.locator('li p').first().boundingBox(); expect(bounds.x).toBeGreaterThan(25); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await preview.screenshot({ path: `test-results/rich-lists-${width}-${theme}.png` });
  }
});
test('list policy rejects unsupported and excessive structures while preserving inline whitespace', async () => {
  const { id, preview } = await open('<p>Policy fixture</p>'); await preview.close();
  const target = await reopen(id);
  const policies = await target.preview.evaluate(() => [
    '<ol start="2147483648"><li>Too large</li></ol>', '<ol><li value="2x">Invalid integer</li></ol>',
    '<ol style="list-style-type:my-counter"><li>Custom</li></ol>', '<ul style="list-style-image:url(https://example.invalid/marker.png)"><li>External</li></ul>',
    '<ol><li>'.repeat(33) + 'Deep' + '</li></ol>'.repeat(33)
  ].map(html => PasteEditor.inspect(html)));
  for (const policy of policies) expect(policy.reason).toMatch(/暂不支持|超出|超过/);
  expect(policies[3].html).not.toContain('url(');
  const clean = await target.preview.evaluate(() => PasteEditor.inspect('<ol reversed start="-1"><li value="0"><p><span>two</span> <span>words</span><script>window.listInjected=true</script></p></li></ol>'));
  expect(clean.reason).toBe(''); expect(clean.html).toContain('reversed'); expect(clean.html).toContain('value="0"');
  expect(clean.html).not.toContain('script'); expect(clean.html).toContain('</span> <span>');
  expect(await target.preview.evaluate(() => window.listInjected)).toBeUndefined();
});
