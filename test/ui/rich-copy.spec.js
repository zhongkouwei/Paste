const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let application, page, directory;

// Every fixture and copy event is synthetic; this suite never accesses the system clipboard.
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-rich-copy-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
});
test.afterEach(async () => {
  if (application) {
    await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().endsWith('/preview.html')) window.destroy(); });
    await application.close();
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = null;
});
async function open(html) {
  const id = await application.evaluate((_electron, html) => {
    const hooks = globalThis.__pasteTest, item = hooks.store.add({ type: 'text', html, body: 'Synthetic copy fixture' });
    hooks.imageText.onChanged(); return item.id;
  }, html);
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.paste.openPreview(id, { mode: 'edit' }), id);
  const preview = await opened; await preview.waitForFunction(() => document.body.dataset.previewReady === 'true');
  const editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await expect(editor).toBeVisible();
  return { id, preview, editor };
}
async function textSelection(editor, first, last = first, length = last.length, reverse = false) {
  await editor.evaluate((element, { first, last, length, reverse }) => {
    const engine = element.editor, positions = new Map();
    engine.state.doc.descendants((node, pos) => { if (node.isText) positions.set(node.text, pos); });
    const from = positions.get(first), to = positions.get(last) + length;
    engine.commands.setTextSelection(reverse ? { from: to, to: from } : { from, to }); engine.view.focus();
  }, { first, last, length, reverse });
}
async function cells(editor, first, last = first) {
  await editor.evaluate((element, { first, last }) => {
    const engine = element.editor, positions = new Map();
    engine.state.doc.descendants((node, pos) => { if (['tableCell', 'tableHeader'].includes(node.type.name)) positions.set(node.textContent, pos); });
    engine.commands.setCellSelection({ anchorCell: positions.get(first), headCell: positions.get(last) }); engine.view.focus();
  }, { first, last });
}
async function copy(editor, cut = false) {
  return editor.evaluate((element, cut) => {
    const data = new DataTransfer(); element.dispatchEvent(new ClipboardEvent(cut ? 'cut' : 'copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { text: data.getData('text/plain'), html: data.getData('text/html') };
  }, cut);
}
test('a word selection inside a cell copies only that word rather than the whole table', async () => {
  const { editor } = await open('<table><tr><td><p>Visible word</p></td><td><p>Private neighbor</p></td></tr><tr><td><p>Second private row</p></td><td><p>Other private</p></td></tr></table>');
  for (const reverse of [false, true]) {
    await textSelection(editor, 'Visible word', 'Visible word', 7, reverse);
    const result = await copy(editor); expect(result.text).toBe('Visible'); expect(result.html).toContain('Visible');
    expect(result.html).not.toMatch(/Private|private|word/);
  }
});
test('a column cell selection copies a rectangular TSV without intervening unselected cells', async () => {
  const { editor } = await open('<table><tr><td><p>A</p></td><td><p>Secret one</p></td></tr><tr><td><p>B</p></td><td><p>Secret two</p></td></tr></table>');
  for (const [first, last] of [['A', 'B'], ['B', 'A']]) {
    await cells(editor, first, last); const result = await copy(editor);
    expect(result.text).toBe('A\nB'); expect(result.html).not.toContain('Secret');
  }
});
test('merged rectangular cell selections preserve coordinate blanks and never include the unselected left column', async () => {
  const { editor } = await open('<table><tr><td rowspan="2"><p>Secret left</p></td><th colspan="2"><p>Heading</p></th></tr><tr><td><p>A</p></td><td><p>B</p></td></tr><tr><td><p>Secret bottom</p></td><td><p>C</p></td><td><p>D</p></td></tr></table>');
  await cells(editor, 'D', 'Heading'); const result = await copy(editor);
  expect(result.text).toBe('Heading\t\nA\tB\nC\tD'); expect(result.html).not.toContain('Secret'); expect(result.html).toContain('colspan="2"');
});
test('a text range crossing cells retains partial text and column boundaries, not unselected rows', async () => {
  const { editor } = await open('<table><tr><td><p>Alpha tail</p></td><td><p>Beta secret</p></td></tr><tr><td><p>Private row</p></td><td><p>Private cell</p></td></tr></table>');
  await textSelection(editor, 'Alpha tail', 'Beta secret', 4); const result = await copy(editor);
  expect(result.text).toBe('Alpha tail\tBeta'); expect(result.html).not.toMatch(/secret|Private/);
});
test('copying middle items from an implicit reversed list retains their original displayed ordinals', async () => {
  const html = '<ol reversed type="A"><li><p>First</p></li><li><p>Second</p></li><li><p>Third</p></li><li><p>Fourth</p></li><li><p>Fifth</p></li></ol>';
  const { id, editor } = await open(html); await textSelection(editor, 'Second', 'Third', 5);
  const result = await copy(editor), parsed = await editor.evaluate((_element, html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html'), list = doc.querySelector('ol');
    return { start: list?.getAttribute('start'), reversed: list?.hasAttribute('reversed'), type: list?.getAttribute('type'), items: [...doc.querySelectorAll('li')].map(item => item.textContent) };
  }, result.html);
  expect(parsed).toEqual({ start: '4', reversed: true, type: 'A', items: ['Second', 'Third'] });
  expect((await page.evaluate(id => window.paste.getItem(id), id)).html).toBe(html);
});
test('cutting a selected table word copies no neighbors, removes only the selection and undo preserves the original bytes', async () => {
  const html = '<table><tr><td><p>Visible word</p></td><td><p>Private neighbor</p></td></tr></table>';
  const { id, preview, editor } = await open(html); await textSelection(editor, 'Visible word', 'Visible word', 7);
  const result = await copy(editor, true); expect(result.text).toBe('Visible'); expect(result.html).not.toContain('Private');
  await expect(editor.locator('td').first()).toHaveText(' word'); await expect(editor.locator('td').nth(1)).toHaveText('Private neighbor');
  await preview.keyboard.press('Meta+z'); await expect(editor.locator('td').first()).toHaveText('Visible word');
  const closed = preview.waitForEvent('close'); await preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  expect((await page.evaluate(id => window.paste.getItem(id), id)).html).toBe(html);
});
test('copied reversed list fragments paste with correct ordinals while copy itself leaves the source clean', async () => {
  const source = await open('<ol reversed type="A"><li><p>One</p></li><li><p>Two</p></li><li value="0"><p>Zero</p></li><li><p>Minus one</p></li><li><p>Minus two</p></li></ol>');
  await textSelection(source.editor, 'Two', 'Minus one'); const result = await copy(source.editor);
  await expect(source.preview.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await source.preview.close();
  const target = await open('<p>Replace me</p>'); await target.editor.press('Meta+a');
  await target.editor.evaluate((element, result) => {
    const data = new DataTransfer(); data.setData('text/html', result.html); data.setData('text/plain', result.text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, result);
  await expect(target.editor.locator('ol')).toHaveAttribute('start', '4'); await expect(target.editor.locator('ol')).toHaveAttribute('reversed', '');
  await expect(target.editor.locator('li')).toHaveCount(3); await expect(target.editor.locator('li[value="0"]')).toHaveCount(1);
  const closed = target.preview.waitForEvent('close'); await target.preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  const saved = await page.evaluate(id => window.paste.getItem(id), target.id);
  expect(saved.body).toBe('D. Two\n0. Zero\n-1. Minus one');
  expect(saved.html).not.toContain('Minus two'); expect(saved.html).not.toContain('One');
});
test('a merged copied table rectangle pastes as an editable grid without excluded columns or styles leaking to the source', async () => {
  const source = await open('<table><tr><td rowspan="2"><p>Secret</p></td><th colspan="2" style="color:rgb(180,30,60)"><p>Heading</p></th></tr><tr><td><p>A</p></td><td><p>B</p></td></tr></table>');
  await cells(source.editor, 'Heading', 'B'); const result = await copy(source.editor); expect(result.text).toBe('Heading\t\nA\tB');
  await source.preview.close();
  const target = await open('<p>Replace me</p>'); await target.editor.press('Meta+a');
  await target.editor.evaluate((element, result) => {
    const data = new DataTransfer(); data.setData('text/html', result.html); data.setData('text/plain', result.text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, result);
  await expect(target.editor.locator('tr')).toHaveCount(2); await expect(target.editor.locator('th')).toHaveAttribute('colspan', '2');
  await expect(target.editor.locator('th')).toHaveCSS('color', 'rgb(180, 30, 60)'); expect(await target.editor.textContent()).not.toContain('Secret');
  const closed = target.preview.waitForEvent('close'); await target.preview.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  expect((await page.evaluate(id => window.paste.getItem(id), target.id)).body).toBe('Heading\t\nA\tB\n');
});
