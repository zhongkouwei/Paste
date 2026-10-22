const path = require('node:path');
const LIMIT = 16 * 1024 * 1024;
class SelectionComposer {
  constructor({ BrowserWindow, ipcMain }) {
    Object.assign(this, { BrowserWindow, ipcMain }); this.queue = Promise.resolve(); this.sequence = 0;
    this.receive = (event, message) => {
      if (!this.pending || event.sender !== this.window?.webContents || event.senderFrame !== event.sender.mainFrame || message?.id !== this.pending.id) return;
      if (message.error) this.pending.finish(Error(String(message.error).slice(0, 1000)));
      else {
        const result = message.result;
        if (typeof result?.html !== 'string' || Buffer.byteLength(result.html) > LIMIT || !Number.isInteger(result.images) || result.images < 0 || result.images > 20000 || !Array.isArray(result.fragments)
            || result.fragments.length !== this.pending.count || result.fragments.some(html => typeof html !== 'string')
            || result.fragments.reduce((size, html) => size + Buffer.byteLength(html), 0) > LIMIT) this.pending.finish(Error('合并进程返回无效结果，剪贴板未修改。'));
        else this.pending.finish(null, result);
      }
    };
    ipcMain.on('selection:result', this.receive);
  }
  async ready() {
    if (this.window && !this.window.isDestroyed()) return;
    const window = new this.BrowserWindow({ show: false, width: 1, height: 1, focusable: false, skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, 'selection-compose-preload.js'), sandbox: true, nodeIntegration: false,
        contextIsolation: true, backgroundThrottling: false, partition: 'paste-selection-composer' } });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'about:'].includes(new URL(details.url).protocol) }));
    window.webContents.on('render-process-gone', () => { if (this.window === window) this.stop(Error('合并进程意外退出，剪贴板未修改。')); });
    window.once('closed', () => { if (this.window === window) { this.window = null; this.pending?.finish(Error('合并窗口已关闭，剪贴板未修改。')); } });
    await window.loadFile(path.join(__dirname, 'selection-compose.html'));
  }
  stop(error) { this.pending?.finish(error); const window = this.window; this.window = null; if (window && !window.isDestroyed()) window.destroy(); }
  compose(parts, { signal } = {}) {
    const operation = this.queue.then(async () => {
      if (this.closed) throw Error('内容合并已停止'); signal?.throwIfAborted(); clearTimeout(this.idleTimer);
      let timer, abort;
      try {
        return await new Promise((resolve, reject) => {
          const id = ++this.sequence;
          const finish = (error, result) => { if (this.pending?.id !== id) return; this.pending = null; error ? reject(error) : resolve(result); };
          this.pending = { id, count: parts.length, finish };
          abort = () => this.stop(signal.reason); signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => this.stop(Error('合并超时，剪贴板未修改。')), 30000);
          this.ready().then(() => { if (this.pending?.id === id) this.window.webContents.send('selection:request', { id, parts }); }, error => { if (this.pending?.id === id) this.stop(error); });
        });
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!this.closed) this.idleTimer = setTimeout(() => this.stop(Error('合并会话已释放。')), 1000); }
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async close() { this.closed = true; clearTimeout(this.idleTimer); this.stop(Error('内容合并已停止')); await this.queue; this.ipcMain.removeListener('selection:result', this.receive); }
}
module.exports = { SelectionComposer };
