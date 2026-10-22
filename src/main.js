const electron = require('electron');
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, ShareMenu, nativeImage, Tray, screen, dialog, shell, nativeTheme, powerMonitor } = electron;
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ClipStore, hash, textSignature } = require('./store');
const { classifyText, sanitizeSettings } = require('./model');
const { ClipboardService, imageSignature } = require('./clipboard');
const { Transfers, fileDetails } = require('./transfers');
const { GlobalHotkeys } = require('./hotkeys');
const { ClipboardMonitor } = require('./monitor');
const { ImageProcessor, ImageDraft } = require('./image-editor');
const { ImportService } = require('./import-service');
const { ImageInspector } = require('./image-inspector');
const { RichTextService, unsupportedRTF } = require('./rich-text');
const { ApplicationCatalog, validApplicationID, captureSource } = require('./applications');
const { PasteTargetSession, PasteDelivery, targetIdentity } = require('./paste-target');
const { StackQueue } = require('./stack-queue');
const { StackInput } = require('./stack-input');
const { SelectionService, selectionIDs } = require('./selection');
const { SelectionComposer } = require('./selection-composer');
const { ClipboardOwnership } = require('./clipboard-ownership');
const { copySource, verifyCopySources } = require('./copy-sources');
const { ImageTextIndex } = require('./image-text');
const { SearchService } = require('./search-service');
const { MediaService, thumbnail } = require('./media');
const { applicationMenuTemplate, previewShortcut, newTextShortcut, pauseShortcut } = require('./app-menu');
const { CapturePause } = require('./capture-pause');
const { PanelSize } = require('./panel-size');
const { DEFAULT_HEIGHT } = require('./panel-layout');
const { ItemOpener } = require('./item-opener');
const { ShortcutRecorder } = require('./shortcut-recorder');
const clip = new ClipboardService({ ...electron, fileBridge: process.platform === 'darwin' ? {
  read: () => native('read-files'), write: (files, options) => nativeInput('write-files', { files, ...options })
} : undefined });

const execute = promisify(execFile);
const TEST_MODE = process.argv.includes('--test-mode');
app.setPath('userData', process.env.PASTE_DATA_DIR ? path.resolve(process.env.PASTE_DATA_DIR) : path.join(app.getPath('appData'), 'Paste Easy'));
let mainWindow, settingsWindow, previewWindow, tray, store, transfers, pollTimer;
let previewState = null, previewDirty = false, previewOpening = false, activeShare;
let richTextService, previewRichJob, previewSaveJob;
let selectionService, selectionComposer;
let capturePause, panelSize;
let hotkeys, monitor, imageProcessor, imageDraft, imageText, capabilities = {}, processingClosing = false, processingStopped = false;
let searchService, mediaService, importService, imageInspector, applicationCatalog, exportDialogOpen = false, importDialogOpen = false, applicationDialogOpen = false;
let quitting = false, quitAfterPreview = false, copyQueue = Promise.resolve(), settingsQueue = Promise.resolve();
let copyRequest = 0;
let suppressBlur = false;
let itemOpener, openingItems = 0, openEpoch = 0;
const shortcutRecorder = new ShortcutRecorder({ getWindow: () => settingsWindow, getSettings: () => store.data.settings, save: saveSettings, onError: report });
let lastError = '', stackWindow, stackReady, stackOpening, stackLifecycle = 0, stackPollRequested = false, stackPolling = null;
const stackQueue = new StackQueue();
const helper = path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'native/bin/paste-bridge');
const pasteTargets = new PasteTargetSession({ ownPID: process.pid, read: () => native('frontmost'),
  onError: error => console.error('Could not resolve foreground application', error.message) });
const pasteOwnership = new ClipboardOwnership({ readVersion: async () => (await native('change-count')).count,
  check: lease => nativeInput('check-pasteboard', lease), onError: error => console.error('Clipboard ownership unavailable', error.message) });
const pasteDelivery = new PasteDelivery({ simulate: TEST_MODE, permission: () => native('permission'),
  verify: lease => pasteOwnership.verify(lease),
  activate: ({ pid, bundleId, launchTime }, lease) => nativeInput('paste', { target: { pid, bundleId, launchTime }, lease }),
  dismiss: () => { hidePanel(); closePreview(); }, recover: () => showPanel(),
  onError: error => console.error('Paste delivery failed', error.message) });
const stackInput = new StackInput({ helper, ownPID: process.pid, simulate: TEST_MODE,
  baseline: () => monitor?.version ?? 0,
  inventory: epoch => stackQueue.active && store.data.settings.pasteTarget === 'application' ? stackQueue.inventory(epoch) : { count: 0, busy: false },
  onPaste: ({ target, epoch }) => nextInStack({ target, nativeEpoch: epoch, background: true }),
  onClipboard: (version, reset) => {
    if (!stackQueue.active) return;
    if (reset || store.data.settings.paused) stackQueue.version = version;
    requestStackPoll();
  },
  onState: () => { if (store) emit(); },
  onFailure: error => { stackQueue.cancelPending(); stackInput.reset(); stackQueue.deliveryError = error.message; if (store) emit(); }
});

