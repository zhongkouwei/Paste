/* global lucide, PasteEditor */
const $ = selector => document.querySelector(selector);
const api = window.paste;
const labels = { text: '文本', code: '文本', link: '链接', image: '图片', color: '颜色', file: '文件' };
let state, dirty = false, statusTimer, richEditor, imageBusy = false, ocrOpen = false, ocrBusy = false, saveBusy = false;
let composing = false;
let pendingCommand;
let nativeRich;
let openBusy = false;
async function openItem(index) {
  if (openBusy || !state || state.mode !== 'view' || dirty || saveBusy || composing || !['link', 'file'].includes(state.item.type)) return;
  openBusy = true;
  const owner = state;
  try {
    const result = await api.openItems([owner.id], index === undefined ? {} : { index });
    if (state?.id === owner.id && state.mode === 'view' && state.item.signature === owner.item.signature && !result.ok && !result.cancelled) status(result.error);
  }
  finally { openBusy = false; }
}
function needsNative(item) { return ['text', 'code', 'link', 'color'].includes(item.type) && !!item.rtf; }
function loadNative(item) {
  if (!needsNative(item)) { nativeRich = null; return; }
  if (nativeRich?.id === item.id && nativeRich.signature === item.signature) return;
  const entry = { id: item.id, signature: item.signature, loading: true }; nativeRich = entry;
  (async () => {
    try {
      let html = item.html;
      if (!html) {
        const result = await api.getRichText(item.id, item.signature);
        if (result.text !== item.body && result.text !== `${item.body}\n`) throw new Error('RTF与正文不一致，原文未修改。');
        html = result.html;
      }
      Object.assign(entry, await PasteEditor.nativeRichHTML(html));
    } catch (error) { entry.reason = error.message; }
    entry.loading = false;
    if (nativeRich === entry && state?.id === entry.id && state.item.signature === entry.signature && state.mode !== 'rename') render(state, true);
  })();
}
function icons() { lucide.createIcons(); }
function status(message) {
  $('#previewStatus').textContent = message; $('#previewStatus').hidden = false;
  clearTimeout(statusTimer); statusTimer = setTimeout(() => { $('#previewStatus').hidden = true; }, 6000);
}
async function attempt(action) { try { return await action(); } catch (error) { status(error.message); return undefined; } }
function markDirty(value) { dirty = value; api.markPreviewDirty(value); }
function previewCommand(mode) {
  if (!['edit', 'rename', 'open'].includes(mode)) return;
  if (!state) { pendingCommand = mode; return; }
  if (state.mode !== 'view' || saveBusy || composing) return;
  if (mode === 'open') attempt(() => openItem());
  else if (mode === 'edit') { if (!$('#editPreview').hidden && !$('#editPreview').disabled) $('#editPreview').click(); }
  else attempt(() => api.openPreview(state.id, { mode, ids: state.ids }));
}

