/* global lucide */
const $ = selector => document.querySelector(selector);
let library, recording = null, timer;
const retention = [1, 7, 30, 365, 0];
function status(message) { $('#settingsStatus').textContent = message; $('#settingsStatus').hidden = false; clearTimeout(timer); timer = setTimeout(() => { $('#settingsStatus').hidden = true; }, 5000); }
async function attempt(task) { try { return await task(); } catch (error) { status(error.message); return undefined; } }
async function save(changes) {
  try { render(await window.paste.saveSettings(changes)); }
  catch (error) { render(library); throw error; }
}
function render(value) {
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
document.querySelectorAll('[data-shortcut]').forEach(button => { button.onclick = () => {
  if (recording) { recording.button.classList.remove('recording'); recording = null; render(library); }
  recording = { key: button.dataset.shortcut, button }; button.textContent = '按下快捷键'; button.classList.add('recording');
}; });
document.querySelectorAll('[data-clear-shortcut]').forEach(button => { button.onclick = () => attempt(() => save({ [button.dataset.clearShortcut]: '' })); });
document.addEventListener('keydown', event => {
  if (!recording) return;
  event.preventDefault();
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
  if (event.key === 'Escape') { recording.button.classList.remove('recording'); recording = null; render(library); return; }
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return;
  const key = /^Digit[0-9]$/.test(event.code) ? event.code.slice(-1) : /^Key[A-Z]$/.test(event.code) ? event.code.slice(-1) : event.key;
  const accelerator = [event.metaKey ? 'CommandOrControl' : event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key.length === 1 ? key.toUpperCase() : key.replace('Arrow', '')].filter(Boolean).join('+');
  const setting = recording.key; recording.button.classList.remove('recording'); recording = null; attempt(() => save({ [setting]: accelerator }));
});
$('#resetHotkey').onclick = () => attempt(() => save({ hotkey: 'CommandOrControl+Shift+V', stackHotkey: 'CommandOrControl+Shift+C', nextBoardHotkey: 'CommandOrControl+Right', previousBoardHotkey: 'CommandOrControl+Left', quickPasteModifier: 'CommandOrControl', plainTextModifier: 'Shift' }));
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
