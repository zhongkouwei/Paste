class ClipboardMonitor {
  constructor({ readVersion, readSnapshot, onSnapshot, isPaused = () => false, isKnown = () => false, onError = () => {}, readContext = () => null, onObserved = () => {}, onBaseline = () => {} }) {
    Object.assign(this, { readVersion, readSnapshot, onSnapshot, isPaused, isKnown, onError, readContext, onObserved, onBaseline });
    this.version = null; this.signature = ''; this.generation = 0; this.busy = false; this.suspended = 0; this.initial = true;
    this.pending = null; this.owned = new Map(); this.ownedTokens = new Set();
    this.needsBaseline = false; this.baselineError = '';
  }
  invalidate() { this.generation++; }
  requireBaseline() { this.invalidate(); this.needsBaseline = true; }

  async versionNow() {
    const value = await this.readVersion();
    return Number.isInteger(value) ? value : null;
  }

  tick() {
    if (this.pending) return this.pending;
    if (this.suspended) return Promise.resolve();
    this.pending = this.check().finally(() => { this.pending = null; }); return this.pending;
  }
  async check() {
    this.busy = true;
    const generation = this.generation, context = this.readContext();
    try {
      const before = await this.versionNow();
      if (generation !== this.generation || this.suspended) return;
      if (this.isPaused()) { this.version = before; this.signature = ''; return; }
      if (this.needsBaseline) {
        if (!Number.isSafeInteger(before) || before < 0) throw Error('无法确认剪贴板变化，记录尚未恢复。');
        this.version = before; this.signature = ''; this.initial = false; this.needsBaseline = false;
        await this.onBaseline(before); this.baselineError = ''; return;
      }
      if (before !== null && before === this.version) return;
      const snapshot = await this.readSnapshot();
      const after = await this.versionNow();
      // A copy or settings change during an asynchronous read invalidates that
      // candidate. Do not advance the version; retry the new clipboard next tick.
      if (generation !== this.generation || this.suspended || this.isPaused() || (before !== null && before !== after)) return;
      const owned = !!snapshot?.clipboardWriteID && this.owned.get(after) === snapshot.clipboardWriteID;
      const uncertain = !owned && !!snapshot?.clipboardWriteID && this.ownedTokens.has(snapshot.clipboardWriteID);
      let saved;
      if (snapshot && !owned && snapshot.signature !== this.signature && !(this.initial && this.isKnown(snapshot.signature))) {
        const { clipboardWriteID: _writeID, ...record } = snapshot;
        saved = await this.onSnapshot(record);
      }
      await this.onObserved(snapshot, { version: after, initial: this.initial, owned, uncertain, context, saved });
      this.version = after; this.signature = snapshot?.signature || ''; this.initial = false;
    } catch (error) { if (this.needsBaseline) this.baselineError = error.message; this.onError(error); }
    finally { this.busy = false; }
  }

  remember(signature, lease) {
    this.signature = signature; this.initial = false;
    if (Number.isSafeInteger(lease?.version) && typeof lease.token === 'string') this.owned.set(lease.version, lease.token);
    if (typeof lease?.token === 'string') this.ownedTokens.add(lease.token);
    while (this.owned.size > 64) this.owned.delete(this.owned.keys().next().value);
    while (this.ownedTokens.size > 64) this.ownedTokens.delete(this.ownedTokens.values().next().value);
  }

  async suspend(operation, { baseline = false } = {}) {
    this.generation += 1; this.suspended += 1;
    try {
      const version = baseline ? await this.versionNow() : null;
      const result = await operation();
      if (baseline) { this.version = version; this.signature = ''; this.initial = false; }
      return result;
    } finally { this.suspended -= 1; }
  }
}
module.exports = { ClipboardMonitor };