const tableCommands = [
  ['insertTable', '插入表格', 'table-2'], ['addRowBefore', '在上方插入行', 'rows-3'], ['addRowAfter', '在下方插入行', 'rows-3'],
  ['addColumnBefore', '在左侧插入列', 'columns-3'], ['addColumnAfter', '在右侧插入列', 'columns-3'],
  ['mergeCells', '合并单元格', 'table-cells-merge'], ['splitCell', '拆分单元格', 'table-cells-split'],
  ['toggleHeaderRow', '切换标题行', 'panel-top'], ['deleteRow', '删除行', 'list-minus'],
  ['deleteColumn', '删除列', 'list-minus'], ['deleteTable', '删除表格', 'trash-2']
];
function closeTableMenu() { $('#tableMenu').hidden = true; $('#tableToggle').setAttribute('aria-expanded', 'false'); }
function updateTools() {
  if (state?.imageEdit) {
    for (const button of document.querySelectorAll('#imageTools [data-image]')) {
      const action = button.dataset.image;
      button.disabled = imageBusy || (action === 'undo' && !state.imageEdit.canUndo)
        || (action === 'redo' && !state.imageEdit.canRedo) || (action === 'restore' && !state.imageEdit.turns && !state.imageEdit.backgroundRemoved)
        || (action === 'background' && !state.imageEdit.canRemoveBackground);
      if (action === 'background') {
        button.title = state.imageEdit.backgroundRemoved ? '恢复背景' : '移除背景';
        button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(state.imageEdit.backgroundRemoved));
      }
    }
    $('#savePreview').disabled = imageBusy;
  }
  if (!richEditor) return;
  for (const button of document.querySelectorAll('#editTools [data-command], #tableMenu [data-command]')) {
    const command = button.dataset.command;
    button.disabled = !richEditor.can(command);
    if (['bold', 'italic', 'underline', 'strike'].includes(command)) button.setAttribute('aria-pressed', String(richEditor.active(command)));
  }
}
function renderOCR() {
  const enabled = state?.item.type === 'image' && state.mode === 'view' && state.capabilities?.textRecognition;
  $('#recognizePreview').hidden = !enabled; $('#recognizePreview').setAttribute('aria-pressed', String(!!enabled && ocrOpen));
  $('#ocrPanel').hidden = !enabled || !ocrOpen;
  const ocr = state?.item.ocr, text = ocr && ocr.signature === state?.item.signature ? ocr.text : '';
  if ($('#ocrText').value !== text) $('#ocrText').value = text;
  $('#copyOCR').disabled = !text || ocrBusy; $('#retryOCR').disabled = ocrBusy;
  const message = ocrBusy ? '正在识别…' : ocr?.status === 'error' ? ocr.error || '文字识别失败' : !text ? '未识别到文字' : '';
  $('#ocrState').textContent = message; $('#ocrState').hidden = !message;
}
async function recognize(retry = false) {
  if (ocrBusy) return;
  const id = state.id; ocrBusy = true; renderOCR();
  try {
    const result = await api.recognizeItem(id, retry);
    if (state.id === id) state.item.ocr = result;
  } finally { ocrBusy = false; renderOCR(); }
}
function renderImage() {
  const content = $('#previewContent'); content.classList.add('picture');
  let image = content.querySelector('img');
  if (!image) { image = document.createElement('img'); content.replaceChildren(image); }
  image.src = state.item.body; image.alt = state.item.title;
  image.draggable = state.mode === 'view';
  image.ondragstart = event => { event.preventDefault(); if (state.mode === 'view') attempt(() => api.startDrag([state.id])); };
  $('#previewMeta').textContent = `${state.item.size?.width || '?'} × ${state.item.size?.height || '?'}`;
  updateTools();
}

function richPreview(html) {
  const iframe = document.createElement('iframe'); iframe.title = '富文本预览'; iframe.setAttribute('sandbox', ''); iframe.referrerPolicy = 'no-referrer';
  const sanitized = PasteEditor.sanitize(html);
  const parsed = new DOMParser().parseFromString(sanitized, 'text/html');
  for (const link of parsed.querySelectorAll('[href]')) link.removeAttribute('href');
  iframe.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">'
    + '<style>body{margin:0;padding:16px;color:#222;background:#fff;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px;min-width:25px}p{margin:0 0 8px}</style>' + parsed.body.innerHTML;
  return iframe;
}

