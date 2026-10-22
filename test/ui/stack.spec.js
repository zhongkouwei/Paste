const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, panel, directory;
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-stack-ui-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 1;
    const hooks = globalThis.__pasteTest;
    globalThis.__stackVersion = 10; globalThis.__writes = []; globalThis.__plainWrites = []; globalThis.__sent = []; globalThis.__copyValue = null;
    globalThis.__signature = hooks.textSignature;
    hooks.monitor.readVersion = async () => globalThis.__stackVersion;
    hooks.monitor.readSnapshot = async () => globalThis.__copyValue;
    hooks.clip.read = () => { throw Error('Unexpected system clipboard access'); };
    hooks.clip.write = async (item, options) => {
      globalThis.__writes.push(item.body);
      globalThis.__plainWrites.push(options.plain);
      if (globalThis.__hold) { globalThis.__hold = false; await new Promise(resolve => { globalThis.__release = resolve; }); }
      if (globalThis.__writeFailure) throw Error('Injected Stack write failure');
      globalThis.__stackVersion++;
      globalThis.__copyValue = { type: 'text', body: item.body, title: item.title, signature: globalThis.__signature(item.body), clipboardWriteID: options.writeID };
      return globalThis.__copyValue.signature;
    };
    hooks.stackInput.baseline = () => globalThis.__stackVersion;
    hooks.pasteOwnership.readVersion = async () => globalThis.__stackVersion;
    hooks.pasteOwnership.check = async lease => ({ ok: lease.version === globalThis.__stackVersion && lease.token === globalThis.__copyValue.clipboardWriteID });
    hooks.pasteTargets.read = async () => ({ pid: 111, bundleId: 'test.stack.target', launchTime: 123 });
    hooks.pasteDelivery.simulate = false;
    hooks.pasteDelivery.permission = async () => ({ accessibility: true });
    hooks.pasteDelivery.activate = async target => { globalThis.__sent.push(target); return { ok: true }; };
  });
  await page.evaluate(() => window.paste.toggleStack());
  panel = application.windows().find(window => window.url().endsWith('/stack.html'));
  await panel.waitForFunction(() => document.body.dataset.stackReady === 'true');
  // The real native protocol dispatcher runs with synthetic adapters only. Never
  // launch a production key tap or touch the general pasteboard in this suite.
  await application.evaluate(() => { const input = globalThis.__pasteTest.stackInput; input.launch = () => { throw Error('Forbidden production helper'); }; input.simulate = false; input.message({ event: 'keyboard', keyboard: true }); });
});
test.afterEach(async () => {
  if (application) { await application.evaluate(() => { globalThis.__release?.(); }).catch(() => {}); await application.close(); }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = panel = directory = null;
});
async function collect(body) {
  await application.evaluate(async (_electron, body) => {
    const hooks = globalThis.__pasteTest; globalThis.__stackVersion++;
    globalThis.__copyValue = body === null ? null : { type: 'text', body, title: body, preview: body, signature: globalThis.__signature(body) };
    hooks.stackInput.message({ event: 'clipboard', version: globalThis.__stackVersion }); await hooks.requestStackPoll();
  }, body);
}
async function command(count = 1) {
  await application.evaluate((_electron, count) => {
    const input = globalThis.__pasteTest.stackInput;
    const seq = input.received;
    for (let i = 1; i <= count; i++) input.message({ event: 'paste', epoch: input.epoch, seq: seq + i, target: { pid: 111, bundleId: 'test.stack.target', launchTime: 123 } });
  }, count);
}
const queued = () => panel.evaluate(() => window.paste.getStack()).then(value => value.entries.map(entry => entry.item.body));
test('copies automatically collect duplicate occurrences; own writes do not feed back; floating panel never requests focus', async () => {
  const window = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/stack.html'));
    return { focusable: window.isFocusable(), alwaysOnTop: window.isAlwaysOnTop(), visible: window.isVisible() };
  });
  expect(window).toEqual({ focusable: false, alwaysOnTop: true, visible: true }); expect(await queued()).toEqual([]);
  await collect('Alpha'); await collect('Alpha'); await collect('Beta'); await collect(null);
  expect(await queued()).toEqual(['Alpha', 'Alpha', 'Beta']);
  expect((await page.evaluate(() => window.paste.getLibrary())).items).toHaveLength(2);
  await command(); await expect.poll(queued).toEqual(['Alpha', 'Beta']);
  await application.evaluate(async () => { await globalThis.__pasteTest.poll(); }); expect(await queued()).toEqual(['Alpha', 'Beta']);
  expect(await application.evaluate(() => globalThis.__sent)).toHaveLength(1);
  await panel.screenshot({ path: 'test-results/stack-floating.png' });
});
test('rapid Command-V reservations survive reversal and consume distinct queue entries in acceptance order', async () => {
  for (const body of ['One', 'Two', 'Three']) await collect(body);
  await application.evaluate(() => { globalThis.__hold = true; }); await command(2);
  await expect.poll(() => application.evaluate(() => typeof globalThis.__release)).toBe('function');
  await panel.getByRole('button', { name: '反转顺序', exact: true }).click();
  await application.evaluate(() => globalThis.__release()); await expect.poll(queued).toEqual(['Three']);
  expect(await application.evaluate(() => globalThis.__writes)).toEqual(['One', 'Two']);
  await command(); await expect.poll(queued).toEqual([]);
});
test('failure preserves the head, cancels queued successors and permits an explicit retry', async () => {
  await collect('First'); await collect('Second');
  await application.evaluate(() => { globalThis.__writeFailure = true; }); await command(2);
  await expect(panel.getByRole('status')).toContainText('Injected Stack write failure');
  expect(await queued()).toEqual(['First', 'Second']); expect(await application.evaluate(() => globalThis.__writes)).toEqual(['First']);
  await application.evaluate(() => { globalThis.__writeFailure = false; }); await command(); await expect.poll(queued).toEqual(['Second']);
  await expect(panel.getByRole('status')).toBeHidden();
});
test('floating controls remove only one occurrence, reverse and stop without deleting history', async () => {
  await collect('Same'); await collect('Same'); await collect('Other');
  await panel.getByRole('button', { name: '移除第1项', exact: true }).click(); expect(await queued()).toEqual(['Same', 'Other']);
  await panel.getByRole('button', { name: '反转顺序', exact: true }).click(); expect(await queued()).toEqual(['Other', 'Same']);
  await panel.getByRole('button', { name: '粘贴下一项', exact: true }).click(); await expect.poll(queued).toEqual(['Same']);
  await panel.getByRole('button', { name: '结束 Stack 并清空队列', exact: true }).click();
  expect((await page.evaluate(() => window.paste.getLibrary())).status.stackMode).toBe(false);
  expect((await page.evaluate(() => window.paste.getLibrary())).items).toHaveLength(2);
  expect(await application.evaluate(() => globalThis.__pasteTest.stackInput.state.running)).toBe(false);
});
test('permission loss and copy-only settings are visible; repeated hotkeys never reset the queue', async () => {
  await collect('Keep'); await application.evaluate(async () => { await globalThis.__pasteTest.hotkeys.callbacks.stack(); }); expect(await queued()).toEqual(['Keep']);
  await application.evaluate(() => globalThis.__pasteTest.stackInput.message({ event: 'keyboard', keyboard: false, error: 'accessibility-required' }));
  await expect(panel.getByRole('status')).toContainText('需要辅助功能权限');
  await page.evaluate(() => window.paste.saveSettings({ pasteTarget: 'clipboard' })); await expect(panel.locator('#mode')).toHaveText('仅复制模式');
  expect(await application.evaluate(() => globalThis.__pasteTest.stackInput.inventory(globalThis.__pasteTest.stackInput.epoch))).toEqual({ count: 0, busy: false });
  await panel.getByRole('button', { name: '粘贴下一项', exact: true }).click(); await expect.poll(queued).toEqual([]); expect(await application.evaluate(() => globalThis.__sent)).toEqual([]);
});
test('paused, excluded and missed snapshots never silently masquerade as a complete captured queue', async () => {
  await page.evaluate(() => window.paste.saveSettings({ paused: true })); await collect('Private'); expect(await queued()).toEqual([]);
  await page.evaluate(() => window.paste.saveSettings({ paused: false })); await collect('Public'); expect(await queued()).toEqual(['Public']);
  await application.evaluate(() => { globalThis.__stackVersion += 2; }); await collect('Later'); await expect(panel.getByRole('status')).toContainText('可能有内容未收集');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/stack.html')).setSize(280, 230); });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: 'test-results/stack-compact-warning.png' });
});
test('background Stack delivery and failure do not close or overwrite an unsaved new-text draft', async () => {
  await collect('Deliver me');
  const opened = application.waitForEvent('window'); await page.evaluate(() => window.paste.newText('history')); const preview = await opened;
  await preview.waitForFunction(() => document.body.dataset.previewReady === 'true');
  const editor = preview.getByRole('textbox', { name: '剪贴板内容' }); await editor.fill('Unsaved draft must survive');
  await command(); await expect.poll(queued).toEqual([]); expect(preview.isClosed()).toBe(false); await expect(editor).toHaveText('Unsaved draft must survive');
  await collect('Failed delivery'); await application.evaluate(() => { globalThis.__pasteTest.pasteDelivery.activate = async () => ({ ok: false }); });
  await command(); await expect(panel.getByRole('status')).toContainText('目标应用不可用');
  expect(preview.isClosed()).toBe(false); await expect(editor).toHaveText('Unsaved draft must survive');
  expect((await page.evaluate(() => window.paste.getLibrary())).items).toHaveLength(2);
});
test('a floating paste resolves the actual current target, never falls back after failed lookup; long light-mode content stays bounded', async () => {
  await collect('LongWord'.repeat(200));
  await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; globalThis.__pasteTest.pasteTargets.read = async () => ({ pid: 222, bundleId: 'test.current.target', launchTime: 456 }); });
  await panel.getByRole('button', { name: '粘贴下一项', exact: true }).click(); await expect.poll(queued).toEqual([]);
  expect(await application.evaluate(() => globalThis.__sent.map(value => value.pid))).toEqual([222]);
  await collect('LongWord'.repeat(200));
  await application.evaluate(() => { globalThis.__pasteTest.pasteTargets.read = async () => null; });
  await panel.getByRole('button', { name: '粘贴下一项', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('未能确认目标应用'); expect(await queued()).toHaveLength(1);
  expect(await application.evaluate(() => globalThis.__sent)).toHaveLength(1);
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: 'test-results/stack-light-long.png' });
});
test('an unresolved floating paste cannot consume a replacement Stack after stop and restart', async () => {
  await collect('Old queue');
  await application.evaluate(() => { globalThis.__pasteTest.pasteTargets.read = () => new Promise(resolve => { globalThis.__resolveFront = resolve; }); });
  await panel.evaluate(() => { window.__pendingNext = window.paste.nextInStack(); });
  await expect.poll(() => application.evaluate(() => typeof globalThis.__resolveFront)).toBe('function');
  await application.evaluate(() => { globalThis.__pasteTest.stackInput.simulate = true; });
  await page.evaluate(async () => { await window.paste.toggleStack(); await window.paste.toggleStack(); });
  await application.evaluate(() => { const input = globalThis.__pasteTest.stackInput; input.simulate = false; input.message({ event: 'keyboard', keyboard: true }); });
  await collect('New queue');
  await application.evaluate(() => globalThis.__resolveFront({ pid: 111, bundleId: 'test.stack.target', launchTime: 123 }));
  expect(await panel.evaluate(() => window.__pendingNext)).toMatchObject({ ok: false });
  expect(await queued()).toEqual(['New queue']); expect(await application.evaluate(() => globalThis.__writes)).toEqual([]);
});
test('a floating click reserves its item and delivery preference before asynchronous foreground lookup', async () => {
  await collect('First clicked'); await collect('Second');
  await application.evaluate(() => { globalThis.__pasteTest.pasteTargets.read = () => new Promise(resolve => { globalThis.__resolveFront = resolve; }); });
  await panel.evaluate(() => { window.__pendingNext = window.paste.nextInStack(); });
  await expect.poll(() => application.evaluate(() => typeof globalThis.__resolveFront)).toBe('function');
  await panel.evaluate(() => window.paste.reverseStack());
  await page.evaluate(() => window.paste.saveSettings({ plainText: true }));
  await application.evaluate(() => globalThis.__resolveFront({ pid: 111, bundleId: 'test.stack.target', launchTime: 123 }));
  expect(await panel.evaluate(() => window.__pendingNext)).toMatchObject({ ok: true });
  expect(await application.evaluate(() => globalThis.__writes)).toEqual(['First clicked']); expect(await queued()).toEqual(['Second']);
  expect(await application.evaluate(() => globalThis.__plainWrites)).toEqual([false]);
});
