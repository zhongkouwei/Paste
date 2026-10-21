class GlobalHotkeys {
  constructor(registry, callbacks, disabled = false) {
    this.registry = registry; this.callbacks = callbacks; this.disabled = disabled; this.current = [];
  }

  apply(settings) {
    if (this.disabled) return;
    const desired = [['hotkey', this.callbacks.history], ['stackHotkey', this.callbacks.stack]]
      .filter(([key]) => settings[key]).map(([key, callback]) => [settings[key], callback]);
    const previous = this.current;
    this.registry.unregisterAll();
    try {
      for (const [accelerator, callback] of desired) if (!this.registry.register(accelerator, callback)) throw new Error(`快捷键 ${accelerator} 已被占用，请更换。`);
      this.current = desired;
    } catch (error) {
      this.registry.unregisterAll();
      for (const [accelerator, callback] of previous) this.registry.register(accelerator, callback);
      throw error;
    }
  }
}
module.exports = { GlobalHotkeys };
