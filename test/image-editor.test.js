const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ImageDraft, ImageProcessor, pngSize } = require('../src/image-editor');

function png(width = 3, height = 2, marker = 0) {
  const buffer = Buffer.alloc(34); Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12); buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20); buffer[33] = marker;
  return buffer;
}
function fixture() {
  const original = png(), calls = [];
  const draft = new ImageDraft({ original, transform: async (input, turns) => {
    assert.equal(input, original); calls.push(turns);
    const size = turns % 2 ? { width: 2, height: 3 } : { width: 3, height: 2 };
    return { buffer: png(size.width, size.height, turns), size };
  } });
  return { draft, calls, original };
}
test('four rotations restore original bytes and never repeatedly resample edited images', async () => {
  const { draft, calls, original } = fixture();
  for (let n = 0; n < 4; n++) await draft.apply('right');
  assert.equal(draft.image.buffer, original); assert.equal(draft.state().changed, false);
  assert.deepEqual(calls, [1, 2, 3]);
  await draft.apply('undo'); assert.equal(draft.turns, 3);
  await draft.apply('redo'); assert.equal(draft.image.buffer, original);
});
test('undo, redo, restoring a previously saved original and branching history stay coherent', async () => {
  const { draft } = fixture();
  await draft.apply('left'); await draft.apply('right'); await draft.apply('undo');
  await draft.apply('left'); assert.equal(draft.state().canRedo, false);
  const saved = new ImageDraft({ original: png(), current: png(2, 3, 1), turns: 1, transform: draft.transform });
  assert.equal(saved.state().changed, false);
  await saved.apply('restore'); assert.equal(saved.state().changed, true); assert.equal(saved.turns, 0);
});
test('failed or cancelled transformations never mutate the visible draft or its history', async () => {
  const { draft, original } = fixture();
  draft.transform = async () => { throw new Error('processing failed'); };
  await assert.rejects(draft.apply('right'), /processing failed/);
  assert.equal(draft.image.buffer, original); assert.equal(draft.state().canUndo, false);
  let finish; draft.transform = () => new Promise(resolve => { finish = resolve; });
  const operation = draft.apply('right');
  await assert.rejects(draft.apply('left'), /正在处理/);
  draft.dispose(); finish({ buffer: png(2, 3), size: { width: 2, height: 3 } });
  await assert.rejects(operation, /已关闭/);
});
test('processor uses private temporary files and removes them on success or failure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paste-image-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const processor = new ImageProcessor(directory, async (command, request) => {
    assert.equal(command, 'image-rotate'); assert.equal((await fs.stat(request.input)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(request.input))).mode & 0o777, 0o700);
    assert.deepEqual(await fs.readFile(request.input), png());
    await fs.writeFile(request.output, png(2, 3)); return { ok: true };
  });
  assert.deepEqual((await processor.rotate(png(), 1)).size, { width: 2, height: 3 });
  assert.deepEqual(await fs.readdir(directory), []);
  processor.run = async () => { throw new Error('helper failed'); };
  await assert.rejects(processor.rotate(png(), 1), /helper failed/);
  assert.deepEqual(await fs.readdir(directory), []);
});
test('oversized, empty or non-PNG dimensions are rejected before native processing', () => {
  assert.throws(() => pngSize(Buffer.from('not png')));
  assert.throws(() => pngSize(png(0, 2)));
  assert.throws(() => pngSize(png(100000, 100000)));
});
