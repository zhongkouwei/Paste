const fs = require('node:fs');
const path = require('node:path');
const { TYPES, DEFAULT_SETTINGS, sanitizeSettings } = require('./model');
const { ContentFiles, validOCR } = require('./content-files');
const { textSignature, hash } = require('./store');
const { pngSize } = require('./image-editor');
const { fileURLToPath } = require('node:url');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const bounded = (value, limit) => typeof value === 'string' && Buffer.byteLength(value) <= limit;
const copy = value => JSON.parse(JSON.stringify(value));
const unsafeID = value => /[\x00-\x1f\x7f-\x9f]/.test(value) || !value.isWellFormed();

class ImportNormalizer {
  constructor(directory, validateImage, signal) { Object.assign(this, { directory, validateImage, signal }); this.contents = new ContentFiles(directory); this.records = []; this.ids = new Set(); this.images = new Map(); this.rotations = new Map(); this.metadataBytes = 0; }
  async image(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('data:image/png;base64,') || uri.length > 90 * 1024 ** 2) throw new Error('图片必须是有界的内嵌 PNG，不能引用本机文件或网络地址。');
    const encoded = uri.slice(22); if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('图片编码无效。');
    const buffer = Buffer.from(encoded, 'base64'); if (buffer.toString('base64') !== encoded) throw new Error('图片编码不完整。'); pngSize(buffer);
    const name = `${hash(buffer)}.png`; if (this.images.has(name)) return this.images.get(name);
    fs.writeFileSync(path.join(this.directory, 'assets', name), buffer, { mode: 0o600, flag: 'wx' });
    const result = await this.validateImage(name); this.signal?.throwIfAborted();
    if (!result || !/^[a-f0-9]{64}$/.test(result.signature) || !Number.isInteger(result.size?.width) || !Number.isInteger(result.size?.height)) throw new Error('图片解码校验失败。');
    const value = { ...result, asset: name }; this.images.set(name, value); return value;
  }
  async add(input) {
    this.signal?.throwIfAborted();
    if (this.records.length >= 100000) throw new Error('备份项目超过 100000 项限制。');
    if (!input || Array.isArray(input) || typeof input !== 'object' || !id(input.id) || this.ids.has(input.id) || !TYPES.includes(input.type)) throw new Error('备份项目类型、ID 无效或重复。');
    if ('contentAsset' in input || ['asset', 'originalAsset', 'foregroundAsset'].some(key => input[key] != null)) throw new Error('外部备份不能引用本机内容或图片文件。');
    if (!bounded(input.body, 16 * 1024 ** 2) && input.type !== 'image') throw new Error('文本超过 16 MiB 限制。');
    if (!bounded(input.createdAt, 100) || !Number.isFinite(Date.parse(input.createdAt)) || !Array.isArray(input.boardIds || []) || (input.boardIds || []).length > 1000 || (input.boardIds || []).some(value => !id(value))) throw new Error('备份日期或 Pinboard 成员无效。');
    if (input.isFavorite !== undefined && typeof input.isFavorite !== 'boolean') throw new Error('固定状态无效。');
    const item = { id: input.id, type: input.type, body: input.body, title: input.title ?? '', boardIds: [...new Set(input.boardIds || [])],
      createdAt: input.createdAt, isFavorite: !!input.isFavorite, signature: '' };
    if (!bounded(item.title, 10000)) throw new Error('项目名称超过限制。');
    for (const key of ['renamed', 'firstCopiedAt', 'note']) if (input[key] !== undefined) item[key] = input[key];
    if (item.note !== undefined && !bounded(item.note, 1024 ** 2)) throw new Error('备注超过限制。');
    if (item.renamed !== undefined && typeof item.renamed !== 'boolean') throw new Error('项目重命名状态无效。');
    if (item.firstCopiedAt !== undefined && !Number.isFinite(Date.parse(item.firstCopiedAt))) throw new Error('首次复制日期无效。');
    if (input.source) {
      if (typeof input.source !== 'object' || Array.isArray(input.source)) throw new Error('来源信息无效。');
      const source = input.source; item.source = {};
      for (const key of ['name', 'bundleId', 'color', 'icon']) if (source[key] !== undefined) {
        if (!bounded(source[key], key === 'icon' ? 2 * 1024 ** 2 : 1000)) throw new Error('来源信息无效或过大。'); item.source[key] = source[key];
      }
      if (item.source.icon && !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(item.source.icon)) throw new Error('来源图标不能引用外部资源。');
    }
    if (item.type === 'image') {
      const current = await this.image(input.body); item.body = current.asset; item.asset = current.asset; item.size = current.size;
      item.signature = current.signature; item.signatureFormat = 'pixels-v1'; item.preview = current.preview || '';
      const original = input.originalBody != null ? await this.image(input.originalBody) : current;
      const foreground = input.foregroundBody != null ? await this.image(input.foregroundBody) : null;
      for (const key of ['originalAsset', 'foregroundAsset', 'originalBody', 'foregroundBody']) if (input[key] === null) item[key] = null;
      if (input.originalBody != null) item.originalAsset = original.asset;
      if (foreground) item.foregroundAsset = foreground.asset;
      item.imageTurns = input.imageTurns ?? 0; item.backgroundRemoved = input.backgroundRemoved ?? false;
      if (![0, 1, 2, 3].includes(item.imageTurns) || typeof item.backgroundRemoved !== 'boolean' || (item.backgroundRemoved && !item.foregroundAsset)
        || ((item.imageTurns || item.backgroundRemoved) && !item.originalAsset)) throw new Error('图片编辑状态无效。');
      const sameSize = (a, b) => a.width === b.width && a.height === b.height;
      const expectedSize = item.imageTurns % 2 ? { width: original.size.height, height: original.size.width } : original.size;
      if (!sameSize(current.size, expectedSize) || (foreground && !sameSize(foreground.size, original.size))) throw new Error('图片编辑状态与图片尺寸不一致。');
      const base = item.backgroundRemoved ? foreground : original;
      let expected = base;
      if (item.imageTurns) {
        const key = `${base.asset}:${item.imageTurns}`;
        if (!this.rotations.has(key)) this.rotations.set(key, await this.validateImage(base.asset, { turns: item.imageTurns }));
        expected = this.rotations.get(key); this.signal?.throwIfAborted();
      }
      if (current.signature !== expected?.signature) throw new Error('图片编辑状态与当前像素不一致。');
    } else {
      if (item.type === 'file') for (const file of item.body.split('\n')) if (!file || fileURLToPath(file).includes('\0')) throw new Error('备份文件引用无效。');
      if (input.originalBody != null || input.foregroundBody != null) throw new Error('非图片项目不能包含图片变体。');
      for (const key of ['html', 'rtf']) if (input[key] !== undefined) {
        if (input[key] !== null && !bounded(input[key], 16 * 1024 ** 2)) throw new Error('富文本超过 16 MiB 限制。'); item[key] = input[key];
      }
      item.preview = item.body.slice(0, 2000);
      item.signature = item.type === 'file' ? hash(`file:${item.body}`) : textSignature(item.body, item.html, item.rtf);
    }
    if (input.ocr) {
      if (item.type !== 'image' || !validOCR(input.ocr) || Buffer.byteLength(JSON.stringify(input.ocr)) > 4 * 1024 ** 2 || input.ocr.signature !== input.signature) throw new Error('备份 OCR 数据无效或不属于当前图片。');
      item.ocr = { ...copy(input.ocr), signature: item.signature };
    }
    const record = this.contents.record(item); this.metadataBytes += Buffer.byteLength(JSON.stringify(record));
    if (this.metadataBytes > 64 * 1024 ** 2) throw new Error('备份展示元数据超过 64 MiB 限制。');
    this.ids.add(item.id); this.records.push(record);
  }
  finish(header) {
    const ids = new Set(), boards = header.boards.map(board => {
      if (!board || !id(board.id) || ids.has(board.id) || !bounded(board.name, 1000) || !/^#[a-f0-9]{6}$/i.test(board.color)) throw new Error('Pinboard 信息无效或重复。');
      ids.add(board.id); const value = { id: board.id, name: board.name, color: board.color };
      if (board.itemOrder !== undefined) {
        if (!Array.isArray(board.itemOrder) || board.itemOrder.length > 100000 || board.itemOrder.some(value => !id(value))) throw new Error('Pinboard 排序无效。');
        value.itemOrder = [...new Set(board.itemOrder)];
      }
      return value;
    });
    if (this.records.some(item => item.isFavorite && !item.boardIds.length) && !ids.has('favorites')) { ids.add('favorites'); boards.push({ id: 'favorites', name: '已固定', color: '#ef6259' }); }
    for (const item of this.records) {
      if (item.isFavorite && !item.boardIds.length) item.boardIds = ['favorites'];
      if (item.boardIds.some(value => !ids.has(value))) throw new Error('项目引用了不存在的 Pinboard。'); item.isFavorite = !!item.boardIds.length;
    }
    const records = new Map(this.records.map(item => [item.id, item]));
    for (const board of boards) if (board.itemOrder?.some(value => !records.get(value)?.boardIds.includes(board.id))) throw new Error('Pinboard 排序引用了无效项目。');
    const settings = sanitizeSettings(header.settings);
    for (const key of Object.keys(header.settings)) if (!(key in DEFAULT_SETTINGS) || JSON.stringify(header.settings[key]) !== JSON.stringify(settings[key])) throw new Error('备份偏好设置包含无效值。');
    // External IDs must survive HTML attributes and cannot occupy the history navigation sentinel.
    const itemIDs = new Map(), boardIDs = new Map(), usedItems = new Set(this.records.map(item => item.id)), usedBoards = new Set(boards.map(board => board.id));
    const fresh = (kind, original, used) => {
      let value, attempt = 0;
      do { value = `restored-${kind}-${hash(Buffer.from(`${attempt++}:${original}`, 'utf16le'))}`; } while (used.has(value));
      used.add(value); return value;
    };
    for (const item of this.records) if (unsafeID(item.id)) itemIDs.set(item.id, fresh('item', item.id, usedItems));
    for (const board of boards) if (board.id === 'history' || unsafeID(board.id)) boardIDs.set(board.id, fresh('board', board.id, usedBoards));
    const data = { version: 3, items: this.records.map(item => ({ ...item, id: itemIDs.get(item.id) || item.id, boardIds: item.boardIds.map(value => boardIDs.get(value) || value) })),
      boards: boards.map(board => ({ ...board, id: boardIDs.get(board.id) || board.id, ...(board.itemOrder ? { itemOrder: board.itemOrder.map(value => itemIDs.get(value) || value) } : {}) })), settings };
    fs.writeFileSync(path.join(this.directory, 'library.json'), JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    return { data, summaries: [...this.contents.summaries], bytes: header.bytes, repairedIds: itemIDs.size + boardIDs.size };
  }
}
module.exports = { ImportNormalizer };
