const { DatabaseSync } = require('node:sqlite');
const { searchText } = require('./model');

class SearchIndex {
  constructor() {
    this.db = new DatabaseSync(':memory:'); this.entries = new Map(); this.revision = -1;
    this.db.exec(`CREATE TABLE docs(id TEXT PRIMARY KEY, text TEXT NOT NULL);
      CREATE VIRTUAL TABLE terms USING fts5(text, content='docs', content_rowid='rowid', tokenize='trigram case_sensitive 1');
      CREATE TRIGGER added AFTER INSERT ON docs BEGIN INSERT INTO terms(rowid,text) VALUES(new.rowid,new.text); END;
      CREATE TRIGGER removed AFTER DELETE ON docs BEGIN INSERT INTO terms(terms,rowid,text) VALUES('delete',old.rowid,old.text); END;
      CREATE TRIGGER edited AFTER UPDATE ON docs BEGIN
        INSERT INTO terms(terms,rowid,text) VALUES('delete',old.rowid,old.text);
        INSERT INTO terms(rowid,text) VALUES(new.rowid,new.text); END;`);
    this.put = this.db.prepare('INSERT INTO docs(id,text) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text');
    this.remove = this.db.prepare('DELETE FROM docs WHERE id=?');
  }
  sync(items, revision) {
    if (this.revision === revision) return;
    const next = new Map(); this.db.exec('BEGIN');
    try {
      for (const item of items) {
        const fields = [item.type, item.body, item.title, item.source?.name, item.note, item.ocr?.signature === item.signature ? item.ocr?.text : ''];
        const previous = this.entries.get(item.id);
        if (!previous || fields.some((value, index) => value !== previous[index])) this.put.run(item.id, searchText(item));
        next.set(item.id, fields);
      }
      for (const id of this.entries.keys()) if (!next.has(id)) this.remove.run(id);
      this.db.exec('COMMIT'); this.entries = next; this.revision = revision;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
