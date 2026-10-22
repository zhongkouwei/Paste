const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, directory, ids;
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-target-ui-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  ids = await application.evaluate(async () => {
    const hooks = globalThis.__pasteTest;
    globalThis.__front = { pid: 111, bundleId: 'test.target.A', launchTime: 1.234, name: 'Target A' };
    globalThis.__writes = []; globalThis.__sent = []; globalThis.__permissionReads = 0;
    // Only adapters are synthetic; the real main-process queue, context and delivery path run.
    hooks.clip.read = () => { throw Error('Unexpected system clipboard read'); };
    hooks.clip.write = async (item, options) => {
      globalThis.__writes.push({ id: item.id, plain: options.plain });
      if (globalThis.__holdWrite) { globalThis.__holdWrite = false; await new Promise(resolve => { globalThis.__releaseWrite = resolve; }); }
      return `synthetic:${item.id}`;
    };
    hooks.pasteTargets.read = async () => globalThis.__front;
    hooks.pasteDelivery.simulate = false;
    hooks.pasteDelivery.permission = async () => {
      globalThis.__permissionReads += 1;
      if (globalThis.__holdPermission) return new Promise(resolve => { globalThis.__releasePermission = () => resolve({ accessibility: true }); });
      return { accessibility: true };
    };
    hooks.pasteDelivery.activate = async target => { globalThis.__sent.push(target); return { ok: true }; };
    const ids = ['Alpha', 'Beta'].map(name => hooks.store.add({ type: 'text', body: `${name} target fixture`, title: name }).id);
    hooks.imageText.onChanged(); await hooks.showPanel(); return ids;
  });
});
test.afterEach(async () => {
  if (application) { await application.evaluate(() => { globalThis.__releaseWrite?.(); globalThis.__releasePermission?.(); }).catch(() => {}); await application.close(); }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = ids = null;
});
const sent = () => application.evaluate(() => globalThis.__sent.map(target => ({ pid: target.pid, bundleId: target.bundleId, launchTime: target.launchTime })));
async function targetB() { await application.evaluate(async () => { globalThis.__front = { pid: 222, bundleId: 'test.target.B', launchTime: 2.345, name: 'Target B' }; await globalThis.__pasteTest.pasteTargets.refresh(); }); }

