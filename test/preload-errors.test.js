const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function api(invoke) {
  let exposed;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } }, ipcRenderer: { invoke } })
  });
  return exposed;
}
test('IPC errors display the actual application message without a channel or transport prefix', async () => {
  const error = new Error("Error invoking remote method 'preview:save': Error: 请输入文本后再保存。");
  const exposed = api(async () => { throw error; });
  await assert.rejects(exposed.savePreview({ body: '' }), result => result === error && result.message === '请输入文本后再保存。');
  assert.ok(error.stack.includes('preload-errors.test.js')); // Keep the original diagnostic frames.
});
test('only this invocation envelope is unwrapped; unrelated errors and nested message text are preserved', async () => {
  for (const message of ['Disk unavailable', "Error invoking remote method 'other:channel': Error: Keep this", 'User text Error: unchanged']) {
    const exposed = api(async () => { throw new Error(message); });
    await assert.rejects(exposed.savePreview({}), error => error.message === message);
  }
  const exposed = api(async () => { throw new Error("Error invoking remote method 'preview:save': Error: Error: Actual message"); });
  await assert.rejects(exposed.savePreview({}), error => error.message === 'Error: Actual message');
});
test('successful structured copied/error results and invocation arguments are unchanged', async () => {
  const result = { ok: false, copied: true, error: 'Clipboard changed' }; let args;
  const exposed = api(async (...values) => { args = values; return result; });
  assert.equal(await exposed.copy('id', { paste: true }), result);
  assert.deepEqual(Array.from(args).slice(0, 2), ['item:copy', 'id']); assert.equal(args[2].paste, true);
});