async function native(command, ...args) {
  if (process.platform !== 'darwin' || !fs.existsSync(helper)) return {};
  const { stdout } = await execute(helper, [command, ...args.map(String)], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}
async function nativeInput(command, data, timeout = 4000, options = {}) {
  if (!fs.existsSync(helper)) throw new Error('缺少原生辅助程序，请先构建应用。');
  const operation = execute(helper, [command], { timeout, maxBuffer: command === 'selection-rich' ? 96 * 1024 * 1024 : command === 'image-ocr' ? 8 * 1024 * 1024 : 2 * 1024 * 1024, signal: options.signal });
  operation.child.stdin.end(JSON.stringify(data));
  try { const { stdout } = await operation; return JSON.parse(stdout); }
  catch (error) {
    try { const result = JSON.parse(error.stdout); if (result.ok === false) return result; } catch {}
    throw error;
  }
}

function snapshot() { return { ...store.snapshot(), capabilities, status: { error: lastError, capture: capturePause?.snapshot(), stackMode: stackQueue.active, stackCount: stackQueue.entries.length } }; }
function stackSnapshot(library = store.snapshot()) {
  const items = new Map(library.items.map(item => [item.id, item]));
  return { ...stackQueue.snapshot(), input: stackInput.snapshot(), paused: store.data.settings.paused,
    capture: capturePause?.snapshot(), copyOnly: store.data.settings.pasteTarget !== 'application', entries: stackQueue.snapshot().entries.map(entry => ({ ...entry, item: items.get(entry.itemId) })) };
}
function emit() {
  const captureMenu = Menu.getApplicationMenu()?.getMenuItemById('capture-toggle');
  if (captureMenu) captureMenu.label = capturePause?.snapshot().paused ? '继续记录' : '暂停记录';
  if (tray && !tray.isDestroyed()) tray.setToolTip(capturePause?.snapshot().resuming ? 'Paste Easy · 正在恢复记录' : capturePause?.isPaused() ? 'Paste Easy · 记录已暂停' : 'Paste Easy');
  stackQueue.retain(id => !!store.getMetadata(id));
  const library = snapshot();
  stackInput.sync();
  if (stackWindow && !stackWindow.isDestroyed()) stackWindow.webContents.send('stack:changed', stackSnapshot(library));
  for (const window of [mainWindow, settingsWindow]) if (window && !window.isDestroyed()) window.webContents.send('library:changed', library);
  if (previewWindow && !previewWindow.isDestroyed()) {
    if (previewState?.draft || store.get(previewState?.id)) previewWindow.webContents.send('preview:changed', getPreviewState());
    else closePreview();
  }
}
function report(error) { lastError = error.message; console.error(error); emit(); }

function sourceColor(source) {
  const id = source?.bundleId || '';
  if (/terminal|iterm/i.test(id)) return '#0b252d';
  if (/jetbrains|goland|pycharm/i.test(id)) return '#5bd59b';
  if (/chrome|safari|firefox/i.test(id)) return '#587ce8';
  if (/lark|feishu/i.test(id)) return '#4d79ed';
  if (/code|sublime/i.test(id)) return '#b17ad9';
  return '#77808a';
}

async function currentSource() {
  return captureSource(() => native('frontmost'), process.pid);
}

function isIgnored(formats, source) {
  const settings = store.data.settings;
  if ((capturePause?.isPaused() ?? settings.paused) || settings.excludedApps.includes(source?.bundleId)) return true;
  if (settings.ignoreConfidential && formats.some(f => /concealed|password|confidential/i.test(f))) return true;
  return settings.ignoreTransient && formats.some(f => /transient|autogenerated/i.test(f));
}

async function clipboardSnapshot() {
  const value = await clip.read();
  const { formats, text, html, rtf, files, signature } = value;
  if (!formats.length) return null;
  const source = await currentSource();
  if (isIgnored(formats, source)) return null;
  const metadata = { ...(value.clipboardWriteID ? { clipboardWriteID: value.clipboardWriteID } : {}), source: source ? { name: source.name, bundleId: source.bundleId, icon: source.icon, color: sourceColor(source) } : null };
  if (value.image) {
    return { ...metadata, type: 'image', title: '图片', body: '', imageBuffer: value.image, signature, signatureFormat: 'pixels-v1' };
  }
  if (files.length) return { ...metadata, type: 'file', body: files.join('\n'),
    title: decodeURIComponent(files[0].split('/').pop()), preview: files.join('\n'), signature };
  if (!text?.trim() || Buffer.byteLength(text) > 16 * 1024 * 1024) return null;
  return { ...metadata, type: classifyText(text), title: text.split('\n').find(Boolean)?.slice(0, 120) || '文本',
    body: text, html, rtf, preview: text.slice(0, 16000), signature };
}

function capture(item) {
  if (item.imageBuffer) {
    const image = nativeImage.createFromBuffer(item.imageBuffer), size = image.getSize();
    if (image.isEmpty()) throw new Error('剪贴板图片不可用');
    const asset = store.putAsset(item.imageBuffer);
    item = { ...item, body: asset, asset, size, preview: thumbnail(image) };
    delete item.imageBuffer;
  }
  const saved = store.add(item); lastError = ''; if (store.data.settings.sound && !TEST_MODE) shell.beep(); emit(); queueImageText(saved);
  return saved;
}
function imageBytes(item) { return item.asset ? store.readAsset(item.asset) : nativeImage.createFromDataURL(item.body).toPNG(); }
function queueImageText(item) { if (capabilities.textRecognition && item.type === 'image') imageText.enqueue(item.id).catch(error => console.error('Image text recognition:', error.message)); }
async function poll() { await capturePause?.check().catch(report); return monitor.tick(); }
async function finishCaptureBaseline() {
  if (!monitor.needsBaseline || capturePause.isPaused()) return;
  if (monitor.pending) await monitor.pending;
  if (monitor.needsBaseline && !capturePause.isPaused()) await monitor.tick();
}
function requestStackPoll() {
  stackPollRequested = true;
  if (stackPolling) return stackPolling;
  stackPolling = (async () => {
    while (stackPollRequested && stackQueue.active && !quitting) { stackPollRequested = false; await poll(); }
  })().finally(() => { stackPolling = null; });
  return stackPolling;
}
async function showStack() {
  if (!stackWindow || stackWindow.isDestroyed()) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    stackWindow = createWindow('stack.html', { type: 'panel', focusable: false, show: false, frame: false,
      width: 340, height: 430, minWidth: 280, minHeight: 230, x: display.x + display.width - 360, y: display.y + 30,
      alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, minimizable: false, title: 'Paste Stack', backgroundColor: '#f4f4f4' });
    const window = stackWindow;
    stackReady = new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', resolve);
      window.webContents.once('did-fail-load', (_event, code, description) => reject(Error(`Stack窗口加载失败: ${code} ${description}`)));
    });
    window.on('close', event => { if (!quitting) { event.preventDefault(); void stopStack(); } });
    window.on('closed', () => { if (stackWindow === window) { stackWindow = null; stackReady = null; void stopStack(); } });
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  await stackReady;
  if (stackQueue.active && !quitting && !stackWindow?.isDestroyed()) { emit(); stackWindow.showInactive(); }
}
async function activateStack() {
  if (stackQueue.active) { await showStack(); return true; }
  if (stackOpening) return stackOpening;
  const lifecycle = ++stackLifecycle;
  const operation = (async () => {
    const ready = await stackInput.start();
    // Finish any history read from before activation before assigning the new
    // collection session. It must not advance past a copy for the new session.
    if (monitor.pending) await monitor.pending;
    if (lifecycle !== stackLifecycle || quitting) return false;
    stackQueue.start(stackInput.state.version ?? ready.version); emit();
    try { await showStack(); } catch (error) { await stopStack(); throw error; }
    return stackQueue.active;
  })();
  stackOpening = operation;
  try { return await operation; } finally { if (stackOpening === operation) stackOpening = null; }
}
async function stopStack() {
  stackLifecycle++; stackQueue.stop(); stackPollRequested = false;
  if (stackWindow && !stackWindow.isDestroyed()) stackWindow.hide();
  await stackInput.stop(); if (store && !quitting) emit(); return false;
}