test('queued copies retain their requested targets and settings rather than following later global state', async () => {
  await application.evaluate(() => { globalThis.__holdWrite = true; });
  await page.evaluate(id => { window.__first = window.paste.copy(id, { paste: true }); }, ids[0]);
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releaseWrite)).toBe('function'); await targetB();
  await page.evaluate(id => { window.__second = window.paste.copy(id, { paste: true }); }, ids[1]);
  await page.evaluate(() => window.paste.saveSettings({ plainText: true, pasteTarget: 'clipboard' }));
  await application.evaluate(() => globalThis.__releaseWrite());
  expect(await page.evaluate(() => Promise.all([window.__first, window.__second]))).toEqual([{ ok: true, copied: true }, { ok: true, copied: true }]);
  expect(await sent()).toEqual([{ pid: 111, bundleId: 'test.target.A', launchTime: 1.234 }, { pid: 222, bundleId: 'test.target.B', launchTime: 2.345 }]);
  expect(await application.evaluate(() => globalThis.__writes.map(value => value.plain))).toEqual([false, false]);
  await page.evaluate(id => window.paste.copy(id, { paste: true }), ids[0]);
  expect(await application.evaluate(() => globalThis.__writes.map(value => value.plain))).toEqual([false, false, true]); expect(await sent()).toHaveLength(2);
});
test('an application switch during permission lookup cannot redirect a paste to the newly captured target', async () => {
  await application.evaluate(() => { globalThis.__holdPermission = true; });
  await page.evaluate(id => { window.__copy = window.paste.copy(id, { paste: true }); }, ids[0]);
  await expect.poll(() => application.evaluate(() => typeof globalThis.__releasePermission)).toBe('function'); await targetB();
  await application.evaluate(() => globalThis.__releasePermission()); expect(await page.evaluate(() => window.__copy)).toMatchObject({ ok: true });
  expect(await sent()).toEqual([{ pid: 111, bundleId: 'test.target.A', launchTime: 1.234 }]);
});
test('a pending repeat open preserves the still-displayed target until a new result is committed', async () => {
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest; hooks.pasteTargets.read = () => new Promise(resolve => { globalThis.__repeatFront = resolve; });
    globalThis.__repeatOpen = hooks.showPanel();
  });
  await page.locator(`.clip-card[data-id="${ids[0]}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '粘贴到 Target A', exact: true }).click();
  await expect.poll(sent).toEqual([{ pid: 111, bundleId: 'test.target.A', launchTime: 1.234 }]);
  await application.evaluate(() => globalThis.__repeatFront({ pid: 222, bundleId: 'test.target.B', launchTime: 2.345, name: 'Target B' }));
  expect(await application.evaluate(() => globalThis.__repeatOpen)).toBe(false);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
});
test('a failed foreground lookup clears the old destination and keeps copy-only fallback visible', async () => {
  await application.evaluate(async () => { const hooks = globalThis.__pasteTest; hooks.pasteTargets.read = async () => { throw Error('Injected foreground failure'); }; await hooks.showPanel(); });
  await page.locator(`.clip-card[data-id="${ids[0]}"]`).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '粘贴到当前应用', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '粘贴到当前应用', exact: true }).click(); await expect(page.locator('#status')).toContainText('未能确认目标应用');
  expect(await sent()).toEqual([]); expect(await application.evaluate(() => globalThis.__permissionReads)).toBe(0);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
});
test('late foreground replies neither replace the newer panel target nor reopen a panel cancelled by its hotkey', async () => {
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest; hooks.hidePanel(); globalThis.__frontJobs = [];
    hooks.pasteTargets.read = () => new Promise(resolve => globalThis.__frontJobs.push(resolve));
    globalThis.__firstOpen = hooks.showPanel(); globalThis.__secondOpen = hooks.showPanel();
  });
  await application.evaluate(() => globalThis.__frontJobs[1]({ pid: 222, bundleId: 'test.target.B', launchTime: 2.345, name: 'Target B' }));
  expect(await application.evaluate(() => globalThis.__secondOpen)).toBe(true);
  await application.evaluate(() => globalThis.__frontJobs[0]({ pid: 111, bundleId: 'test.target.A', launchTime: 1.234, name: 'Target A' }));
  expect(await application.evaluate(() => globalThis.__firstOpen)).toBe(false);
  expect(await application.evaluate(() => globalThis.__pasteTest.pasteTargets.snapshot().pid)).toBe(222);
  await application.evaluate(({ app }) => {
    const hooks = globalThis.__pasteTest; hooks.hidePanel(); globalThis.__cancelledOpen = hooks.hotkeys.callbacks.history();
    app.emit('activate'); hooks.hotkeys.callbacks.history();
    globalThis.__frontJobs[2]({ pid: 111, bundleId: 'test.target.A', launchTime: 1.234, name: 'Target A' });
  });
  expect(await application.evaluate(() => globalThis.__cancelledOpen)).toBe(false);
  expect(await application.evaluate(({ BrowserWindow }) => ({ visible: BrowserWindow.getAllWindows()[0].isVisible(), target: globalThis.__pasteTest.pasteTargets.snapshot(), reads: globalThis.__frontJobs.length }))).toEqual({ visible: false, target: null, reads: 3 });
});
test('permission and native helper failures keep the Stack head, expose copied status and allow retry', async () => {
  await page.evaluate(async ids => { await window.paste.toggleStack(); for (const id of ids) await window.paste.addToStack(id); }, ids);
  await application.evaluate(() => { globalThis.__pasteTest.pasteDelivery.permission = async () => ({ accessibility: false }); });
  await page.locator('#stackButton').click(); await expect(page.locator('#status')).toContainText('授权辅助功能'); await expect(page.locator('#stackCount')).toHaveText('2');
  await page.screenshot({ path: 'test-results/paste-target-permission.png' });
  await application.evaluate(() => { globalThis.__pasteTest.pasteDelivery.permission = async () => { throw Error('Injected permission helper failure'); }; });
  expect(await page.evaluate(() => window.paste.nextInStack())).toMatchObject({ ok: false, copied: true, error: '内容已复制。无法检查辅助功能权限，请手动粘贴或重试。' });
  await application.evaluate(() => {
    const delivery = globalThis.__pasteTest.pasteDelivery; delivery.permission = async () => ({ accessibility: true });
    delivery.activate = async target => { globalThis.__sent.push(target); throw Error('Injected native paste failure'); };
  });
  expect(await page.evaluate(() => window.paste.nextInStack())).toMatchObject({ ok: false, copied: true }); await expect(page.locator('#stackCount')).toHaveText('2');
  await application.evaluate(() => { globalThis.__pasteTest.pasteDelivery.activate = async target => { globalThis.__sent.push(target); return { ok: true }; }; });
  expect(await page.evaluate(() => window.paste.nextInStack())).toMatchObject({ ok: true }); await expect(page.locator('#stackCount')).toHaveText('1');
  expect(await application.evaluate(() => globalThis.__writes.map(value => value.id))).toEqual(Array(4).fill(ids[0]));
});
