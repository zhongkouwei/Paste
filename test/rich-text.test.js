const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RichTextService, runTextUtil, nativeTextMatches, unsupportedRTF } = require('../src/rich-text');
const { ClipStore, textSignature } = require('../src/store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\colortbl;\red200\green30\blue40;}\f0\fs32\cf1{\b Bold} plain\par {\i\ul Next}}`;
test('system RTF reader and writer retain styled paragraphs and exact text', { skip: process.platform !== 'darwin' }, async t => {
  const service = new RichTextService(); t.after(() => service.close());
  const read = await service.read(rtf); assert.equal(read.text, 'Bold plain\nNext');
  assert.match(read.html, /<b>Bold<\/b>/); assert.match(read.html, /Arial/); assert.match(read.html, /#c81e28/i);
  const edited = await service.write('<p><strong>Bold</strong> plain</p><p><em><u>Next!</u></em></p>', 'Bold plain\nNext!');
  const result = await service.read(edited); assert.equal(result.text, 'Bold plain\nNext!\n'); assert.match(result.html, /<b>/); assert.match(result.html, /<i>/); assert.match(result.html, /underline/);
  const unicode = await service.write('<p>中文🙂<strong>粗体</strong></p>', '中文🙂粗体'); assert.equal((await service.read(unicode)).text, '中文🙂粗体\n');
  await assert.rejects(service.write('<p>Other</p>', 'Keep'), /不一致/);
});
test('only an actual native terminal LF is allowed, not trimming or arbitrary whitespace', () => {
  for (const text of ['Text', 'Text\n']) assert.equal(nativeTextMatches('Text', text), true);
  for (const text of ['Text\n\n', 'Text ', ' Text', 'Text\r', 'text']) assert.equal(nativeTextMatches('Text', text), false);
  assert.equal(nativeTextMatches('Text\n', 'Text'), false);
});
test('opaque RTF destinations cannot be silently removed by the native conversion', async t => {
  const service = new RichTextService({ run: () => { throw new Error('must not run'); } }); t.after(() => service.close());
  for (const control of ['pict', 'object', 'bin123', 'footnote', 'footer', 'shp', 'mmath', 'NeXTGraphic', 'filetbl']) await assert.rejects(service.read(`{\\rtf1 Before{\\${control} opaque}After}`), /附件或文档结构/);
  assert.equal(unsupportedRTF(String.raw`{\rtf1 Literal \\pict and \'5cpict}`), false);
});
test('invalid, oversized and malformed Unicode rich documents never reach the native runner', async t => {
  const service = new RichTextService({ run: () => { throw new Error('must not run'); } }); t.after(() => service.close());
  for (const value of ['plain', '\uD800', '{\\rtf1 ' + 'x'.repeat(16 * 1024 * 1024)]) await assert.rejects(service.read(value), /RTF格式/);
  await assert.rejects(service.write('<p>x</p>', '\uD800'), /格式或大小/);
});
test('read cache is serial, bounded and does not share mutable results', async t => {
  let calls = 0, active = 0;
  const service = new RichTextService({ run: async (_value, _from, to) => { assert.equal(++active, 1); calls++; await new Promise(resolve => setTimeout(resolve, 1)); active--; return to === 'html' ? '<p>x</p>' : 'x'; } });
  t.after(() => service.close());
  const values = await Promise.all([service.read(rtf), service.read(rtf)]); assert.equal(calls, 2);
  values[0].html = 'changed'; assert.equal((await service.read(rtf)).html, '<p>x</p>');
  for (let n = 0; n < 20; n++) await service.read(`{\\rtf1 ${n}}`);
  assert.equal(service.cache.size, 16); assert.ok(service.bytes <= 8 * 1024 * 1024);
});
test('conversion output and regenerated RTF must validate before use', async t => {
  const service = new RichTextService({ run: async () => 'x'.repeat(16 * 1024 * 1024 + 1) }); t.after(() => service.close());
  await assert.rejects(service.read(rtf), /超过限制/); await assert.rejects(service.write('<p>x</p>', 'x'), /有效RTF/);
});
test('cancelled queued work never starts; close aborts active work and waits for cleanup', async () => {
  let calls = 0, started, cleaned = false;
  const ready = new Promise(resolve => { started = resolve; });
  const service = new RichTextService({ run: (_input, _from, _to, { signal }) => new Promise((_resolve, reject) => {
    calls++; started(); signal.addEventListener('abort', () => setTimeout(() => { cleaned = true; reject(signal.reason); }, 10), { once: true });
  }) });
  const first = service.read(rtf); const firstResult = assert.rejects(first); await ready;
  const controller = new AbortController(), second = service.read('{\\rtf1 queued}', { signal: controller.signal });
  const secondResult = assert.rejects(second); controller.abort(); await service.close(); await firstResult; await secondResult;
  assert.equal(calls, 1); assert.equal(cleaned, true); assert.equal(service.jobs.size, 0);
  await assert.rejects(service.read(rtf), /停止/);
});
test('native runner refuses pre-aborted work and reaps timeout before rejecting', { skip: process.platform !== 'darwin' }, async () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => runTextUtil(rtf, 'rtf', 'html', { signal: controller.signal }), /abort/i);
  await assert.rejects(runTextUtil(rtf, 'rtf', 'html', { timeout: 1 }), /超时/);
});
test('store atomically commits regenerated RTF and keeps identity and pinned metadata across restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-rich-store-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ClipStore(directory); t.after(() => store.close());
  const item = store.add({ type: 'text', body: 'Bold plain\nNext', rtf }), board = store.saveBoard({ name: 'Keep', color: '#ef6259' });
  store.update(item.id, { title: 'My rich text', boardIds: [board.id] });
  const changes = { body: 'Changed', html: '<p><b>Changed</b></p>', rtf: '{\\rtf1{\\b Changed}}' };
  store.update(item.id, changes); const value = store.get(item.id);
  assert.equal(value.signature, textSignature(changes.body, changes.html, changes.rtf)); assert.equal(value.title, 'My rich text'); assert.deepEqual(value.boardIds, [board.id]);
  const reopened = new ClipStore(directory); t.after(() => reopened.close()); assert.deepEqual(reopened.get(item.id), value);
  const raw = fs.readFileSync(store.file, 'utf8');
  assert.throws(() => store.update(item.id, { ...changes, rtf: 'x'.repeat(16 * 1024 * 1024 + 1) }), /RTF exceeds/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), raw); assert.deepEqual(store.get(item.id), value);
  store.persist = () => { throw new Error('disk full'); }; assert.throws(() => store.update(item.id, { ...changes, body: 'Other' }), /disk full/); assert.deepEqual(store.get(item.id), value);
});
test('written RTF retains actual sRGB colors according to AppKit, independently of Cocoa HTML export colors', { skip: process.platform !== 'darwin' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-rtf-colors-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'colors');
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Cocoa', path.join(__dirname, 'fixtures/rtf-colors.m'), '-o', executable]);
  const service = new RichTextService(); t.after(() => service.close());
  const written = await service.write('<p style="color:rgb(200,30,40)">中文🙂 Color</p>', '中文🙂 Color');
  const info = JSON.parse(execFileSync(executable, [], { input: written, encoding: 'utf8' }));
  assert.equal(info.text, '中文🙂 Color\n'); assert.ok(info.colors.length);
  for (const color of info.colors) [200, 30, 40, 1].forEach((value, index) => assert.ok(Math.abs(color[index] - value) < 0.02));
});
