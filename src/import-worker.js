const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parentPort, workerData: job } = require('node:worker_threads');
const { parseBackup } = require('./import-parse');
const { ImportNormalizer } = require('./import-normalize');
const { exportFile } = require('./export-file');
const controller = new AbortController(), pending = new Map(); let sequence = 0;
parentPort.on('message', message => {
  if (message.type === 'cancel') { controller.abort(); for (const request of pending.values()) request.reject(controller.signal.reason); pending.clear(); }
  else if (pending.has(message.request)) { const request = pending.get(message.request); pending.delete(message.request); if (message.error) request.reject(Object.assign(new Error(message.error), { name: message.name || 'Error' })); else request.resolve(message.result); }
});
async function checksum(file, expected) {
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('恢复资产不是普通文件。');
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal: controller.signal })) digest.update(chunk);
  if (digest.digest('hex') !== expected) throw new Error('恢复资产校验失败。');
}
async function run() {
  if (job.operation === 'prepare') {
    let done = 0, notified = 0;
    const normalizer = new ImportNormalizer(job.stage, (name, { turns = 0 } = {}) => new Promise((resolve, reject) => {
      const request = ++sequence; pending.set(request, { resolve, reject }); parentPort.postMessage({ validateImage: name, turns, request });
    }), controller.signal);
    const header = await parseBackup(job.file, async item => {
      await normalizer.add(item); done++;
      if (Date.now() - notified >= 100) { parentPort.postMessage({ done }); notified = Date.now(); }
    }, { signal: controller.signal });
    controller.signal.throwIfAborted(); return normalizer.finish(header);
  }
  const backup = await exportFile({ directory: job.directory, directories: [], data: job.current, file: job.checkpoint,
    temporary: job.temporary, signal: controller.signal, onTemporary: () => parentPort.postMessage({ temporaryOwned: true }) });
  if (backup.warning) throw new Error('恢复前备份已写入，但耐久性尚未确认；原库未替换。');
  // Only immutable files created by validation are promoted. The manifest commit stays in the parent.
  for (const folder of ['contents', 'assets']) {
    for (const name of fs.readdirSync(path.join(job.stage, folder))) {
      controller.signal.throwIfAborted();
      if (!(folder === 'contents' ? /^[a-f0-9]{64}\.json$/ : /^[a-f0-9]{64}\.png$/).test(name)) throw new Error('暂存资产名称无效。');
      const source = path.join(job.stage, folder, name), target = path.join(job.directory, folder, name), digest = name.slice(0, 64);
      await checksum(source, digest);
      if (fs.existsSync(target)) await checksum(target, digest);
      else {
        try { fs.linkSync(source, target); } catch (error) { if (error.code !== 'EEXIST') throw error; await checksum(target, digest); }
      }
      const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    const fd = fs.openSync(path.join(job.directory, folder), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  controller.signal.throwIfAborted(); return { checkpoint: job.checkpoint };
}
run().then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: error.message, name: error.name })).finally(() => parentPort.close());
