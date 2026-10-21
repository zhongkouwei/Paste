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
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-plain-paste-')); await launch();
});
test.afterEach(async () => {
  if (application) {
    await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().endsWith('/preview.html')) window.destroy(); });
    await application.close();
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = null;
});
async function open(html = '<p>Replace me</p>') {
  const id = await application.evaluate((_electron, html) => {
    const hooks = globalThis.__pasteTest, item = hooks.store.add({ type: 'text', html, body: 'Synthetic input fixture' });
    hooks.imageText.onChanged(); return item.id;
  }, html);
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const preview = await opened; await preview.waitForFunction(() => document.body.dataset.previewReady === 'true');
  const editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible(); return { id, preview, editor };
}
async function paste(editor, text) {
  await editor.evaluate((element, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}
async function save(preview) { const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed; }
// Synthetic store and DataTransfer fixtures do not access the system clipboard.
test('plain numbered text preserves leading zeros, separators, indentation and blank lines rather than being reinterpreted', async () => {
  const text = '  001)  First\n\n    002) Second\n\n';
  const { id, preview, editor } = await open(); await editor.press('Meta+a'); await paste(editor, text);
  await expect(editor.locator('ol,li')).toHaveCount(0); await save(preview);
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe(text);
});
test('ordinary plain text preserves every empty line including trailing paragraphs', async () => {
  const text = '\nAlpha\n\n\nBeta\n\n'; const { id, preview, editor } = await open();
  await editor.press('Meta+a'); await paste(editor, text); await save(preview);
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe(text);
});
test('canonical numbered prose and Markdown punctuation stay literal on plain paste', async () => {
  const text = '1. First\n2. Second\n\n**literal bold** and ~~literal strike~~';
  const { id, preview, editor } = await open(); await editor.press('Meta+a'); await paste(editor, text);
  await expect(editor.locator('ol,strong,s')).toHaveCount(0); await save(preview);
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe(text);
});
test('plain canonical list text alone does not silently become rich numbering', async () => {
  const text = '1. First\n2. Second'; const { id, preview, editor } = await open();
  await editor.press('Meta+a'); await paste(editor, text); await expect(editor.locator('ol')).toHaveCount(0); await save(preview);
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe(text);
});
test('an out-of-range typed ordinal stays literal text and remains editable after save', async () => {
  const { id, preview, editor } = await open('<p></p>'); await editor.press('Meta+a');
  await preview.keyboard.type('2147483648. Item'); await expect(editor.locator('ol')).toHaveCount(0); await save(preview);
  const item = await page.evaluate(id => window.paste.getItem(id), id); expect(item.body).toBe('2147483648. Item');
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const reopened = await opened; await expect(reopened.getByRole('textbox', { name: '剪贴板内容' })).toBeVisible();
});
test('nonfinite-looking plain ordinals and line-ending normalization survive actual restart without HTML interpretation', async () => {
  const text = '\r\n' + '9'.repeat(400) + '. Literal\r\n\r\n<b>not HTML</b> 🙂\t尾\r';
  const expected = text.replace(/\r\n?/g, '\n'), { id, preview, editor } = await open();
  await editor.press('Meta+a'); await paste(editor, text); await expect(editor.locator('ol,b,strong')).toHaveCount(0); await save(preview);
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe(expected);
  await application.close(); await launch();
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe(expected);
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const reopened = await opened; await expect(reopened.getByRole('textbox', { name: '剪贴板内容' }).locator('ol,b')).toHaveCount(0);
  await expect(reopened.getByRole('textbox', { name: '剪贴板内容' })).toContainText('<b>not HTML</b>');
});
test('plain paste inside a code block never replaces the code block with an inferred ordered list', async () => {
  const { id, preview, editor } = await open('<pre><code>Replace me</code></pre>');
  await editor.evaluate(element => { const engine = element.editor; engine.commands.setTextSelection({ from: 1, to: 11 }); engine.view.focus(); });
  const text = '1. First\n\n2. Second\n\n'; await paste(editor, text);
  await expect(editor.locator('pre code')).toHaveText(text); await expect(editor.locator('ol')).toHaveCount(0); await save(preview);
  expect((await page.evaluate(id => window.paste.getItem(id), id)).body).toBe(text + '\n');
});
test('partial replacement inherits active bold marks but retains literal Markdown, and undo restores exact source HTML', async () => {
  const html = '<p>Before <strong>Target</strong> After</p>', { id, preview, editor } = await open(html);
  await editor.evaluate(element => {
    const engine = element.editor; let from;
    engine.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Target') from = pos; });
    engine.commands.setTextSelection({ from: from + 1, to: from + 4 }); engine.view.focus();
  });
  await paste(editor, '**x**'); await expect(editor.locator('strong')).toHaveText('T**x**et');
  await expect(editor).toHaveText('Before T**x**et After');
  await preview.keyboard.press('Meta+z'); await expect(editor).toHaveText('Before Target After'); await save(preview);
  expect((await page.evaluate(id => window.paste.getItem(id), id)).html).toBe(html);
});
test('canonical typed zero and maximum ordinals still create lists while padded numeric identifiers stay literal', async () => {
  for (const value of ['0', '2147483647', '001']) {
    const { preview, editor } = await open('<p></p>'); await editor.press('Meta+a'); await preview.keyboard.type(value + '. Item');
    if (value === '001') { await expect(editor.locator('ol')).toHaveCount(0); await expect(editor).toHaveText('001. Item'); }
    else { await expect(editor.locator('ol')).toHaveAttribute('start', value); await expect(editor.locator('li')).toHaveText('Item'); }
    await save(preview);
  }
});