function placePanel() {
  const display = screen.getDisplayNearestPoint(pasteTargets.snapshot()?.windowPoint || screen.getCursorScreenPoint());
  panelSize.place(display);
}
async function showPanel(mode) {
  if (!mainWindow || mainWindow.isDestroyed() || quitting) return false;
  if (!await pasteTargets.refresh(mainWindow.isVisible() || !!previewWindow?.isVisible())) return false;
  if (mainWindow.isDestroyed() || quitting) return false;
  placePanel(); mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.show(); mainWindow.moveTop(); mainWindow.focus();
  mainWindow.webContents.send('panel:shown', { target: pasteTargets.snapshot()?.name || '', mode: mode || 'history' });
  return true;
}
function hidePanel() {
  try { panelSize?.cancel(); } catch (error) { console.error('Could not cancel panel resize', error.message); }
  pasteTargets.cancel();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function itemDetail(id) {
  const item = store.get(id);
  if (!item) throw new Error('项目已被删除');
  return { ...item, files: fileDetails(item), body: item.asset ? `data:image/png;base64,${store.readAsset(item.asset).toString('base64')}` : item.body };
}
function getPreviewState() {
  if (!previewState) return null;
  const item = previewState.draft || itemDetail(previewState.id);
  if (imageDraft) { item.body = `data:image/png;base64,${imageDraft.image.buffer.toString('base64')}`; item.size = imageDraft.image.size; }
  return { ...previewState, item, imageEdit: imageDraft?.state(), capabilities, boards: store.data.boards };
}
function closePreview() {
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.close();
}
function previewBlurAction(window) {
  const session = previewState, epoch = pasteTargets.epoch, opening = openEpoch;
  return () => {
    if (!window || previewWindow !== window || window.isDestroyed() || previewState !== session || epoch !== pasteTargets.epoch
        || opening !== openEpoch || quitting || previewOpening || !mainWindow || mainWindow.isDestroyed()) return false;
    if (previewDirty || suppressBlur || openingItems || window.isFocused() || mainWindow.isFocused()) return false;
    hidePanel(); closePreview(); return true;
  };
}
function cancelPreviewRich() { previewRichJob?.controller.abort(); previewRichJob = null; previewSaveJob?.abort(); }
function trustedPreview(event) { return event.sender === previewWindow?.webContents && event.senderFrame === event.sender.mainFrame; }
function requirePanel(event) {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw Error('请从主面板调整窗口。');
}
function requireSettings(event) {
  if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw Error('请从设置窗口录制快捷键。');
  return settingsWindow;
}
function requestOpenItem(focused = BrowserWindow.getFocusedWindow()) {
  if (focused === previewWindow && previewState?.mode === 'view' && !previewDirty) focused.webContents.send('preview:command', 'open');
  else if (focused === mainWindow && mainWindow.isVisible()) mainWindow.webContents.send('item:openCommand');
}
async function openItems(event, ids, options = {}) {
  const preview = trustedPreview(event);
  if (!preview) requirePanel(event);
  const window = preview ? previewWindow : mainWindow, session = previewState, epoch = pasteTargets.epoch;
  if (preview && (session?.mode !== 'view' || previewDirty || ids?.length !== 1 || ids[0] !== session.id)) throw Error('请从未编辑的当前预览打开项目。');
  if (!preview && previewWindow && (previewDirty || previewState?.mode !== 'view')) throw Error('请先保存或关闭正在编辑的预览。');
  const current = () => !quitting && window && !window.isDestroyed() && window.isVisible() && epoch === pasteTargets.epoch
    && previewState === session && !previewDirty && (!preview || previewState?.mode === 'view');
  openingItems++; openEpoch++;
  try {
    const result = await itemOpener.open(ids, { index: options?.index, current });
    if (result.ok && current() && !TEST_MODE) { hidePanel(); closePreview(); }
    return result;
  } finally { openingItems--; }
}
function samePreview(window, id, signature) {
  return previewWindow === window && !window.isDestroyed() && previewState?.id === id && store.getMetadata(id)?.signature === signature;
}
function requestNewText() {
  if (previewWindow && !previewWindow.isDestroyed() && (previewDirty || previewState?.mode !== 'view')) { previewWindow.focus(); return false; }
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.webContents.send('item:new'); return true;
}
async function createTextDraft(boardId = 'history') {
  if (previewWindow && !previewWindow.isDestroyed() && (previewDirty || previewState?.mode !== 'view')) { previewWindow.focus(); return false; }
  if (typeof boardId !== 'string' || (boardId !== 'history' && !store.data.boards.some(board => board.id === boardId))) throw new Error('目标Pinboard不存在。');
  if (!mainWindow.isVisible() && !await showPanel()) return false;
  return showPreview(randomUUID(), { mode: 'create', boardId });
}
function showPreview(id, { mode = 'view', anchor, ids = [], boardId = 'history' } = {}) {
  if (mode !== 'create' && !store.get(id)) throw new Error('项目已被删除');
  if (!['view', 'edit', 'rename', 'create'].includes(mode)) throw new Error('Invalid preview mode');
  if (mode === 'edit' && store.get(id).type === 'file') throw new Error('文件项目不支持内容编辑');
  if (previewWindow && !previewWindow.isDestroyed() && (previewDirty || previewState?.mode !== 'view')) { previewWindow.focus(); return false; }
  if (previewState?.id !== id) cancelPreviewRich();
  imageDraft?.dispose(); imageDraft = null;
  const item = mode === 'create' ? { id, type: 'text', body: '', html: '', rtf: '', signature: textSignature('', '', ''),
    title: '新建文本', boardIds: boardId === 'history' ? [] : [boardId] } : store.get(id);
  if (mode === 'edit' && item.type === 'image') {
    const current = imageBytes(item);
    const original = item.originalAsset ? store.readAsset(item.originalAsset) : item.originalBody?.startsWith('data:image/png;base64,')
      ? Buffer.from(item.originalBody.slice('data:image/png;base64,'.length), 'base64') : current;
    const foreground = item.foregroundAsset ? store.readAsset(item.foregroundAsset) : item.foregroundBody?.startsWith('data:image/png;base64,')
      ? Buffer.from(item.foregroundBody.slice('data:image/png;base64,'.length), 'base64') : undefined;
    imageDraft = new ImageDraft({ original, current, foreground, turns: item.imageTurns || 0, backgroundRemoved: !!item.backgroundRemoved,
      transform: (buffer, turns, options) => imageProcessor.rotate(buffer, turns, options),
      cutout: capabilities.backgroundRemoval ? (buffer, options) => imageProcessor.cutout(buffer, options) : undefined });
  }
  previewState = { id, mode, ids: Array.isArray(ids) ? ids.filter(value => !!store.get(value)).slice(0, 100000) : [], ...(mode === 'create' ? { draft: item } : {}) };
  store.protectedItemId = mode !== 'view' ? id : null;
  previewDirty = false;
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.webContents.send('preview:changed', getPreviewState()); previewWindow.show(); previewWindow.focus(); return true;
  }
  previewOpening = true;
  const panel = mainWindow.getBounds(), area = screen.getDisplayMatching(panel).workArea;
  const width = Math.min(720, area.width - 24), height = Math.min(500, area.height - 40);
  const anchorX = anchor && Number.isFinite(anchor.x) ? Math.max(0, Math.min(panel.width, anchor.x)) : panel.width / 2;
  const x = Math.round(Math.max(area.x + 12, Math.min(area.x + area.width - width - 12, panel.x + anchorX - width / 2)));
  const y = Math.max(area.y + 12, panel.y - height - 12);
  previewWindow = createWindow('preview.html', { width, height, x, y, parent: mainWindow, title: 'Paste Easy 预览',
    frame: false, transparent: true, hasShadow: true, resizable: true, minWidth: 320, minHeight: 220, show: false, alwaysOnTop: true, skipTaskbar: true });
  const window = previewWindow;
  let blurTimer;
  const cancelBlur = () => { clearTimeout(blurTimer); blurTimer = undefined; };
  window.on('focus', cancelBlur);
  window.once('ready-to-show', () => setImmediate(() => {
    if (previewWindow !== window || window.isDestroyed()) return;
    window.show();
    if (previewWindow === window && !window.isDestroyed()) { window.focus(); previewOpening = false; }
  }));
  previewWindow.webContents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(previewWindow, { type: 'question', message: '放弃未保存的修改？', buttons: ['继续编辑', '放弃修改'], defaultId: 0, cancelId: 0 });
    if (response === 1) { previewDirty = false; event.preventDefault(); }
    else { quitAfterPreview = false; quitting = false; }
  });
  previewWindow.on('closed', () => {
    cancelBlur();
    if (previewWindow !== window) return;
    cancelPreviewRich();
    imageDraft?.dispose(); imageDraft = null;
    store.protectedItemId = null;
    previewWindow = null; previewState = null; previewDirty = false; previewOpening = false;
    if (quitAfterPreview) { quitAfterPreview = false; app.quit(); }
    // Let Cocoa finish destroying the child before changing the key window.
    else setImmediate(() => {
      if (!quitting && !quitAfterPreview && !previewWindow && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.focus();
    });
  });
  previewWindow.on('blur', () => {
    cancelBlur();
    if (openingItems) return;
    const dismiss = previewBlurAction(window);
    blurTimer = setTimeout(() => { blurTimer = undefined; if (!TEST_MODE) dismiss(); }, 100);
  });
  return true;
}

