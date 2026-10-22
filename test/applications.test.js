const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApplicationCatalog, normalizeApplication, validApplicationID, captureSource } = require('../src/applications');
const app = (bundleId, extra = {}) => ({ bundleId, name: `Name ${bundleId}`, available: true, ...extra });
function icon(width = 64) { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(64, 20); return `data:image/png;base64,${b.toString('base64')}`; }
test('selected applications deduplicate stable bundle identities and cache display data without returning paths', async () => {
  let calls = 0; const catalog = new ApplicationCatalog(async request => { calls++; assert.equal(request.paths.length, 2); return { ok: true, applications: [app('sample.app', { icon: icon(), path: '/private/not-for-storage' }), app('sample.app', { icon: icon() })] }; });
  assert.deepEqual(await catalog.selected(['/Applications/Sample.app', '/Applications/Other.app']), ['sample.app']);
  const [value] = await catalog.metadata(['sample.app']); assert.equal(value.name, 'Name sample.app'); assert.equal(value.icon, icon()); assert.equal(value.path, undefined); assert.equal(calls, 1);
});
test('invalid selections or a partially invalid native reply never populate the catalog', async () => {
  let calls = 0; const catalog = new ApplicationCatalog(async () => { calls++; return { ok: true, applications: [app('valid.app'), app('../invalid')] }; });
  for (const input of [[], ['relative.app'], ['/a\0.app'], Array(33).fill('/Applications/Any.app'), [null]]) await assert.rejects(catalog.selected(input));
  assert.equal(calls, 0); await assert.rejects(catalog.selected(['/Applications/A.app', '/Applications/B.app'])); assert.equal(catalog.cache.size, 0);
  catalog.read = async () => ({ ok: false }); await assert.rejects(catalog.selected(['/Applications/A.app']), /有效/);
});
test('metadata resolves only missing identifiers, preserves request order and rejects mismatched native identities', async () => {
  const calls = [], catalog = new ApplicationCatalog(async request => { calls.push(request); return { ok: true, applications: request.identifiers.map(id => app(id)) }; });
  await catalog.metadata(['one.app']); assert.deepEqual((await catalog.metadata(['two.app', 'one.app', 'two.app'])).map(value => value.bundleId), ['two.app', 'one.app', 'two.app']);
  assert.deepEqual(calls, [{ identifiers: ['one.app'] }, { identifiers: ['two.app'] }]);
  catalog.read = async () => ({ ok: true, applications: [app('wrong.app')] }); await assert.rejects(catalog.metadata(['missing.app']), /不匹配/); assert.equal(catalog.cache.has('wrong.app'), false);
  await assert.rejects(catalog.metadata(['../invalid'])); await assert.rejects(catalog.metadata(Array(33).fill('one.app')));
});
test('LRU eviction cannot lose already cached members of a mixed batch and remains bounded', async () => {
  const catalog = new ApplicationCatalog(async request => ({ ok: true, applications: request.identifiers.map(id => app(id)) }));
  for (let n = 0; n < 128; n += 32) await catalog.metadata(Array.from({ length: 32 }, (_, i) => `app.${n + i}`));
  const ids = ['app.0', ...Array.from({ length: 31 }, (_, n) => `new.${n}`)];
  assert.deepEqual((await catalog.metadata(ids)).map(value => value.bundleId), ids); assert.equal(catalog.cache.size, 128);
});
test('an unavailable application can resolve on the next request instead of being negatively cached forever', async () => {
  let available = false; const catalog = new ApplicationCatalog(async request => ({ ok: true, applications: request.identifiers.map(id => app(id, { available })) }));
  assert.equal((await catalog.metadata(['later.app']))[0].available, false); available = true;
  assert.equal((await catalog.metadata(['later.app']))[0].available, true);
});
test('display metadata uses plain bounded names and raster icons, never external paths, SVGs or oversized images', () => {
  for (const value of ['https://example.test/icon.png', 'file:///private/icon.png', 'data:image/svg+xml;base64,PHN2Zy8+', icon(65), 'data:image/png;base64,bm90cG5n']) {
    assert.equal(normalizeApplication(app('sample.app', { icon: value })).icon, undefined);
  }
  assert.equal(normalizeApplication(app('sample.app', { name: 'x'.repeat(1001) })).name, 'sample.app');
  assert.equal(normalizeApplication(app('sample.app', { name: '<b>Literal name</b>' })).name, '<b>Literal name</b>');
  for (const value of ['sample.app', 'app-with-dash', 'legacy_id.42']) assert.equal(validApplicationID(value), true);
  for (const value of ['', '../app', 'has spaces', 'a'.repeat(201), null]) assert.equal(validApplicationID(value), false);
});
test('new captures always resolve fresh foreground identity even for copies within the old 800ms cache interval', async () => {
  let calls = 0; const sources = [{ pid: 11, bundleId: 'allowed.app', name: 'Allowed' }, { pid: 12, bundleId: 'private.app', name: 'Excluded' }];
  const read = async () => sources[calls++];
  assert.equal((await captureSource(read, 42)).bundleId, 'allowed.app'); assert.equal((await captureSource(read, 42)).bundleId, 'private.app'); assert.equal(calls, 2);
});
test('own, invalid and unavailable foreground identity cannot inherit the previous app, and native failures remain failures', async () => {
  for (const value of [{ pid: 42, bundleId: 'our.app' }, { pid: 10, bundleId: 'com.zhongkouwei.pastelike' }, {}, { pid: 3 }, null]) assert.equal(await captureSource(async () => value, 42), null);
  await assert.rejects(captureSource(async () => { throw new Error('native source failed'); }, 42), /native source failed/);
});
