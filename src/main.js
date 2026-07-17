const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');

const APP_NAME = 'Paste Easy';
const LEGACY_APP_NAME = 'Paste Like';
const HOTKEY = 'CommandOrControl+Shift+V';
const MAX_ITEMS = 300;
const POLL_MS = 900;
const WINDOW_HEIGHT = 372;
const DEBUG_WINDOW = process.env.PASTE_DEBUG_WINDOW === '1';

app.setName(APP_NAME);

let windowsByDisplayId = new Map();
let activeWindow;
let tray;
let pollTimer;
let lastSignature = '';
let history = [];

function debugWindow(event, details = {}) {
  if (!DEBUG_WINDOW) return;
  console.error(`[window:${event}]`, JSON.stringify(details));
}

function displayDebugInfo(display) {
  return {
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor
  };
}

function historyPath() {
  return path.join(app.getPath('userData'), 'clipboard-history.json');
}

function legacyHistoryPath() {
  return path.join(app.getPath('appData'), LEGACY_APP_NAME, 'clipboard-history.json');
}

function createHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function classifyText(text) {
  const trimmed = text.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return 'link';
  if (/(\bfunction\b|\bconst\b|\blet\b|\bclass\b|=>|<\/?[a-z][\s\S]*>|^\s*(import|export)\s+)/m.test(text)) return 'code';
  return 'text';
}

