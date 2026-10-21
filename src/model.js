(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PasteModel = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const TYPES = ['text', 'link', 'code', 'image', 'color', 'file'];
  const COLORS = ['#ef6259', '#f3ad43', '#62c68d', '#4f80ed', '#af78d3', '#dc79b0', '#8e9299'];
  const DEFAULT_SETTINGS = {
    launchAtLogin: false, pasteTarget: 'application', plainText: false,
    retentionDays: 30, maxItems: 10000, paused: false, sound: false,
    ignoreConfidential: true, ignoreTransient: true, excludedApps: ['com.apple.keychainaccess'],
    hotkey: 'CommandOrControl+Shift+V', theme: 'system', language: 'zh-CN'
  };

  function classifyText(text) {
    const value = text.trim();
    if (/^https?:\/\/\S+$/i.test(value)) return 'link';
    if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return 'color';
    if (/(\bfunction\b|\bconst\b|\bclass\b|=>|^\s*(import|export)\s+)/m.test(text)) return 'code';
    return 'text';
  }

  function filterItems(items, { board = 'history', query = '', type = 'all', source = '', after = '' } = {}) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(item => {
      if (board !== 'history' && !item.boardIds?.includes(board)) return false;
      if (type !== 'all' && item.type !== type && !(type === 'text' && item.type === 'code')) return false;
      if (source && item.source?.bundleId !== source) return false;
      if (after && item.createdAt < after) return false;
      const haystack = `${item.title}\n${item.body || ''}\n${item.source?.name || ''}\n${item.note || ''}`.toLocaleLowerCase();
      return terms.every(term => haystack.includes(term));
    });
  }

  function relativeTime(value, locale = 'zh-CN', now = Date.now()) {
    const seconds = Math.max(0, (now - new Date(value).getTime()) / 1000);
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return locale === 'zh-CN' ? '刚刚' : 'Just now';
    const unit = seconds < 3600 ? 'minute' : seconds < 86400 ? 'hour' : 'day';
    const divisor = unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400;
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'long' }).format(-Math.floor(seconds / divisor), unit);
  }

  function prune(items, settings, now = Date.now()) {
    const cutoff = settings.retentionDays ? now - settings.retentionDays * 86400000 : 0;
    let count = 0;
    return items.filter(item => {
      if (item.isFavorite || item.boardIds?.length) return true;
      if (new Date(item.createdAt).getTime() < cutoff) return false;
      count += 1;
      return count <= settings.maxItems;
    });
  }

  function sanitizeSettings(input, previous = DEFAULT_SETTINGS) {
    const result = { ...previous };
    for (const key of ['launchAtLogin', 'plainText', 'sound', 'paused', 'ignoreConfidential', 'ignoreTransient']) {
      if (typeof input[key] === 'boolean') result[key] = input[key];
    }
    if (['application', 'clipboard'].includes(input.pasteTarget)) result.pasteTarget = input.pasteTarget;
    if ([0, 1, 7, 30, 365].includes(input.retentionDays)) result.retentionDays = input.retentionDays;
    if (Number.isInteger(input.maxItems) && input.maxItems >= 100 && input.maxItems <= 100000) result.maxItems = input.maxItems;
    if (['system', 'light', 'dark'].includes(input.theme)) result.theme = input.theme;
    if (['zh-CN', 'en'].includes(input.language)) result.language = input.language;
    if (typeof input.hotkey === 'string' && input.hotkey.length < 120 && /(?:Command|Control|Alt|Shift)/.test(input.hotkey)) result.hotkey = input.hotkey;
    if (Array.isArray(input.excludedApps)) result.excludedApps = [...new Set(input.excludedApps.filter(x => typeof x === 'string' && /^[\w.-]{1,200}$/.test(x)))];
    return result;
  }

  return { TYPES, COLORS, DEFAULT_SETTINGS, classifyText, filterItems, relativeTime, prune, sanitizeSettings };
});
