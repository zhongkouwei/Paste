/* global PastePanelLayout, toast */
(function () {
  const api = window.paste, handle = document.getElementById('panelResize');
  let gesture = null, revision = -1, epoch = 0;
  function sizeInfo(info) {
    if (!info) return;
    if (Number.isInteger(info.revision)) { if (info.revision < revision) return; revision = info.revision; }
    for (const [key, value] of [['min', info.min], ['max', info.max], ['now', info.height]]) if (Number.isFinite(value)) handle.setAttribute(`aria-value${key}`, Math.round(value));
  }
  function position(g) {
    if (g.pointer !== null) return g.y;
    const desired = (g.absolute === null ? g.info.height : g.absolute) + g.delta;
    return g.info.height - Math.max(g.info.min, Math.min(g.info.max, desired));
  }
  function queueMove(g) {
    g.dirty = true;
    if (g.frame || g.busy || g.finished) return;
    g.frame = requestAnimationFrame(async () => {
      g.frame = null; g.busy = true; g.dirty = false;
      try {
        await g.ready;
        if (!g.finished && g.info) sizeInfo(await api.movePanelResize(g.info.id, position(g)));
      } catch (error) { if (!g.finished) { toast(error.message); finish(g, true); } }
      finally { g.busy = false; if (g.dirty && !g.finished) queueMove(g); }
    });
  }
  function begin(y, pointer = null) {
    const g = { y, pointer, epoch: ++epoch, returnFocus: document.activeElement, info: null, frame: null, busy: false, dirty: false, finished: false, absolute: null, delta: 0 };
    gesture = g; document.body.classList.add('resizing');
    g.ready = api.beginPanelResize(y).then(info => { g.info = info; sizeInfo(info); return info; });
    // A quick pointer-up can precede the begin reply. finish still owns and
    // closes that exact native session rather than leaving a resize active.
    g.ready.catch(error => { if (!g.finished) { toast(error.message); finish(g, true); } });
    return g;
  }
  async function finish(g, cancel = false, restoreFocus = true) {
    if (!g || g.finished) return;
    const returnFocus = restoreFocus && g.pointer !== null && document.activeElement === handle;
    g.finished = true; cancelAnimationFrame(g.frame);
    if (gesture === g) { gesture = null; document.body.classList.remove('resizing'); }
    if (g.pointer !== null && handle.hasPointerCapture(g.pointer)) handle.releasePointerCapture(g.pointer);
    try { await g.ready; if (g.info) sizeInfo(await api.endPanelResize(g.info.id, position(g), cancel)); }
    catch (error) { if (!cancel) toast(error.message); }
    finally {
      if (returnFocus && epoch === g.epoch && !gesture && document.activeElement === handle) (g.returnFocus?.isConnected ? g.returnFocus : document.getElementById('timeline')).focus({ preventScroll: true });
    }
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault(); if (gesture) return;
    const g = begin(event.screenY, event.pointerId); handle.focus({ preventScroll: true }); handle.setPointerCapture(event.pointerId); queueMove(g);
  });
  handle.addEventListener('pointermove', event => { if (gesture?.pointer === event.pointerId) { gesture.y = event.screenY; queueMove(gesture); } });
  handle.addEventListener('pointerup', event => { if (gesture?.pointer === event.pointerId) { gesture.y = event.screenY; finish(gesture); } });
  handle.addEventListener('pointercancel', event => { if (gesture?.pointer === event.pointerId) finish(gesture, true); });
  handle.addEventListener('lostpointercapture', event => { if (gesture?.pointer === event.pointerId) finish(gesture, true); });
  handle.addEventListener('dblclick', event => {
    event.preventDefault(); if (gesture) return;
    const g = begin(0); g.absolute = PastePanelLayout.DEFAULT_HEIGHT; finish(g);
  });
  handle.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); finish(gesture, true); document.getElementById('timeline').focus(); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Enter' && event.repeat) return;
    if (gesture && gesture.pointer !== null) return;
    const g = gesture || begin(0);
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') g.delta += (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 64 : 16);
    else { g.absolute = event.key === 'Home' ? PastePanelLayout.MIN_HEIGHT : event.key === 'End' ? PastePanelLayout.MAX_HEIGHT : PastePanelLayout.DEFAULT_HEIGHT; g.delta = 0; }
    queueMove(g);
  });
  handle.addEventListener('keyup', event => {
    if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key) && gesture?.pointer === null) { event.stopPropagation(); finish(gesture); }
  });
  handle.addEventListener('blur', () => finish(gesture, true));
  function leaveContext() { epoch++; finish(gesture, true, false); }
  window.addEventListener('blur', leaveContext);
  document.addEventListener('visibilitychange', () => { if (document.hidden) leaveContext(); });
  api.onPanelSize(sizeInfo);
  window.addEventListener('resize', () => handle.setAttribute('aria-valuenow', innerHeight));
  api.onShown(() => { leaveContext(); api.getPanelSize().then(sizeInfo).catch(error => toast(error.message)); });
  api.getPanelSize().then(sizeInfo).catch(error => toast(error.message));
})();
