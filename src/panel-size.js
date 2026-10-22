const { MIN_HEIGHT, panelFrame } = require('./panel-layout');
const fingerprint = display => JSON.stringify([display.id, display.bounds, display.workArea]);
const validY = value => Number.isFinite(value) && Math.abs(value) <= 1000000;
class PanelSize {
  constructor({ getBounds, display, apply, preference, save }) { Object.assign(this, { getBounds, display, apply, preference, save }); this.epoch = 0; this.revision = 0; this.session = null; }
  info(display = this.display()) { const { min, max } = panelFrame(display, this.getBounds().height); return { height: this.getBounds().height, min, max, revision: ++this.revision }; }
  place(display = this.display()) { this.cancel(false); this.apply(panelFrame(display, this.preference()).bounds); return this.info(display); }
  begin(y) {
    if (!validY(y)) throw Error('无效的窗口调整位置。');
    const display = this.display(), id = ++this.epoch;
    this.session = { id, y, height: this.getBounds().height, display: fingerprint(display) };
    return { id, ...this.info(display) };
  }
  move(id, y) {
    const session = this.session;
    if (!session || id !== session.id || !validY(y)) return { ok: false };
    const display = this.display();
    if (fingerprint(display) !== session.display) { this.cancel(false); return { ok: false }; }
    this.apply(panelFrame(display, session.height + session.y - y).bounds);
    return { ok: true, ...this.info(display) };
  }
  async end(id, y, cancel = false) {
    if (!this.session || id !== this.session.id) return { ok: false };
    if (cancel) { this.cancel(); return { ok: true, ...this.info() }; }
    const result = this.move(id, y); if (!result.ok) return result;
    this.session = null;
    try { await this.save(Math.max(MIN_HEIGHT, result.height)); }
    catch (error) {
      // A failed older save must never resize a later gesture or display session.
      if (this.epoch === id) this.apply(panelFrame(this.display(), this.preference()).bounds);
      throw error;
    }
    return result;
  }
  cancel(restore = true) {
    const session = this.session; this.session = null; this.epoch++;
    if (restore && session) this.apply(panelFrame(this.display(), session.height).bounds);
  }
}
module.exports = { PanelSize };
