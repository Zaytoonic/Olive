const { app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage, protocol, globalShortcut, screen, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// A simple window that mostly sits in the tray doesn't need the graphics process. Measured: about 150 MB less memory,
// the same CPU with a moving meter, still smooth; only scrolling and dragging cost a little more, while they happen.
app.disableHardwareAcceleration();

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
  '/recorder-worklet.js': path.join(RENDERER, 'recorder-worklet.js'),
  '/rnnoise.wasm': path.join(RENDERER, 'vendor', 'rnnoise.wasm')
};
function serveWorklet(request) {
  const url = new URL(request.url);
  const file = url.host === 'local' ? WORKLETS[url.pathname] : undefined;
  if (!file) return new Response('Not found', { status: 404 });
  const type = file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
  return fs.promises.readFile(file)
    .then(data => new Response(data, { headers: { 'content-type': type, 'access-control-allow-origin': '*' } }))
    .catch(() => new Response('Not found', { status: 404 }));
}
const { HelperClient } = require('./sysmic-client');
const { OLD_SETTINGS_FOLDER, migrateSettings, moveLoginEntry, repairLoginEntry } = require('./migrate');
const { GITHUB, checkForUpdate, downloadInstaller } = require('./updates');

// ---- Windows microphone control (volume + mute) via the win-audio helper ----
const HELPER_EXE = path.join(__dirname, 'win-audio.exe');
let helper = null, pttKey = 0;
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
    helper.onEvent = ev => {
      if (!win || win.isDestroyed()) return;
      if (ev === 'mic-key') win.webContents.send('mute:mic-key');
      else if (ev === 'ptt-down' || ev === 'ptt-up') win.webContents.send('ptt:key', ev === 'ptt-down');
    };
    const started = helper;
    if (pttKey) started.call('ptt', pttKey).catch(() => {});
    helper.onDeath = () => {                   // not when quitting; wait a little so a failing helper can't spin
      if (win && !win.isDestroyed()) win.webContents.send('ptt:key', false);   // a key the helper can't see any more counts as released
      if (!quitting && helper === started) setTimeout(() => { if (!quitting) getHelper(true); }, 3000);
    };
  }
  return helper;
}
ipcMain.handle('ptt:set', async (event, vk) => {
  const key = Number(vk);
  if (!Number.isInteger(key) || key < 0 || key > 255) throw new Error('bad key');
  pttKey = key;
  const h = getHelper(true);
  if (!h) throw new Error('Windows only');
  await h.call('ptt', key);
  return true;
});
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
// A copy with its own settings folder is a test copy: it must never point Windows' login entry at itself.
const canRegisterAtLogin = () => process.platform === 'win32' && app.isPackaged && !app.commandLine.hasSwitch('user-data-dir');
function upgradeLoginItem() {                 // an entry saved by an older version has no quotes
  if (!canRegisterAtLogin()) return;
  const old = { path: process.execPath, args: [HIDDEN_ARG] };
  if (app.getLoginItemSettings(old).openAtLogin && !app.getLoginItemSettings(loginItemOpts()).openAtLogin) app.setLoginItemSettings({ openAtLogin: true, ...loginItemOpts() });
}
const registerLoginItem = enabled => {
  app.setLoginItemSettings({ openAtLogin: true, enabled, ...loginItemOpts() });
  return !!app.getLoginItemSettings(loginItemOpts()).openAtLogin;
};
function fixLoginItem() {
  if (!canRegisterAtLogin()) return;
  if (moveLoginEntry(registerLoginItem) === 'failed') notices.push("Start with Windows couldn't be moved to Olive. Turn it on again below.");
  if (repairLoginEntry(process.execPath, registerLoginItem) === 'failed') notices.push("Olive's folder moved and Start with Windows couldn't follow it. Turn it on again below.");
}
// Only the built app may register itself. From source (npm start) process.execPath is the bare electron.exe, which
// at login has no app to load and opens Electron's "run this command" welcome window.
ipcMain.handle('startup:get', () => {
  if (process.platform !== 'win32') return { supported: false, enabled: false };
  if (!canRegisterAtLogin()) return { supported: false, enabled: false, reason: app.isPackaged ? 'Not in a test copy' : 'Only in the built app (Olive.exe)' };
  return { supported: true, enabled: !!app.getLoginItemSettings(loginItemOpts()).openAtLogin };
});
ipcMain.handle('startup:set', (event, on) => {
  if (process.platform !== 'win32') throw new Error('Windows only');
  if (!canRegisterAtLogin()) throw new Error('Only in the installed copy of the app');
  app.setLoginItemSettings({ openAtLogin: on === true, ...loginItemOpts() });
  return { supported: true, enabled: !!app.getLoginItemSettings(loginItemOpts()).openAtLogin };
});

