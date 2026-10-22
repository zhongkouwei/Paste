const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
test('native Stack policy and PRIVATE clipboard stream exit on EOF and malformed configuration without any keyboard tap', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-stack-native-'));
  try {
    const executable = path.join(directory, 'stack');
    execFileSync('xcrun', ['clang', '-O2', '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'ApplicationServices',
      path.resolve(__dirname, 'fixtures/stack-events.m'), path.resolve(__dirname, '../native/stack-events.m'), '-o', executable], { timeout: 20000 });
    assert.match(execFileSync(executable, ['policy'], { encoding: 'utf8', timeout: 4000 }), /policy passed/);
    for (const malformed of [false, true]) {
      const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
      let buffer = '', ready, copied = false; const messages = [];
      child.stdout.on('data', chunk => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); messages.push(value);
          if (value.event === 'ready') { ready = value; child.stdin.write('{"epoch":1,"ack":0,"count":3,"busy":false}\n'); }
          if (value.event === 'clipboard') { copied = true; if (malformed) child.stdin.end('{"epoch":true}\n'); else child.stdin.end(); }
        }
      });
      const [code, signal] = await once(child, 'close'); assert.equal(signal, null); assert.equal(code, 0);
      assert.equal(ready?.keyboard, false); assert.equal(ready?.error, 'simulation'); assert.equal(copied, true);
      assert.equal(messages.some(value => value.event === 'paste'), false);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
