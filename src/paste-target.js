const { validApplicationID } = require('./applications');

function targetIdentity(value, ownPID) {
  if (!value || !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 0x7fffffff || value.pid === ownPID
      || !validApplicationID(value.bundleId) || !Number.isFinite(value.launchTime) || value.launchTime <= 0) return null;
  const target = { pid: value.pid, bundleId: value.bundleId, launchTime: value.launchTime,
    name: typeof value.name === 'string' && value.name.length && value.name.length <= 1000 ? value.name : value.bundleId };
  if (value.windowPoint && Number.isFinite(value.windowPoint.x) && Number.isFinite(value.windowPoint.y)) {
    target.windowPoint = Object.freeze({ x: value.windowPoint.x, y: value.windowPoint.y });
  }
  return Object.freeze(target);
}

class PasteTargetSession {
  constructor({ ownPID, read, beforeReady, onError = () => {} }) { Object.assign(this, { ownPID, read, beforeReady, onError }); this.epoch = 0; this.pending = false; this.target = null; }
  snapshot() { return this.target; }
  cancel() { this.epoch += 1; this.pending = false; this.target = null; }
  async refresh(retain = false) {
    const previous = retain ? this.target : null, epoch = ++this.epoch;
    if (!retain) this.target = null;
    this.pending = true;
    let front;
    try { front = await this.read(); } catch (error) { this.onError(error); }
    if (epoch !== this.epoch) return false;
    const target = front?.pid === this.ownPID ? previous : targetIdentity(front, this.ownPID);
    try { await this.beforeReady?.({ retain, current: () => epoch === this.epoch }); } catch (error) { this.onError(error); }
    if (epoch !== this.epoch) return false;
    this.pending = false;
    this.target = target;
    return true;
  }
}

class PasteDelivery {
  constructor({ permission, verify, activate, dismiss, recover, simulate = false, onError = () => {} }) {
    Object.assign(this, { permission, verify, activate, dismiss, recover, simulate, onError });
  }
  async deliver({ paste, pasteTarget, target, lease, background = false }) {
    if (this.simulate) return { ok: true, copied: true };
    if (!paste || pasteTarget !== 'application') { if (!background) this.dismiss(); return { ok: true, copied: true }; }
    if (!target) return { ok: false, copied: true, error: '内容已复制，未能确认目标应用，请切回目标应用粘贴。' };
    let permission;
    try { permission = await this.permission(); }
    catch (error) { this.onError(error); return { ok: false, copied: true, error: '内容已复制。无法检查辅助功能权限，请手动粘贴或重试。' }; }
    let ownership;
    try { ownership = await this.verify(lease); } catch (error) { this.onError(error); }
    if (ownership?.ok !== true) return clipboardFailure(ownership);
    if (permission?.accessibility !== true) return { ok: false, copied: true, error: '内容已复制。自动粘贴需要在系统设置中授权辅助功能。' };
    let result;
    try {
      if (!background) this.dismiss();
      result = await this.activate(target, lease);
      if (result?.ok === true) return { ok: true, copied: true };
    } catch (error) { this.onError(error); }
    try { if (!background) await this.recover(); } catch (error) { this.onError(error); }
    if (result?.error?.startsWith('clipboard-')) return clipboardFailure(result);
    return { ok: false, copied: true, error: '目标应用不可用，内容已复制到剪贴板，请手动粘贴或重试。' };
  }
}
function clipboardFailure(result) {
  return { ok: false, copied: true, error: result?.error === 'clipboard-changed'
    ? '剪贴板已被其他复制替换，已取消自动粘贴。请重新选择原项目后重试。'
    : '内容已复制，但无法确认剪贴板归属，已取消自动粘贴。请手动粘贴或重试。' };
}
module.exports = { targetIdentity, PasteTargetSession, PasteDelivery };
