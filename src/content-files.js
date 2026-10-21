const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function validate(payload) {
  if (!payload || typeof payload.body !== 'string' || ['html', 'rtf', 'originalBody', 'foregroundBody']
    .some(key => payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'string')) throw new Error('Invalid clipboard content payload');
}

class ContentFiles {
  constructor(directory) {
    this.directory = path.join(directory, 'contents'); this.cache = new Map();
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
  remember(id, payload, name) { this.cache.set(id, { ...payload, stored: { contentAsset: name } }); }
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
    const { body, html, rtf, ocr, originalBody, foregroundBody, contentAsset: _old, ...metadata } = item;
    let cached = this.cache.get(item.id);
    if (!cached || cached.body !== body || cached.html !== html || cached.rtf !== rtf || cached.ocr !== ocr || cached.originalBody !== originalBody || cached.foregroundBody !== foregroundBody) {
      const payload = { body, ...(originalBody !== undefined ? { originalBody } : {}), ...(foregroundBody !== undefined ? { foregroundBody } : {}),
        ...(html !== undefined ? { html } : {}), ...(rtf !== undefined ? { rtf } : {}), ...(ocr ? { ocr } : {}) };
      validate(payload);
      const raw = JSON.stringify(payload);
      cached = { ...payload, stored: Buffer.byteLength(raw) > 16384 ? { contentAsset: this.write(raw) } : payload };
      this.cache.set(item.id, cached);
    }
    return { ...metadata, preview: item.type === 'image' ? item.preview : (item.preview || body).slice(0, 2000), ...cached.stored };
  }
  retain(ids) { for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id); }
}
module.exports = { ContentFiles };
