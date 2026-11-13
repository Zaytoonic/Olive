// ---- Saved settings ----
// Restored on start: mic, volume (in-app), gate, mono, noise reduction, monitor level, EQ, send.
// Not restored on purpose: Listen (could cause feedback at launch) and Mute (Windows keeps its own).
import { state, showNotice } from './core.js';
import { loadEqPrefs, eqPrefs } from './eq.js';

export const PREFS_KEY = 'olive.settings.v1';
export const OLD_PREFS_KEY = 'micManager.settings.v1';   // the old name, from before the rebrand
// Saved wishes that can differ from what's happening now: the mic you chose (it may be unplugged)
// and whether you want Send on (it's off while the cable is missing).
export const pref = { deviceId: null, deviceName: null, send: true };
let saveTimer = null;

export function loadPrefs() {
  let p = null;
  try {
    const old = localStorage.getItem(OLD_PREFS_KEY);
    if (old !== null) {
      if (localStorage.getItem(PREFS_KEY) === null) localStorage.setItem(PREFS_KEY, old);
      localStorage.removeItem(OLD_PREFS_KEY);
    }
    p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
  } catch { p = null; }
  if (!p || typeof p !== 'object') return null;
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  if (typeof p.deviceId === 'string') { pref.deviceId = p.deviceId; state.deviceId = p.deviceId; }
  if (typeof p.deviceName === 'string') pref.deviceName = p.deviceName;
  state.volume = num(p.volume, 0, 100, state.volume);
  state.gateDb = num(p.gateDb, -60, -10, state.gateDb);
  if (typeof p.gateAuto === 'boolean') state.gateAuto = p.gateAuto;
  state.mono = p.mono === true;
  if (typeof p.nr === 'boolean') state.nr = p.nr;
  state.nrAmount = num(p.nrStrength, 0, 100, state.nrAmount);   // not the old nrAmount: that slider never changed the live audio
  state.monitorVol = num(p.monitorVol, 0, 100, state.monitorVol);
  state.comp = p.comp === true;
  state.compAmount = num(p.compAmount, 0, 100, state.compAmount);
  state.muteHotkey = p.muteHotkey !== false;
  if (typeof p.muteAccel === 'string') state.muteAccel = p.muteAccel;
  state.eqOpen = p.eqOpen === true;
  if (typeof p.send === 'boolean') { pref.send = p.send; state.send = p.send; }
  state.ptt = p.ptt === true;
  if (p.pttKey && Number.isInteger(p.pttKey.vk) && typeof p.pttKey.label === 'string') state.pttKey = { vk: p.pttKey.vk, label: p.pttKey.label };
  if (typeof p.outputId === 'string') state.outputId = p.outputId;
  if (typeof p.outputName === 'string') state.outputName = p.outputName;
  state.setupDone = p.setupDone === true;
  state.updateAuto = p.updateAuto !== false;
  state.muteSounds = p.muteSounds !== false;
  state.muteSoundVol = num(p.muteSoundVol, 5, 100, state.muteSoundVol);
  state.badge = p.badge !== false;
  if (['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-right'].includes(p.badgeCorner)) state.badgeCorner = p.badgeCorner;
  loadEqPrefs(p, pref.deviceName);
  return p;
}
export function savePrefs() {
  clearTimeout(saveTimer); saveTimer = null;
  const p = {
    deviceId: pref.deviceId, deviceName: pref.deviceName, volume: state.volume, gateDb: state.gateDb, gateAuto: state.gateAuto, mono: state.mono,
    nr: state.nr, nrStrength: state.nrAmount, monitorVol: state.monitorVol, send: pref.send,
    ptt: state.ptt, pttKey: state.pttKey, outputId: state.outputId, outputName: state.outputName, setupDone: state.setupDone, updateAuto: state.updateAuto,
    comp: state.comp, compAmount: state.compAmount, muteHotkey: state.muteHotkey, muteAccel: state.muteAccel, eqOpen: state.eqOpen,
    muteSounds: state.muteSounds, muteSoundVol: state.muteSoundVol, badge: state.badge, badgeCorner: state.badgeCorner,
    ...eqPrefs()
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (err) { showNotice("Your settings couldn't be saved, so changes will be lost when Olive closes: " + err.message); }
}
export function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(savePrefs, 300); }
window.addEventListener('beforeunload', () => { if (saveTimer) savePrefs(); });
