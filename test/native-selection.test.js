const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
test('native multi-selection exports complete ordered RTF/RTFD, preserves PNG bytes and writes only a PRIVATE pasteboard', { skip: process.platform !== 'darwin' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-selection-native-'));
  try {
    const executable = path.join(directory, 'selection');
    execFileSync('xcrun', ['clang', '-O2', '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'ImageIO', path.resolve(__dirname, 'fixtures/selection.m'), path.resolve(__dirname, '../native/selection.m'), '-o', executable], { timeout: 30000 });
    assert.match(execFileSync(executable, [], { encoding: 'utf8', timeout: 15000 }), /ordered original PNG RTFD attachments passed/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
