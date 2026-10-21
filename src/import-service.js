const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { planImport } = require('./import-plan');

class ImportService {
  constructor(store, { validateImage, beforeCommit = () => () => {}, afterCommit = () => {} } = {}) {
    Object.assign(this, { store, validateImage, beforeCommit, afterCommit }); this.revision = 0; this.phase = 'idle'; this.done = 0;
  }
  state() { return { revision: this.revision, phase: this.phase, done: this.done, canceling: !!this.active?.canceling, token: this.preview?.token, summary: this.preview?.summary, hasCheckpoint: !!this.lastCheckpoint }; }
  notify() { this.revision++; try { this.onChanged?.(this.state()); } catch (error) { console.error('Import state notification:', error); } }
  discard() { const previous = this.preview; this.preview = null; if (previous) fs.rmSync(previous.stage, { recursive: true, force: true }); }
  worker(data) {
    const worker = new Worker(path.join(__dirname, 'import-worker.js'), { workerData: data }), active = { worker, controller: new AbortController(), validations: new Set() };
    active.promise = new Promise((resolve, reject) => {
      let result, failure;
      const reply = message => { if (this.active === active && !active.exited) worker.postMessage(message); };
      worker.on('message', message => {
        if (message.validateImage) {
          const validation = Promise.resolve().then(() => {
            if (!/^[a-f0-9]{64}\.png$/.test(message.validateImage) || ![0, 1, 2, 3].includes(message.turns)) throw new Error('无效的图片请求。');
            active.controller.signal.throwIfAborted();
            return this.validateImage(path.join(data.stage, 'assets', message.validateImage), { turns: message.turns, signal: active.controller.signal });
          }).then(result => reply({ request: message.request, result }), error => reply({ request: message.request, error: error.message, name: error.name })).catch(error => { failure ||= error; });
          active.validations.add(validation); validation.then(() => active.validations.delete(validation));
        } else if (message.error) failure = Object.assign(new Error(message.error), { name: message.name });
        else if (message.result) result = message.result;
        else if (message.temporaryOwned) active.temporaryOwned = true;
        else if (Number.isInteger(message.done)) { this.done = message.done; this.notify(); }
      });
      worker.on('error', error => { failure = error; });
      worker.on('exit', async code => {
        active.exited = true; active.controller.abort();
        await Promise.allSettled([...active.validations]);
        try { if (active.temporaryOwned && data.temporary && fs.existsSync(data.temporary)) fs.unlinkSync(data.temporary); } catch (error) { failure ||= error; }
        if (this.active === active) this.active = null;
        if (failure || code || !result) reject(failure || new Error('恢复校验进程意外退出；原库未替换。'));
        else if (active.canceling) reject(Object.assign(new Error('恢复已取消，原库未替换。'), { name: 'AbortError' }));
        else resolve(result);
      });
    }); this.active = active; return active.promise;
  }
  checkAvailable() {
    if (this.closed || this.active || this.store.exportService.state().running) throw new Error('请等待当前备份任务完成或取消。');
    if (this.store.protectedItemId) throw new Error('请先保存并关闭正在编辑的项目。');
  }
  async prepare(file) {
    this.checkAvailable();
    try { this.discard(); } catch (error) { this.phase = 'idle'; this.notify(); throw error; }
    const stage = fs.mkdtempSync(path.join(this.store.directory, 'import-')); fs.chmodSync(stage, 0o700);
    fs.mkdirSync(path.join(stage, 'assets'), { mode: 0o700 }); fs.mkdirSync(path.join(stage, 'contents'), { mode: 0o700 });
    this.phase = 'preparing'; this.done = 0; this.notify();
    try {
      const staged = await this.worker({ operation: 'prepare', stage, file });
      const merge = planImport(this.store.data, staged.data), replace = planImport(this.store.data, staged.data, { mode: 'replace' });
      this.preview = { ...staged, stage, token: randomUUID(), baseRevision: this.store.revision,
        summary: { items: staged.data.items.length, boards: staged.data.boards.length, bytes: staged.bytes, added: merge.added, duplicates: merge.duplicates, replaced: replace.replaced, repairedIds: staged.repairedIds } };
      this.phase = 'ready'; this.done = staged.data.items.length; this.notify(); return this.state();
    } catch (error) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (cleanup) { error = new Error(`${error.message}；暂存目录清理失败：${cleanup.message}`); }
      this.phase = 'idle'; this.notify(); throw error;
    }
  }
  async apply(token, options) {
    this.checkAvailable(); const preview = this.preview;
    if (this.phase !== 'ready' || !preview || preview.token !== token) throw new Error('恢复预览已失效，请重新选择备份。');
    const fresh = () => { if (this.store.revision !== preview.baseRevision || this.store.protectedItemId) throw new Error('当前库已变化，请重新选择备份并确认。'); };
    fresh(); const plan = planImport(this.store.data, preview.data, options);
    const checkpoint = path.join(this.store.directory, `backup-before-import-${randomUUID()}.json`), temporary = `${checkpoint}.tmp-${randomUUID()}`;
    this.phase = 'applying'; this.notify();
    try {
      await this.worker({ operation: 'promote', stage: preview.stage, directory: this.store.directory, current: this.store.data, checkpoint, temporary });
      this.lastCheckpoint = checkpoint; fresh();
      const rollback = this.beforeCommit(plan.data.settings), revision = this.store.revision; let warning = '';
      try {
        for (const [key, summary] of preview.summaries) this.store.contents.summaries.set(key, summary);
        this.store.mutate(() => { this.store.data = plan.data; });
      } catch (error) { if (this.store.revision === revision) { rollback?.(); throw error; } warning = error.message; }
      this.store.counts.clear();
      try { this.afterCommit(); } catch (error) { warning = [warning, `数据已恢复，运行设置更新失败：${error.message}`].filter(Boolean).join(' '); }
      try { this.discard(); } catch (error) { warning = [warning, `数据已恢复，暂存目录清理失败：${error.message}`].filter(Boolean).join(' '); }
      this.phase = 'idle'; this.notify(); return { ok: true, added: plan.added, duplicates: plan.duplicates, warning, checkpoint };
    } catch (error) { if (fs.existsSync(checkpoint)) this.lastCheckpoint = checkpoint; this.phase = 'ready'; this.notify(); throw error; }
  }
  cancel() {
    if (this.active) { if (!this.active.canceling) { this.active.canceling = true; this.active.controller.abort(); this.active.worker.postMessage({ type: 'cancel' }); this.notify(); } }
    else { try { this.discard(); } finally { this.phase = 'idle'; this.notify(); } }
    return this.state();
  }
  async close() { this.closed = true; const promise = this.active?.promise; this.cancel(); await promise?.catch(() => {}); this.discard(); this.phase = 'idle'; }
}
module.exports = { ImportService };
