const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ContentFiles } = require('./content-files');
const { COLORS, TYPES, DEFAULT_SETTINGS, prune, sanitizeSettings } = require('./model');

const hash = input => crypto.createHash('sha256').update(input).digest('hex');
function htmlPayload(value = '') {
  const html = typeof value === 'string' ? value : '', prefix = "<meta charset='utf-8'>";
  // Electron's macOS clipboard adds this exact transport prefix on every read.
  // Remove only that framing, not arbitrary document metadata or HTML content.
  let offset = 0;
  while (html.startsWith(prefix, offset)) offset += prefix.length;
  return html.slice(offset);
}
const textSignature = (body, html = '', rtf = '') => hash(`text:${body}\nhtml:${htmlPayload(html)}\nrtf:${rtf}`);
class CommittedWriteError extends Error {
  constructor(cause) { super('清单已提交，但目录同步失败；当前内容已保留，断电耐久性尚未确认。', { cause }); }
}
class UnsupportedLibraryError extends Error {}
function atomicFile(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, contents); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function validOCR(result) {
  if (!result || !['ready', 'none', 'error'].includes(result.status) || typeof result.text !== 'string'
    || Buffer.byteLength(result.text) > 1024 * 1024 || !Array.isArray(result.lines) || result.lines.length > 10000) return false;
  let words = 0;
  return result.lines.every(line => line && typeof line.text === 'string' && (line.words === undefined
    || (Array.isArray(line.words) && (words += line.words.length) <= 20000 && line.words.every(word => typeof word?.text === 'string'))));
}

