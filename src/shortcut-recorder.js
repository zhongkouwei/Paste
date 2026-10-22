const { randomUUID } = require('node:crypto');
const { sanitizeSettings } = require('./model');
const KEYS = new Set(['hotkey', 'stackHotkey', 'nextBoardHotkey', 'previousBoardHotkey']);

class ShortcutRecorder {
  constructor({ getWindow, getSettings, save, onError = () => {} }) { Object.assign(this, { getWindow, getSettings, save, onError }); this.current = null; }
  valid(window) { return window && window === this.getWindow() && !window.isDestroyed() && !window.webContents.isDestroyed() && window.isVisible(); }
  begin(window, key) {
    if (!this.valid(window) || !KEYS.has(key)) throw Error('请从当前设置窗口录制快捷键。');
    const expected = this.getSettings()[key];
    this.clear(this.current, true);
    window.webContents.setIgnoreMenuShortcuts(true);
    this.current = { id: randomUUID(), window, key, expected, phase: 'recording' };
    return { id: this.current.id, key };
  }
  clear(record = this.current, notify = false) {
    if (!record || record !== this.current) return false;
    this.current = null;
    if (!record.window.isDestroyed() && !record.window.webContents.isDestroyed()) {
      try { record.window.webContents.setIgnoreMenuShortcuts(false); } catch (error) { this.onError(error); }
      if (notify) try { record.window.webContents.send('shortcut:recording', { id: record.id, cancelled: true }); } catch (error) { this.onError(error); }
    }
    return true;
  }
  cancel(window, id) { const record = this.current; return record?.window === window && (id === undefined || id === record.id) ? this.clear(record, id === undefined) : false; }
  mode(window) {
    const record = this.current;
    if (record && !this.valid(record.window)) { this.clear(record, true); return null; }
    return record && record.window === window ? record.phase : null;
  }
  interceptGlobal(accelerator) {
    const record = this.current;
    if (!record || !this.mode(record.window)) return false;
    if (!record.window.isFocused()) { this.clear(record, true); return false; }
    // The renderer may ignore an input while composing, so delivery is not
    // acceptance. It owns first-candidate/repeat suppression until full release.
    if (record.phase === 'recording') record.window.webContents.send('shortcut:recording', { id: record.id, accelerator });
    return true;
  }
  async finish(window, id, accelerator) {
    const record = this.current;
    if (!record || record.window !== window || record.id !== id || !this.valid(window)) throw Error('快捷键录制已结束，请重新录制。');
    if (record.phase !== 'recording') throw Error('快捷键正在保存，请稍候。');
    record.phase = 'finishing';
    try {
      if (typeof accelerator !== 'string' || !accelerator || sanitizeSettings({ [record.key]: accelerator }, { [record.key]: '' })[record.key] !== accelerator) throw Error('无效的快捷键组合。');
      return await this.save(settings => {
        if (this.current !== record || !this.valid(window)) throw Error('快捷键录制已取消，设置未修改。');
        if (settings[record.key] !== record.expected) throw Error('该快捷键已在另一处改变，请重新录制。');
        return { [record.key]: accelerator };
      });
    } finally { this.clear(record); }
  }
}
module.exports = { ShortcutRecorder };
