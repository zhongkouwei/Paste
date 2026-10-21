const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ClipStore } = require('../src/store');
const { Transfers, fileDetails } = require('../src/transfers');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-transfers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ClipStore(directory);
  return { store, transfers: new Transfers(store), directory };
}
test('native file transfer preserves all existing paths and reports missing files', t => {
  const { transfers, directory } = setup(t);
  const files = ['first.txt', 'space name.txt'].map(name => path.join(directory, name));
  for (const file of files) fs.writeFileSync(file, 'content');
  const item = { type: 'file', body: files.map(file => pathToFileURL(file).href).join('\n') };
  assert.deepEqual(transfers.files(item), files); assert.deepEqual(transfers.sharingItem(item).filePaths, files);
  fs.unlinkSync(files[1]); assert.equal(fileDetails(item)[1].exists, false);
  assert.throws(() => transfers.files(item), /移动或删除/);
});
test('file URLs cannot turn remote hosts or non-file protocols into local filesystem paths', t => {
  const { transfers } = setup(t);
  for (const body of ['https://example.com', 'file://remote.example/path']) assert.throws(() => transfers.files({ type: 'file', body }));
});
test('image drag and sharing export the full original asset with private permissions', t => {
  const { store, transfers } = setup(t), original = Buffer.alloc(12000, 42);
  const asset = store.putAsset(original);
  const [file] = transfers.files({ type: 'image', asset, renamed: true, title: '../../Artwork' });
  assert.deepEqual(fs.readFileSync(file), original); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(file.startsWith(`${transfers.directory}${path.sep}`));
});
test('native sharing uses URL, text and file payloads without interpreting text as markup', t => {
  const { transfers } = setup(t);
  assert.deepEqual(transfers.sharingItem({ type: 'link', body: 'https://example.com/a' }), { urls: ['https://example.com/a'] });
  assert.deepEqual(transfers.sharingItem({ type: 'text', body: '<script>literal</script>' }), { texts: ['<script>literal</script>'] });
});
