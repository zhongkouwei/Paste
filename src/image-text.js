class ImageTextIndex {
  constructor({ store, processor, readImage, onChanged = () => {} }) {
    Object.assign(this, { store, processor, readImage, onChanged });
    this.queue = []; this.jobs = new Map(); this.running = null; this.stopping = false; this.stopped = false;
  }
  enqueue(id, { force = false, priority = false } = {}) {
    if (this.stopping) return Promise.reject(new Error('文字识别已停止'));
    const item = this.store.get(id);
    if (!item || item.type !== 'image') return Promise.reject(new Error('图片已被删除'));
    if (!force && item.ocr?.signature === item.signature) return Promise.resolve(item.ocr);
    const key = `${id}:${item.signature}`;
    if (this.jobs.has(key)) {
      const existing = this.jobs.get(key), index = this.queue.indexOf(existing);
      if (priority && index >= 0) { this.queue.splice(index, 1); this.queue.unshift(existing); }
      return existing.promise;
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { id, signature: item.signature, key, promise, resolve, reject };
    this.jobs.set(key, job); if (priority) this.queue.unshift(job); else this.queue.push(job);
    this.start(); return promise;
  }
  start() {
    if (this.running || this.stopping) return;
    this.running = this.process().finally(() => {
      this.running = null;
      if (this.queue.length && !this.stopping) this.start();
    });
  }
  async process() {
    while (this.queue.length && !this.stopping) {
      const job = this.queue.shift(), controller = new AbortController(); this.active = controller;
      try {
        const item = this.store.get(job.id);
        if (!item || item.signature !== job.signature) { job.resolve(null); continue; }
        let result, processingError;
        try { result = await this.processor.recognize(await this.readImage(item), { signal: controller.signal }); }
        catch (error) {
          if (this.stopping || controller.signal.aborted) { job.resolve(null); continue; }
          processingError = error; result = { text: '', lines: [], error: error.message };
        }
        if (this.stopping) { job.resolve(null); continue; }
        const value = { ...result, status: processingError ? 'error' : result.text ? 'ready' : 'none' };
        if (this.store.setOCR(job.id, job.signature, value)) this.onChanged();
        if (processingError) job.reject(processingError); else job.resolve(value);
      } catch (error) { job.reject(error); }
      finally { this.jobs.delete(job.key); this.active = null; }
    }
  }
  async idle() { while (this.running || this.queue.length) { if (this.running) await this.running; else this.start(); } }
  close() {
    if (this.closing) return this.closing;
    this.stopping = true;
    for (const job of this.queue.splice(0)) { this.jobs.delete(job.key); job.resolve(null); }
    this.active?.abort();
    this.closing = Promise.resolve(this.running).finally(() => { this.stopped = true; }); return this.closing;
  }
}
module.exports = { ImageTextIndex };