async function dragItem(event, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000) throw new Error('Invalid selection');
  const items = ids.map(id => { const item = store.get(id); if (!item) throw new Error('项目已被删除'); return item; });
  const files = items.flatMap(item => transfers.files(item));
  if (!files.length) throw new Error('此项目不支持文件拖出');
  let icon = nativeImage.createFromDataURL(items[0].preview || '');
  if (icon.isEmpty()) icon = await app.getFileIcon(files[0], { size: 'normal' });
  if (!TEST_MODE) event.sender.startDrag({ file: files[0], files, icon: icon.resize({ width: 64 }) });
  return { files };
}

function createWindow(file, options) {
  const window = new BrowserWindow({ ...options, webPreferences: {
    preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('before-input-event', (event, input) => {
    if (shortcutRecorder.mode(window)) return;
    if (pauseShortcut(input)) { event.preventDefault(); if (!input.isAutoRepeat) capturePause.toggle().catch(report); return; }
    if (newTextShortcut(input)) { event.preventDefault(); if (!input.isAutoRepeat) requestNewText(); return; }
    if (previewShortcut(input) === 'open') { event.preventDefault(); if (!input.isAutoRepeat) requestOpenItem(window); return; }
    if (file !== 'preview.html') return;
    if (previewState?.mode !== 'view') return;
    const command = previewShortcut(input);
    if (command) { event.preventDefault(); if (!input.isAutoRepeat) window.webContents.send('preview:command', command); }
  });
  window.loadFile(path.join(__dirname, file));
  return window;
}
function openSettings() {
  if (previewState?.mode !== 'view' && previewWindow) { previewWindow.focus(); return; }
  hidePanel();
  closePreview();
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createWindow('settings.html', { width: 642, height: 580, minWidth: 620, minHeight: 520,
      title: 'Paste Easy', titleBarStyle: 'hiddenInset', backgroundColor: nativeTheme.shouldUseDarkColors ? '#282828' : '#f4f4f4', show: false });
    settingsWindow.once('ready-to-show', () => settingsWindow.show());
    const owner = settingsWindow;
    for (const event of ['blur', 'hide', 'close', 'closed']) owner.on(event, () => shortcutRecorder.cancel(owner));
    owner.on('closed', () => { if (settingsWindow === owner) settingsWindow = null; });
    for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) owner.webContents.on(event, () => shortcutRecorder.cancel(owner));
  } else { settingsWindow.show(); settingsWindow.focus(); }
}
function createTray() {
  if (!store.data.settings.showInMenuBar) { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; return; }
  if (tray && !tray.isDestroyed()) return;
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAKElEQVR42mP8z8AARLJgwiFGEGkYRgYGBkYkDQwMDDQwMDAAAMu2AheG4i39AAAAAElFTkSuQmCC');
  icon.setTemplateImage(true); tray = new Tray(icon); tray.setToolTip('Paste Easy');
  tray.on('click', () => showPanel());
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: '显示剪贴板', click: () => showPanel() },
    { label: capturePause.isPaused() ? '继续记录' : '暂停记录', click: () => capturePause.toggle().catch(report) },
    { label: '暂停时长', submenu: [
      ...[[300000, '5分钟'], [900000, '15分钟'], [3600000, '1小时'], [null, '直到手动恢复']].map(([duration, label]) => ({ label, click: () => capturePause.pauseFor(duration).catch(report) }))
    ] },
    { type: 'separator' }, { label: '设置…', click: openSettings }, { label: '退出 Paste Easy', role: 'quit' }
  ])));
}
function applyRuntimeSettings() {
  nativeTheme.themeSource = store.data.settings.theme; createTray();
  if (process.platform === 'darwin' && !TEST_MODE) {
    if (store.data.settings.background) app.dock.hide(); else app.dock.show();
  }
}

function saveSettings(changes) {
  const ticket = typeof changes === 'function' ? null : capturePause?.request(changes);
  const operation = settingsQueue.then(() => performSaveSettings(typeof changes === 'function' ? changes(store.data.settings) : changes, ticket));
  operation.catch(error => { capturePause?.failed(ticket, error); emit(); });
  settingsQueue = operation.catch(() => {}); return operation;
}
async function performSaveSettings(changes, ticket) {
  const settings = sanitizeSettings(changes || {}, store.data.settings), previous = store.data.settings;
  const shortcutsChanged = settings.hotkey !== previous.hotkey || settings.stackHotkey !== previous.stackHotkey;
  const registration = shortcutsChanged || hotkeys.needsCleanup ? hotkeys.prepare(settings) : null, revision = store.revision;
  let warning = '';
  try {
    capturePause?.beforeCommit(ticket);
    if (!ticket && settings.paused !== previous.paused) { monitor.invalidate(); if (!settings.paused) monitor.requireBaseline(); }
    store.settings(settings);
  } catch (error) {
    if (store.revision === revision) {
      const cleanup = registration?.rollback();
      if (cleanup) throw Error(`${error.message} ${cleanup}`, { cause: error });
      throw error;
    }
    warning = error.message;
  }
  warning = [warning, registration?.commit()].filter(Boolean).join(' ');
  applyRuntimeSettings();
  capturePause?.committed(ticket);
  if (capturePause) await finishCaptureBaseline();
  if (settings.paused !== previous.paused && stackQueue.active) stackQueue.version = monitor.version;
  if (settings.pasteTarget !== previous.pasteTarget) { stackQueue.cancelPending(); stackInput.reset(); }
  if (!TEST_MODE) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  emit(); return warning ? { ...snapshot(), settingsWarning: warning } : snapshot();
}

