const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');

class ExportService {
  constructor(directory, directories = [directory]) { Object.assign(this, { directory, directories }); this.closed = false; this.active = null; this.revision = 0; }
  state() { const job = this.active; return { revision: this.revision, running: !!job, canceling: !!job?.canceling, itemsDone: job?.itemsDone || 0, total: job?.total || 0 }; }
  notify() { this.revision++; try { this.onChanged?.(this.state()); } catch (error) { console.error('Export state notification:', error); } }
  export(data, file, { signal } = {}) {
    if (!data || !Array.isArray(data.items) || typeof file !== 'string' || !file) return Promise.reject(new Error('Invalid backup export request'));
    if (this.closed) return Promise.reject(new Error('备份导出已停止'));
    if (this.active) return Promise.reject(new Error('已有备份正在导出，请等待或取消。'));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('备份导出已取消，原有导出未替换。'), { name: 'AbortError' }));
    const temporary = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.tmp-${crypto.randomUUID()}`);
    let worker;
    try { worker = new Worker(path.join(__dirname, 'export-worker.js'), { workerData: { directory: this.directory, directories: this.directories, data, file, temporary } }); }
    catch (error) { return Promise.reject(error); }
    const job = { worker, total: data.items.length, itemsDone: 0, canceling: false };
    const abort = () => { if (this.active === job) this.cancel(); };
    job.promise = new Promise((resolve, reject) => {
      let result, failure, reportedFailure = false;
      worker.on('message', message => {
        if (message.temporaryOwned) job.temporaryOwned = true;
        else if (message.error) { reportedFailure = true; failure = Object.assign(new Error(message.error), { name: message.name }); }
        else if (message.result) result = message.result;
        else if (Number.isInteger(message.itemsDone)) { job.itemsDone = message.itemsDone; this.notify(); }
      });
      worker.on('error', error => { failure = error; });
      worker.on('exit', code => {
        signal?.removeEventListener('abort', abort);
        try { if (job.temporaryOwned && fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (error) { failure ||= error; }
        if (this.active === job) this.active = null; this.notify();
        if (reportedFailure) reject(failure);
        else if (failure || code || !result) reject(new Error(`备份导出进程已退出，目标文件的提交状态未确认；请检查后重试。(${code})`, { cause: failure }));
        else resolve(result);
      });
    });
    this.active = job; signal?.addEventListener('abort', abort, { once: true }); this.notify(); return job.promise;
  }
  cancel() {
    const job = this.active; if (!job) return false;
    if (!job.canceling) { job.canceling = true; job.worker.postMessage({ type: 'cancel' }); this.notify(); }
    return true;
  }
  close() { this.closed = true; this.cancel(); return this.active?.promise.catch(() => {}) || Promise.resolve(); }
}
module.exports = { ExportService };