// ---- Window + tray: closing the window hides it; Quit is in the tray menu ----
let win = null, tray = null, quitting = false;
const notices = [];                            // problems from starting up, for the page to show

// Every time the window is closed, say where Olive went. The first time explains it in full; after that, a short reminder.
const trayHintFile = () => path.join(app.getPath('userData'), 'tray-hint-shown');
function showTrayHint() {
  if (!tray || process.platform !== 'win32') return;
  const seenBefore = fs.existsSync(trayHintFile());
  if (!seenBefore) try { fs.writeFileSync(trayHintFile(), ''); } catch {}
  const size = Math.round(32 * screen.getPrimaryDisplay().scaleFactor);
  tray.displayBalloon({
    icon: nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: size, height: size, quality: 'best' }),
    largeIcon: true,
    noSound: true,
    title: 'Still running in the background',
    content: seenBefore
      ? 'Olive is in the tray by the clock (it may be under the ^ arrow). Right-click it and choose Quit to close it fully.'
      : 'Your mic settings stay on. To open Olive, click its icon by the clock (it may be under the ^ arrow). To close it fully, right-click that icon and choose Quit.'
  });
}

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
    backgroundColor: '#000000', title: 'Olive', autoHideMenuBar: true,
    show: false,                               // shown on ready-to-show, unless started hidden at login
    icon: path.join(ASSETS, 'icon.ico'),
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
    showTrayHint();
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
ipcMain.handle('mute:state', (event, on) => { muted = on === true; updateTray(); updateTaskbarBadge(); updateBadge(); });
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
ipcMain.handle('app:notices', () => notices.splice(0));
// ---- Updates ----
// Install: download the release's installer, check it, start it quietly and quit. The installer waits for Olive to close,
// replaces it (putting the old copy back if anything fails) and opens it again; a failure is written to UPDATE_LOG.
const isTestCopy = () => app.commandLine.hasSwitch('user-data-dir');
// A test copy may use a made-up release on this PC and a test name for everything the installer registers (tools/installer/test.js).
const testFeed = process.env.OLIVE_TEST_UPDATE_FEED, testTag = process.env.OLIVE_TEST_INSTALL_TAG;
const updateFeed = () => (testFeed && isTestCopy() ? { api: testFeed, page: /^http:\/\/127\.0\.0\.1:\d+\//, asset: /^http:\/\/127\.0\.0\.1:\d+\// } : GITHUB);
const UPDATE_LOG = () => path.join(app.getPath('userData'), 'update-error.txt');
const DOWNLOADS = () => path.join(app.getPath('temp'), 'olive-update');
// Only a copy the installer put there can update itself: it has the uninstaller beside it. Others get the release page.
const installDir = () => {
  const dir = path.dirname(process.execPath);
  return app.isPackaged && fs.existsSync(path.join(dir, 'Uninstall Olive.exe')) ? dir : null;
};
const fetchFn = (url, options) => net.fetch(url, options);
let releaseUrl = null, latest = null, installing = false;
const updateResult = { updated: process.argv.includes('--updated'), error: null };
function readUpdateResult() {
  try {
    updateResult.error = fs.readFileSync(UPDATE_LOG(), 'utf8').split(/\r?\n/)[0].replace(/^[\w.]+Exception: /, '').slice(0, 300) || 'unknown error';
    updateResult.updated = false;
    fs.rmSync(UPDATE_LOG(), { force: true });
  } catch { /* no log: the last update, if any, worked */ }
  // Installers from earlier updates; the last one may still be finishing, so wait a little.
  setTimeout(() => { if (!installing) fs.rm(DOWNLOADS(), { recursive: true, force: true }, () => {}); }, 60000);
}
ipcMain.handle('update:result', () => ({ ...updateResult, version: app.getVersion() }));
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return { status: 'unavailable', reason: 'only checks in the built app' };
  const result = await checkForUpdate(app.getVersion(), fetchFn, updateFeed());
  releaseUrl = result.url || releaseUrl;
  if (result.status === 'available') latest = result;
  return { status: result.status, version: result.version, reason: result.reason, canInstall: !!(result.installer && installDir()) };
});
ipcMain.handle('update:install', async event => {
  const dir = installDir(), release = latest;
  if (!release || !release.installer || !dir) throw new Error('this copy of Olive can only be updated from the release page');
  if (installing) throw new Error('already updating');
  installing = true;
  try {
    fs.mkdirSync(DOWNLOADS(), { recursive: true });
    const file = path.join(DOWNLOADS(), release.installer.name);
    await downloadInstaller(release.installer, fetchFn, file, p => { if (!event.sender.isDestroyed()) event.sender.send('update:progress', p); });
    fs.rmSync(UPDATE_LOG(), { force: true });
    // Opens again as it is now (same settings folder), shown, and knowing it was just updated.
    const again = ['--updated', ...process.argv.slice(1).filter(a => a !== HIDDEN_ARG && a !== '--updated')];
    const args = ['--silent', '--dir', dir, '--wait', String(process.pid), '--log', UPDATE_LOG(), '--relaunch'];
    if (testTag && isTestCopy()) args.push('--tag', testTag);
    const child = spawn(file, [...args, '--', ...again], { detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    setTimeout(quitApp, 500);                  // lets the page show "Installing" first
    return true;
  } catch (err) {
    installing = false;
    throw err;
  }
});
// The page names a link instead of passing an address, so nothing in it can open anything else.
ipcMain.handle('app:open', (event, name) => {
  const url = name === 'vbcable' ? 'https://vb-audio.com/Cable/' : name === 'release' ? releaseUrl : null;
  if (url) shell.openExternal(url);
});

// A red slashed-mic badge on the taskbar button while muted, when the window is open.
function updateTaskbarBadge() {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  if (muted) win.setOverlayIcon(nativeImage.createFromPath(path.join(ASSETS, 'taskbar-muted-badge.png')), 'Microphone muted');
  else win.setOverlayIcon(null, '');
}

// ---- Muted badge: a small "Muted" pill in a corner of the screen, over other apps and borderless games ----
// Its own little window: clicks go through it and it never takes focus. Made the first time it's needed.
const BADGE_SIZE = { width: 132, height: 52 }, BADGE_MARGIN = 12;
const CORNERS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-right'];
let badge = null, badgeOn = false, badgeCorner = 'top-left', badgePreviewUntil = 0, badgePreviewTimer = null;
function createBadge() {
  badge = new BrowserWindow({
    ...BADGE_SIZE, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, title: 'Olive muted',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  badge.setIgnoreMouseEvents(true);
  badge.setAlwaysOnTop(true, 'screen-saver');
  badge.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  badge.webContents.on('will-navigate', e => e.preventDefault());
  badge.loadFile(path.join(RENDERER, 'badge.html'));
  badge.once('ready-to-show', () => { badge.ready = true; updateBadge(); });
  badge.on('closed', () => { badge = null; });
}
// On the screen you're using (where the pointer is), inside the area the taskbar leaves free.
function placeBadge() {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, { width, height } = BADGE_SIZE;
  const [v, h] = badgeCorner.split('-');
  const x = h === 'left' ? area.x + BADGE_MARGIN : h === 'right' ? area.x + area.width - width - BADGE_MARGIN : area.x + Math.round((area.width - width) / 2);
  const y = v === 'top' ? area.y + BADGE_MARGIN : area.y + area.height - height - BADGE_MARGIN;
  badge.setBounds({ x, y, width, height });
}
function updateBadge() {
  const wanted = badgeOn && process.platform === 'win32' && (muted || Date.now() < badgePreviewUntil);
  if (!wanted) { if (badge && badge.isVisible()) badge.hide(); return; }
  if (!badge) return createBadge();
  if (!badge.ready) return;
  placeBadge();
  if (!badge.isVisible()) badge.showInactive();
  badge.setAlwaysOnTop(true, 'screen-saver');   // back on top of anything that went full screen since
}
ipcMain.handle('badge:set', (event, on, corner, preview) => {
  badgeOn = on === true;
  if (CORNERS.includes(corner)) badgeCorner = corner;
  clearTimeout(badgePreviewTimer);
  badgePreviewUntil = 0;
  if (preview === true && badgeOn && !muted) {   // after a change: show it for a moment so you can see where it goes
    badgePreviewUntil = Date.now() + 2500;
    badgePreviewTimer = setTimeout(updateBadge, 2600);
  }
  updateBadge();
});

function updateTray() {
  if (!tray) return;
  tray.setImage(nativeImage.createFromPath(path.join(ASSETS, muted ? 'tray-icon-muted.png' : 'tray-icon.png')));
  tray.setToolTip(muted ? 'Olive: muted' : 'Olive');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Olive', click: showWindow },
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
  tray.on('balloon-click', showWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();                                  // already running: the other copy shows its window
} else {
  // Holding the lock means no other copy is using this folder. A test copy's folder has no old folder beside it, so it starts clean.
  const settingsDir = app.getPath('userData');
  if (migrateSettings(path.join(path.dirname(settingsDir), OLD_SETTINGS_FOLDER), settingsDir) === 'failed') {
    notices.push("Couldn't bring over your Mic Manager settings, so Olive started with its defaults. The old settings are untouched.");
  }
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    readUpdateResult();
    fixLoginItem();
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
