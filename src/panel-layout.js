(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PastePanelLayout = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const DEFAULT_HEIGHT = 332, MIN_HEIGHT = 180, MAX_HEIGHT = 1600;
  function panelLayout(value, viewportWidth = Infinity) {
    const height = Number.isFinite(value) ? Math.max(1, Math.round(value)) : DEFAULT_HEIGHT;
    const cardHeight = Math.max(88, height - 92), compact = cardHeight < 180;
    const preferredWidth = compact ? Math.max(160, cardHeight) : cardHeight;
    const cardWidth = Math.min(preferredWidth, Number.isFinite(viewportWidth) ? Math.max(160, viewportWidth - 48) : preferredWidth);
    return { cardHeight, cardWidth, step: cardWidth + 24, headerHeight: compact ? 36 : 52, trackHeight: Math.max(1, height - 60), compact };
  }
  function panelFrame(display, value) {
    const bounds = display?.bounds;
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) || bounds.width <= 0 || bounds.height <= 0) throw Error('无法确认显示器范围。');
    const bottom = bounds.y + bounds.height;
    const top = Math.min(bottom - 1, Math.max(bounds.y, Number.isFinite(display.workArea?.y) ? display.workArea.y : bounds.y));
    const max = Math.min(MAX_HEIGHT, bottom - top), min = Math.min(MIN_HEIGHT, max);
    const height = Math.round(Math.max(min, Math.min(max, Number.isFinite(value) ? value : DEFAULT_HEIGHT)));
    return { bounds: { x: bounds.x, y: bottom - height, width: bounds.width, height }, min, max };
  }
  return { DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT, panelLayout, panelFrame };
});
