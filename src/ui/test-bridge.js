// ---- For the audio test (tools/audio-test), which drives the window from outside ----
// It was written against the old page, whose functions and settings were page globals; these give it the same names.
// $(id) finds elements by their old ids, including the hidden native <select> and switch inputs that React Aria
// renders inside its components (changing those drives the real components).
import { EQ_BANDS, eq, snapshotEq, eqBandsReset } from './eq-model.js';
import { state, view, ui, getView } from './core.js';
import { PREFS_KEY, OLD_PREFS_KEY, pref, savePrefs } from './prefs.js';
import { onMicKey, micKeyResult, applyPtt, applyMuteHotkey, pttOpen } from './keys.js';
import { checkUpdates, setSettingsOpen } from './app-settings.js';
import {
  muteSound, unmuteSound, sysApi, toggleMute, setMonitor, setSendWanted, loadDevices, selectDevice, selectBand, setEqOpen,
  eqEdited, applyEq, applyNr, updateGate, setMutedUi, updateSetup, loadOutputs, syncTicker, isCableLabel, currentDevice, updateHints,
  testHooks
} from './store.js';

const TEST_CONTROLS = {
  micSelect: '.olive-mic-select select', outputSelect: '.olive-output-select select', eqPreset: '.olive-preset select', badgeCorner: '.olive-badge-corner select',
  settingsPanel: '.olive-drawer-dialog', settingsScrim: '.olive-backdrop', soundVol: '[aria-label="Mute sound volume"] input',
  muteKeyToggle: 'input[aria-label="Mute hotkey"]', pttToggle: 'input[aria-label="Push to talk"]', soundToggle: 'input[aria-label="Mute sounds"]',
  badgeToggle: 'input[aria-label="Muted badge on screen"]', updateAuto: 'input[aria-label="Check for updates automatically"]', startupToggle: 'input[aria-label="Start with Windows"]',
  sendToggle: 'input[aria-label="Send to Discord / other apps"]', nrToggle: 'input[aria-label="Noise reduction"]', compToggle: 'input[aria-label="Compressor"]',
  monoToggle: 'input[aria-label="Mono audio"]', monToggle: 'input[aria-label="Mic monitoring"]', eqToggle: 'input[aria-label="Enable EQ"]'
};
const testGlobals = {
  state, eq, EQ_BANDS, PREFS_KEY, OLD_PREFS_KEY, muteSound, unmuteSound, sysApi, eqBandsReset, olive: null,
  toggleMute, setMonitor, savePrefs, loadDevices, selectDevice, selectBand, setEqOpen, eqEdited, applyEq, applyNr, updateGate, setMutedUi, onMicKey, micKeyResult,
  updateSetup, loadOutputs, syncTicker, applyPtt, applyMuteHotkey, checkUpdates, isCableLabel, currentDevice, updateHints,
  restoreEq: testHooks.restoreEq,
  snapshotEq: () => snapshotEq(view.eqPreset),
  showEqPreset: testHooks.showEqPreset,
  syncEqUi: () => applyEq(),
  eqPoint: testHooks.eqPoint,
  setView: p => ui(p),
  // The settings live in a drawer that only exists while open: these open it (resolving once it's on screen) and close it.
  openSettings: () => new Promise(resolve => {
    setSettingsOpen(true);
    const t0 = performance.now();
    (function wait() {
      if (document.querySelector('.olive-drawer-dialog')) setTimeout(() => resolve(true), 50);
      else if (performance.now() - t0 > 3000) resolve(false);
      else setTimeout(wait, 30);                // timers, not animation frames: the test copy's window is hidden
    })();
  }),
  closeSettings: () => new Promise(resolve => { setSettingsOpen(false); setTimeout(() => resolve(true), 400); }),
  $: id => document.getElementById(id) || (TEST_CONTROLS[id] ? document.querySelector(TEST_CONTROLS[id]) : null)
};
testGlobals.olive = { state, getView, eq, toggleMute, setMonitor, setSendWanted, savePrefs, loadDevices, selectBand, setEqOpen, setSettingsOpen, PREFS_KEY };
for (const [k, v] of Object.entries(testGlobals)) window[k] = v;
const testVars = {
  ...testHooks.vars,
  pttOpen: [() => pttOpen], prefDeviceName: [() => pref.deviceName],
  sendWanted: [() => pref.send, v => { pref.send = v; }]
};
for (const [k, [get, set]] of Object.entries(testVars)) Object.defineProperty(window, k, { get, set: set || (() => {}), configurable: true });
