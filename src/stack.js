const api = window.paste;
const $ = selector => document.querySelector(selector);
let state, visible = 100, localError = '';
function icon(name) { const element = document.createElement('i'); element.dataset.lucide = name; return element; }
async function attempt(action) {
  try { const result = await action(); if (result?.ok === false) localError = result.error; else localError = ''; }
  catch (error) { localError = error.message; }
  render();
}
function render() {
  if (!state) return;
  $('#count').textContent = state.entries.length;
  $('#next').disabled = !state.entries.some(entry => !entry.pending);
  $('#reverse').disabled = state.entries.length < 2;
  $('#reverse').setAttribute('aria-pressed', String(state.direction === 'newest'));
  $('#mode').textContent = state.capture?.resuming ? '正在恢复记录' : (state.capture?.paused ?? state.paused) ? '记录已暂停' : state.copyOnly ? '仅复制模式' : state.input.keyboard ? (state.direction === 'oldest' ? '按复制顺序' : '按倒序') : '顺序粘贴未启用';
  const permissions = !state.input.keyboard && !state.copyOnly;
  $('#permission').hidden = !permissions; $('#retry').hidden = !permissions;
  const inputError = state.input.error === 'accessibility-required' ? '需要辅助功能权限才能顺序粘贴。' : state.input.error === 'keyboard-paused' ? '系统已暂停顺序粘贴，请重新检查权限。' : state.input.error && state.input.error !== 'simulation' ? '顺序粘贴已暂停，请重新检查权限。' : '';
  $('#error').textContent = localError || state.capture?.error || state.deliveryError || state.problem || inputError;
  $('#error').hidden = !$('#error').textContent;
  $('#empty').hidden = !!state.entries.length;
  const fragment = document.createDocumentFragment();
  for (const [index, entry] of state.entries.slice(0, visible).entries()) {
    const row = document.createElement('li'); row.className = `stack-entry${entry.pending ? ' pending' : ''}`; row.dataset.id = entry.id;
    const number = document.createElement('span'); number.className = 'position'; number.textContent = index + 1;
    const content = document.createElement('div'); content.className = 'content';
    const title = document.createElement('strong'); title.textContent = entry.item?.title || '项目已删除'; title.title = title.textContent;
    const preview = document.createElement('p'); preview.textContent = entry.pending ? '粘贴中' : entry.item?.preview || ({ image: '图片', file: '文件' }[entry.item?.type]) || '';
    content.append(title, preview);
    const remove = document.createElement('button'); remove.className = 'icon-button'; remove.title = '从Stack移除'; remove.setAttribute('aria-label', `移除第${index + 1}项`); remove.append(icon('x'));
    remove.onclick = () => attempt(() => api.removeFromStack(entry.id)); row.append(number, content, remove); fragment.append(row);
  }
  const scroll = $('#entries').scrollTop; $('#entries').replaceChildren(fragment); $('#entries').scrollTop = scroll;
  window.lucide.createIcons();
}
$('#entries').onscroll = () => {
  if ($('#entries').scrollTop + $('#entries').clientHeight >= $('#entries').scrollHeight - 100 && visible < state.entries.length) { visible += 100; render(); }
};
$('#next').onclick = () => attempt(() => api.nextInStack());
$('#reverse').onclick = () => attempt(() => api.reverseStack());
$('#stop').onclick = () => attempt(() => api.stopStack());
$('#retry').onclick = () => attempt(() => api.retryStack());
$('#permission').onclick = () => attempt(() => api.openPermission());
api.onStackChanged(value => { state = value; localError = ''; render(); });
api.getStack().then(value => { state = value; render(); document.body.dataset.stackReady = 'true'; }).catch(error => { $('#error').textContent = error.message; $('#error').hidden = false; });