function queueCopy(action) {
  const operation = copyQueue.then(action);
  copyQueue = operation.catch(() => {}); return operation;
}
function copyContext({ paste = false, plain = false } = {}) {
  return Object.freeze({ paste, plain: plain || store.data.settings.plainText,
    pasteTarget: store.data.settings.pasteTarget, target: pasteTargets.snapshot() });
}
function copy(id, options) { copyRequest += 1; const context = copyContext(options); return queueCopy(() => performCopy(id, context)); }
function copySelection(value, options) {
  const ids = selectionIDs(value); if (ids.length === 1) return copy(ids[0], options);
  copyRequest += 1; const context = copyContext(options);
  return queueCopy(async () => {
    const { item, references } = await selectionService.prepare(ids, context);
    selectionService.verify(references);
    return writeCopy(item, context, () => selectionService.verify(references));
  });
}
function nextInStack({ target, nativeEpoch, background = false, readTarget } = {}) {
  copyRequest += 1;
  const token = stackQueue.reserve(nativeEpoch === undefined ? 'manual' : 'native', nativeEpoch);
  if (!token) return Promise.resolve({ ok: false, error: 'Stack 为空' });
  const context = Object.freeze({ ...copyContext({ paste: true }), background, ...(background ? { target: target || null } : {}) });
  // Start the lookup at acceptance, but reserve the occurrence and preferences
  // first. A late result must not select from a reversed or replacement queue.
  const destination = readTarget ? Promise.resolve().then(readTarget).then(value => ({ target: targetIdentity(value, process.pid) }), error => ({ error })) : null;
  emit();
  return queueCopy(async () => {
    let result, failed = false;
    try {
      const resolved = destination ? await destination : null;
      if (!stackQueue.begin(token)) return { ok: false, error: 'Stack 已重置或项目已移除，请重新粘贴。' };
      if (resolved?.error) throw resolved.error;
      result = await performCopy(token.itemId, resolved ? { ...context, target: resolved.target } : context);
      failed = !result.ok;
      if (token.session === stackQueue.session) stackQueue.deliveryError = result.ok ? '' : result.error;
      return result;
    } catch (error) { failed = true; if (token.session === stackQueue.session) stackQueue.deliveryError = error.message; throw error; }
    finally {
      stackQueue.finish(token, result?.ok === true);
      if (failed && token.session === stackQueue.session) { stackQueue.cancelPending(); stackInput.reset(); }
      emit();
    }
  });
}
function nextFromStackWindow() {
  return nextInStack({ readTarget: () => pasteTargets.read(), background: true });
}
async function recognizeItem(id, retry = false) {
  if (!capabilities.textRecognition) throw new Error('此系统不支持图片文字识别');
  const item = store.get(id); if (!item || item.type !== 'image') throw new Error('图片已被删除');
  const signature = item.signature;
  await imageText.enqueue(id, { force: retry === true, priority: true });
  const current = store.get(id);
  if (!current || current.signature !== signature) throw new Error('图片已改变，请重试识别');
  if (current.ocr?.status === 'error') throw new Error(current.ocr.error || '图片文字识别失败');
  return current.ocr;
}
async function copyImageText(id) {
  const request = ++copyRequest, version = (await native('change-count')).count;
  await recognizeItem(id);
  return queueCopy(async () => {
    const currentVersion = (await native('change-count')).count;
    if (request !== copyRequest || (Number.isInteger(version) && version !== currentVersion)) throw new Error('图片文字复制已被后续复制替代');
    const item = store.get(id), ocr = item?.ocr;
    if (!ocr?.text || ocr.signature !== item.signature) throw new Error('未识别到可复制的文字');
    await monitor.suspend(async () => {
      if (stackQueue.active && !stackInput.simulate) {
        const receipt = await pasteOwnership.write(writeID => clip.write({ type: 'text', body: ocr.text }, { writeID }));
        monitor.remember(receipt.signature, receipt.lease || { token: receipt.token });
      } else monitor.remember(await clip.write({ type: 'text', body: ocr.text }));
    });
    if (!TEST_MODE) { hidePanel(); closePreview(); }
    return { ok: true, copied: true };
  });
}
async function performCopy(id, context) {
  const item = store.get(id);
  if (!item) throw new Error('此项目已被删除。');
  const references = [copySource(item)], verify = () => verifyCopySources(store, references);
  verify();
  return writeCopy(item, context, verify);
}
async function writeCopy(item, context, verify) {
  let lease;
  await monitor.suspend(async () => {
    const options = { plain: context.plain, image: item.asset ? store.readAsset(item.asset) : undefined };
    if ((context.paste && context.pasteTarget === 'application' && context.target && !pasteDelivery.simulate) || (stackQueue.active && !stackInput.simulate)) {
      const receipt = await pasteOwnership.write(writeID => { verify(); return clip.write(item, { ...options, writeID }); });
      lease = receipt.lease; monitor.remember(receipt.signature, lease || { token: receipt.token });
    } else { verify(); monitor.remember(await clip.write(item, options)); }
  });
  return pasteDelivery.deliver({ ...context, lease });
}

