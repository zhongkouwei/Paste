const { Worker } = require('node:worker_threads');
const path = require('node:path');

class SearchService {
  constructor() { this.entries = new Map(); this.pending = new Map(); this.sequence = 0; this.revision = -1; this.closed = false; this.terminations = []; }
  start() {
    const worker = new Worker(path.join(__dirname, 'search-worker.js')); this.worker = worker;
    worker.on('message', message => {
      if (this.worker !== worker) return;
      const operation = this.pending.get(message.id); if (!operation) return;
      if (message.error) { this.failed(worker, new Error(message.error)); return; }
      this.pending.delete(message.id); operation.resolve(message.result);
    });
    worker.on('error', error => this.failed(worker, error));
    worker.on('exit', code => { if (this.worker === worker) this.failed(worker, new Error(`搜索进程已退出 (${code})`)); });
  }
  failed(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null; this.entries.clear(); this.revision = -1;
    for (const operation of this.pending.values()) operation.reject(error); this.pending.clear();
    this.terminations.push(worker.terminate());
  }
  search(items, revision, query) {
    if (this.closed) return Promise.reject(new Error('搜索已停止'));
    if (typeof query !== 'string' || query.length > 2048 || query.trim().split(/\s+/).length > 32) return Promise.reject(new Error('搜索内容超过长度或词数限制'));
    if (!this.worker) this.start();
    const updates = [], deleted = [], next = new Map();
    if (revision !== this.revision) {
      for (const item of items) {
        const text = item.ocr?.signature === item.signature ? item.ocr?.text : '';
        const fields = [item.type, item.body, item.title, item.source?.name, item.note, text], previous = this.entries.get(item.id);
        if (!previous || fields.some((value, index) => value !== previous[index])) updates.push({ id: item.id, body: item.body,
          type: item.type, title: item.title, source: { name: item.source?.name }, note: item.note, signature: item.signature,
          ...(text ? { ocr: { signature: item.signature, text } } : {}) });
        next.set(item.id, fields);
      }
      for (const id of this.entries.keys()) if (!next.has(id)) deleted.push(id);
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, updates, deleted, revision, query });
        if (revision !== this.revision) { this.entries = next; this.revision = revision; }
      } catch (error) { this.failed(this.worker, error); }
    });
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      if (this.worker) this.failed(this.worker, new Error('搜索已停止'));
    }
    await Promise.allSettled(this.terminations);
  }
}
module.exports = { SearchService };
