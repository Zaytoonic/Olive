const { app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

// Project layout: src/main (this file), src/renderer (the window), assets (icons).
const RENDERER = path.join(__dirname, '..', 'renderer');
const ASSETS = path.join(__dirname, '..', '..', 'assets');

// ---- app://local/gate-worklet.js ----
// The noise gate runs as an AudioWorklet. Chromium won't load worklet code from file://, so this one
// file is served from a private app:// address that allows the page to load it (no network involved).
// The page itself stays on file://, which keeps its saved settings.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
const WORKLETS = { '/gate-worklet.js': path.join(RENDERER, 'gate-worklet.js') };
function serveWorklet(request) {
  const url = new URL(request.url);
  const file = url.host === 'local' ? WORKLETS[url.pathname] : undefined;
  if (!file) return new Response('Not found', { status: 404 });
  return fs.promises.readFile(file)
    .then(data => new Response(data, { headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' } }))
    .catch(() => new Response('Not found', { status: 404 }));
}
const { HelperClient } = require('./sysmic-client');

// ---- Windows microphone control (volume + mute) via win-audio.ps1 ----
let helper = null;
function getHelper(allowRestart) {
  if (process.platform !== 'win32') return null;
  if (!helper || (helper.dead && allowRestart)) {
    if (helper) helper.stop();
    helper = new HelperClient('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'win-audio.ps1')
    ]);
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
const loginItemOpts = () => ({ path: process.execPath, args: [HIDDEN_ARG] });
ipcMain.handle('startup:get', () => {
  if (process.platform !== 'win32') return { supported: false, enabled: false };
  return { supported: true, enabled: !!app.getLoginItemSettings(loginItemOpts()).openAtLogin };
});
ipcMain.handle('startup:set', (event, on) => {
  if (process.platform !== 'win32') throw new Error('Windows only');
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
  win = new BrowserWindow({
    width: 980, height: 680, minWidth: 760, minHeight: 560,
    backgroundColor: '#0f1115', title: 'Mic Manager', autoHideMenuBar: true,
    show: false,                               // shown on ready-to-show, unless started hidden at login
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, spellcheck: false }
  });
  win.loadFile(path.join(RENDERER, 'index.html'));
  win.once('ready-to-show', () => { if (!startedHidden) win.show(); });
  // With backgroundThrottling off, the page can't tell it's hidden (document.hidden stays false),
  // so tell it directly; it stops drawing while hidden or minimized.
  const sendVisible = v => { if (win && !win.isDestroyed()) win.webContents.send('window:visible', v); };
  win.on('hide', () => sendVisible(false));
  win.on('minimize', () => sendVisible(false));
  win.on('show', () => sendVisible(!win.isMinimized()));
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

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray-icon.png')));
  tray.setToolTip('Mic Manager');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Mic Manager', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: quitApp }
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();                                  // already running: the other copy shows its window
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
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
  app.on('will-quit', () => { if (helper) helper.stop(); });
  app.on('window-all-closed', () => { if (quitting && process.platform !== 'darwin') app.quit(); });
}
