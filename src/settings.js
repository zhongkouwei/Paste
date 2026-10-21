/* global lucide */
const $ = selector => document.querySelector(selector);
let library, recording = false, timer;
const retention = [1, 7, 30, 365, 0];
function status(message) { $('#settingsStatus').textContent = message; $('#settingsStatus').hidden = false; clearTimeout(timer); timer = setTimeout(() => { $('#settingsStatus').hidden = true; }, 5000); }
async function attempt(task) { try { return await task(); } catch (error) { status(error.message); return undefined; } }
async function save(changes) { const value = await window.paste.saveSettings(changes); render(value); }
function render(value) {
  library = value;
  document.querySelectorAll('[data-setting]').forEach(input => {
    if (input.type === 'checkbox') input.checked = !!value.settings[input.dataset.setting];
    else input.value = value.settings[input.dataset.setting];
  });
  document.querySelectorAll('[name=pasteTarget]').forEach(input => { input.checked = input.value === value.settings.pasteTarget; });
  $('#retention').value = retention.indexOf(value.settings.retentionDays);
  $('#hotkey').textContent = value.settings.hotkey.replace(/CommandOrControl/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥').replace(/Control/g, '⌃').replace(/\+/g, '');
  $('#excludedApps').replaceChildren();
  for (const id of value.settings.excludedApps) {
    const li = document.createElement('li'), text = document.createElement('span'), remove = document.createElement('button');
    text.textContent = id; remove.className = 'icon-button'; remove.title = '移除'; remove.setAttribute('aria-label', `移除 ${id}`); remove.innerHTML = '<i data-lucide="minus"></i>';
    remove.onclick = () => attempt(() => save({ excludedApps: library.settings.excludedApps.filter(entry => entry !== id) }));
    li.append(text, remove); $('#excludedApps').append(li);
  }
  $('#itemCount').textContent = value.items.length; $('#boardCount').textContent = value.boards.length;
  lucide.createIcons();
}
document.querySelectorAll('[data-page]').forEach(button => { button.onclick = () => {
  document.querySelectorAll('[data-page]').forEach(tab => tab.classList.toggle('active', tab === button));
  document.querySelectorAll('[data-section]').forEach(section => { section.hidden = section.dataset.section !== button.dataset.page; });
  $('#pageTitle').textContent = button.textContent;
}; });
document.querySelectorAll('[data-setting]').forEach(input => { input.onchange = () => attempt(() => save({ [input.dataset.setting]: input.type === 'checkbox' ? input.checked : input.value })); });
document.querySelectorAll('[name=pasteTarget]').forEach(input => { input.onchange = () => attempt(() => save({ pasteTarget: input.value })); });
$('#retention').onchange = event => attempt(() => save({ retentionDays: retention[Number(event.target.value)] }));
$('#excludeForm').onsubmit = event => { event.preventDefault(); attempt(async () => { await save({ excludedApps: [...library.settings.excludedApps, $('#excludeId').value.trim()] }); $('#excludeId').value = ''; }); };
$('#hotkey').onclick = () => { recording = true; $('#hotkey').textContent = '按下快捷键'; $('#hotkey').classList.add('recording'); };
document.addEventListener('keydown', event => {
  if (!recording) return;
  event.preventDefault();
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
  if (event.key === 'Escape') { recording = false; $('#hotkey').classList.remove('recording'); render(library); return; }
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return;
  const accelerator = [event.metaKey ? 'CommandOrControl' : event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.key.length === 1 ? event.key.toUpperCase() : event.key].filter(Boolean).join('+');
  recording = false; $('#hotkey').classList.remove('recording'); attempt(() => save({ hotkey: accelerator }));
});
$('#resetHotkey').onclick = () => attempt(() => save({ hotkey: 'CommandOrControl+Shift+V' }));
$('#openPermission').onclick = () => attempt(() => window.paste.openPermission());
$('#exportData').onclick = () => attempt(async () => { if (await window.paste.exportLibrary()) status('备份已导出'); });
$('#clearHistory').onclick = () => attempt(async () => render(await window.paste.clearHistory()));
window.paste.onChanged(render);
attempt(async () => {
  render(await window.paste.getLibrary());
  const permission = await window.paste.getPermission();
  $('#permissionState span').textContent = permission.accessibility ? '辅助功能已授权' : '自动粘贴需要辅助功能权限';
});
lucide.createIcons();
