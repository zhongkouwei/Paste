const crypto = require('node:crypto');
const { pngSize } = require('./image-editor');

class MediaReferences {
  constructor() { this.items = new Map(); }
  get(item) {
    const preview = item.type === 'image' ? item.preview || '' : '', icon = item.source?.icon || '';
    const previous = this.items.get(item.id);
    if (previous?.preview === preview && previous?.icon === icon) return previous;
    const key = (kind, value) => typeof value === 'string' && value.startsWith('data:image/')
      ? `${kind}:${crypto.createHash('sha256').update(value).digest('hex')}` : '';
    const value = { preview, icon, previewKey: key('image', preview), iconKey: key('icon', icon) };
    this.items.set(item.id, value); return value;
  }
  retain(ids) { for (const id of this.items.keys()) if (!ids.has(id)) this.items.delete(id); }
}

function thumbnail(image, edge = 480) {
  const size = image.getSize();
  if (image.isEmpty() || !size.width || !size.height) throw new Error('图片预览不可用');
  const scale = Math.min(1, edge / Math.max(size.width, size.height));
  return image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' }).toDataURL();
}

class MediaService {
  constructor(store, nativeImage, { maxEntries = 96, maxBytes = 16 * 1024 * 1024 } = {}) {
    Object.assign(this, { store, nativeImage, maxEntries, maxBytes }); this.cache = new Map(); this.bytes = 0;
  }
  image(key, raw) {
    if (this.cache.has(key)) {
      const value = this.cache.get(key); this.cache.delete(key); this.cache.set(key, value); return value;
    }
    let value = '';
    try {
      if (typeof raw !== 'string' || raw.length > 64 * 1024 * 1024 || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) throw new Error('图片预览格式不可用');
      if (raw.startsWith('data:image/png;')) pngSize(Buffer.from(raw.slice(raw.indexOf(',') + 1), 'base64'));
      value = thumbnail(this.nativeImage.createFromDataURL(raw), key.startsWith('icon:') ? 128 : 480);
      if (value.length > this.maxBytes) value = '';
    } catch { /* Unreadable previews never remove or rewrite the original item. */ }
    this.cache.set(key, value); this.bytes += value.length;
    while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.cache.keys().next().value; this.bytes -= this.cache.get(oldest).length; this.cache.delete(oldest);
    }
    return value;
  }
  read(requests) {
    if (!Array.isArray(requests) || requests.length > 32 || requests.some(value => !value || typeof value.id !== 'string'
      || ['previewKey', 'iconKey'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || !/^(image|icon):[a-f0-9]{64}$/.test(value[key]))))) throw new Error('Invalid media selection');
    const values = new Map();
    for (const request of requests) {
      const item = this.store.getMetadata(request.id); if (!item) continue;
      const references = this.store.media.get(item);
      for (const [field, raw] of [['previewKey', 'preview'], ['iconKey', 'icon']]) {
        const key = request[field];
        if (key && key === references[field] && !values.has(key)) values.set(key, this.image(key, references[raw]));
      }
    }
    return [...values].map(([key, value]) => ({ key, value }));
  }
}
module.exports = { MediaReferences, MediaService, thumbnail };
