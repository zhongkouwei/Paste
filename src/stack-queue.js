const { randomUUID } = require('node:crypto');

class StackQueue {
  constructor() { this.entries = []; this.active = false; this.session = 0; this.requestEpoch = 0; this.reservations = new Map(); this.direction = 'oldest'; this.version = null; this.problem = ''; this.deliveryError = ''; }
  start(version = null) {
    this.stop(); this.active = true; this.version = Number.isSafeInteger(version) ? version : null;
  }
  stop() { this.active = false; this.session++; this.requestEpoch++; this.entries = []; this.reservations.clear(); this.direction = 'oldest'; this.version = null; this.problem = ''; this.deliveryError = ''; }
  ordered() { return this.direction === 'oldest' ? [...this.entries] : [...this.entries].reverse(); }
  add(itemId, { unique = true } = {}) {
    if (unique && this.entries.some(entry => entry.itemId === itemId)) return false;
    if (this.entries.length >= 1000) { this.problem = 'Stack已达1000项上限，请先粘贴或移除项目。'; return false; }
    this.entries.push({ id: randomUUID(), itemId }); return true;
  }
  observe(itemId, { version, session, owned = false, uncertain = false } = {}) {
    if (!this.active || session !== this.session || !Number.isSafeInteger(version) || (this.version !== null && version <= this.version)) return false;
    if (this.version !== null && version > this.version + 1) this.problem = '剪贴板在读取前多次改变，可能有内容未收集，请重新复制缺少的项目。';
    this.version = version;
    if (uncertain) { this.problem = '复制归属无法确认，本次未加入Stack，请重新复制。'; return false; }
    return itemId && !owned ? this.add(itemId, { unique: false }) : false;
  }
  reverse() { this.direction = this.direction === 'oldest' ? 'newest' : 'oldest'; }
  remove(id) { this.entries = this.entries.filter(entry => entry.id !== id); }
  retain(hasItem) { this.entries = this.entries.filter(entry => hasItem(entry.itemId)); }
  reserve(kind = 'manual', nativeEpoch = null) {
    const reserved = new Set([...this.reservations.values()].map(token => token.entryId));
    const entry = this.ordered().find(value => !reserved.has(value.id));
    if (!entry) return null;
    const token = { id: randomUUID(), entryId: entry.id, itemId: entry.itemId, session: this.session,
      requestEpoch: this.requestEpoch, kind, nativeEpoch, started: false };
    this.reservations.set(token.id, token); return token;
  }
  begin(token) {
    if (!this.reservations.has(token.id) || token.session !== this.session || token.requestEpoch !== this.requestEpoch
        || !this.entries.some(entry => entry.id === token.entryId)) return false;
    token.started = true; return true;
  }
  finish(token, success) {
    this.reservations.delete(token.id);
    if (success && token.started && token.session === this.session) this.remove(token.entryId);
  }
  cancelPending() {
    this.requestEpoch++;
    for (const [id, token] of this.reservations) if (!token.started) this.reservations.delete(id);
  }
  inventory(nativeEpoch) {
    const reserved = new Set([...this.reservations.values()].map(token => token.entryId));
    const available = this.entries.filter(entry => !reserved.has(entry.id)).length;
    const native = [...this.reservations.values()].filter(token => token.kind === 'native' && token.nativeEpoch === nativeEpoch && this.entries.some(entry => entry.id === token.entryId)).length;
    return { count: available + native, busy: this.reservations.size > 0 };
  }
  snapshot() {
    const reserved = new Set([...this.reservations.values()].map(token => token.entryId));
    return { active: this.active, session: this.session, direction: this.direction, problem: this.problem, deliveryError: this.deliveryError,
      entries: this.ordered().map(entry => ({ ...entry, pending: reserved.has(entry.id) })) };
  }
}
module.exports = { StackQueue };
