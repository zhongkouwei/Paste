const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const detached = value => Buffer.from(value, 'utf16le').toString('utf16le');
function validOCR(result) {
  if (!result || !['ready', 'none', 'error'].includes(result.status) || typeof result.text !== 'string'
    || Buffer.byteLength(result.text) > 1024 * 1024 || !Array.isArray(result.lines) || result.lines.length > 10000) return false;
  let words = 0;
  return result.lines.every(line => line && typeof line.text === 'string' && (line.words === undefined
    || (Array.isArray(line.words) && (words += line.words.length) <= 20000 && line.words.every(word => typeof word?.text === 'string'))));
}
function validate(payload) {
  if (!payload || typeof payload.body !== 'string' || ['html', 'rtf', 'originalBody', 'foregroundBody']
    .some(key => payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'string')) throw new Error('Invalid clipboard content payload');
}

class ContentFiles {
  constructor(directory) {
    this.directory = path.join(directory, 'contents'); this.summaries = new Map();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  read(name) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Invalid clipboard content asset');
    const raw = fs.readFileSync(path.join(this.directory, name));
    if (`${digest(raw)}.json` !== name) throw new Error('Clipboard content checksum mismatch');
    const payload = JSON.parse(raw);
    validate(payload);
    return { body: payload.body, ...(payload.originalBody !== undefined ? { originalBody: payload.originalBody } : {}),
      ...(payload.foregroundBody !== undefined ? { foregroundBody: payload.foregroundBody } : {}), ...(payload.html !== undefined ? { html: payload.html } : {}),
      ...(payload.rtf !== undefined ? { rtf: payload.rtf } : {}), ...(payload.ocr ? { ocr: payload.ocr } : {}) };
  }
  remember(name, payload) {
    let characters = payload.body.length;
    const pairs = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g; while (pairs.exec(payload.body)) characters--;
    const ocr = validOCR(payload.ocr) ? payload.ocr : null;
    this.summaries.set(name, { characters, body: payload.body.length <= 2000 ? detached(payload.body) : '',
      preview: detached(payload.body.slice(0, 2000)), ...(ocr ? { ocr: { hasText: !!ocr.text, status: ocr.status, signature: ocr.signature, completedAt: ocr.completedAt } } : {}) });
  }
  write(raw) {
    const name = `${digest(raw)}.json`, file = path.join(this.directory, name);
    if (fs.existsSync(file)) {
      if (digest(fs.readFileSync(file)) !== name.slice(0, -5)) throw new Error('Clipboard content checksum mismatch');
      return name;
    }
    const temporary = `${file}.tmp-${crypto.randomUUID()}`;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, raw); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, file);
      const directory = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return name;
  }
  record(item) {
    const { body, html, rtf, ocr, originalBody, foregroundBody, contentAsset, ...metadata } = item;
    if (contentAsset && body === undefined) return { ...metadata, contentAsset };
    const payload = { body, ...(originalBody !== undefined ? { originalBody } : {}), ...(foregroundBody !== undefined ? { foregroundBody } : {}),
      ...(html !== undefined ? { html } : {}), ...(rtf !== undefined ? { rtf } : {}), ...(ocr ? { ocr } : {}) };
    validate(payload);
    const raw = JSON.stringify(payload); let stored = payload;
    if (Buffer.byteLength(raw) > 16384) { const name = this.write(raw); this.remember(name, payload); stored = { contentAsset: name }; }
    return { ...metadata, ...(typeof metadata.title === 'string' ? { title: detached(metadata.title) } : {}),
      preview: item.type === 'image' ? item.preview : detached((item.preview || body).slice(0, 2000)), ...stored };
  }
  retain(items) { const names = new Set(items.map(item => item.contentAsset)); for (const name of this.summaries.keys()) if (!names.has(name)) this.summaries.delete(name); }
}
module.exports = { ContentFiles, validOCR };
