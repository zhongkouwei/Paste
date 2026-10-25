(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PasteModel = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const TYPES = ['text', 'link', 'code', 'image', 'color', 'file'];
  const COLORS = ['#ef6259', '#f3ad43', '#62c68d', '#4f80ed', '#af78d3', '#dc79b0', '#8e9299'];
  const PAUSE_OPTIONS = [[15 * 60000, '15分钟'], [30 * 60000, '30分钟'], [60 * 60000, '1小时'],
    [180 * 60000, '3小时'], [480 * 60000, '8小时'], [null, '直到手动恢复']];
  const PAUSE_DURATIONS = PAUSE_OPTIONS.filter(([duration]) => duration !== null).map(([duration]) => duration);
  const DEFAULT_SETTINGS = {
    launchAtLogin: false, background: true, showInMenuBar: true, pasteTarget: 'application', plainText: false,
    retentionDays: 30, maxItems: 10000, paused: false, pausedUntil: null, panelHeight: 332, sound: false,
    ignoreConfidential: true, ignoreTransient: true, excludedApps: ['com.apple.keychainaccess'],
    hotkey: 'CommandOrControl+Shift+V', stackHotkey: 'CommandOrControl+Shift+C',
    nextBoardHotkey: 'CommandOrControl+Right', previousBoardHotkey: 'CommandOrControl+Left',
    quickPasteModifier: 'CommandOrControl', plainTextModifier: 'Shift', theme: 'system', language: 'zh-CN'
  };

  function classifyText(text) {
    const value = text.trim();
    if (/^https?:\/\/\S+$/i.test(value)) return 'link';
    if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return 'color';
    if (/(\bfunction\b|\bconst\b|\bclass\b|=>|^\s*(import|export)\s+)/m.test(text)) return 'code';
    return 'text';
  }

  function filterItems(items, { board = 'history', boards = [], pinboard = '', query = '', type = 'all', source = '', after = '', before = '' } = {}) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const from = after ? Date.parse(after) : null, until = before ? Date.parse(before) : null;
    if ((after && !Number.isFinite(from)) || (before && !Number.isFinite(until))) return [];
    const filtered = items.filter(item => {
      if (board !== 'history' && !item.boardIds?.includes(board)) return false;
      if (pinboard && !item.boardIds?.includes(pinboard)) return false;
      if (type !== 'all' && item.type !== type && !(type === 'text' && item.type === 'code')) return false;
      if (source && item.source?.bundleId !== source) return false;
      if (after || before) {
        const copied = Date.parse(item.createdAt);
        if (!Number.isFinite(copied) || (from !== null && copied < from) || (until !== null && copied >= until)) return false;
      }
      if (!terms.length) return true;
      const haystack = searchText(item);
      return terms.every(term => haystack.includes(term));
    });
    const order = boards.find(entry => entry.id === board)?.itemOrder;
    if (order?.length) {
      const positions = new Map(order.map((id, index) => [id, index]));
      filtered.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
    }
    return filtered;
  }

  function searchText(item) {
    return `${item.title}\n${item.type === 'image' ? '' : item.body || ''}\n${item.ocr && item.ocr.signature === item.signature ? item.ocr.text : ''}\n${item.source?.name || ''}\n${item.note || ''}`.toLocaleLowerCase();
  }

  function relativeTime(value, locale = 'zh-CN', now = Date.now()) {
    const seconds = Math.max(0, (now - new Date(value).getTime()) / 1000);
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return locale === 'zh-CN' ? '刚刚' : 'Just now';
    const unit = seconds < 3600 ? 'minute' : seconds < 86400 ? 'hour' : 'day';
    const divisor = unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400;
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'long' }).format(-Math.floor(seconds / divisor), unit);
  }

  function imageTextMatches(ocr, query) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean), matches = new Map();
    const add = box => {
      if (!box || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]) && box[key] >= 0 && box[key] <= 1)
        || box.width <= 0 || box.height <= 0) return;
      matches.set(`${box.x}:${box.y}:${box.width}:${box.height}`, box);
    };
    for (const line of Array.isArray(ocr?.lines) ? ocr.lines : []) for (const term of terms) {
      if (!line || typeof line.text !== 'string') continue;
      const words = (Array.isArray(line.words) ? line.words : []).filter(word => typeof word?.text === 'string' && word.text.toLocaleLowerCase().includes(term));
      if (words.length) words.forEach(word => add(word.box));
      else if (line.text.toLocaleLowerCase().includes(term)) add(line.box);
    }
    return [...matches.values()];
  }

  function prune(items, settings, now = Date.now(), protectedId = null) {
    const cutoff = settings.retentionDays ? now - settings.retentionDays * 86400000 : 0;
    let count = 0;
    return items.filter(item => {
      if (item.id === protectedId || item.isFavorite || item.boardIds?.length) return true;
      if (new Date(item.createdAt).getTime() < cutoff) return false;
      count += 1;
      return count <= settings.maxItems;
    });
  }

  function sanitizeSettings(input, previous = DEFAULT_SETTINGS) {
    const result = { ...previous };
    for (const key of ['launchAtLogin', 'background', 'showInMenuBar', 'plainText', 'sound', 'paused', 'ignoreConfidential', 'ignoreTransient']) {
      if (typeof input[key] === 'boolean') result[key] = input[key];
    }
    if (typeof input.paused === 'boolean') result.pausedUntil = null;
    if (result.paused && (input.pausedUntil === null || (Number.isSafeInteger(input.pausedUntil) && input.pausedUntil > 0 && input.pausedUntil <= 8640000000000000))) result.pausedUntil = input.pausedUntil;
    if (!result.paused) result.pausedUntil = null;
    if (['application', 'clipboard'].includes(input.pasteTarget)) result.pasteTarget = input.pasteTarget;
    if ([0, 1, 7, 30, 365].includes(input.retentionDays)) result.retentionDays = input.retentionDays;
    if (Number.isInteger(input.maxItems) && input.maxItems >= 100 && input.maxItems <= 100000) result.maxItems = input.maxItems;
    if (Number.isInteger(input.panelHeight) && input.panelHeight >= 180 && input.panelHeight <= 1600) result.panelHeight = input.panelHeight;
    if (['system', 'light', 'dark'].includes(input.theme)) result.theme = input.theme;
    if (['zh-CN', 'en'].includes(input.language)) result.language = input.language;
    for (const key of ['hotkey', 'stackHotkey', 'nextBoardHotkey', 'previousBoardHotkey']) {
      if (input[key] === '' || (typeof input[key] === 'string' && input[key].length < 120 && /(?:Command|Control|Alt|Shift)/.test(input[key]))) result[key] = input[key];
    }
    if (['CommandOrControl', 'Alt', 'Control'].includes(input.quickPasteModifier)) result.quickPasteModifier = input.quickPasteModifier;
    if (['Shift', 'Alt', 'Control'].includes(input.plainTextModifier)) result.plainTextModifier = input.plainTextModifier;
    if (Array.isArray(input.excludedApps)) result.excludedApps = [...new Set(input.excludedApps.filter(x => typeof x === 'string' && /^[\w.-]{1,200}$/.test(x)))];
    return result;
  }

  function modifierPressed(event, modifier, platform = 'darwin') {
    if (modifier === 'CommandOrControl') return platform === 'darwin' ? event.metaKey : event.ctrlKey;
    return !!event[{ Command: 'metaKey', Meta: 'metaKey', Control: 'ctrlKey', Ctrl: 'ctrlKey', Alt: 'altKey', Option: 'altKey', Shift: 'shiftKey' }[modifier]];
  }

  function isComposingKey(event, composing = false) {
    return composing || !!event.isComposing || event.keyCode === 229 || event.key === 'Process';
  }

  function itemLocations(item, { board = 'history', boards = [], searching = false } = {}) {
    if (!item) return [];
    return [
      ...(searching || board !== 'history' ? [{ id: 'history', name: '剪贴板' }] : []),
      ...boards.filter(value => item.boardIds?.includes(value.id) && (searching || value.id !== board))
    ];
  }

  function shortcutMatches(event, accelerator, platform = 'darwin') {
    if (!accelerator) return false;
    const parts = accelerator.split('+'), key = parts.pop();
    const expected = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    for (const modifier of parts) {
      const field = { CommandOrControl: platform === 'darwin' ? 'metaKey' : 'ctrlKey', Command: 'metaKey', Meta: 'metaKey', Control: 'ctrlKey', Ctrl: 'ctrlKey', Alt: 'altKey', Option: 'altKey', Shift: 'shiftKey' }[modifier];
      if (!field) return false;
      expected[field] = true;
    }
    if (Object.entries(expected).some(([field, value]) => !!event[field] !== value)) return false;
    const aliases = { Right: 'ArrowRight', Left: 'ArrowLeft', Up: 'ArrowUp', Down: 'ArrowDown', Return: 'Enter', Space: ' ', Plus: '+' };
    return (aliases[key] || key).toLowerCase() === event.key.toLowerCase();
  }

  function itemNavigation(event, platform = 'darwin') {
    if (isComposingKey(event)) return null;
    const boundary = { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: false };
    if (shortcutMatches(boundary, 'CommandOrControl+Up', platform)) return 'first';
    if (shortcutMatches(boundary, 'CommandOrControl+Down', platform)) return 'last';
    if (event.metaKey || event.ctrlKey || event.altKey) return null;
    return { Home: 'first', End: 'last', ArrowLeft: -1, ArrowRight: 1 }[event.key] ?? null;
  }

  function shortcutCandidate(event, composing = false) {
    if (typeof event.key !== 'string' || !event.key || isComposingKey(event, composing) || event.repeat || ['Dead', 'Unidentified', 'Meta', 'Control', 'Alt', 'AltGraph', 'Shift', 'CapsLock', 'Fn'].includes(event.key)
      || (!event.metaKey && !event.ctrlKey && !event.altKey)) return null;
    const key = /^Digit[0-9]$/.test(event.code) ? event.code.slice(-1) : /^Key[A-Z]$/.test(event.code) ? event.code.slice(-1)
      : event.key === ' ' ? 'Space' : event.key === '+' ? 'Plus' : event.key.replace(/^Arrow/, '');
    return [event.metaKey ? 'CommandOrControl' : '', event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key.length === 1 ? key.toUpperCase() : key].filter(Boolean).join('+');
  }

  return { TYPES, COLORS, PAUSE_OPTIONS, PAUSE_DURATIONS, DEFAULT_SETTINGS, classifyText, filterItems, searchText, relativeTime, imageTextMatches, prune, sanitizeSettings, modifierPressed, shortcutMatches, isComposingKey, itemLocations, itemNavigation, shortcutCandidate };
});
