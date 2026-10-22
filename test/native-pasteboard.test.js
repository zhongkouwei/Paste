const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native ownership guard rejects both pre-activation and activation-time races on a PRIVATE pasteboard', { skip: process.platform !== 'darwin' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-private-board-'));
  try {
    const executable = path.join(directory, 'ownership');
    execFileSync('xcrun', ['clang', '-O2', '-fobjc-arc', '-framework', 'Cocoa', path.resolve(__dirname, 'fixtures/pasteboard-ownership.m'),
      path.resolve(__dirname, '../native/pasteboard.m'), '-o', executable], { timeout: 30000 });
    const output = execFileSync(executable, [], { encoding: 'utf8', timeout: 10000 });
    assert.match(output, /20 normal\/race cycles/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
