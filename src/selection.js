const { fileDetails } = require('./transfers');
const { nativeTextMatches } = require('./rich-text');
const MAX_BYTES = 16 * 1024 * 1024;
function selectionIDs(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10000 || value.some(id => typeof id !== 'string' || !id.length || id.length > 256)
      || new Set(value).size !== value.length) throw Error('所选项目无效，请重新选择。');
  return [...value];
}
class SelectionService {
  constructor({ store, readImage, richText, composeHTML, composeNative }) { Object.assign(this, { store, readImage, richText, composeHTML, composeNative }); this.jobs = new Map(); }
  prepare(ids, options) {
    const controller = new AbortController();
    const operation = this.build(ids, options, controller.signal).finally(() => this.jobs.delete(controller));
    this.jobs.set(controller, operation); return operation;
  }
  async build(ids, { plain = false } = {}, signal) {
    if (this.closed) throw Error('内容合并已停止'); signal.throwIfAborted();
    ids = selectionIDs(ids);
    const references = ids.map(id => { const item = this.store.getMetadata(id); if (!item) throw Error('所选项目已被删除，请重新选择。'); return { id, signature: item.signature, type: item.type }; });
    const files = references.filter(item => item.type === 'file');
    if (files.length && files.length !== references.length) throw Error('文件与文字或图片暂不能合并粘贴，请分别选择；剪贴板未修改。');
    if (plain && references.some(item => ['image', 'file'].includes(item.type))) throw Error('所选项目包含图片或文件，无法全部按纯文本粘贴；剪贴板未修改。');
    let bytes = 0;
    const budget = value => { bytes += Buffer.byteLength(value || ''); if (bytes > MAX_BYTES) throw Error('合并内容超过16 MiB，请减少选择；剪贴板未修改。'); };
    const parts = [], paths = [], bodies = [];
    let rich = false;
    for (const reference of references) {
      signal.throwIfAborted();
      const item = this.store.get(reference.id);
      if (!item || item.signature !== reference.signature) throw Error('所选内容已改变，请重新选择。');
      if (files.length) {
        const entries = fileDetails(item); if (!entries.length || entries.some(file => !file.exists)) throw Error('原始文件已移动或删除，剪贴板未修改。');
        const urls = item.body.split(/\r?\n/).filter(Boolean); urls.forEach(budget); paths.push(...urls); continue;
      }
      if (item.type === 'image') {
        const image = this.readImage(item);
        if (!Buffer.isBuffer(image) || !image.length || image.length * 4 / 3 > 8 * 1024 * 1024 - 32) throw Error('所选图片过大或不可用，无法合并；剪贴板未修改。');
        const data = image.toString('base64'); budget(data);
        parts.push({ image: data, title: item.title || '图片' }); bodies.push(item.title || '图片'); rich = true; continue;
      }
      const body = item.body.toWellFormed(); budget(body); bodies.push(body);
      let html = plain ? '' : (item.html || '');
      if (!plain && !html && item.rtf) {
        budget(item.rtf); const result = await this.richText.read(item.rtf, { signal }); signal.throwIfAborted();
        if (!nativeTextMatches(body, result.text)) throw Error('所选RTF与正文不一致，无法合并；剪贴板未修改。'); html = result.html;
      }
      budget(html); rich ||= !!html; parts.push({ text: body, html });
    }
    let item;
    if (files.length) {
      const urls = [...new Set(paths)]; if (urls.length > 10000 || Buffer.byteLength(urls.join('\n')) > 4 * 1024 * 1024 - 1024) throw Error('所选文件列表过大，剪贴板未修改。');
      item = { type: 'file', body: urls.join('\n') };
    } else {
      const body = bodies.join('\n'); if (Buffer.byteLength(body) > MAX_BYTES) throw Error('合并内容超过16 MiB，剪贴板未修改。');
      item = { type: 'text', body };
      if (rich && !plain) {
        const result = await this.composeHTML(parts, { signal }); signal.throwIfAborted();
        if (typeof result?.html !== 'string' || Buffer.byteLength(result.html) > MAX_BYTES || !Array.isArray(result.fragments) || result.fragments.length !== parts.length) throw Error('无法完整合并所选格式，剪贴板未修改。');
        const segments = parts.map((part, index) => part.image ? { image: part.image } : { text: part.text, html: result.fragments[index] || '' });
        const native = await this.composeNative(segments, { signal }); signal.throwIfAborted();
        if (native?.ok !== true || native.attachments !== result.images
            || (native.attachments ? typeof native.rtfd !== 'string' || !native.rtfd.length : typeof native.rtf !== 'string' || !native.rtf.startsWith('{\\rtf'))) throw Error('系统无法完整合并所选格式，剪贴板未修改。');
        item = { ...item, html: result.html, ...(native.rtfd ? { rtfd: native.rtfd } : { rtf: native.rtf }) };
      }
    }
    return { item, references };
  }
  async close() { this.closed = true; for (const controller of this.jobs.keys()) controller.abort(Error('内容合并已停止，剪贴板未修改。')); await Promise.allSettled([...this.jobs.values()]); }
  verify(references) {
    if (references.some(reference => this.store.getMetadata(reference.id)?.signature !== reference.signature)) throw Error('合并期间所选内容已改变或删除，剪贴板未修改，请重新选择。');
  }
}
module.exports = { SelectionService, selectionIDs };
