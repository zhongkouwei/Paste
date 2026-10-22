/* global lucide, PasteModel, PasteFilters, PastePanelLayout */
const $ = selector => document.querySelector(selector);
const api = window.paste;
const { filterItems, relativeTime, imageTextMatches, COLORS, modifierPressed, shortcutMatches, isComposingKey, itemLocations } = PasteModel;
const { dateRange, nextMidnight, activeFilters, suggestions, applySuggestion } = PasteFilters;
const state = { items: [], boards: [], settings: {}, status: {}, board: 'history', query: '', type: 'all', source: '', date: '', pinboard: '', sourceName: '', pinboardName: '',
  selected: new Set(), anchor: null, active: null, searching: false, target: '', editingBoard: null, detail: null };
const labels = { text: '文本', code: '文本', link: '链接', image: '图片', color: '颜色', file: '文件' };
const icons = { text: 'text', code: 'code', link: 'link', image: 'image', color: 'palette', file: 'file' };
let toastTimer, renderFrame, dragging = null;
let searchRequest = 0, searchPending = false, queryMatches = new Set(), searchSelection;
let composing = false;
let itemRename = null;
let cardLayout = PastePanelLayout.panelLayout(innerHeight, innerWidth);
let calendarTimer, suggestionSignature = '', suggestionsDismissed = false;
const imageTextCache = new Map(), imageTextPending = new Set();
const mediaCache = new Map(), mediaPending = new Set(), mediaSkipped = new Map(), mediaFailures = new Map();
const mediaRetryDelays = [250, 1000], mediaWarning = '图片预览暂时不可用。';
let mediaBytes = 0, mediaActive = 0, mediaEpoch = 0, mediaRetryTimer;

function icon(name) { return `<i data-lucide="${name}"></i>`; }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function safeColor(value) { return /^#[a-f0-9]{6}$/i.test(value) ? value : '#77808a'; }
function safeImage(value) { return /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value || '') ? value : ''; }
function cachedMedia(key) {
  if (!mediaCache.has(key)) return '';
  const value = mediaCache.get(key); mediaCache.delete(key); mediaCache.set(key, value); return value;
}
function clearMediaWarning() {
  if ($('#status').textContent === mediaWarning) { clearTimeout(toastTimer); $('#status').hidden = true; }
}
function hasMediaOwner(id, key) {
  const item = state.items.find(item => item.id === id);
  return item?.previewKey === key || item?.source?.iconKey === key;
}
function paintMedia() {
  clearTimeout(mediaRetryTimer);
  const requests = [], wanted = new Set(), now = Date.now(); let nextRetry = Infinity;
  for (const node of document.querySelectorAll('.clip-card')) {
    const item = state.items.find(item => item.id === node.dataset.id); if (!item) continue;
    for (const [field, key] of [['previewKey', item.previewKey], ['iconKey', item.source?.iconKey]]) {
      if (!key) continue;
      const rendered = field === 'previewKey' ? node.querySelector('.image-preview img') : node.querySelector('.source-icon');
      if (rendered?.dataset.mediaKey === key) continue;
      const value = safeImage(cachedMedia(key));
      const skipped = mediaSkipped.get(key), previousFailure = mediaFailures.get(key);
      const failure = previousFailure?.epoch === mediaEpoch && hasMediaOwner(previousFailure.id, key) ? previousFailure : null;
      if (!value && (mediaCache.has(key) || failure?.attempts > mediaRetryDelays.length) && field === 'previewKey') {
        const placeholder = node.querySelector('.media-placeholder');
        if (placeholder) { placeholder.setAttribute('aria-label', '图片预览不可用'); placeholder.title = '图片预览不可用'; }
      }
      if (value) {
        const target = field === 'previewKey' ? node.querySelector('.image-preview') : node.querySelector('.source-fallback');
        if (target && (field !== 'previewKey' || !target.querySelector('img'))) {
          const image = document.createElement('img'); image.src = value; image.draggable = false;
          image.dataset.mediaKey = key;
          image.alt = field === 'previewKey' ? item.title : item.source?.name || '';
          if (field === 'previewKey') {
            // OCR overlays own their nodes; replace only the media placeholder.
            const placeholder = target.querySelector('.media-placeholder');
            if (placeholder) placeholder.replaceWith(image); else target.prepend(image);
          }
          else { image.className = 'source-icon'; target.replaceWith(image); }
        }
      }
      if (mediaCache.has(key) || mediaPending.has(key) || wanted.has(key)) continue;
      if (skipped?.id === item.id && skipped.revision === state.revision && skipped.epoch === mediaEpoch) continue;
      if (failure?.retryAt > now) { nextRetry = Math.min(nextRetry, failure.retryAt); continue; }
      wanted.add(key);
      let request = requests.find(request => request.id === item.id);
      if (!request) { request = { id: item.id }; requests.push(request); }
      request[field] = key;
    }
  }
  if (Number.isFinite(nextRetry)) mediaRetryTimer = setTimeout(paintMedia, Math.max(1, nextRetry - now));
  if (!requests.length || mediaActive >= 2) return;
  const batch = requests.slice(0, 32), keys = new Set(batch.flatMap(request => [request.previewKey, request.iconKey].filter(Boolean)));
  const owners = new Map(batch.flatMap(request => [request.previewKey, request.iconKey].filter(Boolean).map(key => [key, request.id])));
  const revision = state.revision, epoch = mediaEpoch;
  for (const key of keys) mediaPending.add(key); mediaActive += 1;
  api.getMedia(batch).then(values => {
    const returned = new Set();
    for (const { key, value } of values) {
      if (!keys.has(key) || typeof value !== 'string') continue;
      returned.add(key); mediaSkipped.delete(key); mediaFailures.delete(key);
      if (mediaCache.has(key)) mediaBytes -= mediaCache.get(key).length;
      mediaCache.set(key, value); mediaBytes += value.length;
    }
    // A stale owner's empty reply must not suppress a newer owner or revision.
    for (const key of keys) if (!returned.has(key)) mediaSkipped.set(key, { id: owners.get(key), revision, epoch });
    if (![...mediaFailures.values()].some(failure => failure.epoch === mediaEpoch && failure.attempts > mediaRetryDelays.length)) clearMediaWarning();
    paintMedia();
    while (mediaCache.size > 96 || mediaBytes > 16 * 1024 * 1024) {
      const key = mediaCache.keys().next().value; mediaBytes -= mediaCache.get(key).length; mediaCache.delete(key);
    }
  }).catch(error => {
    let exhausted = false;
    for (const key of keys) {
      const id = owners.get(key), previous = mediaFailures.get(key);
      const attempts = previous?.epoch === epoch && hasMediaOwner(previous.id, key) ? previous.attempts + 1 : 1;
      mediaFailures.set(key, { id, epoch, attempts, retryAt: attempts <= mediaRetryDelays.length ? Date.now() + mediaRetryDelays[attempts - 1] : Infinity });
      if (epoch === mediaEpoch && attempts > mediaRetryDelays.length && hasMediaOwner(id, key)) exhausted = true;
    }
    if (exhausted) { console.error('Media requests failed', error); toast(mediaWarning); }
  }).finally(() => {
    for (const map of [mediaSkipped, mediaFailures]) while (map.size > 256) map.delete(map.keys().next().value);
    for (const key of keys) mediaPending.delete(key); mediaActive -= 1; paintMedia();
  });
}
function refreshIcons() { lucide.createIcons({ attrs: { 'aria-hidden': 'true' } }); }
function visibleItems() { return filterItems(state.query.trim() ? state.items.filter(item => queryMatches.has(item.id)) : state.items,
  { ...state, ...dateRange(state.date), board: state.searching ? 'history' : state.board, pinboard: state.searching ? state.pinboard : '', query: '' }); }
