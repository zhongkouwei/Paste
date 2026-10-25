const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { preserveClipboard } = require('../scripts/pasteboard-snapshot');

test('native full-format snapshot restores ordered file items and custom bytes on a PRIVATE pasteboard; invalid input never clears it', { skip: process.platform !== 'darwin' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-private-snapshot-'));
  try {
    const executable = path.join(directory, 'snapshot');
    execFileSync('xcrun', ['clang', '-O2', '-fobjc-arc', '-framework', 'Cocoa', path.resolve(__dirname, 'fixtures/pasteboard-snapshot.m'), '-o', executable], { timeout: 30000 });
    const output = execFileSync(executable, ['--self-test'], { encoding: 'utf8', timeout: 10000 });
    assert.match(output, /PRIVATE pasteboard: ordered items/); assert.match(output, /URL-only loss reproduced/); assert.match(output, /malformed restore preflight and empty restore passed/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('snapshot bytes stay in memory and restoration does not depend on a live Electron process', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-snapshot-adapter-')), calls = [], saved = Buffer.from('[{"synthetic":"AP8="}]');
  try {
    const handle = preserveClipboard(directory, { run: (file, args, options) => { calls.push({ file, args, options }); return args[0] === 'snapshot' ? saved : Buffer.alloc(0); } });
    assert.deepEqual(fs.readdirSync(directory), []); handle.restore(); handle.restore();
    assert.equal(calls.length, 3); assert.deepEqual(calls[2].args, ['restore']); assert.equal(calls[2].options.input, saved);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('restore failure retains the exact original bytes with 0600 permissions for explicit recovery', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-snapshot-recovery-')), saved = Buffer.from('[{"synthetic":"AP8="}]');
  try {
    let failed = true;
    const handle = preserveClipboard(directory, { run: (_file, args) => { if (args[0] === 'snapshot') return saved; if (args[0] === 'restore' && failed) throw Object.assign(Error('Synthetic private stderr'), { stdout: saved }); return Buffer.alloc(0); } });
    assert.throws(() => handle.restore(), error => /private original snapshot retained/.test(error.message) && !error.message.includes('Synthetic private') && !error.cause && !error.stdout);
    const file = path.join(directory, 'clipboard-recovery.json');
    assert.deepEqual(fs.readFileSync(file), saved); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    failed = false; handle.restore();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('snapshot failure stops before any restore; a public directory is rejected before invoking native code', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-snapshot-preflight-')), commands = [];
  try {
    assert.throws(() => preserveClipboard(directory, { run: (_file, args) => { commands.push(args[0]); if (args[0] === 'snapshot') throw Object.assign(Error('Synthetic private stdout'), { stdout: Buffer.from('private') }); } }), error => /tests stopped before modifying/.test(error.message) && !error.message.includes('private') && !error.cause && !error.stdout);
    assert.deepEqual(commands, ['clang', 'snapshot']); assert.deepEqual(fs.readdirSync(directory), []);
    fs.chmodSync(directory, 0o755);
    assert.throws(() => preserveClipboard(directory, { run: () => assert.fail('Native code must not run') }), /private directory/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
