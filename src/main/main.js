const { app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage, protocol, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// A simple window that mostly sits in the tray doesn't need the graphics process. Measured: about 150 MB less memory,
// the same CPU with a moving meter, still smooth; only scrolling and dragging cost a little more, while they happen.
app.disableHardwareAcceleration();

// Project layout: src/main (this file), src/renderer (the window), assets (icons).
const RENDERER = path.join(__dirname, '..', 'renderer');
const ASSETS = path.join(__dirname, '..', '..', 'assets');

// ---- app://local/gate-worklet.js, nr-worklet.js ----
// The noise gate and noise reduction run as AudioWorklets. Chromium won't load worklet code from file://, so these
// files are served from a private app:// address that allows the page to load it (no network involved).
// The page itself stays on file://, which keeps its saved settings.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
const WORKLETS = {
  '/gate-worklet.js': path.join(RENDERER, 'gate-worklet.js'),
  '/nr-worklet.js': path.join(RENDERER, 'nr-worklet.js'),
  '/voice-worklet.js': path.join(RENDERER, 'voice-worklet.js'),
  '/rnnoise-sync.js': path.join(RENDERER, 'vendor', 'rnnoise-sync.js')
};
function serveWorklet(request) {
  const url = new URL(request.url);
  const file = url.host === 'local' ? WORKLETS[url.pathname] : undefined;
  if (!file) return new Response('Not found', { status: 404 });
  return fs.promises.readFile(file)
    .then(data => new Response(data, { headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' } }))
    .catch(() => new Response('Not found', { status: 404 }));
}
const { HelperClient } = require('./sysmic-client');

// ---- Windows microphone control (volume + mute) via the win-audio helper ----
const HELPER_EXE = path.join(__dirname, 'win-audio.exe');
let helper = null;
function getHelper(allowRestart) {
  if (process.platform !== 'win32') return null;
  if (!helper || (helper.dead && allowRestart)) {
    if (helper) helper.stop();
    helper = fs.existsSync(HELPER_EXE)
      ? new HelperClient(HELPER_EXE, [])
      : new HelperClient('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-MTA', '-ExecutionPolicy', 'Bypass',   // MTA: firmware events arrive without a message loop
        '-File', path.join(__dirname, 'win-audio.ps1')
      ]);
    helper.onEvent = ev => { if (ev === 'mic-key' && win && !win.isDestroyed()) win.webContents.send('mute:mic-key'); };
    const started = helper;
    helper.onDeath = () => {                   // not when quitting; wait a little so a failing helper can't spin
      if (!quitting && helper === started) setTimeout(() => { if (!quitting) getHelper(true); }, 3000);
    };
  }
  return helper;
}
ipcMain.handle('sysmic', (event, cmd, ...args) => {
  if (!['list', 'get', 'setvol', 'setmute'].includes(cmd)) throw new Error('unknown command');
  if (cmd === 'setvol' && !(Number(args[1]) >= 0 && Number(args[1]) <= 1)) throw new Error('bad volume');
  const h = getHelper(cmd === 'list');      // a rescan may restart a helper that died
  if (!h) throw new Error('Windows only');
  return h.call(cmd, ...args);
});

// ---- Start with Windows: launches hidden in the tray at login ----
const HIDDEN_ARG = '--hidden';
const startedHidden = process.argv.includes(HIDDEN_ARG);
// Quoted: the install path has spaces, and an unquoted one makes Windows guess where the program name ends.
const loginItemOpts = () => ({ path: `"${process.execPath}"`, args: [HIDDEN_ARG] });
// A copy with its own settings folder is a test or a trial: it must never point Windows' login entry at itself.
const canRegisterAtLogin = () => process.platform === 'win32' && app.isPackaged && !app.commandLine.hasSwitch('user-data-dir');
function upgradeLoginItem() {                 // an entry saved by an older version has no quotes
  if (!canRegisterAtLogin()) return;
  const old = { path: process.execPath, args: [HIDDEN_ARG] };
  if (app.getLoginItemSettings(old).openAtLogin && !app.getLoginItemSettings(loginItemOpts()).openAtLogin) app.setLoginItemSettings({ openAtLogin: true, ...loginItemOpts() });
}
// Only the built app may register itself. From source (npm start) process.execPath is the bare electron.exe, which
// at login has no app to load and opens Electron's "run this command" welcome window.
ipcMain.handle('startup:get', () => {
  if (process.platform !== 'win32') return { supported: false, enabled: false };
  if (!canRegisterAtLogin()) return { supported: false, enabled: false, reason: app.isPackaged ? 'Not in a trial copy' : 'Only in the built app (MicManager.exe)' };
  return { supported: true, enabled: !!app.getLoginItemSettings(loginItemOpts()).openAtLogin };
});
ipcMain.handle('startup:set', (event, on) => {
  if (process.platform !== 'win32') throw new Error('Windows only');
  if (!canRegisterAtLogin()) throw new Error('Only in the installed copy of the app');
  app.setLoginItemSettings({ openAtLogin: on === true, ...loginItemOpts() });
  return { supported: true, enabled: !!app.getLoginItemSettings(loginItemOpts()).openAtLogin };
});

// ---- Window + tray: closing the window hides it; Quit is in the tray menu ----
let win = null, tray = null, quitting = false, trayHintShown = false;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  quitting = true;
  app.quit();
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;   // smaller screens get a window that still fits
  win = new BrowserWindow({
    width: Math.min(1120, area.width), height: Math.min(780, area.height), minWidth: 760, minHeight: 560,
    backgroundColor: '#0f1115', title: 'Mic Manager', autoHideMenuBar: true,
    show: false,                               // shown on ready-to-show, unless started hidden at login
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, spellcheck: false }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile(path.join(RENDERER, 'index.html'));
  win.once('ready-to-show', () => { if (!startedHidden) win.show(); });
  // With backgroundThrottling off, the page can't tell it's hidden (document.hidden stays false),
  // so tell it directly; it stops drawing while hidden or minimized.
  const sendVisible = v => { if (win && !win.isDestroyed()) win.webContents.send('window:visible', v); };
  win.on('hide', () => sendVisible(false));
  win.on('minimize', () => sendVisible(false));
  win.on('show', () => { sendVisible(!win.isMinimized()); updateTaskbarBadge(); });   // Windows forgets the badge while hidden
  win.on('restore', () => sendVisible(true));
  win.webContents.on('did-finish-load', () => sendVisible(win.isVisible() && !win.isMinimized()));
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();                        // keep running in the tray (audio keeps flowing)
    win.hide();
    if (!trayHintShown && tray && process.platform === 'win32') {
      trayHintShown = true;
      tray.displayBalloon({
        iconType: 'info',
        title: 'Mic Manager is still running',
        content: 'It keeps working in the background. Click the tray icon to open it, or right-click it and choose Quit.'
      });
    }
  });
  win.on('closed', () => { win = null; });
}

// ---- Mute from anywhere: a system-wide hotkey and the tray. The page owns the mute state and reports it back. ----
const VALID_HOTKEY = /^(?:(?:Control|Alt|Shift|Super)\+)*(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/;
let muted = false, lastPress = 0, muteHotkey = null;
function requestMuteToggle() {
  // Windows repeats a held hotkey (first repeat after about 500 ms), and each repeat restarts this wait,
  // so holding the keys toggles once however long they stay down.
  const now = Date.now(), repeat = now - lastPress < 600;
  lastPress = now;
  if (repeat) return;
  if (win && !win.isDestroyed()) win.webContents.send('mute:toggle');
}
ipcMain.handle('mute:state', (event, on) => { muted = on === true; updateTray(); updateTaskbarBadge(); });
// Registers this shortcut in place of the current one; none turns it off. Returns false if another app holds it.
ipcMain.handle('mute:hotkey', (event, accelerator) => {
  if (muteHotkey) globalShortcut.unregister(muteHotkey);
  muteHotkey = null;
  if (typeof accelerator !== 'string' || !VALID_HOTKEY.test(accelerator)) return false;
  let ok = false;
  try { ok = globalShortcut.register(accelerator, requestMuteToggle); } catch { ok = false; }
  if (ok) muteHotkey = accelerator;
  return ok;
});
ipcMain.handle('app:version', () => app.getVersion());

// A red slashed-mic badge on the taskbar button while muted, when the window is open.
function updateTaskbarBadge() {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  if (muted) win.setOverlayIcon(nativeImage.createFromPath(path.join(ASSETS, 'taskbar-muted-badge.png')), 'Microphone muted');
  else win.setOverlayIcon(null, '');
}

function updateTray() {
  if (!tray) return;
  tray.setImage(nativeImage.createFromPath(path.join(ASSETS, muted ? 'tray-icon-muted.png' : 'tray-icon.png')));
  tray.setToolTip(muted ? 'Mic Manager: muted' : 'Mic Manager');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Mic Manager', click: showWindow },
    { label: 'Mute microphone', type: 'checkbox', checked: muted, click: requestMuteToggle },
    { type: 'separator' },
    { label: 'Quit', click: quitApp }
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray-icon.png')));
  updateTray();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();                                  // already running: the other copy shows its window
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    upgradeLoginItem();
    protocol.handle('app', serveWorklet);
    // Allow microphone access for the app's own page only (no camera, no other permissions).
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      cb(permission === 'media' && (details.mediaTypes || []).every(t => t === 'audio'));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'speaker-selection');
    createTray();
    createWindow();
  });

  app.on('before-quit', () => { quitting = true; });   // Windows shutdown / sign-out also quits for real
  app.on('will-quit', () => { globalShortcut.unregisterAll(); if (helper) helper.stop(); });
  app.on('window-all-closed', () => { if (quitting && process.platform !== 'darwin') app.quit(); });
}
