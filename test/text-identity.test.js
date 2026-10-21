const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClipStore, textSignature, htmlPayload, hash } = require('../src/store');
const { ContentFiles } = require('../src/content-files');
const { ImportService } = require('../src/import-service');
const legacySignature = (body, html = '', rtf = '') => hash(`text:${body}\nhtml:${htmlPayload(html)}\nrtf:${rtf}`);
const pair = prefix => [{ body: `${prefix}\nhtml:<p>Alpha</p>`, html: '<p>Beta</p>', rtf: '' }, { body: prefix, html: '<p>Alpha</p>\nhtml:<p>Beta</p>', rtf: '' }];
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-text-identity-')), store = new ClipStore(directory);
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return store;
}
const record = (fields, n, extra = {}) => ({ ...fields, id: `legacy-${n}`, type: 'text', title: `Original ${n}`, boardIds: [], createdAt: new Date().toISOString(), signature: legacySignature(fields.body, fields.html, fields.rtf), ...extra });
test('text identity frames body, HTML and RTF unambiguously rather than trusting embedded delimiters', () => {
  const [a, b] = pair('Literal text'); assert.equal(legacySignature(a.body, a.html), legacySignature(b.body, b.html));
  assert.notEqual(textSignature(a.body, a.html), textSignature(b.body, b.html));
  const values = ['', 'plain', '\nhtml:', '\nrtf:', 'null', '\0', '"\\', '\uD800', '\uD801', '\uDC00', '\uFFFD', '🧪'], seen = new Map();
  for (const body of values) for (const html of values) for (const rtf of values) {
    const signature = textSignature(body, html, rtf), expected = JSON.stringify([body, htmlPayload(html), rtf]);
    if (seen.has(signature)) assert.equal(seen.get(signature), expected); seen.set(signature, expected);
  }
});
test('Unicode code units and nullable format values cannot silently alias different originals', () => {
  const values = ['orphan-\uD800', 'orphan-\uD801', 'orphan-\uDC00', 'orphan-\uFFFD', 'orphan-𐀀', 'café', 'cafe\u0301'];
  assert.equal(new Set(values.map(value => textSignature(value))).size, values.length);
  assert.notEqual(textSignature('text', '', null), textSignature('text', '', 'null'));
  assert.equal(textSignature('text', "<meta charset='utf-8'><meta charset='utf-8'><b>text</b>"), textSignature('text', '<b>text</b>'));
});
test('capture, rich edits and recopy preserve distinct originals, names, IDs and Pinboard membership', t => {
  const store = fixture(t), [a, b] = pair('Capture identity'), first = store.add({ type: 'text', body: 'Before edit' });
  const board = store.saveBoard({ name: 'Keep identity', color: '#ef6259' }); store.update(first.id, { title: 'My name', boardIds: [board.id] });
  store.update(first.id, a); const second = store.add({ ...b, type: 'code' });
  assert.notEqual(first.id, second.id); assert.equal(store.data.items.length, 2); assert.equal(store.get(first.id).body, a.body);
  const again = store.add({ ...a, type: 'text' }); assert.equal(again.id, first.id); assert.equal(again.title, 'My name'); assert.deepEqual(again.boardIds, [board.id]);
  assert.equal(store.get(second.id).html, b.html); assert.equal(store.data.items.length, 2);
});
test('existing v1/v2/sidecar-v3 libraries normalize legacy identities without rewriting originals or merging records on open', async t => {
  for (const version of [1, 2, 3]) {
    const store = fixture(t), fields = pair('Long original '.repeat(3000)), contents = new ContentFiles(store.directory);
    const records = fields.map((value, n) => record(value, n, { renamed: true, isFavorite: n === 0 }));
    if (version === 1) for (const item of records) delete item.boardIds;
    else records[0].boardIds = ['work'];
    const data = version === 1 ? records : { version, items: version === 3 ? records.map(item => contents.record(item)) : records,
      boards: [{ id: 'work', name: 'Keep old order', color: '#ef6259', itemOrder: ['legacy-0'] }], settings: { paused: true, retentionDays: 0 } };
    const raw = JSON.stringify(data), file = store.file; fs.writeFileSync(file, raw, { mode: 0o600 });
    const reopened = new ClipStore(store.directory); t.after(() => reopened.close());
    assert.equal(fs.readFileSync(file, 'utf8'), raw); assert.equal(new Set(reopened.data.items.map(item => item.signature)).size, 2);
    for (let n = 0; n < 2; n++) { const item = reopened.get(`legacy-${n}`); assert.equal(item.body, fields[n].body); assert.equal(item.html, fields[n].html); assert.equal(item.title, `Original ${n}`); }
    reopened.update('legacy-0', { title: 'Renamed after upgrade' }); assert.equal(reopened.add({ type: 'text', ...fields[1] }).id, 'legacy-1');
    assert.equal(reopened.data.items.length, 2); assert.deepEqual(reopened.get('legacy-0').boardIds, [version === 1 ? 'favorites' : 'work']);
    if (version < 3) assert.equal(fs.readFileSync(path.join(store.directory, `library-v2-${hash(raw)}.json`), 'utf8'), raw);
    const restarted = new ClipStore(store.directory); t.after(() => restarted.close()); assert.equal(restarted.get('legacy-0').title, 'Renamed after upgrade'); assert.equal(restarted.data.items.length, 2);
  }
});
test('recovery from a legacy-signature backup preserves both records and its original bytes', t => {
  const store = fixture(t), fields = pair('Recovery collision');
  const raw = JSON.stringify({ version: 3, items: fields.map((value, n) => record(value, n)), boards: [], settings: {} });
  fs.writeFileSync(`${store.file}.bak`, raw, { mode: 0o600 }); fs.writeFileSync(store.file, 'Broken primary');
  const recovered = new ClipStore(store.directory); t.after(() => recovered.close());
  assert.equal(recovered.data.items.length, 2); assert.equal(new Set(recovered.data.items.map(item => item.signature)).size, 2);
  assert.equal(fs.readFileSync(`${store.file}.bak`, 'utf8'), raw); assert.ok(recovered.recovery);
  assert.equal(recovered.get('legacy-0').body, fields[0].body); assert.equal(recovered.get('legacy-1').html, fields[1].html);
});
test('merging older product directories never coalesces records merely because old signatures collide', t => {
  const store = fixture(t), fields = pair('Legacy directory collision'), directories = fields.map((value, n) => {
    const directory = path.join(store.directory, `old-${n}`); fs.mkdirSync(directory); const raw = JSON.stringify([record(value, n)]);
    fs.writeFileSync(path.join(directory, 'clipboard-history.json'), raw); return { directory, raw };
  });
  const migrated = new ClipStore(path.join(store.directory, 'current'), { legacyDirectories: directories.map(value => value.directory) }); t.after(() => migrated.close());
  assert.equal(migrated.data.items.length, 2); for (let n = 0; n < 2; n++) assert.equal(migrated.get(`legacy-${n}`).body, fields[n].body);
  for (const entry of directories) assert.equal(fs.readFileSync(path.join(entry.directory, 'clipboard-history.json'), 'utf8'), entry.raw);
});
test('backup merge/export/replace/restart keep delimiter and surrogate originals separate while true duplicates still merge', async t => {
  const store = fixture(t), fields = [...pair('Import collision'), { body: 'orphan-\uD800' }, { body: 'orphan-\uD801' }];
  const existing = store.add({ ...fields[0], type: 'text' }); store.update(existing.id, { title: 'Preserved local title' });
  const service = new ImportService(store); t.after(() => service.close());
  const file = path.join(store.directory, 'input.json'); fs.writeFileSync(file, JSON.stringify({ version: 2, items: fields.map((value, n) => record(value, n)) }));
  let state = await service.prepare(file); assert.equal(state.summary.added, 3); assert.equal(state.summary.duplicates, 1);
  await service.apply(state.token, { mode: 'merge' }); assert.equal(store.data.items.length, 4); assert.equal(store.get(existing.id).title, 'Preserved local title');
  const expected = store.exportData(), output = path.join(store.directory, 'export.json'); await store.exportTo(output);
  state = await service.prepare(output); await service.apply(state.token, { mode: 'replace', restoreSettings: true }); assert.deepEqual(store.exportData(), expected);
  const reopened = new ClipStore(store.directory); t.after(() => reopened.close()); assert.deepEqual(reopened.exportData(), expected);
});
