// What every part of the store shares: the audio engine, your settings (state), the view the window draws from,
// and the few helpers they all use. React components read the view through useView(); ui() changes it.
import { useSyncExternalStore } from 'react';

export const engine = window.engine;
export const MIN_DB = -60;
export const dbToPct = db => Math.max(0, Math.min(100, (db - MIN_DB) / -MIN_DB * 100));
export const ampToDb = a => (a <= 0 ? -Infinity : 20 * Math.log10(a));

// ---- Settings (saved) and the view (what the window shows) ----
export const state = {
  deviceId: null,
  volume: 75, muted: false, gateDb: -45, gateAuto: true,
  nr: true, nrAmount: 100, monitor: false, monitorVol: 80, mono: false, send: true, comp: false, compAmount: 50, muteHotkey: true, muteAccel: 'Control+Alt+M', eqOpen: false,
  ptt: false, pttKey: null, outputId: 'default', outputName: null, setupDone: false, updateAuto: true,
  muteSounds: true, muteSoundVol: 100, badge: true, badgeCorner: 'top-left'
};
export let view = {
  st: { ...state },
  devices: [], micDisabled: true, micPlaceholder: 'Looking for microphones…', micNotice: '', devStatus: '', appNotice: '',
  testLabel: 'Test mic', testPhase: null, testHint: '', testDisabled: true,
  volumeHint: '', volumeHintTitle: '', volumeTitle: '', muteTitle: 'Toggle mute (Ctrl+M)',
  gateVal: '', gateMarkHidden: false, gateMarkPct: 0, gateHint: '',
  nrHint: '', compHint: 'Your volume goes out as-is', monHint: "You won't hear yourself", monoHint: '',
  sendOn: true, sendHint: 'Off: other apps hear your raw mic', sendHintCls: '', sendTitle: '', sendLevelShown: false,
  outputs: [{ id: 'default', name: 'Windows default' }], outputSelected: 'default', outputHint: '',
  eqPreset: 'flat', eqFor: '', eqNotice: '', eqSel: null, eqBypass: false, eqVersion: 0,
  setupCardShown: false, setupCable: '', setupDownloadShown: true, setupOpenShown: false,
  muteKeyAvailable: true, muteKeyHint: 'Ctrl+Alt+M mutes your mic from anywhere', hotkeyChoosing: false,
  pttAvailable: true, pttHint: 'Off: your mic is open unless you mute it', pttNotice: false, pttChoosing: false,
  soundHint: '', badgeAvailable: true, badgeHint: '',
  updateHint: "Asks GitHub once a day if there's a new version", updateBtnLabel: 'Check now', updateBtnDisabled: false, updateNotesShown: false, updateAvailable: null,
  startupOn: false, startupHint: 'Opens hidden in the tray when you log in', startupDisabled: false,
  appVersion: 'Olive', settingsOpen: false
};
const listeners = new Set();
let notifyQueued = false;
// Changes the view and tells React, once per task however many changes were made.
export function ui(p = {}) {
  view = { ...view, ...p, st: { ...state } };
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; listeners.forEach(fn => fn()); });
}
const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const getView = () => view;
export const useView = sel => useSyncExternalStore(subscribe, () => sel(view));

// ---- Messages ----
export function setStatus(msg) { ui({ devStatus: msg }); }
export function showNotice(msg) { if (!view.appNotice.includes(msg)) ui({ appNotice: (view.appNotice ? view.appNotice + ' ' : '') + msg }); }
export const cleanErr = err => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
