class GlobalHotkeys {
  constructor(registry, callbacks, disabled = false, intercept = () => false) {
    this.registry = registry; this.callbacks = callbacks; this.disabled = disabled; this.intercept = intercept; this.current = []; this.bindings = new Map(); this.pending = null;
  }

  release(keys) {
    const failed = [];
    for (const key of keys) {
      try {
        this.registry.unregister(key);
        if (this.registry.isRegistered?.(key)) throw Error('Still registered');
        this.bindings.delete(key);
      } catch { failed.push(key); }
    }
    return failed.length ? '部分快捷键绑定未能释放，请重试或重启应用。' : '';
  }
  get needsCleanup() { const wanted = new Set(this.current.map(([key]) => key)); return [...this.bindings.keys()].some(key => !wanted.has(key)); }

  prepare(settings) {
    if (this.pending) throw Error('快捷键设置正在处理中，请稍候。');
    const desired = [['hotkey', this.callbacks.history], ['stackHotkey', this.callbacks.stack]]
      .filter(([key]) => settings[key]).map(([key, callback]) => [settings[key], callback]);
    if (desired.some(([key, callback]) => typeof key !== 'string' || typeof callback !== 'function')) throw Error('无效的快捷键。');
    if (new Set(desired.map(([key]) => key)).size !== desired.length) throw Error('启动与Stack快捷键不能相同。');
    const acquired = [];
    try {
      if (!this.disabled) for (const [accelerator] of desired) {
        if (this.bindings.has(accelerator)) continue;
        // A staged key is inert until its settings commit. Existing keys keep
        // their dispatcher even when history and Stack swap combinations.
        const dispatch = () => { const action = this.current.find(([key]) => key === accelerator)?.[1]; if (action && !this.intercept(accelerator)) action(); };
        if (!this.registry.register(accelerator, dispatch)) throw Error(`快捷键 ${accelerator} 已被占用，请更换。`);
        this.bindings.set(accelerator, dispatch); acquired.push(accelerator);
      }
    } catch (error) {
      const warning = this.release(acquired);
      if (warning) throw Error(`${error.message} ${warning}`, { cause: error });
      throw error;
    }
    let phase = 'prepared', warning = '';
    const transaction = {
      commit: () => {
        if (phase === 'committed') return warning;
        if (phase !== 'prepared') throw Error('快捷键设置已取消。');
        this.current = desired; phase = 'committed'; this.pending = null;
        const wanted = new Set(desired.map(([key]) => key));
        warning = this.release([...this.bindings.keys()].filter(key => !wanted.has(key))); return warning;
      },
      rollback: () => {
        if (phase !== 'prepared') return warning;
        phase = 'rolledback'; this.pending = null; warning = this.release(acquired); return warning;
      }
    };
    this.pending = transaction; return transaction;
  }
  apply(settings) { return this.prepare(settings).commit(); }
}
module.exports = { GlobalHotkeys };