function renderPinboards() {
  const panel = $('#previewPinboards'); panel.replaceChildren();
  if (!state.boards.length) { const empty = document.createElement('span'); empty.textContent = '暂无 Pinboard'; panel.append(empty); }
  const boards = [...state.boards];
  if (state.draft) for (const id of state.item.boardIds) if (!boards.some(board => board.id === id)) boards.push({ id, name: '已删除的 Pinboard', color: '#77808a' });
  for (const board of boards) {
    const label = document.createElement('label'), input = document.createElement('input'), dot = document.createElement('b'), name = document.createElement('span');
    input.type = 'checkbox'; input.checked = state.item.boardIds.includes(board.id);
    dot.className = 'board-dot'; if (/^#[a-f0-9]{6}$/i.test(board.color)) dot.style.setProperty('--board-color', board.color);
    name.textContent = board.name;
    input.onchange = () => attempt(() => state.draft ? api.pinDraft(board.id, !input.checked) : api.pinItems([state.item.id], board.id, !input.checked));
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
      const actions = document.createElement('span'); actions.className = 'file-actions';
      if (state.mode === 'view') {
        const open = document.createElement('button'); open.className = 'icon-button'; open.title = '打开文件'; open.setAttribute('aria-label', '打开文件'); open.innerHTML = '<i data-lucide="external-link"></i>';
        open.onclick = () => attempt(() => openItem(index)); actions.append(open);
      }
      const reveal = document.createElement('button'); reveal.className = 'icon-button'; reveal.title = '在 Finder 中显示'; reveal.setAttribute('aria-label', '在 Finder 中显示'); reveal.innerHTML = '<i data-lucide="folder-search"></i>';
      reveal.onclick = () => attempt(() => api.revealItem(item.id, index)); actions.append(reveal); row.append(actions);
    }
    list.append(row);
  }
  return list;
}
function render(value, force = false) {
  if (!value) return;
  if (state?.id !== value.id || value.mode !== 'view') ocrOpen = false;
  if (!force && state?.id === value.id && state.mode === value.mode && (dirty || value.mode !== 'view')) {
    state.boards = value.boards; state.item.boardIds = value.item.boardIds;
    if (value.imageEdit) { state.imageEdit = value.imageEdit; state.item = value.item; markDirty(value.imageEdit.changed || imageBusy || value.imageEdit.busy); renderImage(); }
    renderPinboards(); renderOCR(); return;
  }
  state = value; dirty = false;
  closeTableMenu();
  richEditor?.destroy(); richEditor = null;
  const item = value.item, editing = value.mode !== 'view';
  loadNative(item);
  const native = needsNative(item) ? nativeRich : null, html = native?.html || item.html;
  const reason = native?.loading ? '正在读取富文本…' : native?.reason || (item.type === 'text' ? PasteEditor.inspect(html).reason : '')
    || (item.rtf && html && new DOMParser().parseFromString(html, 'text/html').querySelector('img') ? '此RTF的内嵌图像暂不支持编辑，原文未修改。' : '');
  const supported = !reason;
  $('#previewTitle').textContent = value.draft ? '新建文本' : item.renamed ? item.title : labels[item.type];
  $('#sharePreview').hidden = !!value.draft;
  $('#openPreviewItem').hidden = editing || !['link', 'file'].includes(item.type);
  $('#previewMeta').textContent = item.type === 'image' ? `${item.size?.width || '?'} × ${item.size?.height || '?'}`
    : item.type === 'file' ? `${item.files.length} 个文件` : `${[...item.body].length} 个字符`;
  $('#editPreview').hidden = editing || item.type === 'file';
  $('#editPreview').disabled = !supported;
  $('#editPreview').title = supported ? '编辑' : '此富文本暂不支持无损编辑';
  $('#savePreview').hidden = !editing; $('#copyPreview').hidden = editing;
  $('#savePreview').disabled = false;
  $('#editTools').hidden = !editing || value.mode === 'rename' || (item.type !== 'text' && !native) || !supported;
  $('#imageTools').hidden = !value.imageEdit;
  const content = $('#previewContent'); content.replaceChildren(); content.className = `preview-content ${item.type === 'code' ? 'code' : ''}`;
  if (value.imageEdit) renderImage();
  else if (editing && value.mode !== 'rename' && !supported) {
    if (html) content.append(richPreview(html));
    else { const text = document.createElement('pre'); text.textContent = item.body; content.append(text); }
    $('#savePreview').hidden = true; $('#copyPreview').hidden = false;
    status(reason);
  }
  else if (editing && value.mode !== 'rename' && (item.type === 'text' || native)) {
    content.classList.add('rich-document');
    let wasEmpty = !item.body.trim();
    richEditor = PasteEditor.create(content, { html, text: item.body, allowImages: !item.rtf, onUnsupported: status,
      onUpdate: changed => {
        markDirty(changed);
        if (richEditor) {
          const body = richEditor.content().body, empty = !body.trim();
          $('#previewMeta').textContent = `${[...body].length} 个字符`;
          if (value.draft && wasEmpty && !empty) { clearTimeout(statusTimer); $('#previewStatus').hidden = true; }
          wasEmpty = empty;
        }
      }, onSelection: updateTools });
    if (native && !item.html) {
      const originalContent = richEditor.content, initial = originalContent().body;
      if (item.body === `${initial}\n`) richEditor.content = () => { const value = originalContent(); return { ...value, body: `${value.body}\n` }; };
      else if (initial !== item.body) {
        richEditor.destroy(); richEditor = null; content.replaceChildren(richPreview(html));
        $('#editTools').hidden = true; $('#savePreview').hidden = true; $('#copyPreview').hidden = false;
        status('RTF结构与正文不一致，原文未修改。');
      }
    }
    updateTools();
  } else if (editing) {
    const input = document.createElement(value.mode === 'rename' ? 'input' : 'textarea');
    input.value = value.mode === 'rename' ? item.title : item.body;
    input.setAttribute('aria-label', value.mode === 'rename' ? '项目名称' : '剪贴板内容');
    if (value.mode === 'rename') { input.className = 'rename-input'; input.maxLength = 200; }
    input.oninput = () => { markDirty(true); if (value.mode !== 'rename') $('#previewMeta').textContent = `${[...input.value].length} 个字符`; }; content.append(input);
  } else if (item.type === 'image' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(item.body)) {
    renderImage();
  } else if (item.type === 'file') content.append(renderFiles(item));
  else if (html) content.append(richPreview(html));
  else { const text = document.createElement('pre'); text.textContent = item.body; content.append(text); }
  renderPinboards(); renderOCR(); icons(); $('.preview-shell').inert = saveBusy; document.body.dataset.previewReady = 'true';
  if (reason && value.mode !== 'rename') status(reason);
  else if ($('#previewStatus').textContent === '正在读取富文本…') { clearTimeout(statusTimer); $('#previewStatus').hidden = true; }
  if (!saveBusy) {
    if (richEditor) richEditor.focus();
    else {
      const input = content.querySelector('input, textarea'); input?.focus();
      if (value.mode === 'rename') input?.select();
    }
  }
  if (pendingCommand) { const command = pendingCommand; pendingCommand = null; previewCommand(command); }
}
$('#closePreview').onclick = () => attempt(() => api.closePreview());
$('#copyPreview').onclick = () => attempt(async () => { const result = await api.copy(state.id, { paste: false }); if (!result.ok) status(result.error); });
$('#editPreview').onclick = () => attempt(() => api.openPreview(state.id, { mode: 'edit', ids: state.ids }));
$('#savePreview').onclick = () => attempt(async () => {
  if (saveBusy) return;
  saveBusy = true; $('.preview-shell').inert = true; $('#savePreview').setAttribute('aria-busy', 'true');
  try {
    const input = $('#previewContent input, #previewContent textarea');
    if (dirty || state.draft) await api.savePreview(state.imageEdit ? {} : state.mode === 'rename' ? { title: input.value } : richEditor ? richEditor.content() : { body: input.value });
    markDirty(false); await api.closePreview();
  } finally { saveBusy = false; $('.preview-shell').inert = false; $('#savePreview').setAttribute('aria-busy', 'false'); }
});
for (const [command, name, icon] of tableCommands) {
  const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem'; button.dataset.command = command;
  button.onpointermove = () => { if (!button.disabled) button.focus({ preventScroll: true }); };
  const symbol = document.createElement('i'); symbol.dataset.lucide = icon;
  const label = document.createElement('span'); label.textContent = name; button.append(symbol, label); $('#tableMenu').append(button);
}
for (const button of document.querySelectorAll('#editTools [data-command], #tableMenu [data-command]')) {
  button.onmousedown = event => event.preventDefault();
  button.onclick = () => { closeTableMenu(); richEditor?.command(button.dataset.command); updateTools(); };
}
$('#tableToggle').onmousedown = event => event.preventDefault();
$('#tableToggle').onclick = () => {
  const open = $('#tableMenu').hidden; closeTableMenu();
  if (open && richEditor) { updateTools(); $('#tableMenu').hidden = false; $('#tableToggle').setAttribute('aria-expanded', 'true'); $('#tableMenu button:not(:disabled)')?.focus(); }
};
for (const button of document.querySelectorAll('#imageTools [data-image]')) button.onclick = () => attempt(async () => {
  const wasDirty = dirty;
  imageBusy = true; markDirty(true); updateTools(); $('#previewContent').setAttribute('aria-busy', 'true');
  try { render(await api.editImage(button.dataset.image)); }
  catch (error) { markDirty(wasDirty); throw error; }
  finally { imageBusy = false; if (state.imageEdit) markDirty(state.imageEdit.changed); updateTools(); $('#previewContent').setAttribute('aria-busy', 'false'); }
});
$('#recognizePreview').onclick = () => attempt(async () => { ocrOpen = !ocrOpen; renderOCR(); if (ocrOpen) await recognize(); });
$('#retryOCR').onclick = () => attempt(() => recognize(true));
$('#copyOCR').onclick = () => attempt(async () => { await api.copyImageText(state.id); status('已复制文字'); });
$('#pinPreview').onclick = () => { $('#previewPinboards').hidden = !$('#previewPinboards').hidden; };
$('#sharePreview').onclick = () => attempt(() => api.shareItem(state.id));
$('#openPreviewItem').onclick = () => attempt(() => openItem());
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('#previewPinboards, #pinPreview')) $('#previewPinboards').hidden = true;
  if (!event.target.closest('#tableMenu, #tableToggle')) closeTableMenu();
});
document.addEventListener('compositionstart', () => { composing = true; });
document.addEventListener('compositionend', () => { composing = false; });
document.addEventListener('keydown', event => {
  if (saveBusy) { event.preventDefault(); return; }
  if (!state) return;
  if (PasteModel.isComposingKey(event, composing)) return;
  if (PasteModel.shortcutMatches(event, 'CommandOrControl+O')) { event.preventDefault(); if (!event.repeat) previewCommand('open'); return; }
  if (PasteModel.shortcutMatches(event, 'CommandOrControl+N')) { event.preventDefault(); if (!event.repeat) attempt(() => api.requestNewText()); return; }
  if (!$('#tableMenu').hidden) {
    const buttons = [...$('#tableMenu').querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); return;
    }
    if (event.key === 'Escape') { event.preventDefault(); closeTableMenu(); richEditor?.focus(); return; }
    if (event.key === 'Tab') { closeTableMenu(); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) buttons[index]?.click(); return; }
    if (!(event.metaKey || event.ctrlKey)) return;
  }
  if (state?.mode === 'view' && PasteModel.shortcutMatches(event, 'CommandOrControl+E')) {
    event.preventDefault(); if (!event.repeat) previewCommand('edit'); return;
  }
  if (state?.mode === 'view' && PasteModel.shortcutMatches(event, 'CommandOrControl+R')) {
    event.preventDefault(); if (!event.repeat) previewCommand('rename'); return;
  }
  if (state?.mode === 'rename' && event.key === 'Enter') {
    event.preventDefault(); if (!event.repeat) $('#savePreview').click(); return;
  }
  if (state?.imageEdit && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault(); const button = $(`#imageTools [data-image="${event.shiftKey ? 'redo' : 'undo'}"]`); if (!button.disabled) button.click(); return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (state.mode !== 'view') $('#savePreview').click(); return; }
  if (event.key === 'Escape' || (event.key === ' ' && state.mode === 'view')) { event.preventDefault(); if (!event.repeat) attempt(() => api.closePreview()); return; }
  if (event.target.matches('input, textarea') || state.mode !== 'view') return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); attempt(() => api.navigatePreview(event.key === 'ArrowRight' ? 1 : -1)); }
});
api.onPreviewChanged(render); api.onPreviewCommand(previewCommand); attempt(async () => render(await api.getPreview())); icons();
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
