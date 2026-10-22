const fs = require('node:fs/promises');
const { fileURLToPath } = require('node:url');
const { selectionIDs } = require('./selection');

const CHANGED = '所选内容或窗口已改变，请重新选择后打开。';
const FILE_CHANGED = '原始文件已移动、删除或替换，请重新选择后打开。';
const executable = /\.(?:app|command|sh|bash|zsh|scpt|applescript|workflow|action|jar|exe|com|bat|cmd|ps1|desktop|webloc|inetloc|url)$/i;
async function fileIdentity(file) {
  try {
    const real = await fs.realpath(file), stat = await fs.stat(real, { bigint: true });
    if (!stat.isFile() && !stat.isDirectory()) throw Error();
    return { token: [real, stat.dev, stat.ino, stat.birthtimeNs, stat.mtimeNs, stat.size, stat.mode].join('\0'),
      risky: executable.test(file) || executable.test(real) || (stat.isFile() && (stat.mode & 0o111n) !== 0n) };
  } catch { throw Error(FILE_CHANGED); }
}

class ItemOpener {
  constructor({ store, openURL, openPath, confirm }) { Object.assign(this, { store, openURL, openPath, confirm }); this.busy = false; }
  async open(value, { index, current = () => true } = {}) {
    if (this.busy) throw Error('正在打开项目，请稍候。');
    this.busy = true;
    let opened = 0;
    try {
      const ids = selectionIDs(value);
      if (ids.length > 128 || (index !== undefined && (ids.length !== 1 || !Number.isInteger(index) || index < 0))) throw Error('打开选择无效或过大，请减少选择。');
      let bytes = 0;
      const sources = ids.map(id => {
        const item = this.store.get(id);
        if (!item || !['link', 'file'].includes(item.type)) throw Error('请选择链接或文件；混选其他类型不能打开。');
        bytes += Buffer.byteLength(item.body);
        if (bytes > 1024 * 1024) throw Error('打开内容过大，请减少选择。');
        return { id, type: item.type, body: item.body, signature: item.signature };
      });
      const verify = () => {
        if (!current()) throw Error(CHANGED);
        for (const source of sources) {
          const item = this.store.get(source.id);
          if (!item || item.signature !== source.signature || item.type !== source.type || item.body !== source.body) throw Error(CHANGED);
        }
      };
      const resources = new Map();
      for (const source of sources) {
        if (source.type === 'link') {
          const address = source.body.trim();
          if (index !== undefined || !/^https?:\/\//i.test(address) || /[\u0000-\u0020\u007f]/.test(address)) throw Error('此链接不能安全打开，仅支持完整的 HTTP(S) 链接。');
          let url;
          try { url = new URL(address); } catch { throw Error('此链接无效。'); }
          if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw Error('此链接不能安全打开。');
          resources.set(`url:${url.href}`, { kind: 'url', value: url.href, risky: !!(url.username || url.password) });
        } else {
          const entries = source.body.split(/\r?\n/).filter(Boolean);
          if (!entries.length || (index !== undefined && index >= entries.length)) throw Error('文件选择无效。');
          for (const entry of index === undefined ? entries : [entries[index]]) {
            let file;
            try {
              const url = new URL(entry);
              if (url.search || url.hash) throw Error();
              file = fileURLToPath(url);
            } catch { throw Error('文件地址无效。'); }
            resources.set(`file:${file}`, { kind: 'file', value: file });
            if (resources.size > 128) throw Error('一次最多打开128个链接或文件，请减少选择。');
          }
        }
      }
      if (resources.size > 128) throw Error('一次最多打开128个链接或文件，请减少选择。');
      for (const resource of resources.values()) if (resource.kind === 'file') Object.assign(resource, await fileIdentity(resource.value));
      verify();
      const risky = [...resources.values()].some(resource => resource.risky);
      if ((risky || resources.size > 10) && !await this.confirm({ count: resources.size, risky })) return { ok: false, cancelled: true, opened: 0 };
      // Recheck the whole group after confirmation, before any OS dispatch.
      // Launches already accepted by the OS cannot be rolled back.
      for (const resource of resources.values()) if (resource.kind === 'file' && (await fileIdentity(resource.value)).token !== resource.token) throw Error(FILE_CHANGED);
      verify();
      for (const resource of resources.values()) {
        if (resource.kind === 'file' && (await fileIdentity(resource.value)).token !== resource.token) throw Error(FILE_CHANGED);
        verify();
        try {
          if (resource.kind === 'url') await this.openURL(resource.value);
          else { const error = await this.openPath(resource.value); if (error) throw Error(); }
        } catch { throw Error('系统未能打开项目，请检查默认应用和访问权限后重试。'); }
        opened++;
      }
      return { ok: true, opened };
    } catch (error) {
      return { ok: false, opened, error: opened ? `已交给系统打开${opened}项，其余未打开。${error.message}` : error.message };
    } finally { this.busy = false; }
  }
}
module.exports = { ItemOpener };
