const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ItemOpener } = require('../src/item-opener');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-open-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const items = new Map(), calls = [], confirmations = [];
  const opener = new ItemOpener({ store: { get: id => items.get(id) },
    openURL: async value => calls.push(['url', value]), openPath: async value => { calls.push(['file', value]); return ''; },
    confirm: async value => { confirmations.push(value); return true; } });
  const add = (id, type, body) => { items.set(id, { id, type, body, signature: body }); return id; };
  const file = (name, mode = 0o600) => { const target = path.join(dir, name); fs.writeFileSync(target, 'fixture', { mode }); return target; };
  return { dir, items, calls, confirmations, opener, add, file, uri: pathToFileURL };
}
test('opens all explicit links and files in selection order, deduplicating resources without rewriting items', async t => {
  const f = fixture(t), name = f.file('中文 #\n & $(touch nope).txt'), before = [];
  f.add('a', 'link', 'https://example.com/中文?q=a%20b#hash'); f.add('b', 'file', `${f.uri(name)}\n${f.uri(f.dir)}`); f.add('c', 'link', 'https://example.com/中文?q=a%20b#hash');
  for (const item of f.items.values()) before.push({ ...item });
  assert.deepEqual(await f.opener.open(['a', 'b', 'c']), { ok: true, opened: 3 });
  assert.deepEqual(f.calls, [['url', new URL(before[0].body).href], ['file', name], ['file', f.dir]]);
  assert.deepEqual([...f.items.values()], before); assert.deepEqual(f.confirmations, []);
});
test('whole selection preflight refuses missing, invalid and unsupported members before any dispatch', async t => {
  for (const [type, body] of [['text', 'plain'], ['link', 'javascript:alert(1)'], ['link', 'file:///tmp/file'], ['link', 'https://example.com/\nnext'], ['link', 'https://'], ['file', 'file://other-host/tmp/x'], ['file', 'https://example.com'], ['file', 'file:///tmp/x?query'], ['file', 'file:///tmp/x#fragment'], ['file', ''], ['file', 'file:///tmp/nonexistent-paste-fixture']]) {
    const f = fixture(t); f.add('a', 'link', 'https://example.com'); f.add('b', type, body);
    assert.equal((await f.opener.open(['a', 'b'])).ok, false, body); assert.deepEqual(f.calls, []);
  }
});
test('opening accepts the same surrounding whitespace as capture classification without changing the original bytes', async t => {
  const f = fixture(t), { classifyText } = require('../src/model'), body = '\n \thttps://example.com/%E4%B8%AD%E6%96%87?q=a%20b\r\n';
  assert.equal(classifyText(body), 'link'); f.add('a', 'link', body);
  assert.deepEqual(await f.opener.open(['a']), { ok: true, opened: 1 });
  assert.deepEqual(f.calls, [['url', body.trim()]]); assert.equal(f.items.get('a').body, body);
});
test('per-file preview index opens exactly that file, missing siblings do not prevent explicit file choice', async t => {
  const f = fixture(t), file = f.file('second.txt'); f.add('a', 'file', `file:///tmp/no-such-paste-sibling\n${f.uri(file)}`);
  assert.deepEqual(await f.opener.open(['a'], { index: 1 }), { ok: true, opened: 1 }); assert.deepEqual(f.calls, [['file', file]]);
  assert.equal((await f.opener.open(['a'])).ok, false);
  for (const index of [-1, 2, 0.5, '1', null]) assert.equal((await f.opener.open(['a'], { index })).ok, false);
});
test('risky files, symlink targets and credentialed links require confirmation and cancellation dispatches nothing', async t => {
  for (const kind of ['command', 'mode', 'app', 'symlink', 'credentials']) {
    const f = fixture(t); let body, type = 'file';
    if (kind === 'credentials') { type = 'link'; body = 'https://user:secret@example.com/'; }
    else if (kind === 'app' || kind === 'symlink') {
      const app = path.join(f.dir, 'Fixture.app'); fs.mkdirSync(app);
      if (kind === 'symlink') { const link = path.join(f.dir, 'harmless.txt'); fs.symlinkSync(app, link); body = f.uri(link).href; } else body = f.uri(app).href;
    } else body = f.uri(f.file(kind === 'command' ? 'fixture.command' : 'fixture.txt', kind === 'mode' ? 0o700 : 0o600)).href;
    f.add('a', type, body); f.opener.confirm = async value => { assert.deepEqual(value, { count: 1, risky: true }); return false; };
    assert.deepEqual(await f.opener.open(['a']), { ok: false, cancelled: true, opened: 0 }); assert.deepEqual(f.calls, []);
  }
});
test('bulk opening confirms count, respects bounds and never silently truncates a batch', async t => {
  const f = fixture(t), ids = Array.from({ length: 11 }, (_, n) => f.add(String(n), 'link', `https://example.com/${n}`));
  assert.equal((await f.opener.open(ids)).opened, 11); assert.deepEqual(f.confirmations, [{ count: 11, risky: false }]);
  f.calls.length = 0;
  const paths = Array.from({ length: 129 }, (_, n) => f.uri(path.join(f.dir, String(n))).href).join('\n'); f.add('files', 'file', paths);
  assert.equal((await f.opener.open(['files'])).ok, false); assert.deepEqual(f.calls, []);
  for (const ids of [[], ['missing'], ['0', '0'], '0', Array(129).fill('0')]) assert.equal((await f.opener.open(ids)).ok, false);
});
test('confirmation cannot open changed/deleted source or stale owner, metadata-only changes remain valid', async t => {
  for (const action of ['body', 'delete', 'context', 'metadata']) {
    const f = fixture(t); f.add('a', 'link', 'https://user:secret@example.com'); let current = true;
    f.opener.confirm = async () => { if (action === 'delete') f.items.delete('a'); else if (action === 'context') current = false; else if (action === 'metadata') f.items.get('a').title = 'new title'; else f.items.get('a').body = 'https://other.example'; return true; };
    const result = await f.opener.open(['a'], { current: () => current });
    assert.equal(result.ok, action === 'metadata'); assert.equal(f.calls.length, action === 'metadata' ? 1 : 0);
  }
});
test('file replacements and symlink retargets during confirmation invalidate the entire preflight', async t => {
  for (const symlink of [false, true]) {
    const f = fixture(t), a = f.file('a.command'), b = f.file('b.command'); let file = a;
    if (symlink) { file = path.join(f.dir, 'link.txt'); fs.symlinkSync(a, file); }
    f.add('url', 'link', 'https://example.com'); f.add('file', 'file', f.uri(file).href);
    f.opener.confirm = async () => { fs.unlinkSync(file); if (symlink) fs.symlinkSync(b, file); else fs.writeFileSync(file, 'different'); return true; };
    assert.equal((await f.opener.open(['url', 'file'])).ok, false); assert.deepEqual(f.calls, []);
  }
});
test('OS errors are sanitized, partial completion is explicit and later resources are not dispatched', async t => {
  const f = fixture(t); for (let n = 0; n < 3; n++) f.add(String(n), 'link', `https://example.com/${n}`);
  f.opener.openURL = async value => { f.calls.push(value); if (f.calls.length === 2) throw Error('credential secret'); };
  const result = await f.opener.open(['0', '1', '2']); assert.equal(result.ok, false); assert.equal(result.opened, 1); assert.match(result.error, /其余未打开/); assert.doesNotMatch(result.error, /secret/); assert.equal(f.calls.length, 2);
  const file = f.file('a.txt'); f.add('file', 'file', f.uri(file).href); f.opener.openPath = async () => 'OS error';
  assert.equal((await f.opener.open(['file'])).opened, 0);
});
test('an in-flight dispatch rejects overlapping opens and source changes stop the remainder', async t => {
  const f = fixture(t); f.add('a', 'link', 'https://example.com/a'); f.add('b', 'link', 'https://example.com/b');
  let release; const gate = new Promise(resolve => { release = resolve; }); f.opener.openURL = async value => { f.calls.push(value); await gate; };
  const pending = f.opener.open(['a', 'b']); await Promise.resolve();
  await assert.rejects(f.opener.open(['b']), /稍候/); f.items.delete('b'); release();
  const result = await pending; assert.equal(result.opened, 1); assert.equal(result.ok, false); assert.equal(f.calls.length, 1);
  assert.equal(f.opener.busy, false);
});
