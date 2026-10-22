const { PAUSE_DURATIONS } = require('./model');
class CapturePause {
  constructor({ read, save, monitor, now = Date.now, schedule = setTimeout, cancel = clearTimeout, automatic = true, onChange = () => {}, onError = () => {} }) {
    Object.assign(this, { read, save, monitor, now, schedule, cancel, automatic, onChange, onError });
    this.hold = false; this.token = 0; this.pending = false; this.error = ''; this.timer = null; this.timerEpoch = 0; this.retryAt = 0;
  }
  isPaused() { return this.hold || this.read().paused; }
  snapshot() {
    const settings = this.read(), paused = this.isPaused();
    return { paused, until: settings.paused ? settings.pausedUntil : null, pending: this.pending,
      resuming: (this.pending && !this.desired) || (!paused && this.monitor.needsBaseline), error: this.error || (this.monitor.needsBaseline ? this.monitor.baselineError : '') };
  }
  request(changes) {
    if (typeof changes?.paused !== 'boolean' && !Object.hasOwn(changes || {}, 'pausedUntil')) return null;
    const desired = typeof changes.paused === 'boolean' ? changes.paused : this.read().paused;
    const ticket = { token: ++this.token, resume: !desired && this.isPaused() };
    this.pending = true; this.desired = desired; this.error = ''; this.retryAt = 0;
    if (desired) { this.hold = true; this.monitor.invalidate(); }
    this.onChange(); return ticket;
  }
  beforeCommit(ticket) { if (ticket?.resume) this.monitor.requireBaseline(); }
  committed(ticket) {
    if (ticket?.token === this.token) { this.hold = false; this.pending = false; this.error = ''; }
    this.sync();
  }
  failed(ticket, error) {
    if (ticket?.token === this.token) {
      this.hold = true; this.pending = false; this.desired = true;
      this.error = `暂停状态未能保存，当前会话仍停止记录：${error.message}`; this.retryAt = this.now() + 5000;
    }
    this.sync();
  }
  sync() {
    if (this.timer !== null) this.cancel(this.timer); this.timer = null;
    const epoch = ++this.timerEpoch, settings = this.read();
    if (this.closed || !this.automatic || !settings.paused || !Number.isSafeInteger(settings.pausedUntil)) return;
    const delay = Math.min(60000, Math.max(0, settings.pausedUntil - this.now(), this.retryAt - this.now()));
    this.timer = this.schedule(() => {
      if (epoch !== this.timerEpoch || this.closed) return;
      this.timer = null; this.check().catch(this.onError);
    }, delay);
  }
  async check() {
    if (this.closed || this.pending) return;
    const settings = this.read();
    if (settings.paused && Number.isSafeInteger(settings.pausedUntil) && settings.pausedUntil <= this.now() && this.now() >= this.retryAt) {
      await this.resume();
    } else this.sync();
  }
  pauseFor(duration = null) {
    if (duration !== null && !PAUSE_DURATIONS.includes(duration)) return Promise.reject(Error('请选择有效的暂停时长。'));
    return this.save({ paused: true, pausedUntil: duration === null ? null : this.now() + duration });
  }
  resume() { return this.save({ paused: false, pausedUntil: null }); }
  toggle() { return this.pending ? (this.desired ? this.resume() : this.pauseFor()) : this.isPaused() ? this.resume() : this.pauseFor(); }
  close() { this.closed = true; this.hold = true; this.monitor.invalidate(); this.timerEpoch++; if (this.timer !== null) this.cancel(this.timer); this.timer = null; }
}
module.exports = { CapturePause };