function registerIPC() {
  // DataTransfer must be populated during dragstart, not after an async IPC reply.
  ipcMain.on('item:dragText', (event, ids) => {
    try {
      if (!Array.isArray(ids) || ids.length > 10000) throw new Error('Invalid drag selection');
      let bytes = 0;
      const parts = [...new Set(ids)].map(id => {
        const item = store.get(id); if (!item) throw new Error('项目已被删除');
        if (['image', 'file'].includes(item.type)) return '';
        bytes += Buffer.byteLength(item.body) + 1;
        if (bytes > 64 * 1024 * 1024) throw new Error('拖出文字超过 64 MB 限制');
        return item.body;
      }).filter(Boolean);
      event.returnValue = { text: parts.join('\n') };
    } catch (error) { event.returnValue = { error: error.message }; }
  });
  const handlers = {
    'panel:size': event => { requirePanel(event); return panelSize.info(); },
    'panel:resizeStart': (event, y) => { requirePanel(event); if (quitting || !mainWindow.isVisible()) return null; return panelSize.begin(y); },
    'panel:resizeMove': (event, id, y) => { requirePanel(event); return panelSize.move(id, y); },
    'panel:resizeEnd': (event, id, y, cancel) => { requirePanel(event); return panelSize.end(id, y, cancel === true); },
    'library:get': () => snapshot(),
    'library:search': (_event, query) => searchService.search(store.data.items, store.revision, query),
    'item:media': (_event, requests) => mediaService.read(requests),
    'item:get': (_event, id) => { const item = store.get(id); return item?.asset ? { ...item, body: `data:image/png;base64,${store.readAsset(item.asset).toString('base64')}` } : item; },
    'item:detail': (_event, id) => itemDetail(id),
    'item:copy': (_event, id, options) => copy(id, options),
    'item:copySelection': (_event, ids, options) => copySelection(ids, options),
    'item:open': openItems,
    'item:new': (event, boardId) => { if (event.sender !== mainWindow?.webContents) throw new Error('请从主面板新建文本。'); return createTextDraft(boardId); },
    'item:requestNew': () => requestNewText(),
    'item:recognize': (_event, id, retry) => recognizeItem(id, retry),
    'item:copyText': (_event, id) => copyImageText(id),
    'item:ocr': (_event, id) => { const item = store.get(id); return item?.ocr && item.ocr.signature === item.signature ? item.ocr : null; },
    'item:update': (_event, id, changes) => { store.update(id, changes || {}); emit(); return snapshot(); },
    'item:rename': (event, id, title, expected) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('请从主面板重命名项目。');
      store.rename(id, title, expected); emit(); return snapshot();
    },
    'item:delete': (_event, ids) => { if (!Array.isArray(ids) || ids.length > 10000) throw new Error('Invalid selection'); store.delete(ids); emit(); return snapshot(); },
    'history:clear': async () => {
      suppressBlur = true;
      try {
        const { response } = await dialog.showMessageBox(mainWindow, { type: 'warning', message: '删除剪贴板历史？',
          detail: 'Pinboard 中固定的项目和正在编辑的项目会保留。此操作无法撤销。', buttons: ['取消', '删除历史'], defaultId: 0, cancelId: 0 });
        if (response === 1) { store.clear(); emit(); } return snapshot();
      } finally { suppressBlur = false; }
    },
    'board:save': (_event, board) => { const saved = store.saveBoard(board || {}); emit(); return saved; },
    'board:delete': (_event, id) => { store.deleteBoard(id); emit(); return snapshot(); },
    'board:reorder': (_event, ids) => { store.reorderBoards(ids); emit(); return snapshot(); },
    'board:reorderItems': (_event, id, ids) => { store.reorderBoardItems(id, ids); emit(); return snapshot(); },
    'board:pin': (_event, ids, boardId, remove) => { store.pinItems(ids, boardId, !!remove); emit(); return snapshot(); },
    'preview:open': (_event, id, options) => { if (options?.mode === 'create') throw new Error('请使用新建文本命令。'); return showPreview(id, options); },
    'preview:get': () => getPreviewState(),
    'preview:richText': (event, id, signature) => {
      if (!trustedPreview(event) || previewState?.id !== id) throw new Error('富文本预览已关闭');
      const item = store.get(id), window = previewWindow;
      if (!item || item.signature !== signature || !['text', 'code', 'link', 'color'].includes(item.type) || !item.rtf) throw new Error('富文本内容已改变');
      if (previewRichJob?.id === id && previewRichJob.signature === signature) return previewRichJob.promise;
      previewRichJob?.controller.abort();
      const controller = new AbortController(), job = { controller, id, signature };
      job.promise = richTextService.read(item.rtf, { signal: controller.signal, key: signature }).then(result => {
        if (!samePreview(window, id, signature)) throw new Error('富文本内容已改变');
        return result;
      }).finally(() => { if (previewRichJob === job) previewRichJob = null; });
      previewRichJob = job; return job.promise;
    },
    'preview:close': closePreview,
    'preview:dirty': (event, value) => { if (event.sender === previewWindow?.webContents) previewDirty = !!value || !!imageDraft?.busy; },
    'preview:pinDraft': (event, boardId, remove) => {
      if (!trustedPreview(event) || !previewState?.draft || typeof boardId !== 'string' || typeof remove !== 'boolean') throw new Error('新建文本已关闭。');
      if (!remove && !store.data.boards.some(board => board.id === boardId)) throw new Error('目标Pinboard不存在。');
      const draft = previewState.draft;
      previewState = { ...previewState, draft: { ...draft, boardIds: remove ? draft.boardIds.filter(id => id !== boardId) : [...new Set([...draft.boardIds, boardId])] } };
      previewWindow.webContents.send('preview:changed', getPreviewState()); return true;
    },
    'preview:image': async (event, action) => {
      if (event.sender !== previewWindow?.webContents || !imageDraft) throw new Error('图片编辑已关闭');
      const draft = imageDraft;
      previewDirty = true;
      try { await draft.apply(action); }
      catch (error) { if (draft === imageDraft) previewDirty = draft.state().changed; throw error; }
      if (draft !== imageDraft) throw new Error('图片编辑已关闭');
      previewDirty = draft.state().changed;
      return getPreviewState();
    },
    'preview:save': async (event, changes) => {
      if (!previewState) throw new Error('Preview closed');
      if (!trustedPreview(event)) throw new Error('Untrusted preview editor');
      if (previewSaveJob) throw new Error('正在保存富文本');
      if (previewState.draft) {
        const saved = store.createText(changes, previewState.draft.boardIds), destination = previewState.draft.boardIds[0] || 'history';
        previewState = { id: saved.id, mode: 'edit', ids: [] }; store.protectedItemId = saved.id;
        previewDirty = false; emit(); mainWindow.webContents.send('item:created', { id: saved.id, boardId: destination }); return snapshot();
      }
      if (imageDraft) {
        if (imageDraft.busy) throw new Error('图片正在处理中');
        if (imageDraft.state().changed) {
          const { buffer, size } = imageDraft.image, image = nativeImage.createFromBuffer(buffer);
          if (image.isEmpty()) throw new Error('图片旋转结果不可用');
          store.replaceImage(previewState.id, { buffer, size, original: imageDraft.original, turns: imageDraft.turns,
            foreground: imageDraft.foreground, backgroundRemoved: imageDraft.state().backgroundRemoved,
            signature: imageSignature(buffer, nativeImage),
            preview: thumbnail(image) });
          imageDraft.markSaved();
          queueImageText(store.get(previewState.id));
        }
      } else {
        const id = previewState.id, window = previewWindow, source = store.get(id);
        if (typeof changes?.body === 'string' && ['text', 'code', 'link', 'color'].includes(source.type) && source.rtf) {
          if (unsupportedRTF(source.rtf)) throw new Error('此RTF包含系统转换无法保留的附件或文档结构，原文未修改。');
          if (typeof changes.html !== 'string') throw new Error('富文本编辑内容不可用，原文未修改。');
          const controller = new AbortController(); previewSaveJob = controller;
          try {
            const rtf = await richTextService.write(changes.html, changes.body, { signal: controller.signal });
            if (!samePreview(window, id, source.signature)) throw new Error('富文本内容已改变，原文未修改。');
            store.update(id, { ...changes, rtf });
          } finally { if (previewSaveJob === controller) previewSaveJob = null; }
        } else store.update(id, changes || {});
      }
      previewDirty = false; emit(); return snapshot();
    },
    'preview:navigate': (_event, direction) => {
      if (!previewState || previewState.mode !== 'view' || previewDirty || ![-1, 1].includes(direction)) return false;
      const ids = previewState.ids.filter(id => !!store.get(id)), index = ids.indexOf(previewState.id), next = ids[index + direction];
      if (!next) return false;
      cancelPreviewRich();
      previewState = { ...previewState, id: next, ids, mode: 'view' }; previewWindow.webContents.send('preview:changed', getPreviewState()); return true;
    },
    'item:drag': dragItem,
    'item:share': async (event, id) => {
      const item = store.get(id); if (!item) throw new Error('项目已被删除');
      const sharingItem = transfers.sharingItem(item);
      if (!TEST_MODE) {
        suppressBlur = true;
        activeShare = new ShareMenu(sharingItem);
        activeShare.popup({ window: BrowserWindow.fromWebContents(event.sender), callback: () => { suppressBlur = false; activeShare = null; } });
      }
      return sharingItem;
    },
    'item:reveal': (_event, id, index = 0) => {
      const item = store.get(id); if (!item) throw new Error('项目已被删除');
      const files = fileDetails(item);
      if (!Number.isInteger(index) || !files[index]?.exists) throw new Error('原始文件已移动或删除');
      if (!TEST_MODE) shell.showItemInFolder(files[index].path); return files[index].path;
    },
    'settings:save': (_event, changes) => saveSettings(changes),
    'settings:shortcutBegin': (event, key) => shortcutRecorder.begin(requireSettings(event), key),
    'settings:shortcutCancel': (event, id) => { const owner = requireSettings(event); if (typeof id !== 'string') throw Error('录制会话无效。'); return shortcutRecorder.cancel(owner, id); },
    'settings:shortcutFinish': (event, id, accelerator) => shortcutRecorder.finish(requireSettings(event), id, accelerator),
    'capture:toggle': () => capturePause.toggle(),
    'capture:pause': (_event, duration) => capturePause.pauseFor(duration),
    'capture:resume': () => capturePause.resume(),
    'settings:excludedApplications': async (event, ids) => {
      if (event.sender !== settingsWindow?.webContents || !Array.isArray(ids) || ids.length > 32 || ids.some(id => !store.data.settings.excludedApps.includes(id))) throw new Error('无效的应用程序查询。');
      return applicationCatalog.metadata(ids);
    },
    'settings:chooseExcludedApplications': async event => {
      if (event.sender !== settingsWindow?.webContents) throw new Error('请从隐私设置选择应用程序。');
      if (exportDialogOpen || importDialogOpen) throw new Error('请先关闭当前文件选择窗口。');
      if (applicationDialogOpen) throw new Error('应用程序选择窗口已打开。');
      applicationDialogOpen = true;
      try {
        const result = await dialog.showOpenDialog(settingsWindow, { title: '忽略应用程序', buttonLabel: '添加', defaultPath: '/Applications',
          properties: ['openFile', 'multiSelections'], filters: [{ name: '应用程序', extensions: ['app'] }] });
        if (result.canceled) return false;
        const ids = await applicationCatalog.selected(result.filePaths);
        return saveSettings(previous => ({ excludedApps: [...previous.excludedApps, ...ids] }));
      } finally { applicationDialogOpen = false; }
    },
    'settings:changeExcludedApplication': (event, id, remove = false) => {
      if (event.sender !== settingsWindow?.webContents || !validApplicationID(id) || typeof remove !== 'boolean') throw new Error('无效的应用程序标识。');
      return saveSettings(previous => ({ excludedApps: remove ? previous.excludedApps.filter(value => value !== id) : [...previous.excludedApps, id] }));
    },
    'settings:open': openSettings, 'permission:get': () => native('permission'),
    'permission:open': () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'),
    'panel:hide': () => { closePreview(); hidePanel(); },
    'stack:toggle': () => stackQueue.active || stackOpening ? stopStack() : activateStack(),
    'stack:add': async (_event, id) => { if (!store.getMetadata(id)) throw new Error('Invalid item'); if (!await activateStack()) return []; stackQueue.add(id); emit(); return stackQueue.ordered().map(entry => entry.itemId); },
    'stack:addSelection': async (_event, value) => {
      const ids = selectionIDs(value);
      const validate = () => { if (ids.some(id => !store.getMetadata(id))) throw Error('所选项目已被删除，Stack未添加项目。'); };
      validate(); if (!await activateStack()) return []; validate();
      const additions = ids.filter(id => !stackQueue.entries.some(entry => entry.itemId === id));
      if (stackQueue.entries.length + additions.length > 1000) throw Error('所选项目超出Stack的1000项容量，未添加项目。');
      additions.forEach(id => stackQueue.add(id)); emit(); return stackQueue.ordered().map(entry => entry.itemId);
    },
    'stack:get': () => stackSnapshot(),
    'stack:reverse': () => { stackQueue.reverse(); emit(); return stackSnapshot(); },
    'stack:remove': (_event, id) => { stackQueue.remove(id); emit(); return stackSnapshot(); },
    'stack:stop': stopStack,
    'stack:retry': async () => {
      if (stackQueue.active) {
        if (stackInput.state.running) stackInput.refreshPermission();
        else { await stackInput.start(); stackInput.reset(); }
      }
      return stackSnapshot();
    },
    'stack:next': event => event.sender === stackWindow?.webContents ? nextFromStackWindow() : nextInStack(),
    'library:export': async () => {
      if (applicationDialogOpen) throw new Error('请先关闭应用程序选择窗口。');
      if (importDialogOpen || importService.state().phase !== 'idle') throw new Error('请先完成或取消备份恢复。');
      if (exportDialogOpen || store.exportService.state().running) throw new Error('已有备份正在选择位置或导出，请等待或取消。');
      exportDialogOpen = true;
      try {
        const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : mainWindow;
        const { canceled, filePath } = await dialog.showSaveDialog(owner, { defaultPath: 'Paste-Easy-backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (canceled) return false;
        try { const result = await store.exportTo(filePath); if (result.warning) { lastError = result.warning; emit(); } return result; }
        catch (error) { if (error.name === 'AbortError') return { canceled: true }; throw error; }
      } finally { exportDialogOpen = false; }
    },
    'library:exportState': () => store.exportService.state(),
    'library:cancelExport': () => store.exportService.cancel(),
    'library:prepareImport': async () => {
      if (applicationDialogOpen) throw new Error('请先关闭应用程序选择窗口。');
      if (exportDialogOpen || importDialogOpen) throw new Error('请先关闭备份文件选择窗口。');
      importService.checkAvailable(); importDialogOpen = true;
      try {
        const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : mainWindow;
        const { canceled, filePaths } = await dialog.showOpenDialog(owner, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (canceled) return false;
        try { return await importService.prepare(filePaths[0]); } catch (error) { if (error.name === 'AbortError') return { canceled: true }; throw error; }
      } finally { importDialogOpen = false; }
    },
    'library:applyImport': async (_event, token, options) => {
      await settingsQueue;
      try {
        const result = await monitor.suspend(async () => { const value = await importService.apply(token, options); monitor.requireBaseline(); capturePause.sync(); return value; });
        await finishCaptureBaseline(); emit(); return result;
      }
      catch (error) { if (error.name === 'AbortError') return { canceled: true }; throw error; }
    },
    'library:importState': () => importService.state(),
    'library:cancelImport': () => importService.cancel(),
    'library:revealImportBackup': () => { const file = importService.lastCheckpoint; if (!file || !fs.existsSync(file)) throw new Error('尚无恢复前备份。'); if (!TEST_MODE) shell.showItemInFolder(file); return file; }
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, (event, ...args) => {
    const senders = [mainWindow, settingsWindow, previewWindow, stackWindow].filter(window => window && !window.isDestroyed()).map(window => window.webContents);
    if (!senders.includes(event.sender) || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted IPC sender');
    return handler(event, ...args);
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showPanel());
  app.whenReady().then(async () => {
    try {
      store = new ClipStore(app.getPath('userData'), { legacyDirectories: TEST_MODE || process.env.PASTE_DATA_DIR ? []
        : ['paste-like', 'Paste Like'].map(name => path.join(app.getPath('appData'), name)) });
      const unavailableImages = store.migrateImageSignatures(item => imageSignature(item.asset ? store.readAsset(item.asset) : nativeImage.createFromDataURL(item.body).toPNG(), nativeImage));
      if (unavailableImages.length) store.recovery = [store.recovery, `${unavailableImages.length} 个历史图片无法读取，原记录已保留。`].filter(Boolean).join(' ');
      nativeTheme.themeSource = store.data.settings.theme;
      transfers = new Transfers(store);
      imageProcessor = new ImageProcessor(app.getPath('userData'), (command, data, options) => nativeInput(command, data, 30000, options));
      capabilities = await native('image-capabilities');
      imageText = new ImageTextIndex({ store, processor: imageProcessor, readImage: imageBytes, onChanged: emit });
      searchService = new SearchService({ directory: app.getPath('userData') });
      mediaService = new MediaService(store, nativeImage);
      imageInspector = new ImageInspector(electron);
      richTextService = new RichTextService();
      selectionComposer = new SelectionComposer(electron);
      selectionService = new SelectionService({ store, readImage: imageBytes, richText: richTextService,
        composeHTML: (parts, options) => selectionComposer.compose(parts, options), composeNative: (segments, options) => nativeInput('selection-rich', { segments }, 10000, options) });
      applicationCatalog = new ApplicationCatalog(request => nativeInput('application-info', request, 10000));
      importService = new ImportService(store, {
        validateImage: async (file, { turns = 0, signal } = {}) => {
          const inspect = (file, options) => imageInspector.inspect(file, options);
          return turns ? imageProcessor.rotateFile(file, turns, inspect, { signal })
            : inspect(file, { expectedHash: path.basename(file, '.png'), signal });
        },
        beforeCommit: settings => {
          const previous = store.data.settings;
          if (settings.hotkey !== previous.hotkey || settings.stackHotkey !== previous.stackHotkey || hotkeys.needsCleanup) {
            const registration = hotkeys.prepare(settings);
            return Object.assign(() => registration.rollback(), { commit: () => registration.commit() });
          }
          return () => {};
        },
        afterCommit: () => {
          applyRuntimeSettings(); if (!TEST_MODE) app.setLoginItemSettings({ openAtLogin: store.data.settings.launchAtLogin });
          emit(); for (const item of store.data.items) queueImageText(item);
        }
      });
      monitor = new ClipboardMonitor({
        readVersion: async () => {
          const value = (await native('change-count')).count;
          if (process.platform === 'darwin' && !Number.isInteger(value)) throw new Error('无法读取剪贴板变化，请重新构建原生辅助程序。');
          return value;
        },
        readSnapshot: clipboardSnapshot, onSnapshot: capture, onError: report,
        readContext: () => stackQueue.active ? stackQueue.session : null,
        onObserved: (value, { version, context, owned, uncertain, saved }) => {
          const item = saved || (value && store.data.items.find(item => item.signature === value.signature));
          stackQueue.observe(item?.id, { version, session: context, owned, uncertain }); emit();
        },
        onBaseline: version => { if (lastError === monitor.baselineError) lastError = ''; if (stackQueue.active) stackQueue.version = version; emit(); },
        isPaused: () => capturePause?.isPaused() ?? store.data.settings.paused, isKnown: signature => store.data.items.some(item => item.signature === signature)
      });
      capturePause = new CapturePause({ read: () => store.data.settings, save: saveSettings, monitor, automatic: !TEST_MODE, onChange: emit, onError: report });
      if (TEST_MODE && process.env.PASTE_TEST_SEED && !store.data.items.length) {
        const seed = JSON.parse(fs.readFileSync(process.env.PASTE_TEST_SEED, 'utf8'));
        for (const item of seed) store.add(item);
      }
      mainWindow = createWindow('index.html', { width: 1200, height: DEFAULT_HEIGHT, minWidth: 320, show: false,
        frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, title: 'Paste Easy', vibrancy: 'under-window' });
      mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
      panelSize = new PanelSize({ getBounds: () => mainWindow.getBounds(), display: () => screen.getDisplayMatching(mainWindow.getBounds()),
        apply: bounds => mainWindow.setBounds(bounds), preference: () => store.data.settings.panelHeight, save: height => saveSettings({ panelHeight: height }) });
      mainWindow.on('resize', () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('panel:size', panelSize.info()); });
      Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(openSettings, process.platform, requestNewText,
        { toggle: () => capturePause.toggle().catch(report), pauseFor: duration => capturePause.pauseFor(duration).catch(report) }, (_item, window) => requestOpenItem(window || undefined))));
      itemOpener = new ItemOpener({ store,
        openURL: url => { if (TEST_MODE) throw Error('System opening disabled in tests'); return shell.openExternal(url); },
        openPath: file => { if (TEST_MODE) throw Error('System opening disabled in tests'); return shell.openPath(file); },
        confirm: async ({ count, risky }) => {
          if (TEST_MODE) throw Error('System confirmation disabled in tests');
          const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || mainWindow, { type: 'warning',
            message: `打开${count}个项目？`, detail: risky ? '包含应用、可执行文件或带登录信息的链接。仅打开你信任的内容。' : '这会通过默认应用打开多个项目。',
            buttons: ['取消', '打开'], defaultId: 0, cancelId: 0 });
          return result.response === 1;
        } });
      mainWindow.on('blur', () => {
        if (openingItems) return;
        const epoch = pasteTargets.epoch, opening = openEpoch;
        setTimeout(() => {
          if (!TEST_MODE && opening === openEpoch && epoch === pasteTargets.epoch && !mainWindow.isFocused() && !suppressBlur && !openingItems && !previewOpening && !previewWindow?.isVisible() && !mainWindow.webContents.isDevToolsOpened()) hidePanel();
        }, 100);
      });
      hotkeys = new GlobalHotkeys(globalShortcut, {
        history: () => mainWindow.isVisible() || pasteTargets.pending ? hidePanel() : showPanel(),
        stack: () => activateStack().catch(report)
      }, TEST_MODE, accelerator => shortcutRecorder.interceptGlobal(accelerator));
      registerIPC(); applyRuntimeSettings();
      capturePause.sync();
      if (!TEST_MODE) powerMonitor.on('resume', () => capturePause.check().catch(report));
      store.exportService.onChanged = state => { for (const window of [mainWindow, settingsWindow]) if (window && !window.isDestroyed()) window.webContents.send('export:changed', state); };
      importService.onChanged = state => { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('import:changed', state); };
      if (TEST_MODE) globalThis.__pasteTest = { poll, store, clip, hash, textSignature, imageSignature, monitor, capturePause, panelSize, isIgnored, imageProcessor, imageInspector, richTextService, selectionService, selectionComposer, applicationCatalog, imageText, searchService, mediaService, importService, thumbnail, pasteTargets, pasteOwnership, pasteDelivery, stackQueue, stackInput, requestStackPoll, showPanel, hidePanel, hotkeys, capturePreviewBlur: () => previewBlurAction(previewWindow) };
      if (TEST_MODE) Object.assign(globalThis.__pasteTest, { itemOpener, shortcutRecorder });
      try { const warning = hotkeys.apply(store.data.settings); if (warning) report(Error(warning)); } catch (error) { report(error); }
      for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(event, () => { if (mainWindow.isVisible()) placePanel(); });
      app.on('activate', () => { if (stackQueue.active) void showStack().catch(report); else if (!mainWindow.isVisible() && !pasteTargets.pending) showPanel(); });
      mainWindow.webContents.once('did-finish-load', () => { if (process.argv.includes('--show') || TEST_MODE) showPanel(); });
      if (!TEST_MODE) pollTimer = setInterval(poll, 650);
      for (const item of store.data.items) queueImageText(item);
      mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); if (store.data.settings.background) hidePanel(); else app.quit(); } });
    } catch (error) { console.error(error); dialog.showErrorBox('Paste Easy 无法加载历史', `${error.message}\n原始数据未被覆盖。`); app.quit(); }
  });
}
app.on('before-quit', event => {
  if (previewWindow && !previewWindow.isDestroyed()) { event.preventDefault(); quitAfterPreview = true; closePreview(); return; }
  quitting = true;
  panelSize?.cancel(false);
  capturePause?.close();
  if (!processingStopped) {
    event.preventDefault(); clearInterval(pollTimer);
    if (!processingClosing) {
      processingClosing = true;
      Promise.allSettled([stopStack(), imageText?.close(), imageProcessor?.close(), imageInspector?.close(), richTextService?.close(), selectionService?.close(), selectionComposer?.close(), searchService?.close(), store?.exportService.close(), importService?.close()]).then(() => { processingStopped = true; app.quit(); });
    }
  }
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); clearInterval(pollTimer); store?.close(); });
app.on('window-all-closed', event => event.preventDefault());
