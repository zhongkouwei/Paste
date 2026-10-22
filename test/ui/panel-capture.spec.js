const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let application, page, directory;
test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-panel-capture-'));
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
  await application.evaluate(({ BrowserWindow }) => {
    const h = globalThis.__pasteTest;
    h.clip.read = () => { throw Error('Unexpected system clipboard read'); }; h.clip.write = () => { throw Error('Unexpected system clipboard write'); };
    globalThis.__front = { pid: 111, bundleId: 'test.panel.target', launchTime: 123, name: 'Target A' };
    globalThis.__captureVersion = 1; globalThis.__captureBody = 'Before opening'; globalThis.__reads = []; globalThis.__readGates = [];
    h.pasteTargets.read = async () => globalThis.__front;
    // Explicitly enable the production opening refresh with synthetic endpoints.
    // TEST_MODE otherwise leaves automatic clipboard capture disabled.
    h.pasteTargets.beforeReady = h.pollBeforeShow;
    globalThis.__productionSnapshot = h.monitor.readSnapshot;
    h.monitor.readVersion = async () => { if (globalThis.__countFailure) throw Error('Injected opening counter failure'); return globalThis.__captureVersion; };
    h.monitor.readSnapshot = async () => {
      const body = globalThis.__captureBody;
      globalThis.__reads.push({ body, visible: BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible() });
      if (globalThis.__holdRead) { globalThis.__holdRead = false; await new Promise(resolve => globalThis.__readGates.push(resolve)); }
      return { type: 'text', body, title: body, signature: h.textSignature(body), source: { name: 'Synthetic source', bundleId: 'test.panel.source' } };
    };
    h.store.add({ type: 'text', body: 'Older history', title: 'Older history' }); h.imageText.onChanged(); h.hidePanel();
  });
});
test.afterEach(async () => {
  if (application) { await application.evaluate(() => { for (const release of globalThis.__readGates || []) release(); }).catch(() => {}); await application.close(); }
  fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = null;
});
const visible = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible());
const items = () => page.evaluate(async () => (await window.paste.getLibrary()).items.map(item => item.title));
async function open() { return application.evaluate(() => globalThis.__pasteTest.hotkeys.callbacks.history()); }
test('copy then immediate invocation includes the fresh item before the panel is first presented', async () => {
  expect(await open()).toBe(true); await expect.poll(items).toEqual(['Before opening', 'Older history']);
  expect(await application.evaluate(() => globalThis.__reads)).toEqual([{ body: 'Before opening', visible: false }]);
  expect(await application.evaluate(() => globalThis.__pasteTest.pasteTargets.snapshot().pid)).toBe(111);
  await expect(page.locator('.clip-card').first()).toContainText('Before opening'); await page.screenshot({ path: 'test-results/panel-capture-fresh.png' });
});
test('an older in-flight read is drained and a fresh read runs before invocation completes', async () => {
  await application.evaluate(() => { globalThis.__holdRead = true; globalThis.__oldPoll = globalThis.__pasteTest.poll(); });
  await expect.poll(() => application.evaluate(() => globalThis.__readGates.length)).toBe(1);
  await application.evaluate(() => { globalThis.__captureVersion++; globalThis.__captureBody = 'Copied after old poll'; globalThis.__opening = globalThis.__pasteTest.hotkeys.callbacks.history(); });
  await expect.poll(() => application.evaluate(() => globalThis.__pasteTest.pasteTargets.pending)).toBe(true); expect(await visible()).toBe(false);
  await application.evaluate(() => globalThis.__readGates[0]()); expect(await application.evaluate(() => globalThis.__opening)).toBe(true);
  await expect.poll(items).toEqual(['Copied after old poll', 'Older history']); expect(await application.evaluate(() => globalThis.__reads.every(read => !read.visible))).toBe(true);
});
test('a second invocation cancels an opening while capture is pending and its late completion never reopens the panel', async () => {
  await application.evaluate(() => { globalThis.__holdRead = true; globalThis.__opening = globalThis.__pasteTest.hotkeys.callbacks.history(); });
  await expect.poll(() => application.evaluate(() => globalThis.__readGates.length)).toBe(1);
  expect(await visible()).toBe(false); await application.evaluate(() => globalThis.__pasteTest.hotkeys.callbacks.history());
  await application.evaluate(() => globalThis.__readGates[0]()); expect(await application.evaluate(() => globalThis.__opening)).toBe(false);
  expect(await visible()).toBe(false); expect(await application.evaluate(() => globalThis.__pasteTest.pasteTargets.snapshot())).toBe(null);
});
test('paused capture remains paused when opening and a resume baseline is never replayed into history', async () => {
  await page.evaluate(() => window.paste.pauseCapture(null)); expect(await open()).toBe(true); expect(await application.evaluate(() => globalThis.__reads)).toEqual([]);
  await application.evaluate(() => globalThis.__pasteTest.hidePanel()); await page.evaluate(() => window.paste.resumeCapture()); expect(await open()).toBe(true);
  expect(await application.evaluate(() => globalThis.__reads)).toEqual([]); expect(await items()).toEqual(['Older history']);
  await application.evaluate(() => { globalThis.__pasteTest.hidePanel(); globalThis.__captureVersion++; globalThis.__captureBody = 'New after resume'; });
  expect(await open()).toBe(true); await expect.poll(items).toEqual(['New after resume', 'Older history']);
});
for (const failure of ['counter', 'persist']) test(`${failure} failure preserves existing history and target, exposes the error and allows another invocation to retry`, async () => {
  await application.evaluate((_electron, failure) => {
    if (failure === 'counter') globalThis.__countFailure = true;
    else { const store = globalThis.__pasteTest.store; globalThis.__workingPersist = store.persist; store.persist = () => { throw Error('Injected opening persistence failure'); }; }
  }, failure);
  expect(await open()).toBe(true); expect(await items()).toEqual(['Older history']); await expect(page.locator('#status')).toContainText(failure === 'counter' ? 'counter failure' : 'persistence failure');
  expect(await application.evaluate(() => globalThis.__pasteTest.pasteTargets.snapshot().pid)).toBe(111);
  await application.evaluate(() => { const h = globalThis.__pasteTest; globalThis.__countFailure = false; if (globalThis.__workingPersist) h.store.persist = globalThis.__workingPersist; h.hidePanel(); });
  expect(await open()).toBe(true); await expect.poll(items).toEqual(['Before opening', 'Older history']);
});
test('reopening an already displayed panel preserves its target and does not read another payload', async () => {
  expect(await open()).toBe(true); await application.evaluate(() => { globalThis.__captureVersion++; globalThis.__captureBody = 'Not automatically read while retained'; });
  expect(await application.evaluate(() => globalThis.__pasteTest.showPanel())).toBe(true);
  expect(await application.evaluate(() => globalThis.__reads.length)).toBe(1); expect(await items()).toEqual(['Before opening', 'Older history']);
});
test('quick paste immediately after invocation uses the newly captured first card, not the previous history', async () => {
  await application.evaluate(() => { globalThis.__writes = []; const h = globalThis.__pasteTest; h.clip.write = async (item, options) => { globalThis.__writes.push({ body: item.body, plain: options.plain }); return h.textSignature(item.body); }; });
  expect(await open()).toBe(true); await page.keyboard.press('Meta+1');
  await expect.poll(() => application.evaluate(() => globalThis.__writes)).toEqual([{ body: 'Before opening', plain: false }]);
  expect(await items()).toEqual(['Before opening', 'Older history']);
});
test('cancelling while an old poll drains does not start an unnecessary new payload read', async () => {
  await application.evaluate(() => { globalThis.__holdRead = true; globalThis.__oldPoll = globalThis.__pasteTest.poll(); });
  await expect.poll(() => application.evaluate(() => globalThis.__readGates.length)).toBe(1);
  await application.evaluate(() => { globalThis.__captureVersion++; globalThis.__captureBody = 'Copy after cancelled opening'; globalThis.__opening = globalThis.__pasteTest.hotkeys.callbacks.history(); });
  await expect.poll(() => application.evaluate(() => globalThis.__pasteTest.pasteTargets.pending)).toBe(true);
  await application.evaluate(() => { globalThis.__pasteTest.hotkeys.callbacks.history(); globalThis.__readGates[0](); });
  expect(await application.evaluate(() => globalThis.__opening)).toBe(false); expect(await application.evaluate(() => globalThis.__reads.length)).toBe(1); expect(await visible()).toBe(false);
});
test('the target captured before a slow clipboard read cannot follow later foreground changes', async () => {
  await application.evaluate(() => { globalThis.__holdRead = true; globalThis.__opening = globalThis.__pasteTest.hotkeys.callbacks.history(); });
  await expect.poll(() => application.evaluate(() => globalThis.__readGates.length)).toBe(1);
  await application.evaluate(() => { globalThis.__front = { pid: 222, bundleId: 'test.panel.other', launchTime: 456, name: 'Target B' }; globalThis.__readGates[0](); });
  expect(await application.evaluate(() => globalThis.__opening)).toBe(true); expect(await application.evaluate(() => globalThis.__pasteTest.pasteTargets.snapshot().pid)).toBe(111);
  await page.locator('.clip-card').first().click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: '粘贴到 Target A', exact: true })).toBeVisible();
});
test('an unchanged clipboard during another invocation does not read payloads or rewrite history timestamps', async () => {
  expect(await open()).toBe(true); const before = await page.evaluate(() => window.paste.getLibrary());
  await application.evaluate(() => globalThis.__pasteTest.hidePanel()); expect(await open()).toBe(true);
  const after = await page.evaluate(() => window.paste.getLibrary()); expect(after.revision).toBe(before.revision); expect(after.items).toEqual(before.items);
  expect(await application.evaluate(() => globalThis.__reads.length)).toBe(1);
});
test('opening refresh uses the production confidential and transient format filters with synthetic clipboard data', async () => {
  await application.evaluate(() => {
    const h = globalThis.__pasteTest; h.monitor.readSnapshot = globalThis.__productionSnapshot;
    h.clip.read = async () => ({ formats: [globalThis.__privateFormat], files: [], text: 'Synthetic private content', signature: h.textSignature('Synthetic private content') });
  });
  for (const format of ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType']) {
    await application.evaluate((_electron, format) => { globalThis.__pasteTest.hidePanel(); globalThis.__captureVersion++; globalThis.__privateFormat = format; }, format);
    expect(await open()).toBe(true); expect(await items()).toEqual(['Older history']);
  }
});
test('an unresponsive clipboard provider cannot block old history and its late content is not backfilled', async () => {
  await application.evaluate(() => { globalThis.__holdRead = true; globalThis.__opening = globalThis.__pasteTest.hotkeys.callbacks.history(); });
  await expect.poll(visible, { timeout: 4000 }).toBe(true);
  await expect(page.locator('#status')).toContainText('读取未完成'); expect(await items()).toEqual(['Older history']);
  expect(await application.evaluate(() => globalThis.__opening)).toBe(true);
  await page.screenshot({ path: 'test-results/panel-capture-timeout.png' });
  await application.evaluate(() => globalThis.__readGates[0]()); await application.evaluate(async () => { const h = globalThis.__pasteTest; if (h.monitor.pending) await h.monitor.pending; await h.poll(); });
  expect(await items()).toEqual(['Older history']);
  await application.evaluate(() => { globalThis.__pasteTest.hidePanel(); globalThis.__captureVersion++; globalThis.__captureBody = 'New copy after provider recovered'; });
  expect(await open()).toBe(true); await expect.poll(items).toEqual(['New copy after provider recovered', 'Older history']);
});
