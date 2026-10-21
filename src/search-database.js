const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const APPLICATION_ID = 0x50455349, VERSION = 1;
const schema = `CREATE TABLE docs(id TEXT PRIMARY KEY, text TEXT NOT NULL, fingerprint TEXT NOT NULL);
  CREATE VIRTUAL TABLE terms USING fts5(text, content='docs', content_rowid='rowid', tokenize='trigram case_sensitive 1');
  CREATE TRIGGER added AFTER INSERT ON docs BEGIN INSERT INTO terms(rowid,text) VALUES(new.rowid,new.text); END;
  CREATE TRIGGER removed AFTER DELETE ON docs BEGIN INSERT INTO terms(terms,rowid,text) VALUES('delete',old.rowid,old.text); END;
  CREATE TRIGGER edited AFTER UPDATE ON docs BEGIN
    INSERT INTO terms(terms,rowid,text) VALUES('delete',old.rowid,old.text);
    INSERT INTO terms(rowid,text) VALUES(new.rowid,new.text); END;`;
function configure(db, disk) {
  db.exec(`PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA secure_delete=ON;`);
  if (disk) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
}
function initialize(db) {
  db.exec(`BEGIN; ${schema} PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION}; COMMIT;`);
}
function regular(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('搜索缓存路径不是普通文件');
}
function openSearchDatabase(directory) {
  let db, file, warning = '', recovered = false;
  if (directory) {
    const folder = path.join(directory, 'search-cache'); file = path.join(folder, 'index.sqlite');
    try {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) throw new Error('搜索缓存目录不是独立目录');
      fs.chmodSync(folder, 0o700);
      for (const candidate of [file, `${file}-wal`, `${file}-shm`]) regular(candidate);
      let created = false;
      try { const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd); created = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      fs.chmodSync(file, 0o600);
      for (let attempt = 0; attempt < 2; attempt++) {
        let owned = created;
        try {
          if (!created) {
            db = new DatabaseSync(file, { readOnly: true });
            const application = db.prepare('PRAGMA application_id').get().application_id, version = db.prepare('PRAGMA user_version').get().user_version;
            const empty = !application && !version && !db.prepare('SELECT count(*) AS count FROM sqlite_schema').get().count;
            if (!empty && (application !== APPLICATION_ID || version !== VERSION)) throw new Error('搜索缓存版本不兼容，已保留原文件');
            if (empty) created = true;
            owned = true;
            db.close(); db = null;
          }
          db = new DatabaseSync(file); configure(db, true);
          if (created) initialize(db);
          else {
            db.prepare('SELECT id,text,fingerprint FROM docs LIMIT 0').all();
            const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all();
            if (triggers.length !== 3 || triggers.some(row => !['added', 'removed', 'edited'].includes(row.name))) {
              const error = new Error('搜索缓存结构不完整'); error.code = 'ERR_SQLITE_CACHE_SCHEMA'; throw error;
            }
            // Include external content in the FTS check, not only the posting-list structure.
            db.exec("INSERT INTO terms(terms,rank) VALUES('integrity-check',1)");
          }
          return { db, file, mode: 'disk', warning, recovered };
        } catch (error) {
          try { db?.close(); } catch { /* Failed connections may already be closed. */ }
          db = null;
          const code = (error.errcode || 0) & 255;
          const corrupt = [11, 26].includes(code) || error.code === 'ERR_SQLITE_CACHE_SCHEMA' || (owned && code === 1);
          if (attempt || !corrupt) throw error;
          for (const candidate of [`${file}-wal`, `${file}-shm`, file]) { regular(candidate); if (fs.existsSync(candidate)) fs.unlinkSync(candidate); }
          const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd); created = true; recovered = true;
          warning = '损坏的派生搜索缓存已重建，原始内容库未修改。';
        }
      }
    } catch (error) {
      try { db?.close(); } catch { /* Keep the original cache when opening fails. */ }
      warning = error.message;
    }
  }
  db = new DatabaseSync(':memory:'); configure(db, false); initialize(db);
  return { db, file: null, mode: 'memory', warning, recovered };
}
module.exports = { openSearchDatabase };
