const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { hash } = require('./store');
const { pngSize } = require('./image-editor');
const { decodedImageSignature } = require('./clipboard');
const { thumbnail } = require('./media');

async function inspectPNG(file, { expectedHash, preview = true } = {}, nativeImage) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 33 || stat.size > 64 * 1024 * 1024) throw new Error('图片格式不可用');
    // Read at most the observed size plus one byte, even if the file grows.
    buffer = Buffer.alloc(stat.size + 1); let bytes = 0;
    while (bytes < buffer.length) { const result = await handle.read(buffer, bytes, buffer.length - bytes, null); if (!result.bytesRead) break; bytes += result.bytesRead; }
    if (bytes !== stat.size) throw new Error('图片文件在校验期间发生变化');
    buffer = buffer.subarray(0, bytes);
  } finally { await handle.close(); }
  const size = pngSize(buffer);
  if (expectedHash && (!/^[a-f0-9]{64}$/.test(expectedHash) || hash(buffer) !== expectedHash)) throw new Error('备份图片校验失败。');
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty() || image.getSize().width !== size.width || image.getSize().height !== size.height) throw new Error('备份图片无法完整解码。');
  return { size, signature: decodedImageSignature(image), ...(preview ? { preview: thumbnail(image) } : {}) };
}
module.exports = { inspectPNG };