function clipboardSnapshot() {
  const image = clipboard.readImage();
  const text = clipboard.readText();
  const html = clipboard.readHTML();

  if (!image.isEmpty()) {
    const dataUrl = image.resize({ width: 320 }).toDataURL();
    return {
      type: 'image',
      title: 'Image',
      body: dataUrl,
      preview: dataUrl,
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
  for (const filePath of [historyPath(), legacyHistoryPath()]) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      history = JSON.parse(raw).filter((item) => item && item.id && item.body).slice(0, MAX_ITEMS);
      lastSignature = history[0]?.signature || '';
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Failed to load clipboard history from ${filePath}:`, error);
      }
    }
  }

  history = [];
}

function saveHistory() {
  fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
  fs.writeFileSync(historyPath(), JSON.stringify(history, null, 2));
}

function sendHistory() {
  for (const window of windowsByDisplayId.values()) {
    if (!window.isDestroyed()) {
      window.webContents.send('history:changed', history);
    }
  }
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
  if (!item) return;
  if (item.type === 'image') {
    clipboard.writeImage(nativeImage.createFromDataURL(item.body));
  } else if (item.html) {
    clipboard.write({ text: item.body, html: item.html });
  } else {
    clipboard.writeText(item.body);
  }
  lastSignature = item.signature;
}

function pasteIntoActiveApp() {
  execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], (error) => {
    if (error) console.error('Paste automation failed:', error);
  });
}

function frontmostWindowBounds() {
  if (process.platform !== 'darwin') return null;

  try {
    const output = execFileSync('osascript', [
      '-e', 'tell application "System Events"',
      '-e', 'set frontProcess to first application process whose frontmost is true',
      '-e', 'if (count of windows of frontProcess) is 0 then return ""',
      '-e', 'set frontWindow to first window of frontProcess',
      '-e', 'set {windowX, windowY} to position of frontWindow',
      '-e', 'set {windowWidth, windowHeight} to size of frontWindow',
      '-e', 'return (windowX as text) & "," & (windowY as text) & "," & (windowWidth as text) & "," & (windowHeight as text)',
      '-e', 'end tell'
    ], { encoding: 'utf8', timeout: 600 }).trim();
    const [x, y, width, height] = output.split(',').map((value) => Number.parseInt(value, 10));
    if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
      return { x, y, width, height };
    }
  } catch (error) {
    debugWindow('frontmost-window-error', { message: error.message });
  }

  return null;
}

function targetDisplay() {
  const frontmostBounds = frontmostWindowBounds();
  if (frontmostBounds) {
    const display = screen.getDisplayMatching(frontmostBounds);
    debugWindow('target-display', {
      strategy: 'frontmost-window',
      frontmostBounds,
      targetDisplay: displayDebugInfo(display),
      displays: screen.getAllDisplays().map(displayDebugInfo)
    });
    return display;
  }

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint) || screen.getPrimaryDisplay();
  debugWindow('target-display', {
    strategy: 'cursor',
    cursorPoint,
    targetDisplay: displayDebugInfo(display),
    displays: screen.getAllDisplays().map(displayDebugInfo)
  });
  return display;
}

function displayWorkArea(display) {
  return display.workArea || display.bounds;
}

function windowBoundsForDisplay(display) {
  const { x, y, width, height } = displayWorkArea(display);
  return {
    x,
    y: y + height - WINDOW_HEIGHT,
    width,
    height: WINDOW_HEIGHT
  };
}

function positionWindow(window, display) {
  if (!window || window.isDestroyed()) return;
  window.setBounds(windowBoundsForDisplay(display), false);
}

function configureFloatingWindow(window) {
  window.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    });
  }
}

function hideWindows(exceptWindow) {
  for (const window of windowsByDisplayId.values()) {
    if (!window.isDestroyed() && window !== exceptWindow) {
      window.hide();
    }
  }
}

function createWindowForDisplay(display) {
  debugWindow('create', { display: displayDebugInfo(display), bounds: windowBoundsForDisplay(display) });
  const window = new BrowserWindow({
    ...windowBoundsForDisplay(display),
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
    hiddenInMissionControl: true,
    title: APP_NAME,
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.loadFile(path.join(__dirname, 'index.html'));
  configureFloatingWindow(window);
  window.on('blur', () => {
    setTimeout(() => {
      if (!window.isDestroyed() && !window.isFocused()) {
        window.hide();
      }
    }, 80);
  });
  window.on('closed', () => {
    for (const [displayId, existingWindow] of windowsByDisplayId.entries()) {
      if (existingWindow === window) {
        windowsByDisplayId.delete(displayId);
      }
    }
    if (activeWindow === window) activeWindow = null;
  });

  windowsByDisplayId.set(display.id, window);
  return window;
}

function ensureWindowForDisplay(display) {
  const existingWindow = windowsByDisplayId.get(display.id);
  if (existingWindow && !existingWindow.isDestroyed()) {
    positionWindow(existingWindow, display);
    return existingWindow;
  }
  return createWindowForDisplay(display);
}

function syncDisplayWindows() {
  const displays = screen.getAllDisplays();
  const activeDisplayIds = new Set(displays.map((display) => display.id));

  for (const display of displays) {
    ensureWindowForDisplay(display);
  }

  for (const [displayId, window] of windowsByDisplayId.entries()) {
    if (!activeDisplayIds.has(displayId) && !window.isDestroyed()) {
      window.close();
    }
  }
}

function showWindow() {
  const display = targetDisplay();
  const window = ensureWindowForDisplay(display);
  debugWindow('show-start', {
    display: displayDebugInfo(display),
    windowBounds: window.getBounds(),
    visible: window.isVisible(),
    focused: window.isFocused()
  });
  hideWindows(window);
  configureFloatingWindow(window);
  positionWindow(window, display);
  if (process.platform === 'darwin') {
    window.showInactive();
  } else {
    window.show();
  }
  window.moveTop();
  window.focus();
  window.webContents.focus();
  activeWindow = window;
  window.webContents.send('window:shown');
  debugWindow('show-end', {
    display: displayDebugInfo(display),
    windowBounds: window.getBounds(),
    visible: window.isVisible(),
    focused: window.isFocused()
  });
}

function hideWindow() {
  hideWindows();
}

function registerDisplayHandlers() {
  const reposition = () => {
    syncDisplayWindows();
    for (const display of screen.getAllDisplays()) {
      const window = windowsByDisplayId.get(display.id);
      if (window?.isVisible()) positionWindow(window, display);
    }
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
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Clipboard History', click: showWindow },
    { label: 'Clear History', click: () => { history = []; saveHistory(); sendHistory(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', showWindow);
}

function configureMacDock() {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
}

app.whenReady().then(() => {
  configureMacDock();
  loadHistory();
  syncDisplayWindows();
  registerDisplayHandlers();
  createTray();
  startClipboardWatcher();

  if (!globalShortcut.register(HOTKEY, showWindow)) {
    console.error(`Failed to register ${HOTKEY}. Another app may already be using it.`);
  }

  ipcMain.handle('history:get', () => history);
  ipcMain.handle('history:toggleFavorite', (_event, id) => {
    history = history.map((item) => item.id === id ? { ...item, isFavorite: !item.isFavorite } : item);
    saveHistory();
    sendHistory();
    return history;
  });
  ipcMain.handle('history:delete', (_event, id) => {
    history = history.filter((item) => item.id !== id);
    saveHistory();
    sendHistory();
    return history;
  });
  ipcMain.handle('history:clear', () => {
    history = [];
    saveHistory();
    sendHistory();
    return history;
  });
  ipcMain.handle('history:copy', (_event, id, shouldPaste = false) => {
    const item = history.find((entry) => entry.id === id);
    setClipboardItem(item);
    if (shouldPaste) {
      hideWindow();
      setTimeout(pasteIntoActiveApp, 120);
    }
    return true;
  });
  ipcMain.handle('window:hide', () => hideWindow());
  ipcMain.handle('window:show', () => showWindow());
  ipcMain.handle('window:quit', () => app.quit());

  if (process.argv.includes('--show')) showWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(pollTimer);
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
