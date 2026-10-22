/* global lucide */
const $ = selector => document.querySelector(selector);
let library, recording = null, timer, exportSelecting = false, exportState = { running: false, revision: -1 };
let importSelecting = false, importState = { phase: 'idle', revision: -1 };
let excludedKey = '', excludedEpoch = 0, choosingApplications = false;
const excludedRows = new Map(), excludedMetadata = new Map();
const retention = [1, 7, 30, 365, 0];
function status(message) { $('#settingsStatus').textContent = message; $('#settingsStatus').hidden = false; clearTimeout(timer); timer = setTimeout(() => { $('#settingsStatus').hidden = true; }, 5000); }
function clearStatus() { clearTimeout(timer); $('#settingsStatus').hidden = true; }
async function attempt(task) { try { return await task(); } catch (error) { status(error.message); return undefined; } }
async function save(changes) {
  try { const value = await window.paste.saveSettings(changes); render(value); if (value.settingsWarning) status(value.settingsWarning); else clearStatus(); }
  catch (error) { render(library); throw error; }
}
function render(value) {
  if (library && value.revision < library.revision) return;
  library = value;
  document.querySelectorAll('[data-setting]').forEach(input => {
    if (input.type === 'checkbox') input.checked = !!value.settings[input.dataset.setting];
    else input.value = value.settings[input.dataset.setting];
  });
  document.querySelectorAll('[name=pasteTarget]').forEach(input => { input.checked = input.value === value.settings.pasteTarget; });
  $('#retention').value = retention.indexOf(value.settings.retentionDays);
  document.querySelectorAll('[data-shortcut]').forEach(button => {
    if (recording?.button === button) return;
    button.textContent = value.settings[button.dataset.shortcut].replace(/CommandOrControl/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥').replace(/Control/g, '⌃').replace(/Right/g, '→').replace(/Left/g, '←').replace(/\+/g, '') || '未设置';
  });
  renderExcludedApplications(value.settings.excludedApps);
  $('#itemCount').textContent = value.items.length; $('#boardCount').textContent = value.boards.length;
  lucide.createIcons();
}
function updateExcludedApplication(id, value) {
  const row = excludedRows.get(id); if (!row) return;
  const name = value?.name || id; row.name.textContent = name; row.name.title = `${name}\n${id}`;
  row.note.textContent = value && !value.available ? '未安装或无法定位' : ''; row.note.hidden = !row.note.textContent;
  row.remove.setAttribute('aria-label', `移除 ${name}`);
  row.icon.replaceChildren();
  if (value?.icon) {
    const image = document.createElement('img'); image.alt = ''; image.src = value.icon; image.onerror = () => { image.remove(); row.icon.innerHTML = '<i data-lucide="app-window"></i>'; lucide.createIcons(); }; row.icon.append(image);
  } else { row.icon.innerHTML = '<i data-lucide="app-window"></i>'; }
}
function renderExcludedApplications(ids) {
  const key = JSON.stringify(ids); if (key === excludedKey) return; excludedKey = key; const epoch = ++excludedEpoch;
  for (const id of excludedMetadata.keys()) if (!ids.includes(id)) excludedMetadata.delete(id);
  excludedRows.clear(); $('#excludedApps').replaceChildren();
  for (const id of ids) {
    const li = document.createElement('li'), icon = document.createElement('span'), label = document.createElement('span'), name = document.createElement('span'), note = document.createElement('small'), remove = document.createElement('button');
    li.dataset.bundleId = id; icon.className = 'excluded-icon'; label.className = 'excluded-label'; name.className = 'excluded-name';
    remove.className = 'icon-button'; remove.title = '移除'; remove.innerHTML = '<i data-lucide="minus"></i>';
    remove.onclick = () => attempt(async () => { remove.disabled = true; try { render(await window.paste.changeExcludedApplication(id, true)); clearStatus(); } finally { remove.disabled = false; } });
    label.append(name, note); li.append(icon, label, remove); $('#excludedApps').append(li); excludedRows.set(id, { name, note, icon, remove }); updateExcludedApplication(id, excludedMetadata.get(id));
  }
  if (!ids.length) { const empty = document.createElement('li'); empty.className = 'excluded-empty'; empty.textContent = '没有项目'; $('#excludedApps').append(empty); }
  (async () => {
    for (let offset = 0; offset < ids.length; offset += 32) {
      const values = await window.paste.getExcludedApplications(ids.slice(offset, offset + 32)); if (epoch !== excludedEpoch) return;
      for (const value of values) { excludedMetadata.set(value.bundleId, value); updateExcludedApplication(value.bundleId, value); } lucide.createIcons();
    }
  })().catch(error => { if (epoch === excludedEpoch) status(error.message); });
}
document.querySelectorAll('[data-page]').forEach(button => { button.onclick = () => {
  document.querySelectorAll('[data-page]').forEach(tab => tab.classList.toggle('active', tab === button));
  document.querySelectorAll('[data-section]').forEach(section => { section.hidden = section.dataset.section !== button.dataset.page; });
  $('#pageTitle').textContent = button.textContent;
}; });
document.querySelectorAll('[data-setting]').forEach(input => { input.onchange = () => attempt(() => save({ [input.dataset.setting]: input.type === 'checkbox' ? input.checked : input.value })); });
document.querySelectorAll('[name=pasteTarget]').forEach(input => { input.onchange = () => attempt(() => save({ pasteTarget: input.value })); });
$('#retention').onchange = event => attempt(() => save({ retentionDays: retention[Number(event.target.value)] }));
$('#excludeForm').onsubmit = event => { event.preventDefault(); attempt(async () => { render(await window.paste.changeExcludedApplication($('#excludeId').value.trim())); clearStatus(); $('#excludeId').value = ''; }); };
$('#chooseExcludedApps').onclick = () => attempt(async () => {
  if (choosingApplications) return; choosingApplications = true; $('#chooseExcludedApps').disabled = true;
  try { const value = await window.paste.chooseExcludedApplications(); if (value) { excludedKey = ''; render(library && value.revision < library.revision ? library : value); clearStatus(); } }
  finally { choosingApplications = false; $('#chooseExcludedApps').disabled = false; }
});
function stopRecording() { if (recording) { recording.button.classList.remove('recording'); recording = null; } }
document.querySelectorAll('[data-shortcut]').forEach(button => { button.onclick = () => {
  if (!library) return;
  stopRecording(); render(library);
  recording = { key: button.dataset.shortcut, button }; button.textContent = '按下快捷键'; button.classList.add('recording');
}; });
document.querySelectorAll('[data-clear-shortcut]').forEach(button => { button.onclick = () => { if (!library) return; stopRecording(); render(library); attempt(() => save({ [button.dataset.clearShortcut]: '' })); }; });
document.addEventListener('keydown', event => {
  if (!recording) return;
  event.preventDefault();
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
  if (event.key === 'Escape') { stopRecording(); render(library); return; }
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return;
  const key = /^Digit[0-9]$/.test(event.code) ? event.code.slice(-1) : /^Key[A-Z]$/.test(event.code) ? event.code.slice(-1) : event.key;
  const accelerator = [event.metaKey ? 'CommandOrControl' : event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key.length === 1 ? key.toUpperCase() : key.replace('Arrow', '')].filter(Boolean).join('+');
  const setting = recording.key; stopRecording(); attempt(() => save({ [setting]: accelerator }));
});
$('#resetHotkey').onclick = () => { if (!library) return; stopRecording(); render(library); attempt(() => save({ hotkey: 'CommandOrControl+Shift+V', stackHotkey: 'CommandOrControl+Shift+C', nextBoardHotkey: 'CommandOrControl+Right', previousBoardHotkey: 'CommandOrControl+Left', quickPasteModifier: 'CommandOrControl', plainTextModifier: 'Shift' })); };
$('#openPermission').onclick = () => attempt(() => window.paste.openPermission());
function renderExport(value) {
  if (value.revision < exportState.revision) return;
  exportState = value; renderDataActions();
  $('#cancelExport').hidden = !value.running; $('#cancelExport').disabled = value.canceling;
  $('#exportProgress').hidden = !value.running;
  $('#exportProgress').textContent = value.canceling ? '正在取消导出…' : `正在导出 ${value.itemsDone || 0}/${value.total || 0}`;
}
$('#exportData').onclick = () => attempt(async () => {
  exportSelecting = true; renderExport(exportState);
  try { const result = await window.paste.exportLibrary(); if (result) status(result.canceled ? '导出已取消' : result.warning || '备份已导出'); }
  finally { exportSelecting = false; renderExport(exportState); }
});
$('#cancelExport').onclick = () => attempt(async () => { await window.paste.cancelExport(); renderExport(await window.paste.getExportState()); });
window.paste.onExportChanged(renderExport);
function renderDataActions() {
  const importing = importSelecting || importState.phase !== 'idle', exporting = exportSelecting || exportState.running;
  $('#exportData').disabled = exporting || importing; $('#importData').disabled = exporting || importing;
  $('#clearHistory').disabled = exporting || importing;
}
function renderImport(value) {
  if (value.revision < importState.revision) return;
  const newPreview = value.token && value.token !== importState.token;
  importState = value; renderDataActions();
  if (newPreview) { $('[name=importMode][value=merge]').checked = true; $('#restoreSettings').checked = false; $('#confirmReplace').checked = false; }
  const busy = ['preparing', 'applying'].includes(value.phase);
  $('#cancelImport').hidden = value.phase === 'idle'; $('#cancelImport').disabled = !!value.canceling;
  $('#importProgress').hidden = !busy;
  $('#importProgress').textContent = value.canceling ? '正在取消恢复…' : value.phase === 'applying' ? '正在保留当前库并恢复备份…' : `正在校验备份：${value.done || 0} 项`;
  $('#importPreview').hidden = value.phase !== 'ready'; $('#revealImportBackup').hidden = !value.hasCheckpoint;
  if (value.summary) { const s = value.summary; $('#importSummary').textContent = `${s.items} 项 · ${s.boards} 个 Pinboard；合并新增 ${s.added} 项，重复 ${s.duplicates} 项；替换将移出当前 ${s.replaced} 项。${s.repairedIds ? ` 已修复 ${s.repairedIds} 个标识。` : ''}`; }
  renderImportChoice();
}
function renderImportChoice() {
  const replace = $('[name=importMode]:checked').value === 'replace';
  $('#replaceConfirmation').hidden = !replace; $('#applyImport').disabled = importState.phase !== 'ready' || (replace && !$('#confirmReplace').checked);
  $('#applyImport').lastChild.textContent = replace ? '替换并恢复' : '合并备份';
}
document.querySelectorAll('[name=importMode], #confirmReplace').forEach(input => { input.onchange = renderImportChoice; });
$('#importData').onclick = () => attempt(async () => {
  importSelecting = true; renderDataActions();
  try { const value = await window.paste.prepareImport(); if (value?.canceled) status('恢复已取消'); else if (value) renderImport(value); }
  finally { importSelecting = false; renderDataActions(); }
});
$('#applyImport').onclick = () => attempt(async () => {
  const result = await window.paste.applyImport(importState.token, { mode: $('[name=importMode]:checked').value, restoreSettings: $('#restoreSettings').checked });
  status(result.canceled ? '恢复已取消' : result.warning || '备份已恢复，恢复前备份已保留');
});
$('#cancelImport').onclick = () => attempt(async () => renderImport(await window.paste.cancelImport()));
$('#revealImportBackup').onclick = () => attempt(() => window.paste.revealImportBackup());
window.paste.onImportChanged(renderImport);
$('#clearHistory').onclick = () => attempt(async () => render(await window.paste.clearHistory()));
window.paste.onChanged(render);
attempt(async () => {
  render(await window.paste.getLibrary());
  renderExport(await window.paste.getExportState());
  renderImport(await window.paste.getImportState());
  const permission = await window.paste.getPermission();
  $('#permissionState span').textContent = permission.accessibility ? '辅助功能已授权' : '自动粘贴需要辅助功能权限';
});
lucide.createIcons();
