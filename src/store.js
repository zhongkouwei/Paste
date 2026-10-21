const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { COLORS, TYPES, DEFAULT_SETTINGS, prune, sanitizeSettings } = require('./model');

const hash = input => crypto.createHash('sha256').update(input).digest('hex');
const textSignature = (body, html = '', rtf = '') => hash(`text:${body}\nhtml:${html}\nrtf:${rtf}`);

class ClipStore {
  constructor(directory, { now = () => new Date().toISOString(), legacyDirectories = [] } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'library.json');
    this.now = now;
    this.legacyDirectories = legacyDirectories;
    this.data = { version: 2, items: [], boards: [], settings: { ...DEFAULT_SETTINGS } };
    this.recovery = '';
    fs.mkdirSync(path.join(directory, 'assets'), { recursive: true, mode: 0o700 });
    this.load();
  }

  parse(raw) {
    const data = JSON.parse(raw);
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items) || (data.version && data.version > 2)) throw new Error('Unsupported clipboard library');
    const valid = items.filter(item => item && typeof item.id === 'string' && TYPES.includes(item.type)
      && typeof item.body === 'string' && typeof item.signature === 'string');
    if (valid.length !== items.length) throw new Error('Invalid clipboard library items');
    const boards = Array.isArray(data.boards) ? data.boards.filter(b => typeof b.id === 'string' && typeof b.name === 'string' && /^#[\da-f]{6}$/i.test(b.color)) : [];
    const favorites = valid.filter(item => item.isFavorite && !item.boardIds?.length);
    if (favorites.length && !boards.some(b => b.id === 'favorites')) boards.push({ id: 'favorites', name: '已固定', color: COLORS[0] });
    return { version: 2, boards, settings: sanitizeSettings(data.settings || {}), items: valid.map(item => ({
      ...item, signature: ['text', 'code', 'color', 'link'].includes(item.type) ? textSignature(item.body, item.html, item.rtf) : item.signature,
      boardIds: Array.isArray(item.boardIds) ? item.boardIds.filter(id => boards.some(b => b.id === id)) : item.isFavorite ? ['favorites'] : [],
      createdAt: Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : this.now()
    })) };
  }

  load() {
    if (fs.existsSync(this.file)) {
      try { this.data = this.parse(fs.readFileSync(this.file, 'utf8')); }
      catch (error) {
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
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify(this.data)); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      if (backup && fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
      fs.renameSync(temporary, this.file);
      if (!fs.existsSync(`${this.file}.bak`)) fs.copyFileSync(this.file, `${this.file}.bak`);
      const directory = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  mutate(action) {
    const previous = structuredClone(this.data);
    try { const result = action(); this.persist(); return result; }
    catch (error) { this.data = previous; throw error; }
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
      this.data.items = prune([item, ...this.data.items.filter(entry => entry.id !== item.id)], this.data.settings, Date.parse(this.now()));
      return item;
    });
  }

  get(id) { return this.data.items.find(item => item.id === id); }

  update(id, changes) {
    if (!this.get(id)) throw new Error('Clipboard item no longer exists');
    return this.mutate(() => {
      const item = this.get(id);
      if (typeof changes.title === 'string') { item.title = changes.title.trim().slice(0, 200); item.renamed = true; }
      if (typeof changes.body === 'string' && ['text', 'code', 'link', 'color'].includes(item.type)) {
        if (Buffer.byteLength(changes.body) > 16 * 1024 * 1024) throw new Error('Text exceeds 16 MB limit');
        item.body = changes.body; item.preview = changes.body.slice(0, 16000);
        item.html = ''; item.rtf = ''; item.signature = textSignature(item.body);
      }
      if (Array.isArray(changes.boardIds)) item.boardIds = [...new Set(changes.boardIds.filter(b => this.data.boards.some(board => board.id === b)))];
      item.isFavorite = item.boardIds.length > 0;
      return item;
    });
  }

  delete(ids) {
    const selected = new Set(ids);
    return this.mutate(() => { this.data.items = this.data.items.filter(item => !selected.has(item.id)); });
  }

  clear() {
    return this.mutate(() => { this.data.items = this.data.items.filter(item => item.isFavorite || item.boardIds.length); });
  }

  saveBoard(input) {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
    if (!name || !COLORS.includes(input.color)) throw new Error('Invalid pinboard');
    return this.mutate(() => {
      let board = this.data.boards.find(b => b.id === input.id);
      if (!board) { board = { id: crypto.randomUUID() }; this.data.boards.push(board); }
      Object.assign(board, { name, color: input.color });
      return board;
    });
  }

  deleteBoard(id) {
    return this.mutate(() => {
      this.data.boards = this.data.boards.filter(board => board.id !== id);
      for (const item of this.data.items) { item.boardIds = item.boardIds.filter(b => b !== id); item.isFavorite = item.boardIds.length > 0; }
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
    return this.mutate(() => { board.itemOrder = [...ids]; });
  }

  pinItems(ids, boardId, remove = false) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => !this.get(id))) throw new Error('Invalid clipboard selection');
    if (!this.data.boards.some(board => board.id === boardId)) throw new Error('Pinboard no longer exists');
    return this.mutate(() => {
      for (const id of new Set(ids)) {
        const item = this.get(id);
        item.boardIds = remove ? item.boardIds.filter(entry => entry !== boardId) : [...new Set([...item.boardIds, boardId])];
        item.isFavorite = item.boardIds.length > 0;
      }
      if (remove) {
        const board = this.data.boards.find(entry => entry.id === boardId);
        if (board.itemOrder) board.itemOrder = board.itemOrder.filter(id => !ids.includes(id));
      }
    });
  }

  settings(changes) {
    return this.mutate(() => {
      this.data.settings = sanitizeSettings(changes, this.data.settings);
      this.data.items = prune(this.data.items, this.data.settings, Date.parse(this.now()));
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

  snapshot() {
    return { ...this.data, recovery: this.recovery, items: this.data.items.map(item => {
      const { html, rtf, ...metadata } = item;
      return { ...metadata, body: item.asset ? '' : item.body, characterCount: item.type === 'image' ? 0 : [...item.body].length };
    }) };
  }
}

module.exports = { ClipStore, hash, textSignature };
