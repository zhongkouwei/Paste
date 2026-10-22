const path = require('node:path');
const { pngSize } = require('./image-editor');
const validApplicationID = value => typeof value === 'string' && /^[\w.-]{1,200}$/.test(value);
async function captureSource(read, ownPID) {
  const value = await read();
  return value && Number.isInteger(value.pid) && value.pid > 0 && value.pid !== ownPID && validApplicationID(value.bundleId)
    && !/paste-easy|pastelike/i.test(value.bundleId) ? value : null;
}
function normalizeApplication(value) {
  if (!value || !validApplicationID(value.bundleId) || typeof value.available !== 'boolean') throw new Error('无法读取应用程序标识。');
  const result = { bundleId: value.bundleId, name: typeof value.name === 'string' && value.name.length && value.name.length <= 1000 ? value.name : value.bundleId, available: value.available };
  try {
    if (typeof value.icon === 'string' && value.icon.length <= 65536 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.icon)) {
      const bytes = Buffer.from(value.icon.slice(22), 'base64'), size = pngSize(bytes);
      if (bytes.toString('base64') === value.icon.slice(22) && size.width <= 64 && size.height <= 64) result.icon = value.icon;
    }
  } catch { /* Display metadata cannot weaken an exclusion rule. */ }
  return result;
}
class ApplicationCatalog {
  constructor(read) { this.read = read; this.cache = new Map(); }
  remember(value) {
    if (!value.available) return value;
    this.cache.delete(value.bundleId); this.cache.set(value.bundleId, value);
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
  async selected(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 32 || paths.some(value => typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || value.includes('\0'))) throw new Error('一次请选择 1 到 32 个应用程序。');
    const reply = await this.read({ paths });
    if (!reply.ok || !Array.isArray(reply.applications) || reply.applications.length !== paths.length) throw new Error('所选项目不是有效的 macOS 应用程序。');
    const values = reply.applications.map(normalizeApplication);
    if (values.some(value => !value.available)) throw new Error('无法读取所选应用程序。');
    values.forEach(value => this.remember(value)); return [...new Set(values.map(value => value.bundleId))];
  }
  async metadata(ids) {
    if (!Array.isArray(ids) || ids.length > 32 || ids.some(value => !validApplicationID(value))) throw new Error('无效的应用程序查询。');
    const valuesByID = new Map(ids.filter(id => this.cache.has(id)).map(id => [id, this.cache.get(id)]));
    const missing = [...new Set(ids)].filter(id => !valuesByID.has(id));
    if (missing.length) {
      const reply = await this.read({ identifiers: missing });
      if (!reply.ok || !Array.isArray(reply.applications) || reply.applications.length !== missing.length) throw new Error('无法读取应用程序信息。');
      const values = reply.applications.map(normalizeApplication);
      if (values.some((value, n) => value.bundleId !== missing[n])) throw new Error('应用程序查询结果不匹配。');
      values.forEach(value => valuesByID.set(value.bundleId, value));
    }
    return ids.map(id => this.remember(valuesByID.get(id)));
  }
}
module.exports = { ApplicationCatalog, normalizeApplication, validApplicationID, captureSource };
