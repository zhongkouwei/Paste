const path = require('node:path');

class ImageInspector {
  constructor({ BrowserWindow, ipcMain }, { timeout = 30000, idle = 1000 } = {}) {
    Object.assign(this, { BrowserWindow, ipcMain, timeout, idle }); this.queue = Promise.resolve(); this.sequence = 0;
    this.receive = (event, message) => {
      if (!this.pending || event.sender !== this.window?.webContents || event.senderFrame !== event.sender.mainFrame || message?.id !== this.pending.id) return;
      if (message.error) this.pending.finish(new Error(message.error));
      else if (!message.result || !/^[a-f0-9]{64}$/.test(message.result.signature) || !Number.isInteger(message.result.size?.width) || message.result.size.width < 1
        || !Number.isInteger(message.result.size?.height) || message.result.size.height < 1 || message.result.size.width * message.result.size.height > 64000000
        || (message.result.preview !== undefined && (typeof message.result.preview !== 'string' || message.result.preview.length > 2 * 1024 * 1024))) this.pending.finish(new Error('图片校验进程返回无效结果。'));
      else this.pending.finish(null, message.result);
    };
    ipcMain.on('image-inspect:result', this.receive);
  }
  async ready() {
    if (this.window && !this.window.isDestroyed()) return;
    const window = new this.BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, focusable: false,
      webPreferences: { preload: path.join(__dirname, 'image-inspect-preload.js'), contextIsolation: true, nodeIntegration: false,
        sandbox: false, backgroundThrottling: false, partition: 'paste-image-inspector' } });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => { if (this.window === window) this.stop(new Error('图片校验进程意外退出，原库未替换。')); });
    window.once('closed', () => { if (this.window === window) { this.window = null; this.pending?.finish(new Error('图片校验进程已关闭。')); } });
    await window.loadFile(path.join(__dirname, 'image-inspect.html'));
  }
  stop(error) {
    this.pending?.finish(error);
    const window = this.window; this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }
  inspect(file, { signal, ...options } = {}) {
    const task = this.queue.then(async () => {
      if (this.closed) throw new Error('图片校验已停止'); signal?.throwIfAborted(); clearTimeout(this.idleTimer);
      let timer, abort;
      try {
        return await new Promise((resolve, reject) => {
          const id = ++this.sequence;
          const finish = (error, result) => { if (this.pending?.id !== id) return; this.pending = null; error ? reject(error) : resolve(result); };
          this.pending = { id, finish };
          abort = () => this.stop(signal.reason); signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => this.stop(new Error('图片校验超时，原库未替换。')), this.timeout);
          this.ready().then(() => { if (this.pending?.id === id) this.window.webContents.send('image-inspect:request', { id, file, options }); }, error => { if (this.pending?.id === id) this.stop(error); });
        });
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (!this.closed) this.idleTimer = setTimeout(() => this.stop(new Error('图片校验会话已释放。')), this.idle);
      }
    });
    this.queue = task.catch(() => {}); return task;
  }
  async close() { this.closed = true; clearTimeout(this.idleTimer); this.stop(new Error('图片校验已停止')); await this.queue; this.ipcMain.removeListener('image-inspect:result', this.receive); }
}
module.exports = { ImageInspector };
