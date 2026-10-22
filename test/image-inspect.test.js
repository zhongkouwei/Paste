const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { inspectPNG } = require('../src/image-inspect');
const { ImageInspector } = require('../src/image-inspector');
const { ImageProcessor } = require('../src/image-editor');
const { hash } = require('../src/store');
function png(width = 3, height = 2) {
  const buffer = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12); buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20); return buffer;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paste-inspect-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}
test('file inspection bounds size and dimensions, rejects symlinks and verifies original bytes before invoking the decoder', async t => {
  const directory = await fixture(t), file = path.join(directory, 'input.png'), buffer = png(); await fs.writeFile(file, buffer);
  let calls = 0;
  const image = { isEmpty: () => false, getSize: () => ({ width: 3, height: 2 }), toBitmap: () => Buffer.alloc(24), resize: () => ({ toDataURL: () => 'data:image/png;base64,preview' }) };
  const nativeImage = { createFromBuffer: value => { calls++; assert.deepEqual(value, buffer); return image; } };
  const result = await inspectPNG(file, { expectedHash: hash(buffer) }, nativeImage); assert.equal(calls, 1);
  assert.equal(result.signature, hash(Buffer.concat([Buffer.from('image:3x2:'), Buffer.alloc(24)]))); assert.equal(result.preview, 'data:image/png;base64,preview');
  assert.equal((await inspectPNG(file, { preview: false }, nativeImage)).preview, undefined);
  const before = calls; await assert.rejects(inspectPNG(file, { expectedHash: 'f'.repeat(64) }, nativeImage), /校验失败/);
  const link = path.join(directory, 'link.png'); await fs.symlink(file, link); await assert.rejects(inspectPNG(link, {}, nativeImage));
  await assert.rejects(inspectPNG(directory, {}, nativeImage));
  await fs.writeFile(file, png(10000, 10000)); await assert.rejects(inspectPNG(file, {}, nativeImage), /6400/);
  await fs.truncate(file, 64 * 1024 * 1024 + 1); await assert.rejects(inspectPNG(file, {}, nativeImage), /格式不可用/);
  assert.equal(calls, before);
});
test('file inspection rejects incomplete decoding and decoder/header dimension disagreement', async t => {
  const directory = await fixture(t), file = path.join(directory, 'input.png'); await fs.writeFile(file, png());
  for (const image of [{ isEmpty: () => true }, { isEmpty: () => false, getSize: () => ({ width: 2, height: 3 }) }]) {
    await assert.rejects(inspectPNG(file, {}, { createFromBuffer: () => image }), /完整解码/);
  }
});
function inspectorFixture(t) {
  const ipcMain = new EventEmitter(), windows = [];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; windows.push(this); this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = (_channel, value) => { this.request = value; }; }
    isDestroyed() { return !!this.destroyed; }
    async loadFile() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const inspector = new ImageInspector({ BrowserWindow: Window, ipcMain }); t.after(() => inspector.close());
  const result = { size: { width: 3, height: 2 }, signature: 'a'.repeat(64) };
  const reply = (window, value = result) => ipcMain.emit('image-inspect:result', { sender: window.webContents, senderFrame: window.webContents.mainFrame }, { id: window.request.id, result: value });
  return { inspector, ipcMain, windows, result, reply };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('inspector accepts only the owning frame/request and serializes replies, cancellation and fresh sessions', async t => {
  const { inspector, ipcMain, windows, result, reply } = inspectorFixture(t);
  const first = inspector.inspect('first'), second = inspector.inspect('second'); await tick(); const old = windows[0], id = old.request.id;
  ipcMain.emit('image-inspect:result', { sender: {}, senderFrame: {} }, { id, result }); assert.equal(inspector.pending.id, id);
  ipcMain.emit('image-inspect:result', { sender: old.webContents, senderFrame: {} }, { id, result }); assert.equal(inspector.pending.id, id);
  ipcMain.emit('image-inspect:result', { sender: old.webContents, senderFrame: old.webContents.mainFrame }, { id: id + 10, result }); assert.equal(inspector.pending.id, id);
  reply(old); assert.deepEqual(await first, result); await tick(); assert.equal(old.request.file, 'second'); reply(old); await second;
  ipcMain.emit('image-inspect:result', { sender: old.webContents, senderFrame: old.webContents.mainFrame }, {});
  const controller = new AbortController(), canceled = inspector.inspect('cancel', { signal: controller.signal }), rejected = assert.rejects(canceled, { name: 'AbortError' });
  await tick(); controller.abort(); await rejected; assert.equal(old.isDestroyed(), true);
  const fresh = inspector.inspect('fresh'); await tick(); const next = windows[1];
  old.webContents.emit('render-process-gone'); reply(old); assert.equal(inspector.window, next); reply(next); assert.deepEqual(await fresh, result);
  await inspector.close(); await assert.rejects(inspector.inspect('closed'), /停止/); assert.equal(ipcMain.listenerCount('image-inspect:result'), 0);
});
test('inspector timeout, crash, invalid replies and shutdown reject pending work without blocking a later session', async t => {
  const { inspector, windows, reply } = inspectorFixture(t);
  inspector.timeout = 10; await assert.rejects(inspector.inspect('timeout'), /超时/); assert.equal(windows[0].isDestroyed(), true); inspector.timeout = 30000;
  const crash = inspector.inspect('crash'), crashed = assert.rejects(crash, /意外退出/); await tick(); windows[1].webContents.emit('render-process-gone'); await crashed;
  const invalid = inspector.inspect('invalid'), rejected = assert.rejects(invalid, /无效结果/); await tick(); reply(windows[2], {}); await rejected;
  const active = inspector.inspect('shutdown'), closed = assert.rejects(active, /停止/); await tick(); await inspector.close(); await closed;
});
test('path-based rotations inspect a private source snapshot and output without bringing PNG bytes back to the caller', async t => {
  const directory = await fixture(t), buffer = png(), source = path.join(directory, `${hash(buffer)}.png`); await fs.writeFile(source, buffer);
  const checks = [];
  const processor = new ImageProcessor(directory, async (command, request) => {
    assert.equal(command, 'image-rotate'); assert.equal((await fs.stat(request.input)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(request.input))).mode & 0o777, 0o700);
    assert.deepEqual(await fs.readFile(request.input), buffer); await fs.writeFile(request.output, png(2, 3)); return { ok: true };
  }); t.after(() => processor.close());
  const inspect = async (file, options) => { checks.push(options); const data = await fs.readFile(file); return { size: { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }, signature: hash(data) }; };
  const result = await processor.rotateFile(source, 1, inspect); assert.deepEqual(result, { size: { width: 2, height: 3 }, signature: hash(png(2, 3)) });
  assert.equal(checks[0].expectedHash, hash(buffer)); assert.equal(checks.every(value => value.preview === false), true); assert.equal(result.buffer, undefined);
  assert.deepEqual(await fs.readdir(directory), [path.basename(source)]); assert.deepEqual(await fs.readFile(source), buffer);
  await assert.rejects(processor.rotateFile(source, 1, async () => { throw new Error('checksum failure'); }), /checksum failure/);
  assert.deepEqual(await fs.readdir(directory), [path.basename(source)]);
});
test('path-based rotation cancellation and shutdown wait for inspection/native work before removing owned snapshots', async t => {
  const directory = await fixture(t), source = path.join(directory, `${hash(png())}.png`); await fs.writeFile(source, png());
  let started; const ready = new Promise(resolve => { started = resolve; });
  const processor = new ImageProcessor(directory, async (_command, _request, { signal }) => {
    started(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 20), { once: true }));
  });
  const inspect = async () => ({ size: { width: 3, height: 2 }, signature: hash(png()) });
  const operation = processor.rotateFile(source, 1, inspect), rejected = assert.rejects(operation, { name: 'AbortError' });
  await ready; assert.equal((await fs.readdir(directory)).length, 2); await processor.close(); await rejected;
  assert.deepEqual(await fs.readdir(directory), [path.basename(source)]); assert.deepEqual(await fs.readFile(source), png());
});
