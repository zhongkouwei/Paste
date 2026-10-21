const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClipStore } = require('../src/store');
const { MediaReferences, MediaService, thumbnail } = require('../src/media');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-media-'));
  const store = new ClipStore(directory); t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return store;
}
function nativeFixture() {
  const calls = [];
  return { calls, createFromDataURL: raw => {
    calls.push(raw);
    return { isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }), resize: options => { calls.push(options); return { toDataURL: () => png }; } };
  } };
}
test('catalog snapshots contain stable media references, never image bytes or duplicate source icons', t => {
  const store = fixture(t), asset = store.putAsset(Buffer.from(png.split(',')[1], 'base64'));
  const item = store.add({ type: 'image', body: asset, asset, preview: png, source: { name: 'Synthetic', bundleId: 'test.source', color: '#ef6259', icon: png } });
  const text = store.add({ type: 'text', body: 'Readable text', source: item.source });
  const first = store.snapshot(), image = first.items.find(value => value.id === item.id);
  assert.equal(image.preview, ''); assert.equal(image.body, ''); assert.equal(image.asset, undefined); assert.equal(image.source.icon, undefined);
  assert.match(image.previewKey, /^image:[a-f0-9]{64}$/); assert.match(image.source.iconKey, /^icon:[a-f0-9]{64}$/);
  assert.equal(first.items.find(value => value.id === text.id).source.iconKey, image.source.iconKey);
  assert.equal(JSON.stringify(first).includes('base64,'), false); assert.equal(store.get(item.id).preview, png);
  const before = store.media.get(item); store.update(item.id, { title: 'New title' });
  assert.equal(store.media.get(store.get(item.id)), before); assert.equal(store.snapshot().items.find(value => value.id === item.id).previewKey, image.previewKey);
  assert.equal(store.exportData().items.find(value => value.id === item.id).body, png);
  store.delete([item.id]); assert.equal(store.media.items.has(item.id), false);
});
test('references change with image and icon bytes, not title, board membership or Bundle ID', () => {
  const media = new MediaReferences(), item = { id: 'a', type: 'image', preview: png, source: { icon: png } }, before = media.get(item);
  assert.equal(media.get({ ...item, title: 'Changed', boardIds: ['work'], source: { ...item.source, bundleId: 'new' } }), before);
  const next = media.get({ ...item, preview: `${png}AA` }); assert.notEqual(next.previewKey, before.previewKey); assert.equal(next.iconKey, before.iconKey);
  assert.equal(media.get({ ...item, type: 'text' }).previewKey, ''); media.retain(new Set()); assert.equal(media.items.size, 0);
});
test('media requests decode only demanded assets, deduplicate keys and cache bounded results', t => {
  const store = fixture(t), image = store.add({ type: 'image', body: 'image', preview: png, source: { icon: png } }), native = nativeFixture();
  const service = new MediaService(store, native), { previewKey, iconKey } = store.media.get(image);
  assert.equal(native.calls.length, 0); assert.deepEqual(service.read([{ id: image.id, previewKey }, { id: image.id, previewKey, iconKey }]), [{ key: previewKey, value: png }, { key: iconKey, value: png }]);
  assert.equal(native.calls.length, 4); service.read([{ id: image.id, previewKey, iconKey }]); assert.equal(native.calls.length, 4);
  assert.deepEqual(native.calls.filter(value => typeof value === 'object').map(({ width, height }) => ({ width, height })), [{ width: 480, height: 320 }, { width: 128, height: 85 }]);
  const bounded = new MediaService(store, native, { maxEntries: 1, maxBytes: png.length }); bounded.read([{ id: image.id, previewKey, iconKey }]);
  assert.equal(bounded.cache.size, 1); assert.equal(bounded.bytes, png.length); assert.equal(bounded.cache.has(iconKey), true);
});
test('removed or replaced item requests cannot return stale pixels or decode an arbitrary path', t => {
  const store = fixture(t), image = store.add({ type: 'image', body: 'image', preview: png }), native = nativeFixture(), service = new MediaService(store, native);
  const { previewKey } = store.media.get(image);
  store.mutate(() => { store.edit(image.id).preview = `${png}AA`; });
  assert.deepEqual(service.read([{ id: image.id, previewKey }]), []); assert.equal(native.calls.length, 0);
  store.delete([image.id]); assert.deepEqual(service.read([{ id: image.id, previewKey }]), []);
  for (const requests of [null, Array(33).fill({ id: 'a' }), [{ id: 1 }], [{ id: 'a', previewKey: '../../secret' }]]) assert.throws(() => service.read(requests), /Invalid media selection/);
});
test('corrupt, huge or non-raster preview data fails without reading assets or mutating history', t => {
  const store = fixture(t), native = nativeFixture(), service = new MediaService(store, native);
  for (const raw of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,YmFk', `data:image/png;base64,${'A'.repeat(64 * 1024 * 1024)}`]) {
    const item = store.add({ type: 'image', body: `image ${raw.length}`, preview: raw }), { previewKey } = store.media.get(item);
    assert.deepEqual(service.read([{ id: item.id, previewKey }]), [{ key: previewKey, value: '' }]); assert.equal(store.get(item.id).preview, raw);
  }
  assert.equal(native.calls.length, 0);
});
test('thumbnail bounds both axes, preserves aspect ratio and never upscales the original', () => {
  for (const [width, height, expected] of [[80, 3200, [12, 480]], [3200, 80, [480, 12]], [12, 6, [12, 6]]]) {
    let resized;
    const result = thumbnail({ isEmpty: () => false, getSize: () => ({ width, height }), resize: options => { resized = options; return { toDataURL: () => png }; } });
    assert.equal(result, png); assert.deepEqual([resized.width, resized.height], expected);
  }
  assert.throws(() => thumbnail({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }), /不可用/);
});
