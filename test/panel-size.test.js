const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PanelSize } = require('../src/panel-size');
const { panelLayout, panelFrame } = require('../src/panel-layout');
const { DEFAULT_SETTINGS, sanitizeSettings } = require('../src/model');
function fixture() {
  let display = { id: 1, bounds: { x: -1200, y: -200, width: 1200, height: 900 }, workArea: { x: -1200, y: -176, width: 1200, height: 850 } }, preferred = 332;
  let bounds = panelFrame(display, preferred).bounds; const saves = [];
  const size = new PanelSize({ getBounds: () => ({ ...bounds }), display: () => display, apply: value => { bounds = value; }, preference: () => preferred,
    save: async height => { saves.push(height); preferred = height; } });
  return { size, saves, bounds: () => bounds, preference: () => preferred, display: value => { display = value; } };
}
test('default metrics retain measured geometry while large and compact layouts share virtual spacing', () => {
  assert.deepEqual(panelLayout(332), { cardHeight: 240, cardWidth: 240, step: 264, headerHeight: 52, trackHeight: 272, compact: false });
  assert.deepEqual(panelLayout(180), { cardHeight: 88, cardWidth: 160, step: 184, headerHeight: 36, trackHeight: 120, compact: true });
  const large = panelLayout(532); assert.equal(large.cardHeight, 440); assert.equal(large.cardWidth, 440); assert.equal(large.step, 464);
  assert.equal(panelLayout(532, 390).cardWidth, 342); assert.equal(panelLayout(332, 320).cardWidth, 240);
});
test('frames retain a negative-origin display bottom, avoid its menu bar and clamp to actual available space', () => {
  const display = { bounds: { x: -1200, y: -200, width: 1200, height: 900 }, workArea: { y: -176 } };
  assert.deepEqual(panelFrame(display, 2000), { bounds: { x: -1200, y: -176, width: 1200, height: 876 }, min: 180, max: 876 });
  assert.equal(panelFrame(display, 1).bounds.height, 180); assert.equal(panelFrame(display, NaN).bounds.height, 332);
  assert.throws(() => panelFrame({ bounds: { width: 0 } }, 332));
});
test('dragging applies bounded live geometry without writes and persists the final pointer position only once', async () => {
  const { size, saves, bounds } = fixture(), token = size.begin(368);
  size.move(token.id, 200); assert.equal(bounds().height, 500); assert.equal(bounds().y + bounds().height, 700); assert.deepEqual(saves, []);
  await size.end(token.id, 168); assert.equal(bounds().height, 532); assert.deepEqual(saves, [532]);
  assert.equal(size.move(token.id, 400).ok, false); assert.equal((await size.end(token.id, 300)).ok, false);
});
test('cancel, replacement and display changes invalidate old gestures without changing remembered preferences', async () => {
  const f = fixture(), first = f.size.begin(300); f.size.move(first.id, 100); f.size.cancel(); assert.equal(f.bounds().height, 332); assert.deepEqual(f.saves, []);
  const old = f.size.begin(300), current = f.size.begin(200); assert.equal(f.size.move(old.id, 10).ok, false); await f.size.end(current.id, 100); assert.deepEqual(f.saves, [432]);
  const stale = f.size.begin(200); f.display({ id: 2, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { y: 24 } });
  assert.equal(f.size.move(stale.id, 100).ok, false); f.size.place(); assert.deepEqual(f.bounds(), { x: 0, y: 168, width: 800, height: 432 });
});
test('failed persistence restores the saved size, but an older failure cannot resize a newer gesture', async () => {
  const f = fixture(); f.size.save = async () => { throw Error('Disk failure'); };
  const first = f.size.begin(300); await assert.rejects(f.size.end(first.id, 100), /Disk failure/); assert.equal(f.bounds().height, 332);
  let reject; f.size.save = () => new Promise((_resolve, fail) => { reject = fail; });
  const old = f.size.begin(300), saving = f.size.end(old.id, 100); const failed = assert.rejects(saving, /Late failure/);
  const fresh = f.size.begin(200); f.size.move(fresh.id, 180); const latest = f.bounds(); reject(Error('Late failure')); await failed; assert.deepEqual(f.bounds(), latest);
});
test('an oversized preference clamps per display without overwriting the preferred height on show', () => {
  const f = fixture(); f.size.preference = () => 1200; f.size.place(); assert.equal(f.bounds().height, 876); assert.deepEqual(f.saves, []);
});
test('panel height is optional for old settings and rejects noncanonical or unbounded preferences', () => {
  assert.equal(DEFAULT_SETTINGS.panelHeight, 332);
  for (const value of [null, '332', 179, 1601, 332.5, NaN, Infinity]) assert.equal(sanitizeSettings({ panelHeight: value }).panelHeight, 332);
  assert.equal(sanitizeSettings({ panelHeight: 532 }).panelHeight, 532);
});
