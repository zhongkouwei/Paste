/* global lucide, PasteModel */
const $ = selector => document.querySelector(selector);
const api = window.paste;
const { filterItems, relativeTime, COLORS, modifierPressed, shortcutMatches } = PasteModel;
const state = { items: [], boards: [], settings: {}, status: {}, board: 'history', query: '', type: 'all', source: '', after: '',
  selected: new Set(), anchor: 0, searching: false, target: '', editingBoard: null, detail: null };
const labels = { text: '文本', code: '文本', link: '链接', image: '图片', color: '颜色', file: '文件' };
const icons = { text: 'text', code: 'code', link: 'link', image: 'image', color: 'palette', file: 'file' };
let toastTimer, renderFrame, dragging = null;

function icon(name) { return `<i data-lucide="${name}"></i>`; }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function safeColor(value) { return /^#[a-f0-9]{6}$/i.test(value) ? value : '#77808a'; }
function safeImage(value) { return /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value || '') ? value : ''; }
function refreshIcons() { lucide.createIcons({ attrs: { 'aria-hidden': 'true' } }); }
function visibleItems() { return filterItems(state.items, state); }
function toast(message) { $('#status').textContent = message; $('#status').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#status').hidden = true; }, 6000); }
async function attempt(task) { try { return await task(); } catch (error) { toast(error.message); return undefined; } }

function accept(library) {
  if (!library) return;
  Object.assign(state, { items: library.items, boards: library.boards, settings: library.settings, status: library.status || {} });
  if (state.board !== 'history' && !state.boards.some(board => board.id === state.board)) state.board = 'history';
  if (state.status.error) toast(state.status.error);
  if (library.recovery) toast(library.recovery);
  render();
}

function renderBoards() {
  const previousEditor = $('#boards .board-edit');
  const restoreEditorFocus = !!previousEditor?.contains(document.activeElement);
  $('#boards').innerHTML = `<button class="board ${state.board === 'history' ? 'active' : ''}" data-board="history" aria-pressed="${state.board === 'history'}" title="剪贴板">${icon('history')}<span>剪贴板</span></button>`
    + state.boards.map(board => `<button class="board ${state.board === board.id ? 'active' : ''}" data-board="${escape(board.id)}" draggable="true" aria-pressed="${state.board === board.id}" title="${escape(board.name)}"><b class="board-dot" style="--board-color:${safeColor(board.color)}"></b><span>${escape(board.name)}</span></button>`).join('');
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

function card(item, index) {
  const selected = state.selected.has(item.id);
  const image = safeImage(item.preview), sourceIcon = safeImage(item.source?.icon);
  let body = `<pre>${escape(item.preview || item.body)}</pre>`;
  let kind = '';
  if (item.type === 'image') { body = image ? `<img src="${image}" alt="${escape(item.title)}" draggable="false">` : icon('image-off'); kind = 'image-preview'; }
  if (item.type === 'color' && /^#[\da-f]{3,8}$/i.test(item.body)) { body = `<span>${escape(item.body)}</span>`; kind = 'color-preview'; }
  const caption = item.type === 'image' ? `${item.size?.width || '?'} × ${item.size?.height || '?'}`
    : item.type === 'file' ? '文件' : `${item.characterCount ?? [...(item.body || '')].length} 个字符`;
  return `<article class="clip-card ${selected ? 'selected' : ''}" role="option" draggable="true" aria-selected="${selected}" aria-label="${escape(item.title)}" data-id="${escape(item.id)}" data-index="${index}" data-type="${escape(item.type)}" style="left:${24 + index * 264}px;--source-color:${safeColor(item.source?.color)}">
    <header class="clip-header"><span class="clip-type">${labels[item.type] || '文本'}</span><time class="clip-time">${relativeTime(item.createdAt)}</time>${sourceIcon ? `<img class="source-icon" src="${sourceIcon}" alt="${escape(item.source?.name)}" draggable="false">` : `<span class="source-fallback" title="${escape(item.source?.name || '')}">${icon(icons[item.type] || 'text')}</span>`}</header>
    <div class="clip-body ${kind}" ${kind === 'color-preview' ? `style="background:${escape(item.body)};color:#111"` : ''}>${body}</div>
    <footer class="clip-footer">${item.renamed ? escape(item.title) : caption}</footer>${item.boardIds?.length ? `<span class="clip-pin">${icon('pin')}</span>` : ''}
    ${['image', 'file'].includes(item.type) ? `<button class="native-drag icon-button" draggable="true" data-native-drag="${escape(item.id)}" title="拖出原始文件" aria-label="拖出原始文件">${icon('grip-vertical')}</button>` : ''}
    ${index < 9 ? `<span class="quick-key">${{ CommandOrControl: '⌘', Control: '⌃', Alt: '⌥' }[state.settings.quickPasteModifier] || '⌘'}${index + 1}</span>` : ''}</article>`;
}

function renderCards() {
  const items = visibleItems();
  const width = $('#timeline').clientWidth;
  const first = Math.max(0, Math.floor($('#timeline').scrollLeft / 264) - 3);
  const end = Math.min(items.length, first + Math.ceil(width / 264) + 8);
  $('#track').style.width = `${Math.max(width, items.length * 264 + 24)}px`;
  $('#track').innerHTML = items.slice(first, end).map((item, offset) => card(item, first + offset)).join('');
  $('#emptyState').hidden = items.length > 0;
  $('#emptyTitle').textContent = state.query || state.type !== 'all' || state.source || state.after ? '无结果'
    : state.board === 'history' ? '剪贴板为空' : 'Pinboard 为空';
  refreshIcons();
}
function render() {
  const items = visibleItems();
  state.selected = new Set([...state.selected].filter(id => items.some(item => item.id === id)));
  if (!state.selected.size && items.length) { state.anchor = 0; state.selected.add(items[0].id); }
  renderBoards(); renderCards();
}
function scrollToIndex(index) {
  const left = 24 + index * 264;
  const viewport = $('#timeline');
  if (left < viewport.scrollLeft + 8) viewport.scrollLeft = Math.max(0, left - 12);
  else if (left + 248 > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = left + 248 - viewport.clientWidth;
}
function select(index, { extend = false, toggle = false } = {}) {
  const items = visibleItems();
  index = Math.min(items.length - 1, Math.max(0, index));
  if (!items[index]) return;
  if (extend) {
    state.selected = new Set(items.slice(Math.min(index, state.anchor), Math.max(index, state.anchor) + 1).map(item => item.id));
  } else if (toggle) {
    if (state.selected.has(items[index].id)) state.selected.delete(items[index].id); else state.selected.add(items[index].id);
    state.anchor = index;
  } else { state.anchor = index; state.selected = new Set([items[index].id]); }
  scrollToIndex(index); renderCards();
}
function resetFilter() { state.selected.clear(); state.anchor = 0; $('#timeline').scrollLeft = 0; render(); }
function setBoard(id) { state.board = id; closeMenu(); resetFilter(); }
function toggleSearch(open) {
  state.searching = open; document.body.classList.toggle('searching', open);
  $('#searchBox').hidden = !open; $('#searchToggle').hidden = open;
  if (open) $('#searchInput').focus();
  else { state.query = ''; $('#searchInput').value = ''; state.type = 'all'; state.source = ''; state.after = ''; $('#filters').hidden = true; resetFilter(); }
}

function closeMenu() { $('#menu').hidden = true; }
function menu(entries, x, y) {
  const element = $('#menu');
  element.replaceChildren();
  entries.forEach(entry => {
    if (!entry) { element.append(document.createElement('hr')); return; }
    if (entry.heading) { const text = document.createElement('div'); text.className = 'menu-label'; text.textContent = entry.heading; element.append(text); return; }
    const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem';
    button.innerHTML = `${entry.icon ? icon(entry.icon) : ''}<span>${escape(entry.label)}</span>${entry.key ? `<kbd>${escape(entry.key)}</kbd>` : ''}`;
    button.disabled = !!entry.disabled;
    button.addEventListener('click', () => { closeMenu(); attempt(entry.action); }); element.append(button);
  });
  element.hidden = false; refreshIcons();
  element.style.left = `${Math.max(8, Math.min(x, innerWidth - element.offsetWidth - 8))}px`;
  element.style.top = `${Math.max(8, Math.min(y, innerHeight - element.offsetHeight - 8))}px`;
  element.querySelector('button:not(:disabled)')?.focus();
}

async function activate(id = [...state.selected][0], paste = true, plain = false) {
  if (!id) return;
  if (state.status.stackMode && paste) { await api.addToStack(id); toast('已加入 Stack'); return; }
  const result = await api.copy(id, { paste, plain });
  if (!result.ok) toast(result.error); else if (!paste) toast('已复制');
}
function itemMenu(item, x, y) {
  menu([
    { label: state.target ? `粘贴到 ${state.target}` : '粘贴到当前应用', icon: 'clipboard-paste', key: '↵', action: () => activate(item.id) },
    { label: '以纯文本粘贴', action: () => activate(item.id, true, true), disabled: ['image', 'file'].includes(item.type) },
    { label: '复制', icon: 'copy', key: '⌘C', action: () => activate(item.id, false) }, null,
    { label: '编辑', icon: 'pencil', action: () => openDetail(item.id, true), disabled: ['image', 'file'].includes(item.type) },
    { label: '重命名', action: () => openDetail(item.id, 'rename') },
    ...(item.type === 'file' ? [{ label: '在 Finder 中显示', icon: 'folder-search', action: () => api.revealItem(item.id) }] : []),
    { label: state.selected.size > 1 ? `删除 ${state.selected.size} 个项目` : '删除', icon: 'trash-2', key: '⌫', action: async () => accept(await api.deleteItems([...state.selected])) }, null,
    { heading: '固定到 Pinboard' },
    ...state.boards.map(board => ({ label: `${item.boardIds?.includes(board.id) ? '✓ ' : ''}${board.name}`, action: () => pin(board.id) })),
    { label: '创建 Pinboard…', icon: 'plus', action: () => boardDialog() }, null,
    { label: '预览', icon: 'scan', key: 'Space', action: () => openDetail(item.id) },
    { label: '分享', icon: 'share', action: () => api.shareItem(item.id) }
  ], x, y);
}
async function pin(boardId) {
  const ids = [...state.selected];
  const shouldRemove = ids.every(id => state.items.find(item => item.id === id)?.boardIds.includes(boardId));
  accept(await api.pinItems(ids, boardId, shouldRemove));
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
  const card = [...$('#track').querySelectorAll('[data-id]')].find(element => element.dataset.id === id);
  const rect = card?.getBoundingClientRect();
  return api.openPreview(id, { mode: mode === true ? 'edit' : mode, anchor: rect ? { x: rect.x + rect.width / 2 } : undefined, ids: visibleItems().map(item => item.id) });
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
  const native = event.target.closest('[data-native-drag]');
  if (native) { event.preventDefault(); const ids = state.selected.has(native.dataset.nativeDrag) ? [...state.selected] : [native.dataset.nativeDrag]; attempt(() => api.startDrag(ids)); return; }
  const card = event.target.closest('[data-id]'); if (!card) return;
  const ids = state.selected.has(card.dataset.id) ? [...state.selected] : [card.dataset.id];
  dragging = { type: 'items', value: ids };
  event.dataTransfer.setData('application/x-paste-easy-items', JSON.stringify(ids));
  const text = ids.map(id => state.items.find(item => item.id === id)).filter(item => item && !['image', 'file'].includes(item.type)).map(item => item.body).join('\n');
  if (text) event.dataTransfer.setData('text/plain', text);
  event.dataTransfer.effectAllowed = 'copyMove';
});
$('#timeline').addEventListener('dragover', event => {
  if (state.board !== 'history' && event.target.closest('[data-id]')) { event.preventDefault(); event.target.closest('[data-id]').classList.add('drop-target'); }
});
$('#timeline').addEventListener('drop', event => {
  event.preventDefault(); const target = event.target.closest('[data-id]'), data = payload(event); clearDrag();
  if (!target || state.board === 'history' || data?.type !== 'items') return;
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
$('#searchInput').oninput = event => { state.query = event.target.value; resetFilter(); };
$('#boards').onclick = event => { const button = event.target.closest('[data-board]'); if (button) setBoard(button.dataset.board); };
$('#boards').oncontextmenu = event => {
  event.preventDefault(); const button = event.target.closest('[data-board]');
  const board = state.boards.find(b => b.id === button?.dataset.board);
  if (board) menu([{ label: '编辑 Pinboard…', icon: 'pencil', action: () => boardDialog(board) },
    { label: '删除 Pinboard', icon: 'trash-2', action: async () => { accept(await api.deleteBoard(board.id)); toast('Pinboard 已删除，项目仍保留在历史中。'); } }], event.clientX, event.clientY);
};
$('#addBoard').onclick = () => attempt(() => boardDialog());
$('#filterToggle').onclick = () => {
  $('#filters').hidden = !$('#filters').hidden;
  $('#typeFilters').innerHTML = Object.entries({ all: '全部', text: '文本', image: '图片', color: '颜色', file: '文件', link: '链接' })
    .map(([type, label]) => `<button data-type="${type}" class="${state.type === type ? 'active' : ''}">${label}</button>`).join('');
  const sources = [...new Map(state.items.filter(i => i.source?.bundleId).map(i => [i.source.bundleId, i.source])).values()];
  $('#sourceFilter').innerHTML = '<option value="">所有应用</option>' + sources.map(source => `<option value="${escape(source.bundleId)}">${escape(source.name)}</option>`).join('');
  $('#sourceFilter').value = state.source;
};
$('#typeFilters').onclick = event => { if (!event.target.dataset.type) return; state.type = event.target.dataset.type; $('#typeFilters').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.type === state.type)); resetFilter(); };
$('#sourceFilter').onchange = event => { state.source = event.target.value; resetFilter(); };
$('#dateFilter').onchange = event => { state.after = event.target.value ? new Date(Date.now() - Number(event.target.value) * 86400000).toISOString() : ''; resetFilter(); };
$('#timeline').addEventListener('scroll', () => { cancelAnimationFrame(renderFrame); renderFrame = requestAnimationFrame(renderCards); });
$('#timeline').addEventListener('wheel', event => {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && !event.ctrlKey) { event.preventDefault(); $('#timeline').scrollLeft += event.deltaY; }
}, { passive: false });
$('#timeline').onclick = event => {
  const item = event.target.closest('[data-index]'); if (!item) return;
  select(Number(item.dataset.index), { extend: event.shiftKey, toggle: event.metaKey || event.ctrlKey }); $('#timeline').focus();
};
$('#timeline').ondblclick = event => { const item = event.target.closest('[data-id]'); if (item) attempt(() => activate(item.dataset.id, true, modifierPressed(event, state.settings.plainTextModifier))); };
$('#timeline').oncontextmenu = event => {
  event.preventDefault(); const node = event.target.closest('[data-id]'); if (!node) return;
  const item = state.items.find(i => i.id === node.dataset.id); if (!item) return;
  if (!state.selected.has(item.id)) select(Number(node.dataset.index));
  itemMenu(item, event.clientX, event.clientY);
};
$('#moreButton').onclick = () => menu([
  { label: '设置…', icon: 'settings', key: '⌘,', action: () => api.openSettings() },
  { label: state.settings.paused ? '继续记录' : '暂停记录', icon: state.settings.paused ? 'play' : 'pause', action: async () => accept(await api.saveSettings({ paused: !state.settings.paused })) },
  { label: state.status.stackMode ? '退出 Paste Stack' : 'Paste Stack', icon: 'layers', action: () => api.toggleStack() },
  { label: '粘贴 Stack 下一项', icon: 'clipboard-paste', disabled: !state.status.stackCount, action: () => api.nextInStack() }, null,
  { label: '导出备份…', icon: 'download', action: () => api.exportLibrary() },
  { label: '删除历史…', icon: 'trash-2', action: async () => accept(await api.clearHistory()) }, null,
  { label: '关闭', icon: 'x', key: 'Esc', action: () => api.hide() }
], innerWidth - 230, 48);
$('#stackButton').onclick = () => attempt(() => state.status.stackCount ? api.nextInStack() : api.toggleStack());
document.addEventListener('pointerdown', event => {
  if (state.editingBoard && !event.target.closest('.board-edit, #menu')) attempt(commitBoard);
  if (!event.target.closest('#menu, #moreButton')) closeMenu();
  if (!event.target.closest('#filters, #filterToggle')) $('#filters').hidden = true;
});
document.addEventListener('keydown', event => {
  const modifier = event.metaKey || event.ctrlKey;
  document.body.classList.toggle('quick-keys', modifierPressed(event, state.settings.quickPasteModifier));
  if ($('#menu').hidden === false) {
    const buttons = [...$('#menu').querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); $('#timeline').focus(); return; }
    if (event.key === 'Enter') return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!$('#filters').hidden) $('#filters').hidden = true;
    else if (state.query) { state.query = ''; $('#searchInput').value = ''; resetFilter(); }
    else if (state.searching) toggleSearch(false);
    else api.hide();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); toggleSearch(true); return; }
  if (modifier && event.key === ',') { event.preventDefault(); api.openSettings(); return; }
  if (modifier && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); attempt(() => boardDialog()); return; }
  if (event.target.matches('input, textarea, select') || event.target.isContentEditable) return;
  const nextBoard = shortcutMatches(event, state.settings.nextBoardHotkey), previousBoard = shortcutMatches(event, state.settings.previousBoardHotkey);
  if (nextBoard || previousBoard) {
    event.preventDefault(); const ids = ['history', ...state.boards.map(b => b.id)]; const next = (ids.indexOf(state.board) + (nextBoard ? 1 : -1) + ids.length) % ids.length; setBoard(ids[next]); return;
  }
  const quickDigit = /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(-1)) : /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
  if (modifierPressed(event, state.settings.quickPasteModifier) && quickDigit) { event.preventDefault(); const item = visibleItems()[quickDigit - 1]; if (item) attempt(() => activate(item.id, true, modifierPressed(event, state.settings.plainTextModifier))); return; }
  if (modifier && event.key.toLowerCase() === 'a') { event.preventDefault(); state.selected = new Set(visibleItems().map(i => i.id)); renderCards(); return; }
  if (modifier && event.key.toLowerCase() === 'c') { event.preventDefault(); attempt(() => activate(undefined, false)); return; }
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const items = visibleItems(); const current = items.findIndex(i => i.id === [...state.selected].at(-1));
    select(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current + (event.key === 'ArrowRight' ? 1 : -1), { extend: event.shiftKey }); return;
  }
  if (event.key === 'Enter') { event.preventDefault(); attempt(() => activate(undefined, !event.altKey || state.settings.plainTextModifier === 'Alt', modifierPressed(event, state.settings.plainTextModifier))); return; }
  if (event.key === ' ') { event.preventDefault(); const id = [...state.selected][0]; if (id) attempt(() => openDetail(id)); return; }
  if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); attempt(async () => accept(await api.deleteItems([...state.selected]))); return; }
  if (!modifier && !event.altKey && event.key.length === 1) { toggleSearch(true); $('#searchInput').value = event.key; state.query = event.key; resetFilter(); event.preventDefault(); }
});
document.addEventListener('keyup', event => document.body.classList.toggle('quick-keys', modifierPressed(event, state.settings.quickPasteModifier)));
window.addEventListener('blur', () => document.body.classList.remove('quick-keys'));
window.addEventListener('resize', renderCards);
api.onChanged(accept);
api.onShown(({ target }) => { state.target = target; closeMenu(); render(); if (state.editingBoard) $('.board-name-edit')?.focus(); else $('#timeline').focus(); });
attempt(async () => accept(await api.getLibrary()));
refreshIcons();
