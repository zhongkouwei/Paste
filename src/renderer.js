const state = {
  history: [],
  filter: 'all',
  query: '',
  selectedIndex: 0
};

const els = {
  timeline: document.querySelector('#timeline'),
  emptyState: document.querySelector('#emptyState'),
  searchInput: document.querySelector('#searchInput'),
  countLabel: document.querySelector('#countLabel'),
  clearButton: document.querySelector('#clearButton'),
  closeButton: document.querySelector('#closeButton'),
  tabs: [...document.querySelectorAll('.tab')],
  boards: [...document.querySelectorAll('.board')]
};

function hashFor(item) {
  const source = item.signature || item.id || item.title || '';
  let total = 0;
  for (let index = 0; index < source.length; index += 1) {
    total = (total + source.charCodeAt(index) * (index + 1)) % 9973;
  }
  return total;
}

function colorStyleFor(item, index) {
  const hash = hashFor(item);
  const hue = (hash + index * 43) % 360;
  const saturation = 50 + (hash % 16);
  const lightness = 28 + (hash % 8);
  const accentLightness = 58 + (hash % 12);
  return [
    `--card-hue: ${hue}`,
    `--card-saturation: ${saturation}%`,
    `--card-lightness: ${lightness}%`,
    `--card-accent-lightness: ${accentLightness}%`
  ].join('; ');
}

function relativeTime(dateString) {
  const timestamp = new Date(dateString).getTime();
  if (!Number.isFinite(timestamp)) return 'unknown';

  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function iconFor(type) {
  if (type === 'link') return '↗';
  if (type === 'code') return '{ }';
  if (type === 'image') return '▧';
  return 'T';
}

function filteredHistory() {
  const query = state.query.trim().toLowerCase();
  return state.history.filter((item) => {
    const matchesFilter = state.filter === 'all'
      || (state.filter === 'favorite' && item.isFavorite)
      || item.type === state.filter;
    if (!matchesFilter) return false;
    if (!query) return true;
    return `${item.title}\n${item.body}`.toLowerCase().includes(query);
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderCard(item, index) {
  const selected = index === state.selectedIndex ? 'selected' : '';
  const favorite = item.isFavorite ? 'pinned' : '';
  const cardStyle = colorStyleFor(item, index);
  const itemId = escapeHtml(item.id);
  const preview = item.type === 'image'
    ? `<img class="clipImage" src="${escapeHtml(item.preview)}" alt="Clipboard image" />`
    : `<pre>${escapeHtml(item.preview)}</pre>`;

  return `
    <article class="clipCard ${selected}" style="${cardStyle}" data-id="${itemId}" data-index="${index}">
      <div class="clipMeta">
        <span class="typeIcon">${iconFor(item.type)}</span>
        <span class="clipType">${item.type}</span>
        <span class="clipTime">${relativeTime(item.createdAt)}</span>
      </div>
      <div class="clipPreview ${favorite}">
        ${preview}
      </div>
      <div class="clipActions">
        <button class="miniButton" data-action="paste" title="Paste" aria-label="Paste">⌘V</button>
        <button class="miniButton" data-action="copy" title="Copy" aria-label="Copy">Copy</button>
        <button class="miniButton" data-action="favorite" title="Pin" aria-label="Pin">${item.isFavorite ? '★' : '☆'}</button>
        <button class="miniButton danger" data-action="delete" title="Delete" aria-label="Delete">⌫</button>
      </div>
    </article>
  `;
}

function render() {
  const items = filteredHistory();
  if (state.selectedIndex >= items.length) state.selectedIndex = Math.max(0, items.length - 1);
  els.timeline.innerHTML = items.map(renderCard).join('');
  els.emptyState.classList.toggle('hidden', items.length > 0);
  els.countLabel.textContent = `${state.history.length} clips saved`;
  els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.filter === state.filter));
  els.boards.forEach((board) => {
    const boardFilter = board.dataset.filter || 'all';
    board.classList.toggle('active', boardFilter === state.filter || (board.dataset.board === 'history' && state.filter === 'all'));
  });
  const selected = els.timeline.querySelector('.clipCard.selected');
  selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function setFilter(filter) {
  state.filter = filter;
  state.selectedIndex = 0;
  render();
}

function moveSelection(delta) {
  const items = filteredHistory();
  if (!items.length) return;
  state.selectedIndex = Math.min(items.length - 1, Math.max(0, state.selectedIndex + delta));
  render();
}

function isTypingTarget(target) {
  return target instanceof HTMLElement
    && (target.matches('input, textarea, select') || target.isContentEditable);
}

async function activateSelected(shouldPaste) {
  const item = filteredHistory()[state.selectedIndex];
  if (!item) return;
  await window.pasteLike.copy(item.id, shouldPaste);
}

els.searchInput.addEventListener('input', (event) => {
  state.query = event.target.value;
  state.selectedIndex = 0;
  render();
});

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => setFilter(tab.dataset.filter));
});

els.boards.forEach((board) => {
  board.addEventListener('click', () => setFilter(board.dataset.filter || 'all'));
});

els.timeline.addEventListener('click', async (event) => {
  const card = event.target.closest('.clipCard');
  if (!card) return;
  state.selectedIndex = Number(card.dataset.index);
  const action = event.target.closest('button')?.dataset.action || 'paste';
  const id = card.dataset.id;

  if (action === 'copy') await window.pasteLike.copy(id, false);
  if (action === 'paste') await window.pasteLike.copy(id, true);
  if (action === 'favorite') state.history = await window.pasteLike.toggleFavorite(id);
  if (action === 'delete') state.history = await window.pasteLike.delete(id);
  render();
});

els.clearButton.addEventListener('click', async () => {
  state.history = await window.pasteLike.clear();
  render();
});

els.closeButton.addEventListener('click', () => window.pasteLike.hide());

window.addEventListener('keydown', async (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    els.searchInput.focus();
    return;
  }
  if (event.key === 'Escape' && event.target === els.searchInput && state.query) {
    event.preventDefault();
    event.stopPropagation();
    state.query = '';
    els.searchInput.value = '';
    state.selectedIndex = 0;
    render();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    window.pasteLike.hide();
    return;
  }
  if (isTypingTarget(event.target)) return;
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    moveSelection(1);
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    moveSelection(-1);
    return;
  }
  if (event.key === 'Enter') {
    await activateSelected(!event.altKey);
  }
}, true);

window.pasteLike.onHistoryChanged((history) => {
  state.history = history;
  render();
});

window.pasteLike.getHistory().then((history) => {
  state.history = history;
  render();
  setTimeout(() => els.searchInput.focus(), 50);
});
