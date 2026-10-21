const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
let application, page, directory;
async function launch() {
  const packaged = process.env.PASTE_TEST_PACKAGED === '1';
  application = await electron.launch({ colorScheme: null,
    executablePath: packaged ? path.resolve(__dirname, '../../release/mac-arm64/Paste Easy.app/Contents/MacOS/Paste Easy') : undefined,
    args: [...(packaged ? [] : [path.resolve(__dirname, '../..')]), '--test-mode', '--show'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PASTE_DATA_DIR: directory } });
  page = await application.firstWindow(); await page.waitForFunction(() => document.body.dataset.panelReady === 'true');
}
// Synthetic profile contents only; no system clipboard access or original Paste data.
test.beforeEach(async () => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-index-cache-')); await launch(); });
test.afterEach(async () => { if (application) await application.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); application = page = directory = null; });
async function seed() {
  await application.evaluate(() => {
    const hooks = globalThis.__pasteTest, createdAt = new Date().toISOString();
    hooks.store.mutate(() => {
      hooks.store.data.settings.retentionDays = 0;
      hooks.store.data.items = Array.from({ length: 80 }, (_, n) => {
        const body = 'abc剪贴板Text '.repeat(2000) + ` unique-tail-${n}-end`;
        return { id: String(n), type: 'text', body, preview: body.slice(0, 2000), title: `Synthetic ${n}`, createdAt,
          signature: hooks.hash(`text:${body}\nhtml:\nrtf:`), boardIds: [] };
      });
    }); hooks.imageText.onChanged();
  });
  expect((await page.evaluate(() => window.paste.search('unique-tail-79-end'))).ids).toEqual(['79']);
}
const stats = () => application.evaluate(() => globalThis.__pasteTest.searchService.diagnostics());
test('full-tail search reuses private persisted rows after a real Electron restart without rewriting the original library', async () => {
  await seed(); const before = fs.readFileSync(path.join(directory, 'library.json'));
  expect((await stats()).written).toBe(80); await application.close(); await launch();
  expect((await page.evaluate(() => window.paste.search('unique-tail-79-end'))).ids).toEqual(['79']);
  const value = await stats(); expect(value.mode).toBe('disk'); expect(value.written).toBe(0); expect(value.reused).toBe(80); expect(value.pageCacheKiB).toBe(8192);
  expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
  expect((await page.evaluate(() => window.paste.getItem('79'))).body.endsWith('unique-tail-79-end')).toBe(true);
  const folder = path.join(directory, 'search-cache'); expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
  for (const file of fs.readdirSync(folder)) expect(fs.statSync(path.join(folder, file)).mode & 0o777).toBe(0o600);
});
test('a damaged derived database rebuilds during the next real app search, leaving the authoritative manifest intact', async () => {
  await seed(); const before = fs.readFileSync(path.join(directory, 'library.json')); await application.close();
  fs.writeFileSync(path.join(directory, 'search-cache/index.sqlite'), 'Synthetic damaged cache'); await launch();
  expect((await page.evaluate(() => window.paste.search('unique-tail-79-end'))).ids).toEqual(['79']);
  const value = await stats(); expect(value.mode).toBe('disk'); expect(value.recovered).toBe(true); expect(value.written).toBe(80);
  expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
});
test('consistent but incorrect cached text cannot override authoritative originals after restart', async () => {
  await seed(); const before = fs.readFileSync(path.join(directory, 'library.json')); await application.close();
  const db = new DatabaseSync(path.join(directory, 'search-cache/index.sqlite'));
  db.prepare('UPDATE docs SET text=? WHERE id=?').run('Wrong cached text', '79'); db.close(); await launch();
  expect((await page.evaluate(() => window.paste.search('unique-tail-79-end'))).ids).toEqual(['79']);
  expect((await page.evaluate(() => window.paste.search('wrong cached text'))).ids).toEqual([]);
  const value = await stats(); expect(value.written).toBe(1); expect(value.reused).toBe(79);
  expect(fs.readFileSync(path.join(directory, 'library.json'))).toEqual(before);
});
test('source changes made after the last search reconcile persisted rows on restart rather than reviving old matches', async () => {
  await seed();
  await application.evaluate(() => {
    const store = globalThis.__pasteTest.store; store.delete(['79']); store.update('78', { body: 'Replacement searchable body', title: 'Renamed' });
  });
  await application.close(); await launch();
  expect((await page.evaluate(() => window.paste.search('unique-tail-79-end'))).ids).toEqual([]);
  expect((await page.evaluate(() => window.paste.search('unique-tail-78-end'))).ids).toEqual([]);
  expect((await page.evaluate(() => window.paste.search('replacement searchable renamed'))).ids).toEqual(['78']);
  const value = await stats(); expect(value.deleted).toBe(1); expect(value.written).toBe(1); expect(value.reused).toBe(78);
});
test('an incompatible cache falls back to working search without overwriting the newer cache file', async () => {
  await seed(); await application.close();
  const file = path.join(directory, 'search-cache/index.sqlite'), db = new DatabaseSync(file); db.exec('PRAGMA user_version=999'); db.close();
  const before = fs.readFileSync(file); await launch();
  expect((await page.evaluate(() => window.paste.search('unique-tail-79-end'))).ids).toEqual(['79']);
  const value = await stats(); expect(value.mode).toBe('memory'); expect(value.warning).toContain('版本'); expect(fs.readFileSync(file)).toEqual(before);
});
