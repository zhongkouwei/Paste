const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { performance } = require('node:perf_hooks');
const { targetIdentity } = require('./paste-target');

class StackInput {
  constructor({ helper, ownPID, simulate = false, baseline = () => 0, inventory = () => ({ count: 0, busy: false }),
    onPaste = async () => {}, onClipboard = () => {}, onState = () => {}, onFailure = () => {} }) {
    Object.assign(this, { helper, ownPID, simulate, baseline, inventory, onPaste, onClipboard, onState, onFailure });
    this.launch = () => spawn(this.helper, ['stack-events'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = null; this.starting = null; this.closing = null; this.epoch = 0; this.lifetime = 0; this.received = 0; this.ack = 0; this.completed = new Set();
    this.state = { running: false, keyboard: false, error: '', version: null }; this.ready = null;
  }
  snapshot() { return { ...this.state }; }
  update(values) { Object.assign(this.state, values); try { this.onState(this.snapshot()); } catch (error) { console.error('Stack state observer:', error); } }
  notifyFailure(error) { try { this.onFailure(error); } catch (failure) { console.error('Stack failure observer:', failure); } }
  reset() { this.epoch = this.epoch % 2147483646 + 1; this.received = this.ack = 0; this.completed.clear(); this.sync(); }
  sync() {
    if (!this.state.running || this.simulate || !this.child?.stdin?.writable) return;
    const inventory = this.inventory(this.epoch);
    if (!Number.isInteger(inventory.count) || inventory.count < 0 || inventory.count > 100000) return this.fail('Stack队列状态无效，顺序粘贴已暂停。');
    try {
      if (!this.child.stdin.write(JSON.stringify({ epoch: this.epoch, ack: this.ack, count: inventory.count, busy: !!inventory.busy }) + '\n')) this.fail('Stack辅助程序通信阻塞，顺序粘贴已暂停。');
    } catch { this.fail('Stack辅助程序连接已断开。'); }
  }
  refreshPermission() {
    if (this.state.running && !this.simulate && this.child?.stdin?.writable) {
      this.sync();
      try { this.child.stdin.write('{"refresh":true}\n'); } catch { this.fail('Stack辅助程序连接已断开。'); }
    }
  }
  async start() {
    if (this.closing) await this.closing;
    if (this.ready && this.state.running) return this.ready;
    if (this.starting) return this.starting;
    const lifetime = ++this.lifetime;
    if (this.simulate) {
      this.reset(); this.ready = { version: this.baseline() ?? 0, keyboard: false, simulated: true };
      this.update({ running: true, keyboard: false, error: '', version: this.ready.version }); return this.ready;
    }
    let child;
    try { child = this.launch(); } catch (error) { this.update({ error: error.message, running: false, keyboard: false }); throw error; }
    this.child = child; this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.lastBeat = performance.now();
    this.reset();
    this.starting = new Promise((resolve, reject) => {
      this.resolveReady = resolve; this.rejectReady = reject;
      this.startTimer = setTimeout(() => this.fail('Stack辅助程序启动超时。'), 4000);
    }).finally(() => { if (lifetime === this.lifetime) this.starting = null; });
    child.stdout.on('data', chunk => {
      if (lifetime !== this.lifetime) return;
      this.buffer += this.decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > 65536) return this.fail('Stack辅助程序响应过大。');
      for (let end; (end = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line || Buffer.byteLength(line) > 4096) return this.fail('Stack辅助程序响应无效。');
        try { this.message(JSON.parse(line)); } catch { this.fail('Stack辅助程序响应无效。'); return; }
        if (lifetime !== this.lifetime) return;
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => { if (lifetime === this.lifetime) this.fail('Stack辅助程序连接已断开。'); });
    child.once('error', () => { if (lifetime === this.lifetime) this.fail('无法启动Stack辅助程序。'); });
    child.once('close', () => { if (lifetime === this.lifetime) this.fail('Stack辅助程序已退出，顺序粘贴已暂停。'); });
    this.heartbeat = setInterval(() => {
      if (performance.now() - this.lastBeat > 4000) this.fail('Stack辅助程序无响应，顺序粘贴已暂停。'); else this.sync();
    }, 500);
    return this.starting;
  }
  message(message) {
    if (!message || typeof message !== 'object') throw Error('Invalid stack message');
    this.lastBeat = performance.now();
    if (message.event === 'ready') {
      if (this.ready || !Number.isSafeInteger(message.version) || message.version < 0 || typeof message.keyboard !== 'boolean') throw Error('Invalid readiness');
      clearTimeout(this.startTimer); this.ready = { version: message.version, keyboard: message.keyboard };
      this.update({ running: true, version: message.version, keyboard: message.keyboard, error: typeof message.error === 'string' ? message.error : '' });
      this.sync(); this.resolveReady?.(this.ready); this.resolveReady = this.rejectReady = null; return;
    }
    if (!this.ready) throw Error('Stack not ready');
    if (message.event === 'heartbeat') return;
    if (message.event === 'keyboard') {
      if (typeof message.keyboard !== 'boolean') throw Error('Invalid permission');
      this.update({ keyboard: message.keyboard, error: typeof message.error === 'string' ? message.error : '' }); return;
    }
    if (message.event === 'clipboard') {
      if (!Number.isSafeInteger(message.version) || message.version < 0) throw Error('Invalid clipboard version');
      const reset = this.state.version !== null && message.version < this.state.version;
      this.state.version = message.version; this.onClipboard(message.version, reset); return;
    }
    if (message.event === 'paste') {
      if (message.epoch !== this.epoch) return;
      const target = targetIdentity(message.target, this.ownPID);
      if (!target || !Number.isSafeInteger(message.seq) || message.seq !== this.received + 1 || message.seq > 1000000000) throw Error('Invalid paste command');
      this.received = message.seq;
      const epoch = this.epoch, seq = message.seq;
      Promise.resolve().then(() => { if (this.epoch === epoch && this.state.running) return this.onPaste({ target, epoch, seq }); }).catch(error => {
        if (this.epoch === epoch && this.state.running) this.notifyFailure(error);
      })
        .finally(() => {
          if (this.epoch !== epoch || !this.state.running) return;
          this.completed.add(seq);
          while (this.completed.delete(this.ack + 1)) this.ack++;
          this.sync();
        });
      return;
    }
    throw Error('Unknown stack event');
  }
  fail(message) {
    if (!this.child && !this.starting && !this.state.running) return;
    const error = new Error(message); this.rejectReady?.(error); this.resolveReady = this.rejectReady = null;
    this.update({ running: false, keyboard: false, error: message }); this.notifyFailure(error); void this.stop(false);
  }
  async stop(clearError = true) {
    if (this.closing) return this.closing;
    ++this.lifetime; clearTimeout(this.startTimer); clearInterval(this.heartbeat);
    this.rejectReady?.(new Error('Stack启动已取消。')); this.resolveReady = this.rejectReady = null; this.starting = null;
    const child = this.child; this.child = null; this.ready = null; this.reset();
    this.update({ running: false, keyboard: false, ...(clearError ? { error: '' } : {}) });
    if (!child || child.exitCode !== null || child.signalCode) return;
    this.closing = new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
      const terminate = setTimeout(() => { child.kill('SIGTERM'); }, 1500);
      child.once('close', () => { clearTimeout(timeout); clearTimeout(terminate); resolve(); });
      child.stdin.end();
    }).finally(() => { this.closing = null; });
    return this.closing;
  }
}
module.exports = { StackInput };
