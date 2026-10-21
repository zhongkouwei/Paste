const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');

function fileDetails(item) {
  if (item.type !== 'file') return [];
  return item.body.split(/\r?\n/).filter(Boolean).map(uri => {
    try {
      const file = fileURLToPath(uri);
      const stats = fs.statSync(file);
      return { path: file, name: path.basename(file), exists: true, directory: stats.isDirectory(), size: stats.size };
    } catch { return { name: uri.split('/').pop() || '文件', exists: false }; }
  });
}

class Transfers {
  constructor(store) {
    this.store = store;
    this.directory = path.join(store.directory, 'transfers');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  files(item) {
    if (item.type === 'file') {
      const files = fileDetails(item);
      if (!files.length || files.some(file => !file.exists)) throw new Error('原始文件已移动或删除，无法拖出或分享。');
      return files.map(file => file.path);
    }
    if (item.type !== 'image') return [];
    const buffer = item.asset ? this.store.readAsset(item.asset) : Buffer.from(item.body.split(',')[1] || '', 'base64');
    if (!buffer.length) throw new Error('原始图片不可用');
    const directory = path.join(this.directory, crypto.randomUUID());
    fs.mkdirSync(directory, { mode: 0o700 });
    const name = (item.renamed ? item.title : 'Image').replace(/[\x00-\x1f/\\:*?"<>|]/g, '_').slice(0, 100).replace(/\.png$/i, '') || 'Image';
    const file = path.join(directory, `${name}.png`);
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    return [file];
  }

  sharingItem(item) {
    if (['file', 'image'].includes(item.type)) return { filePaths: this.files(item) };
    if (item.type === 'link') {
      try {
        const url = new URL(item.body);
        if (['http:', 'https:'].includes(url.protocol)) return { urls: [url.href] };
      } catch { /* An edited link can become plain text. */ }
    }
    return { texts: [item.body] };
  }
}
module.exports = { Transfers, fileDetails };
