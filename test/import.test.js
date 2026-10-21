const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ClipStore, textSignature, hash } = require('../src/store');
const { ImportService } = require('../src/import-service');
const { parseBackup } = require('../src/import-parse');
const { planImport } = require('../src/import-plan');
const { destination } = require('../src/export-file');
const date = '2026-10-22T00:00:00.000Z';
const item = (id, body = id, extras = {}) => ({ id, body, type: 'text', signature: textSignature(body), title: id, boardIds: [], createdAt: date, ...extras });
function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-import-test-')), store = new ClipStore(directory), service = new ImportService(store, options);
  const file = path.join(directory, 'input.json');
  const write = data => { fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); return file; };
  t.after(async () => { await service.close(); await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, file, write };
}
test('stream parser preserves chunked Unicode, escaped lone surrogates and legacy arrays', async t => {
  const f = fixture(t), body = '汉🧪\0\uD800"\\\n'.repeat(18000), values = [];
  const header = await parseBackup(f.write({ version: 2, items: [item('a', body), item('b')], boards: [], settings: { paused: true } }), value => values.push(value));
  assert.equal(values[0].body, body); assert.equal(values.length, 2); assert.equal(header.settings.paused, true);
  const legacy = []; await parseBackup(f.write([item('a')]), value => legacy.push(value)); assert.equal(legacy[0].id, 'a');
});
test('invalid JSON structures, duplicate/prototype keys and future versions are rejected before any manifest mutation', async t => {
  const f = fixture(t); f.store.add({ type: 'text', body: 'untouched' }); const before = fs.readFileSync(f.store.file);
  for (const raw of ['', '{}', '{"version":3,"items":[]}', '{"version":2,"items":null}', '{"version":2,"items":[],"settings":[]}',
    '{"version":2,"items":[],"boards":null}', '{"version":2,"version":2,"items":[]}', '{"version":2,"items":[{"__proto__":{}}]}',
    '{"version":2,"items":[],"unknown":1}', '{"version":2,"items":[', '{"version":2,"items":[]}{}', '{"version":1e400,"items":[]}']) {
    await assert.rejects(f.service.prepare(f.write(raw)), undefined, raw); assert.deepEqual(fs.readFileSync(f.store.file), before);
    assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('import-')), false);
  }
});
test('streaming limits check partial tokens, depth, item bytes and file size', async t => {
  const f = fixture(t), file = f.write({ version: 2, items: [item('a', 'x'.repeat(200000))] });
  await assert.rejects(parseBackup(file, () => {}, { maxString: 1000 }), /字段过大/);
  await assert.rejects(parseBackup(file, () => {}, { maxItemBytes: 1000 }), /项目过大/);
  await assert.rejects(parseBackup(file, () => {}, { maxBytes: 10 }), /8 GiB/);
  await assert.rejects(parseBackup(f.write('{"version":2,"items":[' + '['.repeat(65) + '0' + ']'.repeat(65) + ']}'), () => {}), /嵌套/);
  fs.writeFileSync(file, Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])); await assert.rejects(parseBackup(file, () => {}));
  await assert.rejects(parseBackup(f.write('{"version":2,"items":[],"settings":{"maxItems":1e' + '0'.repeat(200000) + '1}}'), () => {}), /标记过大/);
});
test('external file references, malformed records, board references and invalid settings fail closed', async t => {
  const f = fixture(t);
  const invalid = [item('a', 'x', { contentAsset: `${'a'.repeat(64)}.json` }), item('a', 'x', { asset: '../secret.png' }), item('a', 'x', { createdAt: 'bad' }),
    item('a', 'x', { boardIds: ['missing'] }), item('a', 'x', { source: { icon: 'https://private.invalid/icon' } }), item('a', 'x', { source: 'bad' }),
    item('a', 'x', { isFavorite: 'true' }), item('a', 'x', { originalBody: 'hidden' }), item('a', 'x', { html: {} })];
  for (const value of invalid) await assert.rejects(f.service.prepare(f.write({ version: 2, items: [value] })));
  await assert.rejects(f.service.prepare(f.write({ version: 2, items: [item('a'), item('a')] })), /ID/);
  await assert.rejects(f.service.prepare(f.write({ version: 2, items: [], settings: { maxItems: 1 } })), /设置/);
  await assert.rejects(f.service.prepare(f.write({ version: 2, items: [], boards: [{ id: 'b', name: 'Board', color: '#ef6259', itemOrder: ['missing'] }] })), /排序/);
  assert.equal(fs.existsSync(f.store.file), false);
});
test('merge resolves content and ID collisions without overwriting current names or board order', () => {
  const current = { version: 3, settings: { paused: true }, items: [item('a', 'same', { title: 'User name', renamed: true, boardIds: ['b'] }), item('collision')],
    boards: [{ id: 'b', name: 'Existing', color: '#ef6259', itemOrder: ['a'] }] };
  const incoming = { version: 3, settings: { paused: false }, items: [item('duplicate', 'same', { boardIds: ['b'] }), item('collision', 'different', { boardIds: ['b'] })],
    boards: [{ id: 'b', name: 'Imported', color: '#ef6259', itemOrder: ['collision', 'duplicate'] }] };
  const before = structuredClone(current), result = planImport(current, incoming);
  assert.equal(result.added, 1); assert.equal(result.duplicates, 1); assert.equal(result.data.items[0].title, 'User name');
  const board = result.data.boards[1]; assert.notEqual(board.id, 'b'); assert.notEqual(result.data.items[2].id, 'collision');
  assert.deepEqual(board.itemOrder, [result.data.items[2].id, 'a']); assert.deepEqual(result.data.items[0].boardIds, ['b', board.id]);
  assert.deepEqual(current, before); assert.deepEqual(result.data.settings, current.settings);
  assert.deepEqual(planImport(current, incoming, { mode: 'replace', restoreSettings: true }).data, incoming);
});
test('validated preview does not mutate live data; replace preserves settings, long originals and a portable pre-import backup across restart', async t => {
  const f = fixture(t); f.store.add({ type: 'text', body: 'Old original' }); f.store.settings({ retentionDays: 0, paused: true });
  const before = fs.readFileSync(f.store.file), expected = f.store.exportData(), body = '完整\0\uD800🧪'.repeat(16000);
  const state = await f.service.prepare(f.write({ version: 2, items: [item('a', body, { html: '<p>Original</p>', rtf: '{\\rtf1 Original}' })], settings: { paused: false } }));
  assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(state.summary.items, 1);
  fs.writeFileSync(f.file, 'changed after validation');
  const result = await f.service.apply(state.token, { mode: 'replace' });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.checkpoint)), expected); assert.equal(fs.statSync(result.checkpoint).mode & 0o777, 0o600);
  assert.equal(f.store.get('a').body, body); assert.equal(f.store.data.settings.paused, true); assert.equal(f.service.state().phase, 'idle');
  const reopened = new ClipStore(f.directory); t.after(() => reopened.close()); assert.equal(reopened.get('a').body, body); assert.equal(reopened.get('a').rtf, '{\\rtf1 Original}');
  const restore = await f.service.prepare(result.checkpoint); await f.service.apply(restore.token, { mode: 'replace', restoreSettings: true });
  assert.deepEqual(f.store.exportData(), expected);
});
test('merge reuses canonical text/file signatures and keeps memberships and normalized legacy favorites', async t => {
  const f = fixture(t), existing = f.store.add({ type: 'text', body: 'same' });
  const state = await f.service.prepare(f.write({ version: 2, items: [item('duplicate', 'same', { signature: 'untrusted', isFavorite: true }),
    item('file', 'file:///tmp/never-open', { type: 'file', signature: 'untrusted' })] }));
  assert.equal(state.summary.duplicates, 1); await f.service.apply(state.token, { mode: 'merge' });
  assert.equal(f.store.data.items.length, 2); assert.deepEqual(f.store.get(existing.id).boardIds, ['favorites']);
  assert.equal(f.store.get('file').signature, hash('file:file:///tmp/never-open'));
});
test('stale previews, protected edits, invalid options and active exports cannot replace live data', async t => {
  const f = fixture(t), original = f.store.add({ type: 'text', body: 'original' }), state = await f.service.prepare(f.write({ version: 2, items: [item('a')] }));
  await assert.rejects(f.service.apply('wrong', { mode: 'replace' }), /预览/);
  await assert.rejects(f.service.apply(state.token, { mode: 'invalid' }), /选项/);
  f.store.protectedItemId = original.id; await assert.rejects(f.service.apply(state.token, { mode: 'replace' }), /编辑/); delete f.store.protectedItemId;
  f.store.update(original.id, { title: 'new title' }); await assert.rejects(f.service.apply(state.token, { mode: 'replace' }), /已变化/);
  const exporting = f.store.exportTo(path.join(f.directory, 'export.json'));
  await assert.rejects(f.service.prepare(f.file), /备份任务/); await exporting;
  assert.equal(f.store.get(original.id).title, 'new title');
});
test('changes during checkpoint promotion invalidate the commit while keeping current data and the checkpoint', async t => {
  const f = fixture(t); f.store.add({ type: 'text', body: 'old' }); const state = await f.service.prepare(f.write({ version: 2, items: [item('a')] }));
  const pending = f.service.apply(state.token, { mode: 'replace' }); f.store.add({ type: 'text', body: 'concurrent' });
  await assert.rejects(pending, /已变化/); assert.equal(f.store.data.items.length, 2); assert.ok(fs.existsSync(f.service.lastCheckpoint));
});
test('pre-commit manifest failure rolls back runtime hooks and preserves original bytes; retry succeeds', async t => {
  let rolledBack = 0; const f = fixture(t, { beforeCommit: () => () => rolledBack++ }); f.store.add({ type: 'text', body: 'old' });
  const before = fs.readFileSync(f.store.file), state = await f.service.prepare(f.write({ version: 2, items: [item('a')] })), persist = f.store.persist;
  f.store.persist = () => { throw new Error('Injected manifest failure'); };
  await assert.rejects(f.service.apply(state.token, { mode: 'replace' }), /Injected/); f.store.persist = persist;
  assert.equal(rolledBack, 1); assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(f.store.data.items[0].body, 'old');
  await f.service.apply(state.token, { mode: 'replace' }); assert.equal(f.store.get('a').body, 'a');
});
test('post-commit durability/runtime failures report restored data instead of false rollback', async t => {
  const f = fixture(t, { afterCommit: () => { throw new Error('runtime'); } }); f.store.add({ type: 'text', body: 'old' });
  const state = await f.service.prepare(f.write({ version: 2, items: [item('a')] })), sync = fs.fsyncSync;
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('Injected directory sync'); return sync(fd); };
  try {
    const result = await f.service.apply(state.token, { mode: 'replace' }); assert.equal(result.ok, true); assert.match(result.warning, /已提交.*runtime/); assert.equal(f.store.get('a').body, 'a');
  } finally { fs.fsyncSync = sync; }
});
test('cancel, close and worker termination clean only owned staging directories and preserve the library', async t => {
  const f = fixture(t); f.store.add({ type: 'text', body: 'old' }); const before = fs.readFileSync(f.store.file);
  const file = f.write({ version: 2, items: Array.from({ length: 100 }, (_, i) => item(String(i), 'x'.repeat(40000))) });
  let pending = f.service.prepare(file); f.service.cancel(); await assert.rejects(pending, { name: 'AbortError' });
  pending = f.service.prepare(file); const terminated = assert.rejects(pending, /意外退出/); await f.service.active.worker.terminate(); await terminated;
  const state = await f.service.prepare(file); assert.equal(state.phase, 'ready'); f.service.cancel(); assert.equal(f.service.state().phase, 'idle');
  pending = f.service.prepare(file); const canceled = assert.rejects(pending, { name: 'AbortError' }); await f.service.close(); await canceled;
  assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('import-')), false);
});
test('reserved restore checkpoints and staged content cannot be overwritten by user exports', t => {
  const f = fixture(t), stage = path.join(f.directory, 'import-owned'); fs.mkdirSync(stage);
  for (const file of [path.join(f.directory, 'backup-before-import-example.json'), path.join(stage, 'asset.json')]) assert.throws(() => destination(file, [f.directory]), /不能用导出/);
});
test('corrupt staged content or an existing same-name corrupt asset prevents promotion without overwriting current files', async t => {
  const f = fixture(t); f.store.add({ type: 'text', body: 'Original' }); const before = fs.readFileSync(f.store.file);
  const file = f.write({ version: 2, items: [item('a', 'large'.repeat(10000))] });
  let state = await f.service.prepare(file), name = f.service.preview.data.items[0].contentAsset;
  fs.writeFileSync(path.join(f.service.preview.stage, 'contents', name), 'changed staging');
  await assert.rejects(f.service.apply(state.token, { mode: 'replace' }), /校验失败/); assert.deepEqual(fs.readFileSync(f.store.file), before);
  state = await f.service.prepare(file); name = f.service.preview.data.items[0].contentAsset;
  const target = path.join(f.directory, 'contents', name); fs.writeFileSync(target, 'Existing sentinel');
  await assert.rejects(f.service.apply(state.token, { mode: 'replace' }), /校验失败/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Existing sentinel'); assert.deepEqual(fs.readFileSync(f.store.file), before);
});
test('cancelling apply during its worker and rejecting runtime settings both preserve the current manifest', async t => {
  const f = fixture(t, { beforeCommit: () => { throw new Error('Shortcut conflict'); } }); f.store.add({ type: 'text', body: 'Original' });
  const before = fs.readFileSync(f.store.file), state = await f.service.prepare(f.write({ version: 2, items: [item('a')] }));
  const pending = f.service.apply(state.token, { mode: 'replace' }); f.service.cancel(); await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(fs.readFileSync(f.store.file), before);
  await assert.rejects(f.service.apply(state.token, { mode: 'replace', restoreSettings: true }), /Shortcut conflict/);
  assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(f.store.data.items[0].body, 'Original');
});
test('post-commit staging cleanup failure cannot report an uncommitted restore or leave its token reusable', async t => {
  const f = fixture(t); f.store.add({ type: 'text', body: 'Original' });
  const state = await f.service.prepare(f.write({ version: 2, items: [item('a', 'Restored', { html: null, rtf: null })] })), stage = f.service.preview.stage, rm = fs.rmSync;
  fs.rmSync = (target, ...args) => { if (target === stage) throw new Error('Injected cleanup failure'); return rm(target, ...args); };
  try {
    const result = await f.service.apply(state.token, { mode: 'replace' }); assert.equal(result.ok, true); assert.match(result.warning, /已恢复.*清理失败/);
    assert.equal(f.service.state().phase, 'idle'); assert.equal(f.service.preview, null); assert.equal(f.store.get('a').body, 'Restored');
    assert.equal(f.store.get('a').html, null); assert.equal(f.store.get('a').rtf, null);
    await assert.rejects(f.service.apply(state.token, { mode: 'replace' }), /预览已失效/);
  } finally { fs.rmSync = rm; }
});
test('restore remaps reserved navigation IDs and DOM-unsafe identifiers consistently without changing safe identities', async t => {
  const f = fixture(t), badItem = 'item\0broken', badBoard = 'board\rbroken';
  const state = await f.service.prepare(f.write({ version: 2, items: [item(badItem, 'Pinned', { boardIds: ['history', badBoard] }), item('stable')],
    boards: [{ id: 'history', name: 'Imported', color: '#ef6259', itemOrder: [badItem] }, { id: badBoard, name: 'Second', color: '#62c68d', itemOrder: [badItem] }] }));
  assert.equal(state.summary.repairedIds, 3); const normalized = structuredClone(f.service.preview.data);
  const repeated = await f.service.prepare(f.file); assert.deepEqual(f.service.preview.data, normalized);
  await f.service.apply(repeated.token, { mode: 'replace' });
  const [pinned, stable] = f.store.data.items, [board, second] = f.store.data.boards;
  assert.notEqual(pinned.id, badItem); assert.equal(stable.id, 'stable'); assert.notEqual(board.id, 'history'); assert.notEqual(second.id, badBoard);
  assert.deepEqual(pinned.boardIds, [board.id, second.id]); assert.deepEqual(board.itemOrder, [pinned.id]); assert.deepEqual(second.itemOrder, [pinned.id]);
  const reopened = new ClipStore(f.directory); t.after(() => reopened.close()); assert.deepEqual(reopened.data.items.map(value => value.id), [pinned.id, stable.id]);
  const again = await f.service.prepare(f.file); assert.equal(again.summary.duplicates, 2); await f.service.apply(again.token, { mode: 'merge' });
  assert.equal(f.store.data.boards.length, 2); assert.equal(f.store.data.items.length, 2);
});
test('identifier repair preserves distinct lone UTF-16 surrogates and does not overwrite a preexisting safe alias', async t => {
  const f = fixture(t), first = 'item\uD800', second = 'item\uD801', alias = `restored-item-${hash(Buffer.from(`0:${first}`, 'utf16le'))}`;
  const state = await f.service.prepare(f.write({ version: 2, items: [item(first, 'First'), item(second, 'Second'), item(alias, 'Existing safe alias')] }));
  assert.equal(state.summary.repairedIds, 2); await f.service.apply(state.token, { mode: 'replace' });
  const ids = f.store.data.items.map(value => value.id); assert.equal(new Set(ids).size, 3); assert.equal(ids[2], alias);
  assert.ok(ids.every(value => value.isWellFormed())); assert.equal(f.store.get(alias).body, 'Existing safe alias');
});
test('cancel and worker failure abort and wait for delegated image verification before releasing staging ownership', async t => {
  let announce, cleaned;
  const f = fixture(t, { validateImage: async (_file, { turns, signal }) => {
    if (turns) await new Promise((_resolve, reject) => {
      announce(); signal.addEventListener('abort', () => setTimeout(() => { cleaned = true; reject(signal.reason); }, 30), { once: true });
    });
    return { signature: 'a'.repeat(64), size: { width: 1, height: 1 }, preview: '' };
  } });
  const body = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const file = f.write({ version: 2, items: [item('image', body, { type: 'image', imageTurns: 1, originalBody: body })] });
  for (const mode of ['cancel', 'crash']) {
    cleaned = false; const started = new Promise(resolve => { announce = resolve; }), pending = f.service.prepare(file);
    const rejected = assert.rejects(pending, mode === 'cancel' ? { name: 'AbortError' } : /意外退出/);
    await started; if (mode === 'cancel') f.service.cancel(); else await f.service.active.worker.terminate(); await rejected;
    assert.equal(cleaned, true); assert.equal(f.service.active, null); assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('import-')), false);
  }
});