class ClipStore {
  constructor(directory, { now = () => new Date().toISOString(), legacyDirectories = [] } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'library.json');
    this.now = now;
    this.legacyDirectories = legacyDirectories;
    this.data = { version: 3, items: [], boards: [], settings: { ...DEFAULT_SETTINGS } };
    this.contents = new ContentFiles(directory); this.counts = new Map(); this.revision = 0;
    this.recovery = '';
    fs.mkdirSync(path.join(directory, 'assets'), { recursive: true, mode: 0o700 });
    this.load();
  }

  parse(raw) {
    const data = JSON.parse(raw);
    let items = Array.isArray(data) ? data : data.items;
    if (data.version && data.version > 3) throw new UnsupportedLibraryError('Unsupported clipboard library; use a newer application');
    if (!Array.isArray(items)) throw new Error('Invalid clipboard library');
    items = items.map(item => {
      if (!item?.contentAsset) return item;
      const { contentAsset, ...metadata } = item;
      const payload = this.contents.read(contentAsset); this.contents.remember(item.id, payload, contentAsset);
      return { ...metadata, ...payload };
    });
    const valid = items.filter(item => item && typeof item.id === 'string' && TYPES.includes(item.type)
      && typeof item.body === 'string' && typeof item.signature === 'string');
    if (valid.length !== items.length) throw new Error('Invalid clipboard library items');
    const boards = Array.isArray(data.boards) ? data.boards.filter(b => typeof b.id === 'string' && typeof b.name === 'string' && /^#[\da-f]{6}$/i.test(b.color)) : [];
    const favorites = valid.filter(item => item.isFavorite && !item.boardIds?.length);
    if (favorites.length && !boards.some(b => b.id === 'favorites')) boards.push({ id: 'favorites', name: '已固定', color: COLORS[0] });
    return { version: 3, boards, settings: sanitizeSettings(data.settings || {}), items: valid.map(item => {
      const normalized = {
      ...item, signature: ['text', 'code', 'color', 'link'].includes(item.type) ? textSignature(item.body, item.html, item.rtf) : item.signature,
      boardIds: Array.isArray(item.boardIds) ? item.boardIds.filter(id => boards.some(b => b.id === id)) : item.isFavorite ? ['favorites'] : [],
      createdAt: Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : this.now()
      };
      if (normalized.ocr && (!validOCR(normalized.ocr) || normalized.ocr.signature !== normalized.signature)) delete normalized.ocr;
      return normalized;
    }) };
  }

  load() {
    if (fs.existsSync(this.file)) {
      try { this.data = this.parse(fs.readFileSync(this.file, 'utf8')); }
      catch (error) {
        if (error instanceof UnsupportedLibraryError) throw error;
        const backup = `${this.file}.bak`;
        if (!fs.existsSync(backup)) throw new Error(`Clipboard library is damaged. Original preserved at ${this.file}`, { cause: error });
        this.data = this.parse(fs.readFileSync(backup, 'utf8'));
        fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        this.recovery = '已从备份恢复剪贴板，损坏文件已保留。';
        this.persist(false);
      }
    } else {
      const legacyFiles = [...new Set([this.directory, ...this.legacyDirectories])]
        .map(directory => path.join(directory, 'clipboard-history.json')).filter(file => fs.existsSync(file));
      if (legacyFiles.length) {
        const libraries = legacyFiles.map(file => this.parse(fs.readFileSync(file, 'utf8')));
        const items = new Map(), boards = new Map();
        for (const library of libraries) {
          for (const board of library.boards) boards.set(board.id, board);
          for (const item of library.items) {
            const previous = items.get(item.signature);
            if (previous) {
              const membership = [...new Set([...previous.boardIds, ...item.boardIds])];
              const newest = new Date(item.createdAt) > new Date(previous.createdAt) ? item : previous;
              items.set(item.signature, { ...newest, boardIds: membership, isFavorite: membership.length > 0 });
            } else items.set(item.signature, item);
          }
        }
        this.data = { ...this.data, boards: [...boards.values()], items: [...items.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) };
        this.persist();
      }
    }
  }

  persist(backup = true) {
    const temporary = `${this.file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let committed = false;
    try {
      const record = { ...this.data, items: this.data.items.map(item => this.contents.record(item)) };
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify(record)); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      const backupFile = `${this.file}.bak`, backupSource = backup && fs.existsSync(this.file) ? this.file : fs.existsSync(backupFile) ? backupFile : null;
      if (backupSource) {
        const raw = fs.readFileSync(backupSource, 'utf8'), previous = JSON.parse(raw);
        if (previous.version !== 3) {
          const legacy = path.join(this.directory, `library-v2-${hash(raw)}.json`);
          if (!fs.existsSync(legacy)) atomicFile(legacy, raw);
          const migrated = this.parse(raw);
          atomicFile(backupFile, JSON.stringify({ ...migrated, items: migrated.items.map(item => this.contents.record(item)) }));
        } else if (backupSource !== backupFile) atomicFile(backupFile, raw);
      } else atomicFile(backupFile, JSON.stringify(record));
      fs.renameSync(temporary, this.file);
      committed = true; this.revision += 1;
      const directory = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      const ids = new Set(this.data.items.map(item => item.id)); this.contents.retain(ids);
      for (const id of this.counts.keys()) if (!ids.has(id)) this.counts.delete(id);
    } catch (error) { if (committed) throw new CommittedWriteError(error); throw error; }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  mutate(action) {
    const previous = this.data;
    this.data = { ...previous, items: [...previous.items], boards: [...previous.boards] };
    try { const result = action(); this.persist(); return result; }
    catch (error) { if (!(error instanceof CommittedWriteError)) this.data = previous; throw error; }
  }

  add(snapshot) {
    if (!snapshot || !TYPES.includes(snapshot.type) || typeof snapshot.body !== 'string') throw new Error('Invalid clipboard snapshot');
    return this.mutate(() => {
      const signature = ['text', 'code', 'color', 'link'].includes(snapshot.type) ? textSignature(snapshot.body, snapshot.html, snapshot.rtf) : snapshot.signature || hash(`${snapshot.type}:${snapshot.body}`);
      const existing = this.data.items.find(item => item.signature === signature);
      const item = { ...existing, ...snapshot, signature, id: existing?.id || crypto.randomUUID(),
        title: existing?.renamed ? existing.title : snapshot.title || snapshot.body.slice(0, 80),
        createdAt: this.now(), firstCopiedAt: existing?.firstCopiedAt || this.now(),
        boardIds: existing?.boardIds || [], isFavorite: existing?.isFavorite || false };
      this.data.items = prune([item, ...this.data.items.filter(entry => entry.id !== item.id)], this.data.settings, Date.parse(this.now()), this.protectedItemId);
      return item;
    });
  }

  get(id) { return this.data.items.find(item => item.id === id); }

  edit(id) {
    const index = this.data.items.findIndex(item => item.id === id);
    const item = { ...this.data.items[index] }; this.data.items[index] = item; return item;
  }

  migrateImageSignatures(signatureFor) {
    const updates = [], failed = [];
    for (const item of this.data.items.filter(value => value.type === 'image' && value.signatureFormat !== 'pixels-v1')) {
      try {
        const signature = signatureFor(item);
        if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid image signature');
        updates.push({ id: item.id, signature });
      } catch { failed.push(item.id); }
    }
    if (updates.length) this.mutate(() => {
      for (const update of updates) Object.assign(this.edit(update.id), { signature: update.signature, signatureFormat: 'pixels-v1' });
    });
    return failed;
  }

  update(id, changes) {
    if (!this.get(id)) throw new Error('Clipboard item no longer exists');
    return this.mutate(() => {
      const item = this.edit(id);
      if (typeof changes.title === 'string') { item.title = changes.title.trim().slice(0, 200); item.renamed = true; }
      if (typeof changes.body === 'string' && ['text', 'code', 'link', 'color'].includes(item.type)) {
        if (Buffer.byteLength(changes.body) > 16 * 1024 * 1024) throw new Error('Text exceeds 16 MB limit');
        item.body = changes.body; item.preview = changes.body.slice(0, 16000);
        const html = typeof changes.html === 'string' ? changes.html : '';
        if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new Error('HTML exceeds 16 MB limit');
        item.html = html; item.rtf = ''; item.signature = textSignature(item.body, item.html);
      }
      if (Array.isArray(changes.boardIds)) item.boardIds = [...new Set(changes.boardIds.filter(b => this.data.boards.some(board => board.id === b)))];
      item.isFavorite = item.boardIds.length > 0;
      return item;
    });
  }

  delete(ids) {
    const selected = new Set(ids);
    if (this.protectedItemId && selected.has(this.protectedItemId)) throw new Error('请先保存或关闭正在编辑的项目');
    return this.mutate(() => { this.data.items = this.data.items.filter(item => !selected.has(item.id)); });
  }

  replaceImage(id, { buffer, size, original, turns, preview, signature, foreground, backgroundRemoved = false }) {
    const item = this.get(id);
    if (!item || item.type !== 'image' || ![0, 1, 2, 3].includes(turns)) throw new Error('Invalid image edit');
    const asset = this.putAsset(buffer), originalAsset = this.putAsset(original), foregroundAsset = foreground ? this.putAsset(foreground) : undefined;
    if (backgroundRemoved && !foregroundAsset) throw new Error('缺少前景图片');
    return this.mutate(() => {
      const image = this.edit(id), nextSignature = signature || hash(buffer);
      if (image.signature !== nextSignature) delete image.ocr;
      delete image.originalBody; delete image.foregroundBody;
      return Object.assign(image, { asset, originalAsset, foregroundAsset: foregroundAsset || null, backgroundRemoved, body: asset, size, imageTurns: turns,
        signature: nextSignature, signatureFormat: signature ? 'pixels-v1' : 'png-v0', preview: typeof preview === 'string' ? preview : '' });
    });
  }

  setOCR(id, signature, result) {
    const item = this.get(id);
    if (!item || item.type !== 'image' || item.signature !== signature) return false;
    if (!validOCR(result)) throw new Error('Invalid image text result');
    return this.mutate(() => {
      this.edit(id).ocr = { signature, text: result.text, lines: result.lines, status: result.status, engine: result.engine || '',
        error: result.error || '', completedAt: this.now() }; return true;
    });
  }

  clear() {
    return this.mutate(() => { this.data.items = this.data.items.filter(item => item.id === this.protectedItemId || item.isFavorite || item.boardIds.length); });
  }

  saveBoard(input) {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
    if (!name || !COLORS.includes(input.color)) throw new Error('Invalid pinboard');
    return this.mutate(() => {
      const previous = this.data.boards.find(b => b.id === input.id);
      const board = { ...previous, id: previous?.id || crypto.randomUUID(), name, color: input.color };
      if (previous) this.data.boards = this.data.boards.map(value => value.id === board.id ? board : value);
      else this.data.boards.push(board);
      return board;
    });
  }

  deleteBoard(id) {
    return this.mutate(() => {
      this.data.boards = this.data.boards.filter(board => board.id !== id);
      this.data.items = this.data.items.map(item => {
        const boardIds = item.boardIds.filter(b => b !== id); return { ...item, boardIds, isFavorite: boardIds.length > 0 };
      });
    });
  }

  reorderBoards(ids) {
    this.validateOrder(ids, this.data.boards.map(board => board.id));
    return this.mutate(() => {
      const boards = new Map(this.data.boards.map(board => [board.id, board]));
      this.data.boards = ids.map(id => boards.get(id));
    });
  }

  validateOrder(ids, expected) {
    const valid = new Set(expected);
    if (!Array.isArray(ids) || ids.length !== expected.length || new Set(ids).size !== ids.length
      || ids.some(id => !valid.has(id))) throw new Error('Invalid ordering; reload the current library');
  }

  reorderBoardItems(boardId, ids) {
    const board = this.data.boards.find(entry => entry.id === boardId);
    if (!board) throw new Error('Pinboard no longer exists');
    this.validateOrder(ids, this.data.items.filter(item => item.boardIds.includes(boardId)).map(item => item.id));
    return this.mutate(() => { this.data.boards = this.data.boards.map(value => value.id === boardId ? { ...value, itemOrder: [...ids] } : value); });
  }

  pinItems(ids, boardId, remove = false) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => !this.get(id))) throw new Error('Invalid clipboard selection');
    if (!this.data.boards.some(board => board.id === boardId)) throw new Error('Pinboard no longer exists');
    return this.mutate(() => {
      for (const id of new Set(ids)) {
        const item = this.edit(id);
        item.boardIds = remove ? item.boardIds.filter(entry => entry !== boardId) : [...new Set([...item.boardIds, boardId])];
        item.isFavorite = item.boardIds.length > 0;
      }
      if (remove) {
        const board = this.data.boards.find(entry => entry.id === boardId);
        if (board.itemOrder) this.data.boards = this.data.boards.map(value => value.id === boardId ? { ...value, itemOrder: board.itemOrder.filter(id => !ids.includes(id)) } : value);
      }
    });
  }

  settings(changes) {
    return this.mutate(() => {
      this.data.settings = sanitizeSettings(changes, this.data.settings);
      this.data.items = prune(this.data.items, this.data.settings, Date.parse(this.now()), this.protectedItemId);
      return this.data.settings;
    });
  }

  putAsset(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 64 * 1024 * 1024) throw new Error('Image exceeds 64 MB limit');
    const name = `${hash(buffer)}.png`;
    const file = path.join(this.directory, 'assets', name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buffer, { mode: 0o600, flag: 'wx' });
    return name;
  }

  readAsset(name) {
    if (!/^[a-f0-9]{64}\.png$/.test(name)) throw new Error('Invalid image asset');
    return fs.readFileSync(path.join(this.directory, 'assets', name));
  }

  exportData() {
    const data = structuredClone(this.data);
    data.version = 2;
    for (const item of data.items) {
      if (item.asset) { item.body = `data:image/png;base64,${this.readAsset(item.asset).toString('base64')}`; delete item.asset; }
      if (item.originalAsset) { item.originalBody = `data:image/png;base64,${this.readAsset(item.originalAsset).toString('base64')}`; delete item.originalAsset; }
      if (item.foregroundAsset) { item.foregroundBody = `data:image/png;base64,${this.readAsset(item.foregroundAsset).toString('base64')}`; delete item.foregroundAsset; }
    }
    return data;
  }

  exportTo(file) {
    const contents = JSON.stringify(this.exportData());
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${crypto.randomUUID()}`);
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, contents); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  snapshot() {
    return { version: this.data.version, revision: this.revision, boards: this.data.boards, settings: this.data.settings, recovery: this.recovery, items: this.data.items.map(item => {
      const { id, type, title, signature, source, boardIds, isFavorite, renamed, createdAt, size, ocr } = item;
      let count = this.counts.get(id);
      if (!count || count.body !== item.body) {
        let characters = type === 'image' ? 0 : item.body.length;
        if (type !== 'image') { const pairs = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g; while (pairs.exec(item.body)) characters -= 1; }
        count = { body: item.body, value: characters }; this.counts.set(id, count);
      }
      return { id, type, title, signature, source, boardIds, isFavorite, renamed, createdAt, size,
        ...(ocr ? { ocr: { hasText: !!ocr.text, status: ocr.status, signature: ocr.signature, completedAt: ocr.completedAt } } : {}),
        preview: type === 'image' ? item.preview : (item.preview || item.body).slice(0, 2000),
        body: type !== 'image' && item.body.length <= 2000 ? item.body : '', characterCount: count.value };
    }) };
  }

  search(query) {
    const { SearchIndex } = require('./search');
    this.searchIndex ||= new SearchIndex();
    this.searchIndex.sync(this.data.items, this.revision);
    return { revision: this.revision, ids: this.searchIndex.find(query) };
  }
  close() { this.searchIndex?.close(); }
}

module.exports = { ClipStore, hash, textSignature, htmlPayload };
