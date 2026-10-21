/* global lucide, DOMPurify */
const $ = selector => document.querySelector(selector);
const api = window.paste;
const labels = { text: '文本', code: '文本', link: '链接', image: '图片', color: '颜色', file: '文件' };
let state, dirty = false, statusTimer;
function icons() { lucide.createIcons(); }
function status(message) {
  $('#previewStatus').textContent = message; $('#previewStatus').hidden = false;
  clearTimeout(statusTimer); statusTimer = setTimeout(() => { $('#previewStatus').hidden = true; }, 6000);
}
async function attempt(action) { try { return await action(); } catch (error) { status(error.message); return undefined; } }
function markDirty(value) { dirty = value; api.markPreviewDirty(value); }

function richPreview(html) {
  const iframe = document.createElement('iframe'); iframe.title = '富文本预览'; iframe.setAttribute('sandbox', ''); iframe.referrerPolicy = 'no-referrer';
  const sanitized = DOMPurify.sanitize(html, { USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'link', 'base', 'iframe', 'form', 'input', 'button', 'video', 'audio', 'source'],
    FORBID_ATTR: ['src', 'srcset', 'href', 'poster', 'background'] });
  iframe.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">'
    + '<style>body{margin:0;padding:16px;color:#222;background:#fff;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;overflow-wrap:anywhere}img{max-width:100%}</style>' + sanitized;
  return iframe;
}

function renderPinboards() {
  const panel = $('#previewPinboards'); panel.replaceChildren();
  if (!state.boards.length) { const empty = document.createElement('span'); empty.textContent = '暂无 Pinboard'; panel.append(empty); }
  for (const board of state.boards) {
    const label = document.createElement('label'), input = document.createElement('input'), dot = document.createElement('b'), name = document.createElement('span');
    input.type = 'checkbox'; input.checked = state.item.boardIds.includes(board.id);
    dot.className = 'board-dot'; if (/^#[a-f0-9]{6}$/i.test(board.color)) dot.style.setProperty('--board-color', board.color);
    name.textContent = board.name;
    input.onchange = () => attempt(() => api.pinItems([state.item.id], board.id, !input.checked));
    label.append(input, dot, name); panel.append(label);
  }
}
function renderFiles(item) {
  const list = document.createElement('ul'); list.className = 'file-list';
  for (const [index, file] of item.files.entries()) {
    const row = document.createElement('li'), symbol = document.createElement('i'), text = document.createElement('span');
    symbol.dataset.lucide = file.directory ? 'folder' : 'file';
    const title = document.createElement('strong'), detail = document.createElement('small');
    title.textContent = file.name; detail.textContent = file.exists ? `${file.size.toLocaleString()} bytes` : '原始文件已移动或删除';
    if (!file.exists) row.className = 'missing';
    text.append(title, detail); row.append(symbol, text);
    if (file.exists) {
      const reveal = document.createElement('button'); reveal.className = 'icon-button'; reveal.title = '在 Finder 中显示'; reveal.setAttribute('aria-label', '在 Finder 中显示'); reveal.innerHTML = '<i data-lucide="folder-search"></i>';
      reveal.onclick = () => attempt(() => api.revealItem(item.id, index)); row.append(reveal);
    }
    list.append(row);
  }
  return list;
}
function render(value) {
  if (!value) return;
  if (dirty && state?.id === value.id) { state.boards = value.boards; state.item.boardIds = value.item.boardIds; renderPinboards(); return; }
  state = value; dirty = false;
  const item = value.item, editing = value.mode !== 'view';
  $('#previewTitle').textContent = item.renamed ? item.title : labels[item.type];
  $('#previewMeta').textContent = item.type === 'image' ? `${item.size?.width || '?'} × ${item.size?.height || '?'}`
    : item.type === 'file' ? `${item.files.length} 个文件` : `${[...item.body].length} 个字符`;
  $('#editPreview').hidden = editing || ['image', 'file'].includes(item.type);
  $('#savePreview').hidden = !editing; $('#copyPreview').hidden = editing;
  const content = $('#previewContent'); content.replaceChildren(); content.className = `preview-content ${item.type === 'code' ? 'code' : ''}`;
  if (editing) {
    const input = document.createElement(value.mode === 'rename' ? 'input' : 'textarea');
    input.value = value.mode === 'rename' ? item.title : item.body;
    input.setAttribute('aria-label', value.mode === 'rename' ? '项目名称' : '剪贴板内容');
    if (value.mode === 'rename') { input.className = 'rename-input'; input.maxLength = 200; }
    input.oninput = () => markDirty(true); content.append(input); input.focus();
  } else if (item.type === 'image' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(item.body)) {
    content.classList.add('picture'); const image = document.createElement('img'); image.src = item.body; image.alt = item.title;
    image.draggable = true; image.ondragstart = event => { event.preventDefault(); attempt(() => api.startDrag([item.id])); }; content.append(image);
  } else if (item.type === 'file') content.append(renderFiles(item));
  else if (item.html) content.append(richPreview(item.html));
  else { const text = document.createElement('pre'); text.textContent = item.body; content.append(text); }
  renderPinboards(); icons();
}
$('#closePreview').onclick = () => attempt(() => api.closePreview());
$('#copyPreview').onclick = () => attempt(async () => { const result = await api.copy(state.id, { paste: false }); if (!result.ok) status(result.error); });
$('#editPreview').onclick = () => attempt(() => api.openPreview(state.id, { mode: 'edit', ids: state.ids }));
$('#savePreview').onclick = () => attempt(async () => {
  const input = $('#previewContent input, #previewContent textarea');
  await api.savePreview(state.mode === 'rename' ? { title: input.value } : { body: input.value });
  markDirty(false); await api.closePreview();
});
$('#pinPreview').onclick = () => { $('#previewPinboards').hidden = !$('#previewPinboards').hidden; };
$('#sharePreview').onclick = () => attempt(() => api.shareItem(state.id));
document.addEventListener('pointerdown', event => { if (!event.target.closest('#previewPinboards, #pinPreview')) $('#previewPinboards').hidden = true; });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (state.mode !== 'view') $('#savePreview').click(); return; }
  if (event.key === 'Escape' || (event.key === ' ' && state.mode === 'view')) { event.preventDefault(); attempt(() => api.closePreview()); return; }
  if (event.target.matches('input, textarea') || state.mode !== 'view') return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); attempt(() => api.navigatePreview(event.key === 'ArrowRight' ? 1 : -1)); }
});
api.onPreviewChanged(render); attempt(async () => render(await api.getPreview())); icons();
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
