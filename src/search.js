const crypto = require('node:crypto');
const { openSearchDatabase } = require('./search-database');
const { searchText } = require('./model');

class SearchIndex {
  constructor(options = {}) {
    Object.assign(this, openSearchDatabase(options.directory)); this.revision = -1;
    this.entries = new Map(this.db.prepare('SELECT id,fingerprint FROM docs').all().map(row => [row.id, row.fingerprint]));
    this.written = 0; this.reused = 0; this.deleted = 0;
    this.put = this.db.prepare('INSERT INTO docs(id,text,fingerprint) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,fingerprint=excluded.fingerprint');
    this.matches = this.db.prepare('SELECT 1 AS valid FROM docs WHERE id=? AND fingerprint=? AND CAST(text AS BLOB)=CAST(? AS BLOB)');
    this.remove = this.db.prepare('DELETE FROM docs WHERE id=?');
  }
  sync(items, revision) {
    if (this.revision === revision) return;
    this.apply(items, [], revision, true);
  }
  apply(items, deleted, revision, complete = false) {
    const next = new Map(this.entries), ids = complete ? new Set(items.map(item => item.id)) : null;
    const removed = new Set([...deleted, ...(ids ? [...this.entries.keys()].filter(id => !ids.has(id)) : [])]);
    let written = 0, reused = 0, removals = 0; this.db.exec('BEGIN');
    try {
      for (const item of items) {
        const text = searchText(item), fingerprint = crypto.createHash('sha256').update(text).digest('hex');
        if (this.entries.get(item.id) === fingerprint && this.matches.get(item.id, fingerprint, text)?.valid === 1) reused++;
        else { this.put.run(item.id, text, fingerprint); written++; }
        next.set(item.id, fingerprint);
      }
      for (const id of removed) if (next.has(id)) { this.remove.run(id); next.delete(id); removals++; }
      this.db.exec('COMMIT'); this.entries = next; this.revision = revision;
      this.written += written; this.reused += reused; this.deleted += removals;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  diagnostics() {
    const memory = process.memoryUsage();
    return { mode: this.mode, warning: this.warning, recovered: this.recovered, rows: this.entries.size,
      written: this.written, reused: this.reused, deleted: this.deleted,
      pageCacheKiB: -this.db.prepare('PRAGMA cache_size').get().cache_size,
      databaseBytes: this.db.prepare('PRAGMA page_count').get().page_count * this.db.prepare('PRAGMA page_size').get().page_size,
      processRssMiB: +(memory.rss / 1048576).toFixed(1), threadHeapUsedMiB: +(memory.heapUsed / 1048576).toFixed(1) };
  }
  find(query) {
    if (typeof query !== 'string' || query.length > 2048) throw new Error('搜索内容超过长度限制');
    const terms = [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
    if (terms.length > 32) throw new Error('搜索词过多');
    const indexed = terms.filter(term => [...term].length >= 3 && !term.includes('\0'));
    const clauses = [], args = [];
    if (indexed.length) { clauses.push('rowid IN (SELECT rowid FROM terms WHERE terms MATCH ?)'); args.push(indexed.map(term => `"${term.replace(/"/g, '""')}"`).join(' AND ')); }
    for (const term of terms) { clauses.push('instr(text,?) > 0'); args.push(term); }
    return this.db.prepare(`SELECT id FROM docs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`).all(...args).map(row => row.id);
  }
  close() { this.db.close(); }
}
module.exports = { SearchIndex };
