const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ContentFiles, validOCR } = require('./content-files');

function destination(file, directories) {
  const target = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    const relative = path.relative(fs.realpathSync(directory), target), parts = relative.toLowerCase().split(path.sep);
    if (!relative || ['assets', 'contents', 'search-cache'].includes(parts[0]) || parts[0].startsWith('import-')
      || (parts.length === 1 && /^(?:library\.json|library-v2-|clipboard-history\.json|backup-before-import-|import-)/.test(parts[0]))) throw new Error('不能用导出备份覆盖应用的内容库或内部文件。');
  }
  return target;
}
async function* asset(directory, name, signal) {
  if (!/^[a-f0-9]{64}\.png$/.test(name)) throw new Error('Invalid image asset');
  const file = path.join(directory, 'assets', name), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Image asset is not a regular file');
  const digest = crypto.createHash('sha256'); let pending = Buffer.alloc(0);
  yield '"data:image/png;base64,';
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 65535, signal })) {
    digest.update(chunk);
    const value = pending.length ? Buffer.concat([pending, chunk]) : chunk, size = value.length - value.length % 3;
    if (size) yield value.subarray(0, size).toString('base64');
    pending = Buffer.from(value.subarray(size));
  }
  if (`${digest.digest('hex')}.png` !== name) throw new Error('Image asset checksum mismatch');
  if (pending.length) yield pending.toString('base64');
  yield '"';
}
async function* chunks({ data, directory, signal, onProgress }) {
  const { items, ...metadata } = data, contents = new ContentFiles(directory);
  yield `${JSON.stringify({ ...metadata, version: 2 }).slice(0, -1)},"items":[`;
  let done = 0, notifiedAt = 0;
  for (const record of items) {
    signal.throwIfAborted();
    const { contentAsset, ...fields } = record;
    const item = { ...fields, ...(contentAsset ? contents.read(contentAsset) : {}) };
    if (item.ocr && (!validOCR(item.ocr) || item.ocr.signature !== item.signature)) delete item.ocr;
    const images = [['asset', 'body'], ['originalAsset', 'originalBody'], ['foregroundAsset', 'foregroundBody']]
      .filter(([key]) => item[key]).map(([key, field]) => [item[key], field, key]);
    for (const [, field, key] of images) { delete item[key]; delete item[field]; }
    if (done) yield ',';
    const base = JSON.stringify(item); yield base.slice(0, -1); let separator = base.length > 2 ? ',' : '';
    for (const [name, field] of images) { yield `${separator}${JSON.stringify(field)}:`; yield* asset(directory, name, signal); separator = ','; }
    yield '}';
    done++;
    if (Date.now() - notifiedAt >= 100 || done === items.length) { onProgress?.(done); notifiedAt = Date.now(); }
  }
  yield ']}';
}
async function exportFile({ directory, directories = [directory], data, file, temporary, signal = new AbortController().signal, onProgress, onTemporary }) {
  const target = destination(file, directories); let committed = false, owned = false;
  try {
    signal.throwIfAborted();
    const descriptor = fs.openSync(temporary, 'wx', 0o600); owned = true;
    try { onTemporary?.(); } catch (error) { fs.closeSync(descriptor); throw error; }
    const output = fs.createWriteStream(temporary, { fd: descriptor, autoClose: true, highWaterMark: 65536 });
    await pipeline(Readable.from(chunks({ data, directory, signal, onProgress }), { objectMode: false, highWaterMark: 65536 }), output, { signal });
    signal.throwIfAborted();
    const completed = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(completed); } finally { fs.closeSync(completed); }
    signal.throwIfAborted(); fs.renameSync(temporary, target); committed = true;
    const folder = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(folder); } finally { fs.closeSync(folder); }
    return { ok: true, items: data.items.length, warning: '' };
  } catch (error) {
    if (committed) return { ok: true, items: data.items.length, warning: '备份已导出，但目录同步失败；断电耐久性尚未确认。' };
    throw error;
  } finally { if (owned && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
module.exports = { exportFile, destination };
