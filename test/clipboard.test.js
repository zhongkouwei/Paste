const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClipboardService } = require('../src/clipboard');

function entry(values) { return { types: Object.keys(values), getType: async type => new Blob([values[type]]) }; }
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
