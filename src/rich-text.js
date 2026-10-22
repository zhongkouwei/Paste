const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const LIMIT = 16 * 1024 * 1024;
function bounded(value) { return typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= LIMIT; }
function nativeTextMatches(body, text) { return text === body || text === `${body}\n`; }
function unsupportedRTF(rtf) {
  // This is a loss guard, not a document decoder. Cocoa's HTML writer can omit these destinations.
  const opaque = new Set(['pict', 'object', 'objdata', 'objlink', 'objautlink', 'filetbl', 'NeXTGraphic', 'shp', 'shppict', 'nonshppict', 'bin', 'footnote', 'annotation', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'mmath']);
  for (const token of rtf.matchAll(/\\([a-zA-Z]+)(?:-?\d+)? ?|\\(?:[^a-zA-Z]|$)/g)) if (opaque.has(token[1])) return true;
  return false;
}
function runTextUtil(input, from, to, { signal, timeout = 10000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/textutil', ['-convert', to, '-format', from, '-stdin', '-stdout', '-encoding', 'UTF-8', '-noload', '-nostore', '-strip'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let bytes = 0, failure, force;
    const stop = error => { failure ||= error; child.kill(); force ||= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new Error('富文本转换超时，原文未修改。')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    child.on('error', () => { failure ||= new Error('系统富文本转换不可用，原文未修改。'); });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > LIMIT) stop(new Error('转换后的富文本超过16 MiB，原文未修改。')); else chunks.push(chunk); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', abort);
      if (failure || code) { reject(failure || new Error('无法转换此富文本，原文未修改。')); return; }
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new Error('富文本编码不可用，原文未修改。')); }
    });
    // HTML fragments have no charset declaration; the UTF-8 transport must not be guessed as ANSI.
    child.stdin.end(from === 'html' ? `\uFEFF${input}` : input);
  });
}
class RichTextService {
  constructor({ run = runTextUtil } = {}) { this.run = run; this.queue = Promise.resolve(); this.jobs = new Map(); this.cache = new Map(); this.bytes = 0; }
  task(action, signal) {
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const promise = this.queue.then(async () => { if (this.closed) throw new Error('富文本转换已停止'); combined.throwIfAborted(); return action(combined); }).finally(() => this.jobs.delete(controller));
    this.jobs.set(controller, promise); this.queue = promise.catch(() => {}); return promise;
  }
  read(rtf, { signal, key } = {}) {
    if (!bounded(rtf) || !/^\{\\rtf\d/.test(rtf)) return Promise.reject(new Error('RTF格式或大小不可用，原文未修改。'));
    if (unsupportedRTF(rtf)) return Promise.reject(new Error('此RTF包含系统转换无法保留的附件或文档结构，原文未修改。'));
    key ||= crypto.createHash('sha256').update(rtf).digest('hex');
    return this.task(async signal => {
      if (this.cache.has(key)) { const value = this.cache.get(key); this.cache.delete(key); this.cache.set(key, value); return { ...value.data }; }
      const html = await this.run(rtf, 'rtf', 'html', { signal }), text = await this.run(rtf, 'rtf', 'txt', { signal });
      signal.throwIfAborted();
      if (!bounded(html) || !bounded(text)) throw new Error('转换后的富文本超过限制，原文未修改。');
      const data = { html, text }, bytes = Buffer.byteLength(html) + Buffer.byteLength(text);
      if (bytes <= 8 * 1024 * 1024) {
        this.cache.set(key, { data, bytes }); this.bytes += bytes;
        while (this.cache.size > 16 || this.bytes > 8 * 1024 * 1024) { const first = this.cache.keys().next().value; this.bytes -= this.cache.get(first).bytes; this.cache.delete(first); }
      }
      return { ...data };
    }, signal);
  }
  write(html, body, { signal } = {}) {
    if (!bounded(html) || !bounded(body)) return Promise.reject(new Error('富文本格式或大小不可用，原文未修改。'));
    return this.task(async signal => {
      const rtf = await this.run(html, 'html', 'rtf', { signal });
      if (!bounded(rtf) || !/^\{\\rtf\d/.test(rtf)) throw new Error('系统未生成有效RTF，原文未修改。');
      if (unsupportedRTF(rtf)) throw new Error('RTF包含暂不支持编辑的附件或文档结构，原文未修改。');
      const text = await this.run(rtf, 'rtf', 'txt', { signal }); signal.throwIfAborted();
      if (!nativeTextMatches(body, text)) throw new Error('RTF与编辑正文不一致，原文未修改。');
      return rtf;
    }, signal);
  }
  async close() { this.closed = true; for (const controller of this.jobs.keys()) controller.abort(); await Promise.allSettled([...this.jobs.values()]); this.cache.clear(); this.bytes = 0; }
}
module.exports = { RichTextService, runTextUtil, nativeTextMatches, unsupportedRTF };
