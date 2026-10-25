const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function preserveClipboard(directory, { run = execFileSync } = {}) {
  const stat = fs.statSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077)) throw new Error('Clipboard snapshot requires a private directory (0700).');
  const executable = path.join(directory, 'clipboard-snapshot');
  run('xcrun', ['clang', '-O2', '-fobjc-arc', '-framework', 'Cocoa', path.resolve(__dirname, '../test/fixtures/pasteboard-snapshot.m'), '-o', executable], { timeout: 30000 });
  let saved;
  try { saved = run(executable, ['snapshot'], { stdio: 'pipe', maxBuffer: 96 * 1024 * 1024, timeout: 15000 }); }
  catch { throw new Error('Clipboard snapshot could not be completed; tests stopped before modifying clipboard contents.'); }
  let restored = false;
  return { restore() {
    if (restored) return;
    try { run(executable, ['restore'], { stdio: 'pipe', input: saved, timeout: 30000 }); restored = true; }
    catch {
      const recovery = path.join(directory, 'clipboard-recovery.json');
      fs.writeFileSync(recovery, saved, { mode: 0o600 });
      throw new Error(`Clipboard restore failed; private original snapshot retained at ${recovery}. Keep this directory for recovery.`);
    }
  } };
}
module.exports = { preserveClipboard };
