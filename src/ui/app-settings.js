// The settings you set once, behind the gear: the Muted badge, updates and start with Windows,
// and the dot on the gear when one of them needs you. Mute hotkey and push to talk are in keys.js.
import { state, view, ui, cleanErr, showNotice } from './core.js';
import { savePrefs } from './prefs.js';

// ---- Muted badge ----
// The badge is its own small window, made by main.js; this only says whether it's wanted and where.
function applyBadge(preview) {
  ui({ badgeHint: state.badge ? "Shows over other apps and windowed games while you're muted" : 'Off: the tray icon still turns red while muted' });
  if (window.appBadge) window.appBadge.set(state.badge, state.badgeCorner, preview).catch(() => {});
}
export function setBadge(on) { state.badge = on; applyBadge(true); savePrefs(); }
export function setBadgeCorner(c) { state.badgeCorner = c; applyBadge(true); savePrefs(); }
export function initBadge() {
  if (!window.appBadge) { ui({ badgeAvailable: false, badgeHint: 'Only in the Windows app' }); return; }
  applyBadge(false);
}

// ---- Updates ----
// Install downloads the new installer, checks it against GitHub, and lets it replace this copy and open it again.
// A copy that wasn't installed (a build folder) gets Download instead, which opens the release page.
const UPDATE_EVERY_MS = 24 * 3600 * 1000;
let updating = false;
export async function checkUpdates(asked) {
  if (!window.appInfo || updating) return;
  if (asked) ui({ updateHint: 'Checking…', updateBtnDisabled: true });
  let r;
  try { r = await window.appInfo.checkForUpdate(); } catch (err) { r = { status: 'unavailable', reason: cleanErr(err) }; }
  ui({ updateBtnDisabled: false });
  if (r.status === 'available') {
    ui({
      updateAvailable: r,
      updateHint: r.canInstall ? `Olive ${r.version} is available. Installing closes Olive for a few seconds` : `Olive ${r.version} is available`,
      updateBtnLabel: r.canInstall ? 'Install' : 'Download',
      updateNotesShown: !!r.canInstall          // Download already opens the release page
    });
  } else if (asked) {
    ui({ updateHint: r.status === 'current' ? "You're on the latest version" : "Couldn't check for updates: " + r.reason });
  }
}
async function installUpdate() {
  updating = true;
  ui({ updateBtnDisabled: true, updateHint: 'Downloading… 0%' });
  try {
    await window.appInfo.installUpdate();
    ui({ updateHint: 'Installing. Olive will close and open again in a few seconds' });
  } catch (err) {
    updating = false;
    ui({ updateBtnDisabled: false, updateHint: `Couldn't update: ${cleanErr(err)}. Try again, or download it from What's new` });
  }
}
export function pressUpdate() {
  const u = view.updateAvailable;
  if (!u) checkUpdates(true);
  else if (u.canInstall) installUpdate();
  else window.appInfo.open('release');
}
export const openReleaseNotes = () => { if (window.appInfo) window.appInfo.open('release'); };
export function setUpdateAuto(on) { state.updateAuto = on; savePrefs(); ui(); }
export function initUpdates() {
  if (window.appInfo) {
    window.appInfo.onUpdateProgress(p => { if (updating) ui({ updateHint: `Downloading… ${Math.floor(p * 100)}%` }); });
    window.appInfo.updateResult().then(r => {
      if (r.error) showNotice(`The update couldn't be installed, so Olive is still on ${r.version}: ${r.error}`);
      else if (r.updated) ui({ updateHint: `Updated to Olive ${r.version}` });
    }).catch(() => {});
  }
  const auto = () => { if (state.updateAuto) checkUpdates(false); };
  setTimeout(auto, 20000);
  setInterval(auto, UPDATE_EVERY_MS);
}

// ---- Start with Windows ----
// window.appStartup comes from preload.js; Windows keeps the setting (Settings > Apps > Startup).
export async function initStartup() {
  const api = window.appStartup || null;
  const off = msg => ui({ startupDisabled: true, startupOn: false, startupHint: msg });
  if (!api) return off('Only in the Windows app');
  try {
    const r = await api.get();
    if (!r.supported) return off(r.reason || 'Windows only');
    ui({ startupOn: r.enabled });
  } catch (err) { return off('Unavailable: ' + cleanErr(err)); }
}
export async function setStartup(want) {
  const api = window.appStartup;
  if (!api) return;
  ui({ startupOn: want });
  try {
    const r = await api.set(want);
    ui({ startupOn: r.enabled, startupHint: r.enabled === want ? 'Opens hidden in the tray when you log in' : 'Windows did not accept the change (check Settings > Apps > Startup)' });
  } catch (err) {
    ui({ startupOn: !want, startupHint: "Couldn't change it: " + cleanErr(err) });
  }
}

// ---- Settings panel ----
export const setSettingsOpen = open => ui({ settingsOpen: open });
// A dot on the gear when something in there needs you, so nothing important hides behind it.
export function settingsReasons(v) {
  const reasons = [];
  if (v.updateAvailable) reasons.push(`Olive ${v.updateAvailable.version} is available`);
  if (/in use/.test(v.muteKeyHint)) reasons.push('the mute hotkey is taken by another app');
  if (v.pttNotice) reasons.push("push to talk can't watch its key");
  return reasons;
}
