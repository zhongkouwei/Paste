const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Tray } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const MAX_ITEMS = 300;
const POLL_MS = 900;
const WINDOW_HEIGHT = 372;
const ITEM_TYPES = new Set(['text', 'link', 'code', 'image']);

let mainWindow;
let tray;
let pollTimer;
let lastSignature = '';
let history = [];

function historyPath() {
  return path.join(app.getPath('userData'), 'clipboard-history.json');
}

function corruptHistoryPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(app.getPath('userData'), `clipboard-history.corrupt-${timestamp}.json`);
}

function createHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function syncLastSignature() {
  lastSignature = history[0]?.signature || '';
}

function classifyText(text) {
  const trimmed = text.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return 'link';
  if (/(\bfunction\b|\bconst\b|\blet\b|\bclass\b|=>|<\/?[a-z][\s\S]*>|^\s*(import|export)\s+)/m.test(text)) return 'code';
  return 'text';
}

function stringValue(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function normalizeHistoryItem(item) {
  if (!item || !item.id || item.body === undefined || item.body === null) return null;

  const body = stringValue(item.body);
  if (!body.trim()) return null;

  const type = ITEM_TYPES.has(item.type) ? item.type : classifyText(body);
  const title = stringValue(item.title).trim()
    || (type === 'image' ? 'Image' : body.split('\n').find((line) => line.trim())?.slice(0, 80))
    || 'Text';
  const preview = stringValue(item.preview) || (type === 'image' ? body : body.slice(0, 700));
  const signature = stringValue(item.signature) || createHash(`${type}:${body}`);

  return {
    ...item,
    id: stringValue(item.id),
    type,
    title,
    body,
    html: stringValue(item.html),
    preview,
    signature,
    isFavorite: Boolean(item.isFavorite)
  };
}

function clipboardSnapshot() {
  const image = clipboard.readImage();
  const text = clipboard.readText();
  const html = clipboard.readHTML();

  if (!image.isEmpty()) {
    const dataUrl = image.toDataURL();
    const previewDataUrl = image.resize({ width: 320 }).toDataURL();
    return {
      type: 'image',
      title: 'Image',
      body: dataUrl,
      preview: previewDataUrl,
      signature: createHash(`image:${dataUrl}`)
    };
  }

  if (!text || !text.trim()) return null;

  const normalized = text.replace(/\r\n/g, '\n');
  return {
    type: classifyText(normalized),
    title: normalized.split('\n').find(Boolean)?.slice(0, 80) || 'Text',
    body: normalized,
    html: html || '',
    preview: normalized.slice(0, 700),
    signature: createHash(`text:${normalized}`)
  };
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(historyPath(), 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) {
      throw new Error('Clipboard history file must contain an array.');
    }
    history = items.map(normalizeHistoryItem).filter(Boolean).slice(0, MAX_ITEMS);
    syncLastSignature();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try {
        fs.renameSync(historyPath(), corruptHistoryPath());
      } catch (backupError) {
        console.error('Failed to preserve corrupt clipboard history:', backupError);
      }
      console.error('Clipboard history could not be loaded and was reset:', error);
    }
    history = [];
    syncLastSignature();
  }
}

function saveHistory() {
  fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
  fs.writeFileSync(historyPath(), JSON.stringify(history, null, 2));
}

function sendHistory() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:changed', history);
  }
}

function clearHistory() {
  history = [];
  syncLastSignature();
  saveHistory();
  sendHistory();
}

async function confirmClearHistory() {
  if (!history.length) return false;

  const parentWindow = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    ? mainWindow
    : undefined;
  const options = {
    type: 'warning',
    buttons: ['Cancel', 'Clear History'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Clear Clipboard History?',
    message: 'Clear all saved clipboard history?',
    detail: 'This removes saved clips from Paste Like. The current system clipboard is not changed.'
  };
  const { response } = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options);

  return response === 1;
}

