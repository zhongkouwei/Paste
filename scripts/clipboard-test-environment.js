const { execFileSync } = require('node:child_process');

function activeRecorders(output) {
  return output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[2].includes('T') || !/(?:^|\/)Paste(?: Easy| Like)?\.app\/Contents\/MacOS\/Paste(?: Easy| Like)?$/.test(match[3])) return [];
    return [{ pid: Number(match[1]), executable: match[3] }];
  });
}
function assertClipboardIsolation({ platform = process.platform, list = () => execFileSync('/bin/ps', ['-axo', 'pid=,stat=,comm='], { encoding: 'utf8' }) } = {}) {
  if (platform !== 'darwin') return;
  const recorders = activeRecorders(list());
  if (recorders.length) throw new Error(`剪贴板集成测试已停止：请先退出其他 Paste 记录程序，或使用明确隔离的测试环境。检测到 ${recorders.map(value => `${value.pid}: ${value.executable}`).join(', ')}`);
}
module.exports = { activeRecorders, assertClipboardIsolation };
if (require.main === module) {
  try { assertClipboardIsolation(); process.stdout.write('已通过已知 Paste 记录程序运行检查；仍需确认其他剪贴板工具已退出。\n'); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
