const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { ClipStore, textSignature } = require('../src/store');
const { exportFile } = require('../src/export-file');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-export-test-')), store = new ClipStore(directory);
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return store;
}
const destination = store => path.join(store.directory, 'backup.json');
const leftovers = store => fs.readdirSync(store.directory).filter(name => name.includes('.tmp-'));
function seed(store, count = 30) {
  const body = 'quoted" slash\\ 中文🧪\0\uD800\n'.repeat(3000), createdAt = new Date().toISOString();
  store.mutate(() => { store.data.settings.retentionDays = 0; store.data.items = Array.from({ length: count }, (_, n) => ({ id: String(n), type: 'text',
    body: `${body}${n}`, html: `<p>${body}${n}</p>`, rtf: `{\\rtf1 ${n}}`, title: `Synthetic ${n}`, preview: body.slice(0, 100), boardIds: [], createdAt,
    signature: textSignature(`${body}${n}`, `<p>${body}${n}</p>`, `{\\rtf1 ${n}}`) })); });
}
test('streamed backups exactly preserve empty and mixed libraries, Unicode, formats, OCR, image variants and null metadata', async t => {
  const store = fixture(t), file = destination(store); await store.exportTo(file); assert.deepEqual(JSON.parse(fs.readFileSync(file)), store.exportData());
  seed(store, 2);
  const current = crypto.randomBytes(65537), original = crypto.randomBytes(131071), foreground = crypto.randomBytes(65536);
  const image = store.add({ type: 'image', body: 'image', signature: 'pixels' });
  store.replaceImage(image.id, { buffer: current, original, foreground, turns: 1, size: { width: 1, height: 1 }, backgroundRemoved: true, signature: 'pixels' });
  store.setOCR(image.id, 'pixels', { status: 'ready', text: '识别'.repeat(10000), lines: [{ text: '识别', words: [] }] });
  const expected = store.exportData(); store.exportData = () => { throw new Error('Must not materialize the entire library'); };
  await store.exportTo(file); const actual = JSON.parse(fs.readFileSync(file)); assert.deepEqual(actual, expected);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.deepEqual(leftovers(store), []);
  const exported = actual.items.find(item => item.id === image.id);
  for (const [key, bytes] of [['body', current], ['originalBody', original], ['foregroundBody', foreground]]) assert.deepEqual(Buffer.from(exported[key].split(',')[1], 'base64'), bytes);
});
test('workers export a captured snapshot while the library changes and keep the main event loop available', async t => {
  const store = fixture(t); seed(store); const expected = store.exportData(), file = destination(store); let ticks = 0;
  const states = []; store.exportService.onChanged = state => states.push(state);
  store.get = () => { throw new Error('Export must not read original contents on the main thread'); };
  const timer = setInterval(() => ticks++, 1);
  try {
    const pending = store.exportTo(file); store.update('0', { title: 'Changed after capture' }); store.delete(['1']);
    await assert.rejects(store.exportTo(path.join(store.directory, 'duplicate.json')), /已有备份/); await pending;
  } finally { clearInterval(timer); }
  assert.ok(ticks > 0); assert.deepEqual(JSON.parse(fs.readFileSync(file)), expected); assert.equal(store.exportService.state().running, false);
  assert.ok(states.every((state, n) => !n || state.revision > states[n - 1].revision));
  assert.equal(store.exportService.state().revision, states.at(-1).revision);
});
test('active and pre-aborted cancellation preserve old exports, clean owned temporary files and allow a later successful retry', async t => {
  const store = fixture(t); seed(store, 60); const file = destination(store); fs.writeFileSync(file, 'Old export', { mode: 0o644 });
  const controller = new AbortController(); const pending = store.exportTo(file, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(fs.readFileSync(file, 'utf8'), 'Old export'); assert.deepEqual(leftovers(store), []);
  await assert.rejects(store.exportTo(file, { signal: controller.signal }), { name: 'AbortError' });
  await store.exportTo(file); assert.equal(JSON.parse(fs.readFileSync(file)).items.length, 60);
});
test('shutdown waits for cancellation and worker crashes clean only their owned temporary file', async t => {
  const store = fixture(t); seed(store, 60); const file = destination(store); fs.writeFileSync(file, 'Old export');
  const pending = store.exportTo(file), rejected = assert.rejects(pending, /进程已退出/);
  store.exportService.active.worker.on('message', message => { if (message.temporaryOwned) store.exportService.active?.worker.terminate(); });
  await rejected; assert.equal(fs.readFileSync(file, 'utf8'), 'Old export'); assert.deepEqual(leftovers(store), []);
  const next = store.exportTo(file), canceled = assert.rejects(next, { name: 'AbortError' }); await store.close(); await canceled;
  assert.equal(fs.readFileSync(file, 'utf8'), 'Old export'); assert.equal(store.exportService.active, null);
  await assert.rejects(store.exportTo(file), /已停止/); assert.deepEqual(leftovers(store), []);
});
test('missing or corrupt content and image files fail without replacing an older export or altering the source manifest', async t => {
  const store = fixture(t); seed(store, 2); const file = destination(store); fs.writeFileSync(file, 'Old export'); const before = fs.readFileSync(store.file);
  const content = path.join(store.contents.directory, store.data.items[0].contentAsset), raw = fs.readFileSync(content); fs.writeFileSync(content, 'corrupt');
  await assert.rejects(store.exportTo(file), /checksum/); fs.writeFileSync(content, raw);
  const name = store.putAsset(Buffer.from('image')), image = store.add({ type: 'image', body: name, asset: name }); const asset = path.join(store.directory, 'assets', name);
  fs.writeFileSync(asset, 'bad image'); await assert.rejects(store.exportTo(file), /checksum/);
  fs.unlinkSync(asset); await assert.rejects(store.exportTo(file), /ENOENT/);
  fs.symlinkSync(content, asset); await assert.rejects(store.exportTo(file), /regular file/);
  assert.equal(store.getMetadata(image.id).asset, name); assert.equal(fs.readFileSync(file, 'utf8'), 'Old export'); assert.deepEqual(leftovers(store), []);
  assert.deepEqual(JSON.parse(before).items, JSON.parse(fs.readFileSync(`${store.file}.bak`)).items);
});
test('internal library files and symlinked internal directories cannot be selected as export destinations', async t => {
  const store = fixture(t); seed(store, 1); const before = fs.readFileSync(store.file), alias = path.join(store.directory, 'alias'); fs.symlinkSync(store.contents.directory, alias);
  for (const file of [store.file, `${store.file}.bak`, path.join(store.directory, 'LIBRARY.JSON'), path.join(store.directory, 'library-v2-snapshot.json'), path.join(alias, 'backup.json'), path.join(store.directory, 'assets/output.json')]) {
    await assert.rejects(store.exportTo(file), /不能用导出/);
  }
  assert.deepEqual(fs.readFileSync(store.file), before); assert.deepEqual(leftovers(store), []);
});
test('write, file-sync and rename failures preserve old exports; post-rename directory-sync failure reports committed durability uncertainty', async t => {
  const store = fixture(t); seed(store, 1); const file = destination(store); fs.writeFileSync(file, 'Old export');
  const options = () => ({ directory: store.directory, data: store.data, file, temporary: path.join(store.directory, '.backup.tmp-injected') });
  for (const mode of ['write', 'sync', 'rename']) {
    const original = { write: fs.write, writev: fs.writev, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
    if (mode === 'write') for (const key of ['write', 'writev']) fs[key] = (...args) => queueMicrotask(() => args.at(-1)(new Error('Injected write failure')));
    if (mode === 'sync') fs.fsyncSync = () => { throw new Error('Injected sync failure'); };
    if (mode === 'rename') fs.renameSync = () => { throw new Error('Injected rename failure'); };
    try { await assert.rejects(exportFile(options()), /Injected/); } finally { Object.assign(fs, original); }
    assert.equal(fs.readFileSync(file, 'utf8'), 'Old export'); assert.deepEqual(leftovers(store), []);
  }
  const sync = fs.fsyncSync; fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('Injected directory sync failure'); return sync(fd); };
  try { const result = await exportFile(options()); assert.equal(result.ok, true); assert.match(result.warning, /已导出.*同步失败/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(JSON.parse(fs.readFileSync(file)).items.length, 1);
});
test('a preexisting temporary path is never deleted when exclusive creation fails', async t => {
  const store = fixture(t), file = destination(store), temporary = path.join(store.directory, '.backup.tmp-existing'); fs.writeFileSync(temporary, 'Unrelated sentinel');
  await assert.rejects(exportFile({ directory: store.directory, data: store.data, file, temporary }), /EEXIST/);
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'Unrelated sentinel');
  const random = crypto.randomUUID, collision = path.join(store.directory, '.backup.json.tmp-existing'); fs.writeFileSync(collision, 'Parent cleanup sentinel');
  crypto.randomUUID = () => 'existing';
  let pending; try { pending = store.exportTo(file); } finally { crypto.randomUUID = random; }
  await assert.rejects(pending, /EEXIST/); assert.equal(fs.readFileSync(collision, 'utf8'), 'Parent cleanup sentinel');
});
test('cancellation observed after the atomic commit cannot report that the old backup was preserved', async t => {
  const store = fixture(t); seed(store, 1); const file = destination(store), controller = new AbortController(), sync = fs.fsyncSync;
  fs.writeFileSync(file, 'Old export');
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) controller.abort(); return sync(fd); };
  try {
    const result = await exportFile({ directory: store.directory, data: store.data, file, signal: controller.signal, temporary: path.join(store.directory, '.backup.tmp-late-cancel') });
    assert.equal(result.ok, true); assert.equal(controller.signal.aborted, true); assert.equal(JSON.parse(fs.readFileSync(file)).items.length, 1);
  } finally { fs.fsyncSync = sync; }
});
