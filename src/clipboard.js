const { hash } = require('./store');

// Electron 45 uses asynchronous ClipboardItem objects. Read every format from
// the same item so text and rich formats cannot come from different copies.
class ClipboardService {
  constructor({ clipboard, ClipboardItem, nativeImage }) { Object.assign(this, { clipboard, ClipboardItem, nativeImage }); }

  async read() {
    const entries = await this.clipboard.read();
    const formats = entries.flatMap(entry => entry.types);
    const first = entries[0];
    if (!first) return { formats: [], text: '', html: '', rtf: '', image: null, files: [] };
    const text = async type => first.types.includes(type) ? (await first.getType(type)).text() : '';
    const [plain, html, rtf, uri] = await Promise.all([text('text/plain'), text('text/html'), text('text/rtf'), text('text/uri-list')]);
    let files = uri.split(/\r?\n/).filter(line => line.startsWith('file://'));
    const nativeFile = first.types.find(type => /osclipboard.*public\.file-url/.test(type));
    if (!files.length && nativeFile) files = [(await first.getType(nativeFile)).text()].filter(Boolean);
    // Resolve nested promises before using the native file payload.
    files = (await Promise.all(files)).filter(file => file.startsWith('file://'));
    let image = null;
    if (first.types.includes('image/png') && !files.length) image = Buffer.from(await (await first.getType('image/png')).arrayBuffer());
    const value = { formats, text: plain, html, rtf, image, files };
    value.signature = image ? hash(image) : files.length ? hash(`file:${files.join('\n')}`) : hash(`text:${plain}\nhtml:${html}\nrtf:${rtf}`);
    return value;
  }

  async write(item, { plain = false, image } = {}) {
    let contents;
    if (item.type === 'image') {
      const buffer = image || this.nativeImage.createFromDataURL(item.body).toPNG();
      contents = { 'image/png': new Blob([buffer], { type: 'image/png' }) };
    } else if (item.type === 'file') {
      const files = item.body.split('\n').filter(file => file.startsWith('file://'));
      if (!files.length) throw new Error('Invalid file clipboard item');
      await this.clipboard.write(files.map(file => new this.ClipboardItem({ 'text/uri-list': file,
        'electron application/osclipboard;format="public.file-url"': new Blob([file]) })));
      return;
    } else {
      contents = { 'text/plain': item.body };
      if (!plain) { if (item.html) contents['text/html'] = item.html; if (item.rtf) contents['text/rtf'] = item.rtf; }
    }
    await this.clipboard.write([new this.ClipboardItem(contents)]);
  }
}
module.exports = { ClipboardService };
