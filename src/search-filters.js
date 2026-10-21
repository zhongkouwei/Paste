(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PasteFilters = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const TYPES = { all: '全部', text: '文本', image: '图片', color: '颜色', file: '文件', link: '链接' };
  const DATES = { today: '今天', yesterday: '昨天', '7': '最近 7 天', '30': '最近 30 天' };
  const fold = value => value.normalize('NFKC').toLocaleLowerCase();
  function dateRange(value, now = Date.now()) {
    if (!Object.hasOwn(DATES, value)) return {};
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    if (value === 'yesterday') { end.setTime(start.getTime()); start.setDate(start.getDate() - 1); }
    else if (value !== 'today') start.setDate(start.getDate() - (Number(value) - 1));
    return { after: start.toISOString(), before: end.toISOString() };
  }
  function nextMidnight(now = Date.now()) { const next = new Date(now); next.setHours(24, 0, 0, 0); return next.getTime(); }
  function activeFilters(state) {
    return [
      state.type !== 'all' && Object.hasOwn(TYPES, state.type) && { kind: 'type', value: state.type, label: TYPES[state.type], name: '类型' },
      state.source && { kind: 'source', value: state.source, label: state.sourceName || state.source, name: '应用' },
      Object.hasOwn(DATES, state.date) && { kind: 'date', value: state.date, label: DATES[state.date], name: '日期' },
      state.pinboard && { kind: 'pinboard', value: state.pinboard, label: state.pinboardName || state.pinboard, name: 'Pinboard' }
    ].filter(Boolean);
  }
  function suggestions(query, { sources = [], boards = [], type = 'all', source = '', date = '', pinboard = '' } = {}) {
    if (!query.trim() || query.length > 2048) return [];
    const words = [...query.matchAll(/\S+/gu)].map(match => ({ text: fold(match[0]), start: match.index, end: match.index + match[0].length }));
    const candidates = [];
    const add = (kind, value, label, aliases) => {
      let match;
      for (const alias of aliases) {
        const parts = fold(alias).split(/\s+/);
        for (let n = 0; n < words.length; n++) {
          if (parts.every((part, offset) => words[n + offset]?.text === part)) {
            const found = { start: words[n].start, end: words[n + parts.length - 1].end, exact: true };
            if (!match || !match.exact || found.end - found.start > match.end - match.start) match = found;
          } else if (n === words.length - 1 && words[n].text.length >= 2 && parts[0].startsWith(words[n].text) && !match) {
            match = { start: words[n].start, end: words[n].end, exact: false };
          }
        }
      }
      if (match) candidates.push({ kind, value, label, query, ...match });
    };
    const aliases = { text: ['text', '文本', '文字'], image: ['image', 'images', '图片', '图像'], link: ['link', 'links', '链接'],
      file: ['file', 'files', '文件'], color: ['color', 'colour', '颜色'] };
    for (const [value, names] of Object.entries(aliases)) if (type !== value) add('type', value, `类型：${TYPES[value]}`, names);
    for (const [value, names] of Object.entries({ today: ['today', '今天'], yesterday: ['yesterday', '昨天'], '7': ['last 7 days', '最近7天'], '30': ['last 30 days', '最近30天'] })) {
      if (date !== value) add('date', value, `日期：${DATES[value]}`, names);
    }
    for (const app of sources) if (typeof app.name === 'string' && app.name && app.bundleId && source !== app.bundleId) {
      const last = app.name.split(/\s+/).at(-1);
      add('source', app.bundleId, `来自 ${app.name}`, [app.name, ...(last.length >= 3 ? [last] : [])]);
    }
    for (const board of boards) if (typeof board.name === 'string' && board.name && pinboard !== board.id) add('pinboard', board.id, `Pinboard：${board.name}`, [board.name]);
    return candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || (b.end - b.start) - (a.end - a.start)).slice(0, 8);
  }
  function applySuggestion(query, suggestion) {
    if (query !== suggestion.query || !Number.isInteger(suggestion.start) || !Number.isInteger(suggestion.end)
      || suggestion.start < 0 || suggestion.end <= suggestion.start || suggestion.end > query.length) return null;
    const prefix = query.slice(0, suggestion.start).trimEnd(), suffix = query.slice(suggestion.end).trimStart();
    return [prefix, suffix].filter(Boolean).join(' ');
  }
  return { TYPES, DATES, dateRange, nextMidnight, activeFilters, suggestions, applySuggestion };
});