function toast(message) { $('#status').textContent = message; $('#status').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#status').hidden = true; }, 6000); }
async function attempt(task) { try { return await task(); } catch (error) { toast(error.message); return undefined; } }

function sources() {
  return [...new Map(state.items.filter(item => typeof item.source?.bundleId === 'string' && item.source.bundleId).map(item => [item.source.bundleId,
    { ...item.source, name: typeof item.source.name === 'string' && item.source.name ? item.source.name : item.source.bundleId }])).values()].sort((a, b) => a.name.localeCompare(b.name));
}
function closeFilters() { $('#filters').hidden = true; $('#filterToggle').setAttribute('aria-expanded', 'false'); }
function hideSuggestions() { $('#filterSuggestions').hidden = true; }
function syncOptions(select, entries, value) {
  // Preserve native controls across background library snapshots.
  const signature = JSON.stringify(entries);
  if (select.dataset.options !== signature) {
    const existing = new Map([...select.options].map(option => [option.value, option]));
    entries.forEach(([id, label], index) => {
      const option = existing.get(id) || document.createElement('option'); option.value = id; option.textContent = label;
      if (select.options[index] !== option) select.insertBefore(option, select.options[index] || null);
      existing.delete(id);
    });
    for (const option of existing.values()) option.remove();
    select.dataset.options = signature;
  }
  select.value = value;
}
function renderFilterUI() {
  const apps = sources(), app = apps.find(value => value.bundleId === state.source), board = state.boards.find(value => value.id === state.pinboard);
  if (app) state.sourceName = app.name;
  if (board) state.pinboardName = board.name;
  const filters = activeFilters(state), tokens = $('#filterTokens');
  for (const token of [...tokens.children]) if (!filters.some(filter => filter.kind === token.dataset.filter)) token.remove();
  filters.forEach((filter, index) => {
    let token = tokens.querySelector(`[data-filter="${filter.kind}"]`);
    if (!token) {
      token = document.createElement('span'); token.className = 'filter-token'; token.dataset.filter = filter.kind;
      const label = document.createElement('span'), remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'icon-button'; remove.innerHTML = icon('x');
      remove.onclick = () => setFilter(filter.kind, filter.kind === 'type' ? 'all' : '', true);
      token.append(label, remove); tokens.insertBefore(token, tokens.children[index] || null);
    }
    token.title = `${filter.name}：${filter.label}`; token.firstElementChild.textContent = filter.label;
    token.lastElementChild.setAttribute('aria-label', `移除${filter.name}筛选：${filter.label}`);
  });
  $('#filterCount').hidden = !filters.length; $('#filterCount').textContent = filters.length;
  $('#resetFilters').disabled = !filters.length;
  if (!$('#typeFilters').children.length) {
    for (const [value, name] of Object.entries(PasteFilters.TYPES)) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.type = value; button.textContent = name; $('#typeFilters').append(button);
    }
  }
  for (const button of $('#typeFilters').children) { button.classList.toggle('active', button.dataset.type === state.type); button.setAttribute('aria-pressed', String(button.dataset.type === state.type)); }
  const appOptions = [['', '所有应用'], ...apps.map(app => [app.bundleId, app.name])];
  if (state.source && !app) appOptions.push([state.source, state.sourceName || state.source]);
  syncOptions($('#sourceFilter'), appOptions, state.source);
  const boardOptions = [['', '所有 Pinboard'], ...state.boards.map(board => [board.id, board.name])];
  if (state.pinboard && !board) boardOptions.push([state.pinboard, state.pinboardName || state.pinboard]);
  syncOptions($('#pinboardFilter'), boardOptions, state.pinboard); $('#dateFilter').value = state.date;
  clearTimeout(calendarTimer);
  if (state.searching && state.date) calendarTimer = setTimeout(render, Math.max(1, nextMidnight() - Date.now()));
  updateSuggestions();
}
function updateSuggestions(force = false) {
  if (force) suggestionsDismissed = false;
  const popup = $('#filterSuggestions'), focused = document.activeElement === $('#searchInput') || popup.contains(document.activeElement);
  if (!state.searching || composing || !$('#filters').hidden || !focused || (suggestionsDismissed && !force)) { hideSuggestions(); return; }
  const candidates = suggestions(state.query, { ...state, sources: sources() }), signature = JSON.stringify(candidates);
  if (!candidates.length) { hideSuggestions(); return; }
  if (signature !== suggestionSignature) {
    const previous = popup.contains(document.activeElement) ? document.activeElement.dataset.suggestion : null;
    popup.replaceChildren(); suggestionSignature = signature;
    for (const candidate of candidates) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.suggestion = `${candidate.kind}:${candidate.value}`;
      button.innerHTML = icon({ type: icons[candidate.value] || 'filter', source: 'app-window', date: 'calendar-days', pinboard: 'pin' }[candidate.kind]);
      const text = document.createElement('span'); text.textContent = candidate.label; button.append(text);
      button.onclick = () => {
        if (composing) return;
        const query = applySuggestion(state.query, candidate); if (query === null) return;
        if (candidate.kind === 'pinboard' && !state.boards.some(board => board.id === candidate.value)) return;
        state.query = query; $('#searchInput').value = query; suggestionsDismissed = false; $('#searchInput').focus();
        setFilter(candidate.kind, candidate.value, true);
      };
      button.onpointermove = () => { button.focus({ preventScroll: true }); };
      popup.append(button);
    }
    if (previous) {
      const restore = [...popup.children].find(button => button.dataset.suggestion === previous);
      if (restore) restore.focus({ preventScroll: true });
      else { suggestionsDismissed = true; hideSuggestions(); $('#searchInput').focus(); return; }
    }
    refreshIcons();
  }
  const rect = $('#searchBox').getBoundingClientRect();
  const width = Math.min(rect.width, innerWidth - 32);
  popup.style.width = `${width}px`; popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
  popup.style.top = `${rect.bottom + 5}px`; popup.hidden = false;
}
function setFilter(kind, value, focus = false) {
  if (!['type', 'source', 'date', 'pinboard'].includes(kind)) return;
  state[kind] = value;
  if (kind === 'source') state.sourceName = sources().find(app => app.bundleId === value)?.name || value;
  if (kind === 'pinboard') state.pinboardName = state.boards.find(board => board.id === value)?.name || value;
  closeMenu(); resetFilter();
  if (focus) {
    $('#filterTokens').querySelector(`[data-filter="${kind}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('#searchInput').focus(); updateSuggestions();
  }
}

function accept(library) {
  if (!library) return;
  if (Number.isInteger(state.revision) && library.revision < state.revision) return;
  mediaSkipped.clear();
  const previousCaptureError = state.status.capture?.error;
  Object.assign(state, { items: library.items, boards: library.boards, settings: library.settings, revision: library.revision, capabilities: library.capabilities || {}, status: library.status || {} });
  if (previousCaptureError && !state.status.capture?.error && $('#status').textContent === previousCaptureError) { clearTimeout(toastTimer); $('#status').hidden = true; }
  if (mediaFailures.size) {
    const items = new Map(state.items.map(item => [item.id, item]));
    for (const [key, failure] of mediaFailures) {
      const item = items.get(failure.id);
      if (item?.previewKey !== key && item?.source?.iconKey !== key) mediaFailures.delete(key);
    }
  }
  if (state.board !== 'history' && !state.boards.some(board => board.id === state.board)) state.board = 'history';
  if (state.status.error) toast(state.status.error);
  if (library.recovery) toast(library.recovery);
  requestSearch(true);
}

async function requestSearch(preserveSelection = false) {
  const request = ++searchRequest, query = state.query, revision = state.revision;
  if (!preserveSelection) searchSelection = null;
  else if (state.selected.size || searchSelection?.query !== query) searchSelection = { query, ids: [...state.selected], anchor: state.anchor, active: state.active };
  if (!query.trim()) { searchPending = false; $('#timeline').setAttribute('aria-busy', 'false'); render(); return; }
  searchPending = true; queryMatches = new Set(); $('#timeline').setAttribute('aria-busy', 'true'); render();
  try {
    const result = await api.search(query);
    if (request !== searchRequest || query !== state.query) return;
    if (result.revision !== revision) { accept(await api.getLibrary()); return; }
    queryMatches = new Set(result.ids);
    if (searchSelection?.query === query) {
      state.selected = new Set(searchSelection.ids.filter(id => queryMatches.has(id)));
      state.active = queryMatches.has(searchSelection.active) ? searchSelection.active : [...state.selected][0];
      state.anchor = queryMatches.has(searchSelection.anchor) ? searchSelection.anchor : state.active;
    }
  } catch (error) { if (request === searchRequest) toast(error.message); }
  finally {
    if (request === searchRequest) { searchPending = false; searchSelection = null; $('#timeline').setAttribute('aria-busy', 'false'); render(); }
  }
}

function renderBoards() {
  const previousEditor = $('#boards .board-edit');
  const restoreEditorFocus = !!previousEditor?.contains(document.activeElement);
  $('#boards').innerHTML = `<button class="board ${state.board === 'history' && !state.searching ? 'active' : ''}" data-board="history" aria-pressed="${state.board === 'history' && !state.searching}" title="剪贴板">${icon('history')}<span>剪贴板</span></button>`
    + state.boards.map(board => `<button class="board ${state.board === board.id && !state.searching ? 'active' : ''}" data-board="${escape(board.id)}" draggable="true" aria-pressed="${state.board === board.id && !state.searching}" title="${escape(board.name)}"><b class="board-dot" style="--board-color:${safeColor(board.color)}"></b><span>${escape(board.name)}</span></button>`).join('');
  if (state.editingBoard) {
    const board = state.editingBoard;
    const button = [...$('#boards').querySelectorAll('[data-board]')].find(node => node.dataset.board === board.id);
    if (button) {
      if (previousEditor?.dataset.editBoard === board.id) {
        button.replaceWith(previousEditor);
        previousEditor.querySelector('.board-dot').style.setProperty('--board-color', board.color);
        if (restoreEditorFocus) previousEditor.querySelector('input').focus();
      } else {
      const editor = document.createElement('div'); editor.className = 'board board-edit';
      editor.dataset.editBoard = board.id;
      const color = document.createElement('button'); color.className = 'board-dot'; color.type = 'button'; color.style.setProperty('--board-color', board.color); color.setAttribute('aria-label', 'Pinboard 颜色');
      const input = document.createElement('input'); input.className = 'board-name-edit'; input.value = board.name; input.maxLength = 60; input.setAttribute('aria-label', 'Pinboard 名称');
      color.onpointerdown = event => event.preventDefault();
      color.onclick = event => {
        event.stopPropagation();
        const rect = color.getBoundingClientRect();
        menu(COLORS.map((value, index) => ({ label: `颜色 ${index + 1}`, icon: 'circle', action: async () => {
          state.editingBoard = { ...board, color: value, name: input.value || '未命名' };
          await api.saveBoard(state.editingBoard); accept(await api.getLibrary());
          $('.board-name-edit')?.focus();
        } })), rect.left, rect.bottom + 6);
      };
      input.oninput = () => { if (state.editingBoard) state.editingBoard.name = input.value; };
      input.onkeydown = event => {
        if (['Enter', 'Escape', 'Tab'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); attempt(commitBoard); }
        else event.stopPropagation();
      };
      editor.append(color, input); button.replaceWith(editor);
      }
    }
  }
  $('#stackButton').classList.toggle('active', !!state.status.stackMode);
  $('#stackCount').hidden = !state.status.stackCount;
  $('#stackCount').textContent = state.status.stackCount || '';
}

function optionID(id) { return `clip-${id.split('').map(character => character.charCodeAt(0).toString(16)).join('-')}`; }
function card(item, index, total) {
  const selected = state.selected.has(item.id);
  const image = safeImage(cachedMedia(item.previewKey)), sourceIcon = safeImage(cachedMedia(item.source?.iconKey));
  let body = `<pre>${escape(item.preview || item.body)}</pre>`;
  let kind = '';
  if (item.type === 'image') { body = image ? `<img src="${image}" data-media-key="${escape(item.previewKey)}" alt="${escape(item.title)}" draggable="false">`
    : `<span class="media-placeholder" role="img" aria-label="${!item.previewKey || mediaCache.has(item.previewKey) ? '图片预览不可用' : '正在加载图片预览'}">${icon('image-off')}</span>`; kind = 'image-preview'; }
  if (item.type === 'color' && /^#[\da-f]{3,8}$/i.test(item.body)) { body = `<span>${escape(item.body)}</span>`; kind = 'color-preview'; }
  const caption = item.type === 'image' ? `${item.size?.width || '?'} × ${item.size?.height || '?'}`
    : item.type === 'file' ? '文件' : `${item.characterCount ?? [...(item.body || '')].length} 个字符`;
  return `<article id="${optionID(item.id)}" class="clip-card ${selected ? 'selected' : ''}" role="option" draggable="true" aria-selected="${selected}" aria-posinset="${index + 1}" aria-setsize="${total}" aria-label="${escape(item.title)}" data-id="${escape(item.id)}" data-index="${index}" data-type="${escape(item.type)}" style="left:${24 + index * cardLayout.step}px;--source-color:${safeColor(item.source?.color)}">
    <header class="clip-header"><span class="clip-type">${labels[item.type] || '文本'}</span><time class="clip-time">${relativeTime(item.createdAt)}</time>${sourceIcon ? `<img class="source-icon" src="${sourceIcon}" data-media-key="${escape(item.source?.iconKey)}" alt="${escape(item.source?.name)}" draggable="false">` : `<span class="source-fallback" title="${escape(item.source?.name || '')}">${icon(icons[item.type] || 'text')}</span>`}</header>
    <div class="clip-body ${kind}" ${kind === 'color-preview' ? `style="background:${escape(item.body)};color:#111"` : ''}>${body}</div>
    <footer class="clip-footer"><button class="clip-label" data-rename="${escape(item.id)}" tabindex="-1" title="重命名" aria-label="重命名：${escape(item.title)}">${item.renamed ? escape(item.title) : caption}</button></footer>${item.boardIds?.length ? `<span class="clip-pin">${icon('pin')}</span>` : ''}
    ${['image', 'file'].includes(item.type) ? `<button class="native-drag icon-button" draggable="true" data-native-drag="${escape(item.id)}" title="拖出原始文件" aria-label="拖出原始文件">${icon('grip-vertical')}</button>` : ''}
    ${index < 9 ? `<span class="quick-key">${{ CommandOrControl: '⌘', Control: '⌃', Alt: '⌥' }[state.settings.quickPasteModifier] || '⌘'}${index + 1}</span>` : ''}</article>`;
}

function renderCards() {
  const items = visibleItems();
  const keeper = itemRename?.card, previousScroll = $('#timeline').scrollLeft;
  const previousStep = cardLayout.step;
  cardLayout = PastePanelLayout.panelLayout(innerHeight, innerWidth);
  for (const [name, value] of Object.entries({ 'card-width': cardLayout.cardWidth, 'card-height': cardLayout.cardHeight, 'header-height': cardLayout.headerHeight, 'track-height': cardLayout.trackHeight })) document.documentElement.style.setProperty(`--${name}`, `${value}px`);
  document.body.classList.toggle('compact', cardLayout.compact);
  const width = $('#timeline').clientWidth;
  $('#track').style.width = `${Math.max(width, items.length * cardLayout.step + 24)}px`;
  const renameIndex = itemRename ? items.findIndex(item => item.id === itemRename.id) : -1;
  if (keeper?.isConnected && document.activeElement === itemRename.input && renameIndex >= 0) {
    $('#timeline').scrollLeft = Math.max(0, previousScroll + 24 + renameIndex * cardLayout.step - parseFloat(keeper.style.left));
  } else if (previousStep !== cardLayout.step) {
    $('#timeline').scrollLeft = previousScroll / previousStep * cardLayout.step;
  }
  const first = Math.max(0, Math.floor($('#timeline').scrollLeft / cardLayout.step) - 3);
  const end = Math.min(items.length, first + Math.ceil(width / cardLayout.step) + 8);
  if (keeper?.isConnected) {
    // Keep the live input connected: replacing/reinserting it breaks IME and
    // selection even when the same value and focus are restored afterwards.
    for (const node of [...$('#track').children]) if (node !== keeper) node.remove();
    const index = renameIndex;
    if (index >= 0) { keeper.style.left = `${24 + index * cardLayout.step}px`; keeper.dataset.index = index; keeper.setAttribute('aria-posinset', index + 1); }
    keeper.setAttribute('aria-setsize', items.length); keeper.setAttribute('aria-selected', state.selected.has(itemRename.id)); keeper.classList.toggle('selected', state.selected.has(itemRename.id));
    $('#track').insertAdjacentHTML('beforeend', items.slice(first, end).flatMap((item, offset) => item.id === itemRename.id ? [] : [card(item, first + offset, items.length)]).join(''));
  } else $('#track').innerHTML = items.slice(first, end).map((item, offset) => card(item, first + offset, items.length)).join('');
  const active = state.active && document.getElementById(optionID(state.active));
  if (active) $('#timeline').setAttribute('aria-activedescendant', active.id); else $('#timeline').removeAttribute('aria-activedescendant');
  $('#emptyState').hidden = items.length > 0 || !!itemRename;
  $('#emptyTitle').textContent = searchPending ? '正在搜索…' : state.query || activeFilters(state).length ? '无结果'
    : state.board === 'history' ? '剪贴板为空' : 'Pinboard 为空';
  refreshIcons();
  paintMedia();
  paintImageMatches();
}
function renderCapture() {
  const capture = state.status.capture || { paused: state.settings.paused }, visible = capture.paused || capture.resuming;
  document.querySelector('.panel').classList.toggle('capture-paused', !!visible);
  const button = $('#captureButton'); button.hidden = !visible; button.disabled = capture.pending;
  $('#captureLabel').textContent = capture.resuming ? '恢复中' : '已暂停';
  const until = capture.until ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(capture.until)) : '';
  button.title = capture.error || (capture.resuming ? '正在恢复记录' : until ? `已暂停至${until}；继续记录` : '记录已暂停；继续记录');
  button.setAttribute('aria-label', capture.resuming ? '正在恢复记录' : '继续记录');
}
function paintImageMatches() {
  if (!state.query.trim()) return;
  for (const node of document.querySelectorAll('.clip-card[data-type=image]')) {
    const item = state.items.find(value => value.id === node.dataset.id);
    if (!item?.ocr?.hasText || item.ocr.signature !== item.signature || !item.size?.width || !item.size?.height) continue;
    const key = `${item.id}:${item.signature}:${item.ocr.completedAt || ''}`, cached = imageTextCache.get(key);
    if (!cached) {
      if (!imageTextPending.has(key)) {
        imageTextPending.add(key);
        api.getOCR(item.id).then(value => {
          imageTextCache.set(key, value || { lines: [] });
          while (imageTextCache.size > 64) imageTextCache.delete(imageTextCache.keys().next().value);
          paintImageMatches();
        }).catch(error => toast(error.message)).finally(() => imageTextPending.delete(key));
      }
      continue;
    }
    const body = node.querySelector('.image-preview'); body.querySelectorAll('.ocr-match').forEach(mark => mark.remove());
    const scale = Math.min(body.clientWidth / item.size.width, body.clientHeight / item.size.height);
    const left = (body.clientWidth - item.size.width * scale) / 2, top = (body.clientHeight - item.size.height * scale) / 2;
    for (const box of imageTextMatches(cached, state.query)) {
      const mark = document.createElement('span'); mark.className = 'ocr-match'; mark.setAttribute('aria-hidden', 'true');
      Object.assign(mark.style, { left: `${left + box.x * item.size.width * scale}px`, top: `${top + box.y * item.size.height * scale}px`,
        width: `${box.width * item.size.width * scale}px`, height: `${box.height * item.size.height * scale}px` });
      body.append(mark);
    }
  }
}
function render() {
  const items = visibleItems();
  state.selected = new Set([...state.selected].filter(id => items.some(item => item.id === id)));
  if (!state.selected.size && items.length) { state.anchor = items[0].id; state.selected.add(items[0].id); }
  if (!items.some(item => item.id === state.active)) state.active = [...state.selected][0] || null;
  if (!items.some(item => item.id === state.anchor)) state.anchor = state.active;
  renderBoards(); renderFilterUI(); renderCards(); renderCapture();
}
function scrollToIndex(index) {
  const left = 24 + index * cardLayout.step;
  const viewport = $('#timeline');
  if (left < viewport.scrollLeft + 8) viewport.scrollLeft = Math.max(0, left - 12);
  else if (left + cardLayout.cardWidth + 8 > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = left + cardLayout.cardWidth + 8 - viewport.clientWidth;
}
function select(index, { extend = false, toggle = false } = {}) {
  const items = visibleItems();
  index = Math.min(items.length - 1, Math.max(0, index));
  if (!items[index]) return;
  if (extend) {
    const anchor = Math.max(0, items.findIndex(item => item.id === state.anchor));
    state.selected = new Set(items.slice(Math.min(index, anchor), Math.max(index, anchor) + 1).map(item => item.id));
  } else if (toggle) {
    if (state.selected.has(items[index].id)) state.selected.delete(items[index].id); else state.selected.add(items[index].id);
    state.anchor = items[index].id;
  } else { state.anchor = items[index].id; state.selected = new Set([items[index].id]); }
  state.active = items[index].id;
  scrollToIndex(index); renderCards();
}
function resetFilter() { state.selected.clear(); state.anchor = state.active = null; $('#timeline').scrollLeft = 0; requestSearch(); }
function clearSearch() {
  state.searching = false; document.body.classList.remove('searching');
  $('#searchBox').hidden = true; $('#searchToggle').hidden = false;
  state.query = ''; $('#searchInput').value = ''; state.type = 'all'; state.source = ''; state.date = ''; state.pinboard = '';
  closeFilters(); hideSuggestions(); suggestionsDismissed = false;
}
function setBoard(id) { clearSearch(); state.board = id; closeMenu(); resetFilter(); }
async function newText() {
  if (itemRename && !await commitItemRename()) return;
  closeMenu(); if (state.editingBoard) await commitBoard();
  return api.newText(state.searching ? 'history' : state.board);
}
function toggleSearch(open) {
  if (open) {
    const wasOpen = state.searching; state.searching = true; document.body.classList.add('searching');
    $('#searchBox').hidden = false; $('#searchToggle').hidden = true;
    closeFilters(); if (!wasOpen) resetFilter(); $('#searchInput').focus();
  } else { clearSearch(); resetFilter(); $('#timeline').focus(); }
}
function showIn(id, destination) {
  const item = state.items.find(value => value.id === id);
  if (!item || (destination !== 'history' && !item.boardIds?.includes(destination))) return;
  clearSearch(); state.board = destination; state.selected = new Set([id]); state.anchor = state.active = id; closeMenu(); requestSearch(true);
  scrollToIndex(visibleItems().findIndex(value => value.id === id)); renderCards(); $('#timeline').focus();
}

function closeMenu() { $('#menu').hidden = true; }
function menu(entries, x, y) {
  const element = $('#menu');
  element.replaceChildren();
  entries.forEach(entry => {
    if (!entry) { element.append(document.createElement('hr')); return; }
    if (entry.heading) { const text = document.createElement('div'); text.className = 'menu-label'; text.textContent = entry.heading; element.append(text); return; }
    const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem';
    button.innerHTML = `${entry.icon ? icon(entry.icon) : ''}<span>${escape(entry.label)}</span>${entry.key ? `<kbd aria-hidden="true">${escape(entry.key)}</kbd>` : ''}`;
    if (entry.shortcut) button.setAttribute('aria-keyshortcuts', entry.shortcut);
    button.disabled = !!entry.disabled;
    button.onpointermove = () => { if (!button.disabled && document.activeElement !== button) button.focus({ preventScroll: true }); };
    button.addEventListener('click', () => { closeMenu(); attempt(entry.action); }); element.append(button);
  });
  element.hidden = false; refreshIcons();
  element.style.left = `${Math.max(8, Math.min(x, innerWidth - element.offsetWidth - 8))}px`;
  element.style.top = `${Math.max(8, Math.min(y, innerHeight - element.offsetHeight - 8))}px`;
  element.querySelector('button:not(:disabled)')?.focus();
}

function selectedIDs() { return visibleItems().filter(item => state.selected.has(item.id)).map(item => item.id); }
async function activate(id, paste = true, plain = false) {
  return activateSelection(id === undefined ? selectedIDs() : [id], paste, plain);
}
async function activateSelection(ids, paste = true, plain = false) {
  if (itemRename && !await commitItemRename()) return;
  if (!ids.length) return;
  if (state.status.stackMode && paste) { if (ids.length === 1) await api.addToStack(ids[0]); else await api.addSelectionToStack(ids); toast('已加入 Stack'); return; }
  const result = ids.length === 1 ? await api.copy(ids[0], { paste, plain }) : await api.copySelection(ids, { paste, plain });
  if (!result.ok) toast(result.error); else if (!paste) toast('已复制');
}
async function pasteStackNext() {
  const result = await api.nextInStack();
  if (!result.ok) toast(result.error);
}
function itemMenu(item, x, y) {
  const ids = state.selected.has(item.id) ? selectedIDs() : [item.id];
  menu([
    { label: state.target ? `粘贴到 ${state.target}` : '粘贴到当前应用', icon: 'clipboard-paste', key: '↵', shortcut: 'Enter', action: () => activateSelection(ids) },
    { label: '以纯文本粘贴', action: () => activateSelection(ids, true, true), disabled: ids.some(id => ['image', 'file'].includes(state.items.find(value => value.id === id)?.type)) },
    { label: '复制', icon: 'copy', key: '⌘C', shortcut: 'Meta+C', action: () => activateSelection(ids, false) }, null,
    { label: '编辑', icon: 'pencil', key: '⌘E', shortcut: 'Meta+E', action: () => openDetail(item.id, true), disabled: ids.length !== 1 || item.type === 'file' },
    ...(item.type === 'image' && state.capabilities?.textRecognition ? [{ label: '复制图片中的文字', icon: 'scan-text', action: async () => { await api.copyImageText(item.id); toast('已复制文字'); } }] : []),
    { label: '重命名', key: '⌘R', shortcut: 'Meta+R', action: () => openDetail(item.id, 'rename'), disabled: ids.length !== 1 },
    ...itemLocations(item, state).map((location, index) => ({ label: `在${location.name}中显示`, key: index ? '' : '⌘G',
      shortcut: index ? '' : 'Meta+G', disabled: ids.length !== 1, action: () => showIn(item.id, location.id) })),
    ...(item.type === 'file' ? [{ label: '在 Finder 中显示', icon: 'folder-search', action: () => api.revealItem(item.id) }] : []),
    { label: ids.length > 1 ? `删除 ${ids.length} 个项目` : '删除', icon: 'trash-2', key: '⌫', shortcut: 'Backspace', action: async () => accept(await api.deleteItems(ids)) }, null,
    { heading: '固定到 Pinboard' },
    ...state.boards.map(board => {
      const remove = ids.every(id => state.items.find(value => value.id === id)?.boardIds.includes(board.id));
      return { label: `${remove ? '✓ ' : ''}${board.name}`, action: async () => accept(await api.pinItems(ids, board.id, remove)) };
    }),
    { label: '创建 Pinboard…', icon: 'plus', action: () => boardDialog() }, null,
    { label: '预览', icon: 'scan', key: 'Space', shortcut: 'Space', action: () => openDetail(item.id) },
    { label: '分享', icon: 'share', action: () => api.shareItem(item.id) }
  ], x, y);
}
async function boardDialog(board) {
  if (!board) {
    board = await api.saveBoard({ name: '未命名', color: COLORS[state.boards.length % COLORS.length] });
    accept(await api.getLibrary());
  }
  state.editingBoard = { ...board }; renderBoards(); refreshIcons();
  $('.board-name-edit')?.focus(); $('.board-name-edit')?.select();
}
async function commitBoard() {
  if (!state.editingBoard) return;
  const board = { ...state.editingBoard, name: state.editingBoard.name.trim() || '未命名' };
  state.editingBoard = null;
  await api.saveBoard(board); accept(await api.getLibrary());
}
async function openDetail(id, mode = 'view') {
  if (itemRename && !await commitItemRename()) return;
  const card = [...$('#track').querySelectorAll('[data-id]')].find(element => element.dataset.id === id);
  const rect = card?.getBoundingClientRect();
  return api.openPreview(id, { mode: mode === true ? 'edit' : mode, anchor: rect ? { x: rect.x + rect.width / 2 } : undefined, ids: visibleItems().map(item => item.id) });
}

async function beginItemRename(id) {
  if (itemRename?.id === id) { itemRename.input.focus(); return; }
  if (itemRename && !await commitItemRename()) { itemRename?.input.focus(); return; }
  const item = state.items.find(item => item.id === id), index = visibleItems().findIndex(item => item.id === id);
  if (!item || index < 0 || searchPending) return;
  closeMenu(); select(index);
  const node = document.getElementById(optionID(id)), input = document.createElement('input');
  const draft = { id, card: node, input, expected: { title: String(item.title ?? ''), renamed: !!item.renamed }, composing: false, pending: null };
  itemRename = draft; node.classList.add('renaming'); node.draggable = false;
  input.className = 'clip-name-input'; input.maxLength = 200; input.value = draft.expected.title;
  input.setAttribute('aria-label', '项目名称'); input.autocomplete = 'off'; input.spellcheck = false;
  input.oninput = () => { input.removeAttribute('aria-invalid'); input.title = ''; };
  input.oncompositionstart = () => { draft.composing = true; };
  input.oncompositionend = () => { draft.composing = false; };
  input.onkeydown = event => {
    event.stopPropagation();
    if (isComposingKey(event, draft.composing)) return;
    if (['Enter', 'Escape', 'Tab'].includes(event.key)) {
      event.preventDefault(); if (event.repeat) return;
      if (event.key === 'Escape') { cancelItemRename(); $('#timeline').focus(); }
      else commitItemRename().then(saved => { if (saved) $('#timeline').focus(); });
    }
  };
  for (const event of ['click', 'dblclick', 'pointerdown', 'contextmenu']) input.addEventListener(event, event => event.stopPropagation());
  input.ondragstart = event => { event.preventDefault(); event.stopPropagation(); };
  node.querySelector('.clip-footer').replaceChildren(input); input.focus(); input.select();
}
function cancelItemRename() {
  if (!itemRename || itemRename.pending) return false;
  itemRename.card.remove(); itemRename = null; render(); return true;
}
function commitItemRename() {
  const draft = itemRename;
  if (!draft) return Promise.resolve(true);
  if (draft.pending) return draft.pending;
  if (draft.composing) return Promise.resolve(false);
  if (draft.input.value === draft.expected.title) { cancelItemRename(); return Promise.resolve(true); }
  draft.input.disabled = true;
  draft.pending = (async () => {
    try {
      const library = await api.renameItem(draft.id, draft.input.value, draft.expected);
      if (itemRename === draft) { draft.card.remove(); itemRename = null; accept(library); render(); }
      return true;
    } catch (error) {
      draft.input.setAttribute('aria-invalid', 'true'); draft.input.title = error.message; toast(error.message); return false;
    } finally { draft.pending = null; draft.input.disabled = false; }
  })();
  return draft.pending;
}

function payload(event) {
  for (const [type, key] of [['board', 'application/x-paste-easy-board'], ['items', 'application/x-paste-easy-items']]) {
    const raw = event.dataTransfer?.getData(key);
    if (raw) { try { return { type, value: JSON.parse(raw) }; } catch { return null; } }
  }
  return dragging;
}
function clearDrag() {
  dragging = null;
  document.querySelectorAll('.drop-target').forEach(element => element.classList.remove('drop-target'));
}
$('#boards').addEventListener('dragstart', event => {
  const board = event.target.closest('[data-board]'); if (!board || board.dataset.board === 'history') return;
  dragging = { type: 'board', value: board.dataset.board };
  event.dataTransfer.setData('application/x-paste-easy-board', JSON.stringify(dragging.value)); event.dataTransfer.effectAllowed = 'move';
});
$('#boards').addEventListener('dragover', event => {
  const target = event.target.closest('[data-board]'); if (!target || target.dataset.board === 'history') return;
  event.preventDefault(); target.classList.add('drop-target');
});
$('#boards').addEventListener('dragleave', event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target')); });
$('#boards').addEventListener('drop', event => {
  event.preventDefault(); const target = event.target.closest('[data-board]'), data = payload(event); clearDrag();
  if (!target || target.dataset.board === 'history' || !data) return;
  attempt(async () => {
    if (data.type === 'items') { accept(await api.pinItems(data.value, target.dataset.board)); toast('已固定到 Pinboard'); }
    else if (data.value !== target.dataset.board) {
      const ids = state.boards.map(board => board.id).filter(id => id !== data.value), index = ids.indexOf(target.dataset.board);
      if (index < 0 || !state.boards.some(board => board.id === data.value)) return;
      const rect = target.getBoundingClientRect(); ids.splice(index + (event.clientX > rect.x + rect.width / 2 ? 1 : 0), 0, data.value);
      accept(await api.reorderBoards(ids));
    }
  });
});
$('#timeline').addEventListener('dragstart', event => {
  if (event.target.closest('.renaming')) { event.preventDefault(); return; }
  const native = event.target.closest('[data-native-drag]');
  if (native) { event.preventDefault(); const ids = state.selected.has(native.dataset.nativeDrag) ? [...state.selected] : [native.dataset.nativeDrag]; attempt(() => api.startDrag(ids)); return; }
  const card = event.target.closest('[data-id]'); if (!card) return;
  const ids = state.selected.has(card.dataset.id) ? [...state.selected] : [card.dataset.id];
  dragging = { type: 'items', value: ids };
  event.dataTransfer.setData('application/x-paste-easy-items', JSON.stringify(ids));
  const { text, error } = api.dragText(ids);
  if (error) { event.preventDefault(); toast(error); return; }
  if (text) event.dataTransfer.setData('text/plain', text);
  event.dataTransfer.effectAllowed = 'copyMove';
});
$('#timeline').addEventListener('dragover', event => {
  if (!state.searching && state.board !== 'history' && event.target.closest('[data-id]')) { event.preventDefault(); event.target.closest('[data-id]').classList.add('drop-target'); }
});
$('#timeline').addEventListener('drop', event => {
  event.preventDefault(); const target = event.target.closest('[data-id]'), data = payload(event); clearDrag();
  if (!target || state.searching || state.board === 'history' || data?.type !== 'items') return;
  attempt(async () => {
    const members = filterItems(state.items, { board: state.board, boards: state.boards }).map(item => item.id);
    if (!Array.isArray(data.value) || data.value.some(id => !members.includes(id))) return;
    const ids = members.filter(id => !data.value.includes(id)), index = ids.indexOf(target.dataset.id);
    if (index < 0) return;
    const rect = target.getBoundingClientRect(); ids.splice(index + (event.clientX > rect.x + rect.width / 2 ? 1 : 0), 0, ...data.value);
    accept(await api.reorderBoardItems(state.board, ids));
  });
});
document.addEventListener('dragend', clearDrag);

$('#searchToggle').onclick = () => toggleSearch(true);
$('#searchClear').onclick = () => { $('#searchInput').value = ''; state.query = ''; resetFilter(); $('#searchInput').focus(); };
$('#searchInput').onfocus = () => updateSuggestions();
// IME draft text stays in the input until composition commits.
$('#searchInput').oninput = event => {
  suggestionsDismissed = false;
  if (!composing && !event.isComposing) { state.query = event.target.value; resetFilter(); }
  else hideSuggestions();
};
document.addEventListener('compositionstart', () => { composing = true; hideSuggestions(); });
document.addEventListener('compositionend', event => {
  composing = false; if (event.target === $('#searchInput')) { state.query = event.target.value; suggestionsDismissed = false; resetFilter(); }
});
$('#boards').onclick = event => { const button = event.target.closest('[data-board]'); if (button) setBoard(button.dataset.board); };
$('#boards').oncontextmenu = event => {
  event.preventDefault(); const button = event.target.closest('[data-board]');
  const board = state.boards.find(b => b.id === button?.dataset.board);
  if (board) menu([{ label: '编辑 Pinboard…', icon: 'pencil', action: () => boardDialog(board) },
    { label: '删除 Pinboard', icon: 'trash-2', action: async () => { accept(await api.deleteBoard(board.id)); toast('Pinboard 已删除，项目仍保留在历史中。'); } }], event.clientX, event.clientY);
};
$('#addBoard').onclick = () => attempt(() => boardDialog());
$('#filterToggle').onclick = () => {
  const open = $('#filters').hidden; closeFilters(); hideSuggestions(); suggestionsDismissed = true;
  if (open) { renderFilterUI(); $('#filters').hidden = false; $('#filterToggle').setAttribute('aria-expanded', 'true'); }
};
$('#typeFilters').onclick = event => { if (event.target.dataset.type) setFilter('type', event.target.dataset.type); };
$('#sourceFilter').onchange = event => setFilter('source', event.target.value);
$('#dateFilter').onchange = event => setFilter('date', event.target.value);
$('#pinboardFilter').onchange = event => setFilter('pinboard', event.target.value);
$('#resetFilters').onclick = () => { state.type = 'all'; state.source = state.date = state.pinboard = ''; resetFilter(); };
$('#filterTokens').onkeydown = event => {
  const buttons = [...$('#filterTokens').querySelectorAll('button')], index = buttons.indexOf(event.target);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); $('#searchInput').focus(); }
  else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index + (event.key === 'ArrowRight' ? 1 : -1);
    (buttons[next] || $('#searchInput')).focus();
  } else if (['Backspace', 'Delete'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) event.target.click(); }
};
$('#timeline').addEventListener('scroll', () => { cancelAnimationFrame(renderFrame); renderFrame = requestAnimationFrame(renderCards); });
$('#timeline').addEventListener('wheel', event => {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && !event.ctrlKey) { event.preventDefault(); $('#timeline').scrollLeft += event.deltaY; }
}, { passive: false });
$('#timeline').onclick = event => {
  const label = event.target.closest('[data-rename]'); if (label) { attempt(() => beginItemRename(label.dataset.rename)); return; }
  const item = event.target.closest('[data-index]'); if (!item) return;
  select(Number(item.dataset.index), { extend: event.shiftKey, toggle: event.metaKey || event.ctrlKey }); $('#timeline').focus();
  if (itemRename) commitItemRename();
};
$('#timeline').ondblclick = event => { if (event.target.closest('.clip-label, .renaming')) return; const item = event.target.closest('[data-id]'); if (item) attempt(() => activateSelection(state.selected.has(item.dataset.id) ? selectedIDs() : [item.dataset.id], true, modifierPressed(event, state.settings.plainTextModifier))); };
$('#timeline').oncontextmenu = event => {
  event.preventDefault(); const node = event.target.closest('[data-id]'); if (!node) return;
  const item = state.items.find(i => i.id === node.dataset.id); if (!item) return;
  if (!state.selected.has(item.id)) select(Number(node.dataset.index));
  itemMenu(item, event.clientX, event.clientY);
};
function pauseMenuEntries() {
  const paused = state.status.capture?.paused ?? state.settings.paused;
  return [
    { label: paused ? '继续记录' : '暂停记录', icon: paused ? 'play' : 'pause', key: '⌘T', shortcut: 'Meta+T', action: () => api.toggleCapture() },
    { heading: '暂停时长' },
    ...[[300000, '5分钟'], [900000, '15分钟'], [3600000, '1小时'], [null, '直到手动恢复']].map(([duration, label]) => ({ label, icon: 'clock', action: () => api.pauseCapture(duration) }))
  ];
}
$('#moreButton').onclick = () => menu([
  { label: '新建文本', icon: 'file-plus-2', key: '⌘N', shortcut: 'Meta+n', action: newText },
  { label: '设置…', icon: 'settings', key: '⌘,', shortcut: 'Meta+,', action: () => api.openSettings() },
  ...pauseMenuEntries(),
  { label: state.status.stackMode ? '退出 Paste Stack' : 'Paste Stack', icon: 'layers', action: () => api.toggleStack() },
  { label: '粘贴 Stack 下一项', icon: 'clipboard-paste', disabled: !state.status.stackCount, action: pasteStackNext }, null,
  { label: '导出备份…', icon: 'download', action: () => api.exportLibrary() },
  { label: '删除历史…', icon: 'trash-2', action: async () => accept(await api.clearHistory()) }, null,
  { label: '关闭', icon: 'x', key: 'Esc', shortcut: 'Escape', action: () => api.hide() }
], innerWidth - 230, 48);
$('#stackButton').onclick = () => attempt(() => state.status.stackCount ? pasteStackNext() : api.toggleStack());
$('#captureButton').onclick = () => attempt(() => api.resumeCapture());
document.addEventListener('pointerdown', event => {
  if (itemRename && !event.target.closest('.clip-card')) commitItemRename();
  if (state.editingBoard && !event.target.closest('.board-edit, #menu')) attempt(commitBoard);
  if (!event.target.closest('#menu, #moreButton')) closeMenu();
  if (!event.target.closest('#filters, #filterToggle')) closeFilters();
  if (!event.target.closest('#searchBox, #filterSuggestions')) hideSuggestions();
});
document.addEventListener('focusin', event => { if (!event.target.closest('#searchBox, #filterSuggestions')) hideSuggestions(); });
document.addEventListener('keydown', event => {
  const typing = event.target.matches('input, textarea, select') || event.target.isContentEditable;
  if (isComposingKey(event, composing) || event.key === 'Dead') {
    if (!typing && !composing && (event.key === 'Process' || event.key === 'Dead' || event.keyCode === 229) && $('#menu').hidden) toggleSearch(true);
    return;
  }
  if (event.target.closest('#filterTokens')) return;
  if (event.target.closest('#filters')) {
    if (event.key === 'Escape') { event.preventDefault(); closeFilters(); $('#filterToggle').focus(); }
    else if (event.repeat && ['Enter', ' '].includes(event.key)) event.preventDefault();
    return;
  }
  if (event.target.closest('#filterSuggestions')) {
    const buttons = [...$('#filterSuggestions').children], index = buttons.indexOf(event.target);
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
      (buttons[next] || $('#searchInput')).focus();
    } else if (event.key === 'Escape') { event.preventDefault(); suggestionsDismissed = true; hideSuggestions(); $('#searchInput').focus(); }
    else if (event.repeat && ['Enter', ' '].includes(event.key)) event.preventDefault();
    return;
  }
  if (event.target === $('#searchInput') && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      updateSuggestions(true);
      if (!$('#filterSuggestions').hidden) { event.preventDefault(); const buttons = $('#filterSuggestions').children; buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1]?.focus(); return; }
    }
    if (event.key === 'Backspace' && !state.query && !event.repeat && $('#filterTokens').children.length) {
      event.preventDefault(); $('#filterTokens').lastElementChild.querySelector('button').focus(); return;
    }
  }
  const modifier = event.metaKey || event.ctrlKey;
  if (shortcutMatches(event, 'CommandOrControl+T')) { event.preventDefault(); if (!event.repeat) attempt(() => api.toggleCapture()); return; }
  if (shortcutMatches(event, 'CommandOrControl+N')) { event.preventDefault(); if (!event.repeat) attempt(newText); return; }
  document.body.classList.toggle('quick-keys', modifierPressed(event, state.settings.quickPasteModifier));
  if ($('#menu').hidden === false) {
    const buttons = [...$('#menu').querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); return; }
    if (['Home', 'End'].includes(event.key)) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus(); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); $('#timeline').focus(); return; }
    if (event.key === 'Tab') { closeMenu(); return; }
    if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) buttons[index]?.click(); return; }
    const command = buttons.find(button => {
      const shortcut = button.getAttribute('aria-keyshortcuts');
      return shortcutMatches(event, event.key === 'Delete' && shortcut === 'Backspace' ? 'Delete' : shortcut);
    });
    if (command) { event.preventDefault(); if (!event.repeat) command.click(); }
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (itemRename) { if (cancelItemRename()) $('#timeline').focus(); return; }
    if (!$('#filters').hidden) closeFilters();
    else if (state.query) { state.query = ''; $('#searchInput').value = ''; resetFilter(); }
    else if (state.searching) toggleSearch(false);
    else api.hide();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); toggleSearch(true); return; }
  if (modifier && event.key === ',') { event.preventDefault(); api.openSettings(); return; }
  if (modifier && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); attempt(() => boardDialog()); return; }
  if (state.searching && !modifier && !event.altKey && event.key === 'Tab'
      && (event.target === $('#timeline') || (event.target === $('#searchInput') && !event.shiftKey))) {
    event.preventDefault(); (event.target === $('#timeline') ? $('#searchInput') : $('#timeline')).focus(); return;
  }
  if (event.target === $('#searchInput') && event.key === 'Enter') {
    event.preventDefault(); if (!event.repeat) $('#timeline').focus(); return;
  }
  if (typing || event.target.closest('button, a')) return;
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !modifier && !event.altKey)) {
    event.preventDefault(); const item = state.items.find(value => value.id === state.active);
    const node = item && document.getElementById(optionID(item.id));
    if (item && node) { const rect = node.getBoundingClientRect(); itemMenu(item, rect.left + 20, rect.top + 20); } return;
  }
  for (const [key, mode] of [['E', 'edit'], ['R', 'rename'], ['G', 'locate']]) {
    if (!shortcutMatches(event, `CommandOrControl+${key}`)) continue;
    event.preventDefault(); if (event.repeat || state.selected.size !== 1 || searchPending) return;
    const id = [...state.selected][0], item = state.items.find(value => value.id === id);
    if (!item) return;
    if (mode === 'locate') { const location = itemLocations(item, state)[0]; if (location) showIn(id, location.id); }
    else if (mode !== 'edit' || item.type !== 'file') { closeMenu(); attempt(() => openDetail(id, mode)); }
    return;
  }
  const nextBoard = shortcutMatches(event, state.settings.nextBoardHotkey), previousBoard = shortcutMatches(event, state.settings.previousBoardHotkey);
  if (nextBoard || previousBoard) {
    event.preventDefault(); const ids = ['history', ...state.boards.map(b => b.id)]; const next = (ids.indexOf(state.board) + (nextBoard ? 1 : -1) + ids.length) % ids.length; setBoard(ids[next]); return;
  }
  const quickDigit = /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(-1)) : /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
  if (modifierPressed(event, state.settings.quickPasteModifier) && quickDigit) { event.preventDefault(); const item = visibleItems()[quickDigit - 1]; if (item) attempt(() => activate(item.id, true, modifierPressed(event, state.settings.plainTextModifier))); return; }
  if (modifier && event.key.toLowerCase() === 'a') { event.preventDefault(); state.selected = new Set(visibleItems().map(i => i.id)); renderCards(); return; }
  if (modifier && event.key.toLowerCase() === 'c') { event.preventDefault(); if (!event.repeat && !searchPending) attempt(() => activate(undefined, false)); return; }
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const items = visibleItems(); const current = items.findIndex(i => i.id === state.active);
    select(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current + (event.key === 'ArrowRight' ? 1 : -1), { extend: event.shiftKey }); return;
  }
  if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat && !searchPending) attempt(() => activate(undefined, !event.altKey || state.settings.plainTextModifier === 'Alt', modifierPressed(event, state.settings.plainTextModifier))); return; }
  if (event.key === ' ') { event.preventDefault(); const id = [...state.selected][0]; if (!event.repeat && !searchPending && id) attempt(() => openDetail(id)); return; }
  if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); if (!event.repeat && !searchPending) attempt(async () => accept(await api.deleteItems([...state.selected]))); return; }
  if (!modifier && [...event.key].length === 1) { toggleSearch(true); $('#searchInput').value = event.key; state.query = event.key; resetFilter(); event.preventDefault(); }
});
document.addEventListener('keyup', event => document.body.classList.toggle('quick-keys', modifierPressed(event, state.settings.quickPasteModifier)));
window.addEventListener('blur', () => document.body.classList.remove('quick-keys'));
window.addEventListener('resize', () => { renderCards(); if (!$('#filterSuggestions').hidden) updateSuggestions(); });
api.onChanged(accept);
api.onNewText(() => attempt(newText));
api.onItemCreated(({ id, boardId }) => attempt(async () => { accept(await api.getLibrary()); showIn(id, boardId); }));
api.onShown(({ target }) => {
  mediaEpoch += 1; mediaSkipped.clear(); mediaFailures.clear(); clearMediaWarning();
  document.body.dataset.panelReady = 'true'; state.target = target; closeMenu(); render();
  if (itemRename?.input.isConnected) itemRename.input.focus(); else if (state.editingBoard) $('.board-name-edit')?.focus(); else $('#timeline').focus();
});
attempt(async () => accept(await api.getLibrary()));
refreshIcons();
