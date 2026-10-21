const fs = require('node:fs/promises');
const path = require('node:path');

function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.length > 64 * 1024 * 1024
    || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || buffer.readUInt32BE(8) !== 13
    || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('图片格式不可用');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > 64000000) throw new Error('图片尺寸超过编辑限制（6400 万像素）');
  return { width, height };
}

class ImageProcessor {
  constructor(directory, run) { this.directory = directory; this.run = run; }
  async rotate(buffer, turns) {
    pngSize(buffer);
    if (![1, 2, 3].includes(turns)) throw new Error('Invalid rotation');
    const directory = await fs.mkdtemp(path.join(this.directory, 'image-edit-'));
    try {
      await fs.chmod(directory, 0o700);
      const input = path.join(directory, 'input.png'), output = path.join(directory, 'output.png');
      await fs.writeFile(input, buffer, { mode: 0o600, flag: 'wx' });
      await fs.writeFile(output, '', { mode: 0o600, flag: 'wx' });
      const result = await this.run('image-rotate', { input, output, turns });
      if (!result.ok || (await fs.stat(output)).size > 64 * 1024 * 1024) throw new Error('无法保存编辑后的图片');
      const transformed = await fs.readFile(output), size = pngSize(transformed);
      const original = pngSize(buffer), expected = turns % 2 ? { width: original.height, height: original.width } : original;
      if (size.width !== expected.width || size.height !== expected.height) throw new Error('图片旋转结果尺寸异常');
      return { buffer: transformed, size };
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
}

class ImageDraft {
  constructor({ original, current = original, turns = 0, transform }) {
    if (![0, 1, 2, 3].includes(turns)) throw new Error('Invalid saved rotation');
    this.original = original; this.transform = transform; this.initialTurns = turns;
    this.history = [turns]; this.index = 0; this.busy = false; this.disposed = false;
    this.cache = new Map([[0, { buffer: original, size: pngSize(original) }], [turns, { buffer: current, size: pngSize(current) }]]);
  }
  get turns() { return this.history[this.index]; }
  get image() { return this.cache.get(this.turns); }
  state() { return { turns: this.turns, changed: this.turns !== this.initialTurns, canUndo: this.index > 0, canRedo: this.index < this.history.length - 1, busy: this.busy }; }
  async apply(action) {
    if (this.disposed) throw new Error('预览已关闭');
    if (this.busy) throw new Error('图片正在处理中');
    let turns;
    if (action === 'undo' && this.index > 0) turns = this.history[this.index - 1];
    else if (action === 'redo' && this.index < this.history.length - 1) turns = this.history[this.index + 1];
    else if (action === 'left' || action === 'right') turns = (this.turns + (action === 'right' ? 1 : 3)) % 4;
    else if (action === 'restore') turns = 0;
    else throw new Error('此编辑操作不可用');
    this.busy = true;
    try {
      const image = this.cache.get(turns) || await this.transform(this.original, turns);
      if (this.disposed) throw new Error('预览已关闭');
      this.cache.set(turns, image);
      if (action === 'undo') this.index -= 1;
      else if (action === 'redo') this.index += 1;
      else if (turns !== this.turns) {
        this.history = this.history.slice(0, this.index + 1); this.history.push(turns);
        if (this.history.length > 128) this.history.shift();
        this.index = this.history.length - 1;
      }
    } finally { this.busy = false; }
    return this.state();
  }
  dispose() { this.disposed = true; this.cache.clear(); }
}
module.exports = { ImageProcessor, ImageDraft, pngSize };
