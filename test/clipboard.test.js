const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClipboardService } = require('../src/clipboard');
const { textSignature } = require('../src/store');
const { WRITE_ID_MIME } = require('../src/clipboard-ownership');

function entry(values) { return { types: Object.keys(values), getType: async type => new Blob([values[type]]) }; }
test('read ownership metadata is bounded, validated and excluded from payload identity', async () => {
  const token = '22222222-2222-4222-8222-222222222222'; let identity = token;
  const service = new ClipboardService({ clipboard: { read: async () => [entry({ 'text/plain': 'Body', [WRITE_ID_MIME]: identity })] } });
  const value = await service.read(); assert.equal(value.clipboardWriteID, token); assert.equal(value.signature, textSignature('Body'));
  for (const malformed of ['x'.repeat(36), token + 'extra', '']) { identity = malformed; assert.equal((await service.read()).clipboardWriteID, undefined); }
});
test('reads every native file item in order rather than only the first entry', async () => {
  const clipboard = { read: async () => [entry({ 'text/uri-list': 'file:///tmp/first.txt' }), entry({ 'electron application/osclipboard;format="public.file-url"': 'file:///tmp/second.txt' }), entry({ 'text/uri-list': 'file:///tmp/first.txt' })] };
  const service = new ClipboardService({ clipboard });
  assert.deepEqual((await service.read()).files, ['file:///tmp/first.txt', 'file:///tmp/second.txt']);
});
test('multiple URI entries preserve encoded spaces and ignore non-file links', async () => {
  const clipboard = { read: async () => [entry({ 'text/uri-list': '# Comment\r\nfile:///tmp/a%20b.txt\r\nhttps://example.com\r\nfile:///tmp/c.txt' })] };
  assert.deepEqual((await new ClipboardService({ clipboard }).read()).files, ['file:///tmp/a%20b.txt', 'file:///tmp/c.txt']);
});
test('native marker formats from later clipboard entries remain visible to privacy filtering', async () => {
  const marker = 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"';
  const clipboard = { read: async () => [entry({ 'text/plain': 'sample' }), entry({ [marker]: '1' })] };
  assert.ok((await new ClipboardService({ clipboard }).read()).formats.includes(marker));
});
test('clipboard read/write agree on field-framed identities while distinct rich payloads cannot alias', async () => {
  const fields = [{ 'text/plain': 'Wire text\nhtml:<p>Alpha</p>', 'text/html': '<p>Beta</p>' },
    { 'text/plain': 'Wire text', 'text/html': '<p>Alpha</p>\nhtml:<p>Beta</p>' }];
  let values;
  const service = new ClipboardService({ clipboard: { read: async () => [entry(values)], write: async entries => { values = entries[0].values; } },
    ClipboardItem: class { constructor(input) { this.values = input; } } });
  const signatures = [];
  for (const source of fields) {
    values = source; const read = await service.read(); signatures.push(read.signature);
    const written = await service.write({ type: 'text', body: read.text, html: read.html, rtf: read.rtf }); assert.equal(written, read.signature);
    assert.equal((await service.read()).signature, written);
  }
  assert.notEqual(signatures[0], signatures[1]);
});
test('wire identity follows Unicode scalar transport and absent formats without mutating originals or reading back a later foreign copy', async () => {
  let values, reads = 0, foreign = false;
  const service = new ClipboardService({ clipboard: { read: async () => { reads++; return [entry(values)]; }, write: async entries => { values = foreign ? { 'text/plain': 'Later foreign copy' } : entries[0].values; } },
    ClipboardItem: class { constructor(input) { this.values = input; } } });
  const input = { type: 'text', body: 'Original\0\uD800', html: '<b>Original\uD801</b>', rtf: '{\\rtf1 Original\uDC00}' }, original = structuredClone(input);
  for (const plain of [false, true]) {
    const signature = await service.write(input, { plain }), read = await service.read();
    assert.equal(read.text, input.body.toWellFormed()); assert.equal(read.html, plain ? '' : input.html.toWellFormed());
    assert.equal(read.rtf, plain ? '' : input.rtf.toWellFormed()); assert.equal(signature, read.signature); assert.deepEqual(input, original);
  }
  const emptySignature = await service.write({ type: 'text', body: 'Nullable', html: null, rtf: null }); assert.equal((await service.read()).signature, emptySignature);
  foreign = true; const beforeReads = reads, signature = await service.write({ type: 'text', body: 'Our copy' });
  assert.equal(reads, beforeReads); assert.equal(signature, textSignature('Our copy')); assert.notEqual((await service.read()).signature, signature);
});
