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
  constructor(directory, run) { this.directory = directory; this.run = run; this.active = new Map(); this.closed = false; }
  async operation(command, buffer, parameters = {}, { signal } = {}) {
    if (this.closed) throw new Error('图片处理已停止');
    const controller = new AbortController(); signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let finish, directory;
    this.active.set(controller, new Promise(resolve => { finish = resolve; }));
    try {
      const fileInput = !Buffer.isBuffer(buffer) && buffer?.file;
      if (!fileInput) pngSize(buffer); signal.throwIfAborted();
      directory = await fs.mkdtemp(path.join(this.directory, 'image-edit-'));
      await fs.chmod(directory, 0o700);
      const input = path.join(directory, 'input.png'), output = path.join(directory, 'output.png');
      let original;
      if (fileInput) {
        const stat = await fs.lstat(fileInput);
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('图片格式不可用');
        await fs.copyFile(fileInput, input, fs.constants.COPYFILE_EXCL); await fs.chmod(input, 0o600);
        original = (await buffer.inspect(input, { expectedHash: path.basename(fileInput, '.png'), preview: false, signal })).size;
      } else { await fs.writeFile(input, buffer, { mode: 0o600, flag: 'wx' }); original = pngSize(buffer); }
      await fs.writeFile(output, '', { mode: 0o600, flag: 'wx' });
      signal.throwIfAborted();
      const result = await this.run(command, { input, output, ...parameters }, { signal });
      if (!result.ok) {
        const messages = { 'no-foreground': '未找到可分离的前景主体', 'background-removal-unavailable': '此系统不支持背景移除',
          'text-recognition-failed': '图片文字识别失败，可重试', 'recognized-text-too-large': '识别结果超过大小限制',
          'foreground-segmentation-failed': '前景识别失败，可重试', 'foreground-mask-failed': '无法生成前景图像' };
        const error = new Error(messages[result.error] || '图片处理失败，原始内容未修改'); error.code = result.error; throw error;
      }
      if (command === 'image-ocr') return result;
      if ((await fs.stat(output)).size > 64 * 1024 * 1024) throw new Error('无法保存编辑后的图片');
      if (fileInput) {
        const inspected = await buffer.inspect(output, { preview: false, signal });
        const expected = parameters.turns % 2 ? { width: original.height, height: original.width } : original;
        if (inspected.size.width !== expected.width || inspected.size.height !== expected.height) throw new Error('图片处理结果尺寸异常');
        return inspected;
      }
      const transformed = await fs.readFile(output), size = pngSize(transformed);
      const expected = command === 'image-rotate' && parameters.turns % 2 ? { width: original.height, height: original.width } : original;
      if (size.width !== expected.width || size.height !== expected.height) throw new Error('图片处理结果尺寸异常');
      return { buffer: transformed, size };
    } finally {
      try { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
      finally { this.active.delete(controller); finish(); }
    }
  }
  rotate(buffer, turns, options) {
    if (![1, 2, 3].includes(turns)) return Promise.reject(new Error('Invalid rotation'));
    return this.operation('image-rotate', buffer, { turns }, options);
  }
  rotateFile(file, turns, inspect, options) {
    if (![1, 2, 3].includes(turns)) return Promise.reject(new Error('Invalid rotation'));
    return this.operation('image-rotate', { file, inspect }, { turns }, options);
  }
  cutout(buffer, options) { return this.operation('image-cutout', buffer, {}, options); }
  recognize(buffer, options) { return this.operation('image-ocr', buffer, {}, options); }
  async close() {
    this.closed = true;
    const pending = [...this.active.values()]; for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(pending);
  }
}

const imageKey = ({ turns, backgroundRemoved }) => `${turns}:${backgroundRemoved ? 1 : 0}`;
class ImageDraft {
  constructor({ original, current = original, turns = 0, backgroundRemoved = false, foreground, transform, cutout }) {
    if (![0, 1, 2, 3].includes(turns)) throw new Error('Invalid saved rotation');
    if (backgroundRemoved && !foreground) throw new Error('缺少可恢复的前景图片');
    this.original = original; this.transform = transform; this.cutout = cutout; this.controller = new AbortController();
    this.initial = { turns, backgroundRemoved }; this.history = [this.initial]; this.index = 0; this.busy = false; this.disposed = false;
    this.foreground = foreground;
    this.cache = new Map([['0:0', { buffer: original, size: pngSize(original) }], [imageKey(this.initial), { buffer: current, size: pngSize(current) }]]);
    if (foreground) this.cache.set('0:1', { buffer: foreground, size: pngSize(foreground) });
  }
  get current() { return this.history[this.index]; }
  get turns() { return this.current.turns; }
  get image() { return this.cache.get(imageKey(this.current)); }
  state() { return { ...this.current, changed: imageKey(this.current) !== imageKey(this.initial), canUndo: this.index > 0,
    canRedo: this.index < this.history.length - 1, busy: this.busy, canRemoveBackground: !!this.cutout || !!this.foreground }; }
  async apply(action) {
    if (this.disposed) throw new Error('预览已关闭');
    if (this.busy) throw new Error('图片正在处理中');
    let next = { ...this.current };
    if (action === 'undo' && this.index > 0) next = this.history[this.index - 1];
    else if (action === 'redo' && this.index < this.history.length - 1) next = this.history[this.index + 1];
    else if (action === 'left' || action === 'right') next.turns = (this.turns + (action === 'right' ? 1 : 3)) % 4;
    else if (action === 'background' && (this.cutout || this.foreground || next.backgroundRemoved)) next.backgroundRemoved = !next.backgroundRemoved;
    else if (action === 'restore') next = { turns: 0, backgroundRemoved: false };
    else throw new Error('此编辑操作不可用');
    this.busy = true;
    try {
      if (next.backgroundRemoved && !this.foreground) {
        const foreground = await this.cutout(this.original, { signal: this.controller.signal });
        if (this.disposed) throw new Error('预览已关闭');
        this.foreground = foreground.buffer; this.cache.set('0:1', foreground);
      }
      const key = imageKey(next), base = this.cache.get(next.backgroundRemoved ? '0:1' : '0:0');
      const image = this.cache.get(key) || await this.transform(base.buffer, next.turns, { signal: this.controller.signal });
      if (this.disposed) throw new Error('预览已关闭');
      this.cache.set(key, image);
      if (action === 'undo') this.index -= 1;
      else if (action === 'redo') this.index += 1;
      else if (key !== imageKey(this.current)) {
        this.history = this.history.slice(0, this.index + 1); this.history.push(next);
        if (this.history.length > 128) this.history.shift();
        this.index = this.history.length - 1;
      }
    } finally { this.busy = false; }
    return this.state();
  }
  markSaved() { if (this.busy || this.disposed) throw new Error('图片编辑尚未完成'); this.initial = { ...this.current }; }
  dispose() { this.disposed = true; this.controller.abort(); this.cache.clear(); }
}
module.exports = { ImageProcessor, ImageDraft, pngSize };
