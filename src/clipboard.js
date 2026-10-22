const { hash, textSignature, htmlPayload } = require('./store');
const crypto = require('node:crypto');
const { WRITE_ID_MIME, validWriteID } = require('./clipboard-ownership');

function imageSignature(buffer, nativeImage) {
  return decodedImageSignature(nativeImage.createFromBuffer(buffer));
}
function decodedImageSignature(image) {
  if (image.isEmpty()) throw new Error('图片无法解码');
  const { width, height } = image.getSize();
  // PNG encoders and NSPasteboard can change metadata without changing pixels.
  return crypto.createHash('sha256').update(`image:${width}x${height}:`).update(image.toBitmap()).digest('hex');
}

// Electron 45 uses asynchronous ClipboardItem objects. Read every format from
// the same item so text and rich formats cannot come from different copies.
class ClipboardService {
  constructor({ clipboard, ClipboardItem, nativeImage, fileBridge }) { Object.assign(this, { clipboard, ClipboardItem, nativeImage, fileBridge }); }

  async read() {
    const entries = await this.clipboard.read();
    const formats = entries.flatMap(entry => entry.types);
    const first = entries[0];
    if (!first) return { formats: [], text: '', html: '', rtf: '', image: null, files: [] };
    const text = async type => first.types.includes(type) ? (await first.getType(type)).text() : '';
    const [plain, html, rtf] = await Promise.all([text('text/plain'), text('text/html'), text('text/rtf')]);
    let clipboardWriteID;
    if (first.types.includes(WRITE_ID_MIME)) {
      const identity = await first.getType(WRITE_ID_MIME);
      if (identity.size === 36) { const value = await identity.text(); if (validWriteID(value)) clipboardWriteID = value; }
    }
    const paths = await Promise.all(entries.map(async entry => {
      if (entry.types.includes('text/uri-list')) {
        const uri = await (await entry.getType('text/uri-list')).text();
        const files = uri.split(/\r?\n/).filter(line => line.startsWith('file://'));
        if (files.length) return files;
      }
      const nativeFile = entry.types.find(type => /osclipboard.*public\.file-url/.test(type));
      const file = nativeFile ? await (await entry.getType(nativeFile)).text() : '';
      return file.startsWith('file://') ? [file] : [];
    }));
    let files = [...new Set(paths.flat())];
    if (this.fileBridge && (files.length || formats.some(type => /file-url|uri-list|filenames/i.test(type)))) {
      const native = await this.fileBridge.read();
      if (Array.isArray(native.files) && native.files.length) files = [...new Set(native.files)];
    }
    let image = null;
    if (first.types.includes('image/png') && !files.length) image = Buffer.from(await (await first.getType('image/png')).arrayBuffer());
    const value = { formats, text: plain, html, rtf, image, files, ...(clipboardWriteID ? { clipboardWriteID } : {}) };
    value.signature = image ? imageSignature(image, this.nativeImage) : files.length ? hash(`file:${files.join('\n')}`) : textSignature(plain, html, rtf);
    return value;
  }

  async write(item, { plain = false, image, writeID } = {}) {
    if (writeID !== undefined && !validWriteID(writeID)) throw new Error('Invalid clipboard write identity');
    let contents, signature;
    if (item.type === 'image') {
      const buffer = image || this.nativeImage.createFromDataURL(item.body).toPNG();
      contents = { 'image/png': new Blob([buffer], { type: 'image/png' }) };
      signature = imageSignature(buffer, this.nativeImage);
    } else if (item.type === 'file') {
      const files = item.body.split('\n').filter(file => file.startsWith('file://'));
      if (!files.length) throw new Error('Invalid file clipboard item');
      if (this.fileBridge) {
        const result = await this.fileBridge.write(files, writeID === undefined ? {} : { writeID });
        if (!result.ok) throw new Error('无法写入系统文件剪贴板，请检查原生辅助程序。');
        return hash(`file:${files.join('\n')}`);
      }
      await this.clipboard.write(files.map((file, index) => new this.ClipboardItem({ 'text/uri-list': file,
        'electron application/osclipboard;format="public.file-url"': new Blob([file]),
        ...(writeID && index === 0 ? { [WRITE_ID_MIME]: new Blob([writeID]) } : {}) })));
      return hash(`file:${files.join('\n')}`);
    } else {
      const body = item.body.toWellFormed(), html = plain ? '' : htmlPayload(item.html).toWellFormed();
      const rtf = !plain && typeof item.rtf === 'string' ? item.rtf.toWellFormed() : '';
      contents = { 'text/plain': body };
      if (html) contents['text/html'] = html; if (rtf) contents['text/rtf'] = rtf;
      signature = textSignature(body, html, rtf);
    }
    if (writeID) contents[WRITE_ID_MIME] = new Blob([writeID]);
    await this.clipboard.write([new this.ClipboardItem(contents)]);
    return signature;
  }
}
module.exports = { ClipboardService, imageSignature, decodedImageSignature };