function addSnapshot(snapshot) {
  if (!snapshot || snapshot.signature === lastSignature) return;

  lastSignature = snapshot.signature;
  history = history.filter((item) => item.signature !== snapshot.signature);
  history.unshift({
    id: crypto.randomUUID(),
    createdAt: now(),
    isFavorite: false,
    ...snapshot
  });
  history = history.slice(0, MAX_ITEMS);
  saveHistory();
  sendHistory();
}

function startClipboardWatcher() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    try {
      addSnapshot(clipboardSnapshot());
    } catch (error) {
      console.error('Clipboard polling failed:', error);
    }
  }, POLL_MS);
}

function setClipboardItem(item) {
  if (!item) return false;
  if (item.type === 'image') {
    clipboard.writeImage(nativeImage.createFromDataURL(item.body));
  } else if (item.html) {
    clipboard.write({ text: item.body, html: item.html });
  } else {
    clipboard.writeText(item.body);
  }
  lastSignature = item.signature;
  return true;
}

function pasteIntoActiveApp() {
  execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], (error) => {
    if (error) console.error('Paste automation failed:', error);
  });
}

function primaryScreenBounds() {
  return require('electron').screen.getPrimaryDisplay().bounds;
}

function positionWindows() {
  if (!mainWindow) return;
  const { x, y, width, height } = primaryScreenBounds();
  mainWindow.setBounds({
    x,
    y: y + height - WINDOW_HEIGHT,
    width,
    height: WINDOW_HEIGHT
  });
}

function showWindow() {
  if (!mainWindow) return;
  positionWindows();
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
}

function hideWindow() {
  if (mainWindow) mainWindow.hide();
}

function createWindow() {
  const { width } = primaryScreenBounds();
  mainWindow = new BrowserWindow({
    width,
    height: WINDOW_HEIGHT,
    minWidth: 760,
    minHeight: 300,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: 'Paste Like',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.on('blur', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
        hideWindow();
      }
    }, 80);
  });
}

function registerDisplayHandlers() {
  const { screen } = require('electron');
  const reposition = () => {
    if (mainWindow?.isVisible()) positionWindows();
  };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAKElEQVR42mP8z8AARLJgwiFGEGkYRgYGBkYkDQwMDDQwMDAAAMu2AheG4i39AAAAAElFTkSuQmCC'
  );
  tray = new Tray(icon);
  tray.setToolTip('Paste Like');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Clipboard History', click: showWindow },
    { label: 'Clear History', click: async () => { if (await confirmClearHistory()) clearHistory(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', showWindow);
}

app.whenReady().then(() => {
  loadHistory();
  createWindow();
  registerDisplayHandlers();
  createTray();
  startClipboardWatcher();

  globalShortcut.register('CommandOrControl+Shift+V', showWindow);

  ipcMain.handle('history:get', () => history);
  ipcMain.handle('history:toggleFavorite', (_event, id) => {
    history = history.map((item) => item.id === id ? { ...item, isFavorite: !item.isFavorite } : item);
    saveHistory();
    sendHistory();
    return history;
  });
  ipcMain.handle('history:delete', (_event, id) => {
    history = history.filter((item) => item.id !== id);
    syncLastSignature();
    saveHistory();
    sendHistory();
    return history;
  });
  ipcMain.handle('history:clear', async () => {
    if (await confirmClearHistory()) clearHistory();
    return history;
  });
  ipcMain.handle('history:copy', (_event, id, shouldPaste = false) => {
    const item = history.find((entry) => entry.id === id);
    const didCopy = setClipboardItem(item);
    if (didCopy && shouldPaste) {
      hideWindow();
      setTimeout(pasteIntoActiveApp, 120);
    }
    return didCopy;
  });
  ipcMain.handle('window:hide', () => hideWindow());
  ipcMain.handle('window:show', () => showWindow());

  if (process.argv.includes('--show')) showWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(pollTimer);
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
