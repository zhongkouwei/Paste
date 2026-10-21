class ClipboardMonitor {
  constructor({ readVersion, readSnapshot, onSnapshot, isPaused = () => false, isKnown = () => false, onError = () => {} }) {
    Object.assign(this, { readVersion, readSnapshot, onSnapshot, isPaused, isKnown, onError });
    this.version = null; this.signature = ''; this.generation = 0; this.busy = false; this.suspended = 0; this.initial = true;
  }

  async versionNow() {
    const value = await this.readVersion();
    return Number.isInteger(value) ? value : null;
  }

  async tick() {
    if (this.busy || this.suspended) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const before = await this.versionNow();
      if (generation !== this.generation || this.suspended) return;
      if (this.isPaused()) { this.version = before; this.signature = ''; return; }
      if (before !== null && before === this.version) return;
      const snapshot = await this.readSnapshot();
      const after = await this.versionNow();
      // A copy or settings change during an asynchronous read invalidates that
      // candidate. Do not advance the version; retry the new clipboard next tick.
      if (generation !== this.generation || this.suspended || this.isPaused() || (before !== null && before !== after)) return;
      if (snapshot && snapshot.signature !== this.signature && !(this.initial && this.isKnown(snapshot.signature))) await this.onSnapshot(snapshot);
      this.version = after; this.signature = snapshot?.signature || ''; this.initial = false;
    } catch (error) { this.onError(error); }
    finally { this.busy = false; }
  }

  remember(signature) { this.signature = signature; this.initial = false; }

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
