const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ClipStore } = require('../src/store');
const { copySource, verifyCopySources } = require('../src/copy-sources');

test('copy references bind payload identity and type rather than mutable store objects or unrelated metadata', () => {
  const item = { id: 'A', type: 'text', signature: 'original', title: 'Old name' }, reference = copySource(item);
  const store = { getMetadata: () => item, get: () => { throw Error('No text payload read needed'); } };
  assert.ok(Object.isFrozen(reference)); item.title = 'New name'; item.boardIds = ['board']; item.ocr = { text: 'derived' };
  verifyCopySources(store, [reference]);
  item.signature = 'edited'; assert.throws(() => verifyCopySources(store, [reference]), /改变或删除/);
  item.signature = 'original'; item.type = 'file'; assert.throws(() => verifyCopySources(store, [reference]), /改变或删除/);
  assert.throws(() => verifyCopySources({ getMetadata: () => undefined }, [reference]), /改变或删除/);
});
test('image copies bind the original asset even when an encoded replacement has the same pixel signature', () => {
  const image = { id: 'I', type: 'image', signature: 'same-pixels', asset: 'original.png' }, reference = copySource(image);
  const store = { getMetadata: () => image };
  image.ocr = { text: 'recognized later' }; verifyCopySources(store, [reference]);
  image.asset = 'reencoded.png'; assert.throws(() => verifyCopySources(store, [reference]), /改变或删除/);
});
test('real store edits invalidate copy references while labels, pinning and settings leave payload identity valid', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-copy-sources-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ClipStore(directory), item = store.add({ type: 'text', body: 'Original', title: 'Original' }), reference = copySource(item);
  const board = store.saveBoard({ name: 'Pinned', color: '#62c68d' });
  store.update(item.id, { title: 'Renamed' }); store.pinItems([item.id], board.id); store.settings({ plainText: true });
  verifyCopySources(store, [reference]);
  store.update(item.id, { body: 'Changed' }); assert.throws(() => verifyCopySources(store, [reference]), /改变或删除/);
});
test('file verification rechecks every current path, including later missing members and empty groups', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-copy-files-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ClipStore(directory), paths = [store.file, `${store.file}.bak`];
  const item = store.add({ type: 'file', body: paths.map(file => pathToFileURL(file).href).join('\n'), title: 'Two files' }), reference = copySource(item);
  verifyCopySources(store, [reference]); fs.unlinkSync(paths[1]);
  assert.throws(() => verifyCopySources(store, [reference]), /移动或删除/);
  const empty = { id: 'E', type: 'file', signature: 'empty', body: '' };
  assert.throws(() => verifyCopySources({ getMetadata: () => empty, get: () => empty }, [copySource(empty)]), /移动或删除/);
});
