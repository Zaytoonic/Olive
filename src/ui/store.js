// The window's main logic, without drawing anything: the mic list, the controls, capture, Windows mic control,
// where sounds play, the mic test, and start().
// Other parts live beside it: core.js (settings, view, helpers), prefs.js (saving), keys.js (mic key, mute hotkey,
// push to talk), meters.js (the level meters), eq.js (the mic EQ), cable.js (sending to the virtual cable, first-run
// setup), app-settings.js (badge, updates, start with Windows) and test-bridge.js (for tools/audio-test).
// Components import everything from here.
import { EQ_BANDS, eq, eqBandsReset } from './eq-model.js';
import { engine, dbToPct, state, view, ui, setStatus, showNotice, cleanErr } from './core.js';
import { pref, loadPrefs, savePrefs, scheduleSave } from './prefs.js';
import { hotkeyChoosing, pttChoosing, talking, talkFade, initMuteHotkey, initPtt } from './keys.js';
import { initBadge, initUpdates, initStartup } from './app-settings.js';
import { isHidden, resetLevel, syncTicker } from './meters.js';
import { switchEqTo, presetShown } from './eq.js';
import { isCableLabel, sendHint, updateSendStatus, setSend, setFreshInstall, updateSetup } from './cable.js';

// What the components use from the other parts.
export { dbToPct, state, getView, useView } from './core.js';
export { PREFS_KEY, savePrefs } from './prefs.js';
export { hotkeyLabel, setMuteHotkeyOn, startChoosingHotkey, setPtt, startChoosingPtt } from './keys.js';
export { setMeterEls, resetGateChip, syncTicker } from './meters.js';
export {
  attachEqGraph, applyEq, eqEdited, eqEditEnd, selectBand, resetSelectedBand, choosePreset, setEqOn, setLowCut, setEqOpen, holdCompare
} from './eq.js';
export { isCableLabel, updateSendStatus, updateSetup, setupDownload, setupCheck, setupFinished, setupShow } from './cable.js';
export { setBadge, setBadgeCorner, pressUpdate, openReleaseNotes, setUpdateAuto, setStartup, setSettingsOpen, settingsReasons } from './app-settings.js';

export let devices = [];
let devicesChecked = false;
export let live = false;     // true when devices come from the system

// ---- Device list ----
function renderDevices() {
  ui({
    devices: devices.map(d => ({ id: d.id, name: d.name })), micDisabled: !devices.length,
    micPlaceholder: devicesChecked ? 'No microphone found' : 'Looking for microphones…',
    micNotice: live && pref.deviceName && !preferredDevice() ? `${pref.deviceName} isn't connected. Using ${currentDevice().name} until it's back.` : ''
  });
}
export function selectDevice(id) {
  if (!id || id === state.deviceId) return;
  state.deviceId = id;
  pref.deviceId = id;
  pref.deviceName = (devices.find(d => d.id === id) || {}).name || null;
  if (live) switchEqTo(pref.deviceName);
  savePrefs();
  resetLevel();
  renderDevices();
  applySysToUi();
  if (live) startCapture();
}
export const currentDevice = () => devices.find(d => d.id === state.deviceId) || devices[0] || null;
// The mic you chose, if it's connected right now. Device IDs can change between launches, so its name counts too.
function preferredDevice() {
  const byId = devices.find(d => d.id === pref.deviceId);
  if (byId) return byId;
  const byName = pref.deviceName ? devices.filter(d => d.name === pref.deviceName) : [];
  return byName.length === 1 ? byName[0] : null;
}

// ---- Controls ----
export function setVolume(v) {
  state.volume = v;
  if (curSys()) pushSysVolume(); else updateVolumeGain();
  ui(); scheduleSave();
}
export function setGateDb(v) { state.gateDb = v; updateGate(); scheduleSave(); }
// Switches save at once; sliders save shortly after each move, and at once when let go (bits.jsx).
export function setGateAuto(on) { state.gateAuto = on; updateGate(); savePrefs(); }
export function setNr(on) { state.nr = on; applyNr(); updateHints(); savePrefs(); }
export function setNrAmount(v) { state.nrAmount = v; applyNr(); updateHints(); scheduleSave(); }
export function setMono(on) { state.mono = on; applyMono(); savePrefs(); }
export function setSendWanted(on) { pref.send = on; savePrefs(); setSend(on); }
export function setMonitorVol(v) { state.monitorVol = v; engine.set({ monitorVol: v }); updateHints(); scheduleSave(); }
export function setComp(on) { state.comp = on; applyComp(); updateHints(); savePrefs(); }
export function setCompAmount(v) { state.compAmount = v; applyComp(); updateHints(); scheduleSave(); }
// Ctrl+M while this window has focus. Not while a new hotkey or talk key is being chosen (keys.js).
document.addEventListener('keydown', e => { if (e.ctrlKey && !e.altKey && !e.repeat && e.key.toLowerCase() === 'm' && !hotkeyChoosing && !pttChoosing) toggleMute(); });

export function toggleMute() { const m = !state.muted; setAllMuted(m); playMuteSound(m); }
// Only for a mute you asked for, not when syncing with Windows. Plays on your speakers only: it isn't part of the mic chain, so Discord never hears it.
export const muteSound = new Audio('../../assets/mute.wav'), unmuteSound = new Audio('../../assets/unmute.wav');
muteSound.preload = unmuteSound.preload = 'auto';
export function playMuteSound(muting) {
  for (const s of [muteSound, unmuteSound]) { s.pause(); s.currentTime = 0; }
  if (state.muteSounds) (muting ? muteSound : unmuteSound).play().catch(() => {});
}
// The slider follows loudness rather than raw level: halfway sounds about half as loud.
function applyMuteSoundVol() {
  muteSound.volume = unmuteSound.volume = (state.muteSoundVol / 100) ** 2;
  ui({ soundHint: state.muteSounds ? "Play where Listen plays. Discord doesn't hear them" : 'Off: muting and unmuting are silent' });
}
export function setMuteSounds(on) { state.muteSounds = on; applyMuteSoundVol(); if (on) playMuteSound(true); savePrefs(); }
export function setMuteSoundVol(v) { state.muteSoundVol = v; applyMuteSoundVol(); scheduleSave(); }
export const previewMuteSound = () => playMuteSound(true);   // let go of the slider: hear the new level

// Mute means everything agrees: the app, the selected mic, and the Windows recording devices Discord could listen to
// (the virtual cable and the default device). Otherwise unmuting here could leave the cable muted, and Discord silent.
export function setAllMuted(m) {
  setMutedUi(m);
  const ep = curSys();
  if (!ep) return;
  sysTouched = performance.now();
  sysApi.setMute(ep.id, m).then(r => storeSys(r)).catch(sysFailed);
  for (const e of linkedEndpoints()) if (e.id !== ep.id && e.muted !== m) sysApi.setMute(e.id, m).then(r => storeSys(r)).catch(sysFailed);
}
const linkedEndpoints = () => sysEndpoints.filter(e => e.isDefault || isCableLabel(e.name));
export function setMutedUi(m) {
  state.muted = m;
  syncTalking();
  updateSendStatus();
  ui();
  if (window.appMute) window.appMute.setState(state.muted);
}
export function setMonitor(on) {
  state.monitor = on;                           // not saved: Listen at launch could cause feedback
  engine.set({ monitor: on, monitorVol: state.monitorVol });
  updateHints();
}
function applyMono() {
  ui({ monoHint: state.mono ? 'On: left and right mixed, heard in both ears' : 'Off: stereo mics keep left and right separate' });
  engine.set({ mono: state.mono });
}
// With Windows control the captured audio already has the Windows level applied, so the app adds no gain.
export const volFactor = () => (curSys() ? 1 : state.volume / 75);
function updateVolumeGain() { engine.set({ inputGain: volFactor() }); }
export function applyNr() { engine.set({ nr: state.nr, nrAmount: state.nrAmount }); }
function applyComp() { engine.set({ comp: state.comp, compAmount: state.compAmount }); updateCompHint(); }
export function updateCompHint() {
  if (!state.comp) { ui({ compHint: 'Your volume goes out as-is' }); return; }
  const r = engine.compReduction();
  const text = r < -0.5 ? `Evening out ${(-r).toFixed(1)} dB` : 'Evens out your volume';
  if (text !== view.compHint) ui({ compHint: text });
}
// Mute and push to talk silence what leaves Olive (Listen and the cable).
export function syncTalking() { engine.set({ talking: talking(), talkFade: talkFade() }); }
const gateDbNow = () => (state.gateAuto ? engine.autoGateDb : state.gateDb);
let shownGate = '';
export function updateGate() {
  shownGate = '';                                // the hint depends on Auto too, not only on the number shown
  refreshGateUi();
  engine.set({ gateDb: state.gateDb, gateAuto: state.gateAuto });
  ui();
}
export function refreshGateUi() {
  const t = Math.round(gateDbNow()), st = engine.status();
  const byVoice = state.gateAuto && st.voiceGate;
  const label = byVoice ? 'Voice' : t + ' dB';   // the Auto chip beside it says whether it's automatic
  if (label === shownGate) return;
  shownGate = label;
  ui({
    gateVal: label, gateMarkHidden: !!byVoice, gateMarkPct: dbToPct(t),
    gateHint: !byVoice && st.gateFailed ? 'Using the backup gate, which can clip the start of words' : byVoice ? 'Opens when it hears a voice, so fans and bumps stay out' : state.gateAuto ? 'Mutes you when you go quiet; follows your background noise' : "Mutes you when you're quieter than this"
  });
}
export function updateHints() {
  const st = engine.status();
  ui({
    nrHint: !state.nr ? 'Off: nothing is removed'
      : st.nrFailed ? 'Unavailable: the noise reduction engine could not start'
      : st.voiceFailed ? "Using the backup noise reduction: the voice engine couldn't start"
      : 'Lowers fans, rumble and hiss. Turn it down to mix your natural sound back in',
    monHint: !state.monitor ? "You won't hear yourself" : engine.capturing ? 'Use headphones to avoid echo' : 'On · microphone not open, nothing to play',
    ...(engine.micTest ? {} : { testDisabled: !engine.capturing })
  });
}

// ---- Live input ----
function stopCapture() { engine.stopCapture(); }
async function startCapture() {
  try { if (await engine.capture(state.deviceId)) setStatus(''); }
  catch (err) { setStatus(micError(err)); }
  updateHints();
}
function micError(err) {
  if (err.name === 'NotAllowedError') return 'Windows is blocking microphone access. Check Settings > Privacy & security > Microphone.';
  if (err.name === 'NotReadableError') return "This microphone isn't responding, or another app has taken it over.";
  if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return "This microphone isn't connected any more.";
  return `Couldn't open this microphone (${err.name}).`;
}
const captureIsCurrent = () => engine.isCapturing(state.deviceId);

export async function loadDevices(opts) {
  if (!(opts && opts.retry)) startupRetries = 0;   // a start, refresh or device change: look for another minute
  setStatus('');
  let found = [];
  try {
    // Ask once so Windows reveals device names.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach(tr => tr.stop());
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications' && !isCableLabel(d.label));
    // The default entry's label is "Default - <device label>"; two mics on one sound card share a group, so match the label.
    const defaultEntry = all.find(d => d.kind === 'audioinput' && d.deviceId === 'default');
    const defaultLabel = defaultEntry ? defaultEntry.label.replace(/^[^-]*-\s*/, '') : null;
    found = inputs.filter(d => d.deviceId !== 'default').map(d => ({
      id: d.deviceId,
      name: d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '') || 'Microphone',
      isDefault: d.label === defaultLabel
    }));
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus(micError(err));   // the dropdown already says none was found
  }
  live = found.length > 0;
  devices = found;
  devicesChecked = true;
  if (!live && !view.devStatus) setStatus('Plug in a microphone, then press refresh.');
  // Your chosen mic whenever it's connected, so plugging it back in returns to it; otherwise stay put, or use the default.
  const wanted = preferredDevice();
  if (wanted) state.deviceId = wanted.id;
  else if (live && !devices.some(d => d.id === state.deviceId)) state.deviceId = (devices.find(d => d.isDefault) || devices[0]).id;
  if (live) switchEqTo(currentDevice().name);
  renderDevices();
  updateHints();
  if (!live) stopCapture();
  else if (!captureIsCurrent()) startCapture();
  syncSystem();
  if (pref.send) await setSend(true);   // (re)connect the cable at start-up, after a rescan or a device change
  if (live) await loadOutputs();
  await updateSetup();
  retryWhileAudioStartsUp();
}
// Right after login, Windows audio can still be starting: no mics or no cable yet, and no event when they appear.
// Keep looking for a minute after that (or after any device change or refresh), and stop as soon as everything is there.
let startupRetries = 0, startupRetryTimer = null;
function retryWhileAudioStartsUp() {
  clearTimeout(startupRetryTimer);
  if (live && (!pref.send || engine.hasSend)) { startupRetries = 0; return; }
  if (startupRetries >= 12) {
    if (!live) setStatus('Still no microphone after a minute, so Olive stopped looking. Plug one in, or press refresh to try again.');
    return;
  }
  startupRetries++;
  startupRetryTimer = setTimeout(() => loadDevices({ retry: true }), 5000);
}

// ---- Windows microphone control (volume + mute) ----
// window.sysMic comes from preload.js (Electron on Windows). Elsewhere it is missing and everything stays in-app.
export const sysApi = window.sysMic || null;
export let sysStatus = sysApi ? 'connecting' : 'none';   // connecting | ready | error | none
export let sysEndpoints = [];
let sysError = '';
const sysMap = new Map();                          // browser deviceId -> Windows endpoint
let sysTouched = 0, volInflight = false, volQueued = false, volSent = null;   // volSent: last {id, level} sent
export const curSys = () => (live && sysStatus === 'ready' && sysMap.get(state.deviceId)) || null;
const normName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function matchEndpoints() {
  sysMap.clear();
  const eps = sysEndpoints.filter(e => normName(e.name));
  for (const d of devices) {
    const n = normName(d.name);
    if (!n) continue;
    let c = eps.filter(e => normName(e.name) === n);
    if (!c.length) c = eps.filter(e => n.includes(normName(e.name)) || normName(e.name).includes(n));
    if (c.length === 1) sysMap.set(d.id, c[0]);   // ambiguous (identical names) -> leave in-app
  }
}
async function syncSystem() {
  if (!sysApi || !live) { applySysToUi(); return; }
  try {
    const list = await sysApi.list();
    sysEndpoints = Array.isArray(list) ? list : [];
    sysStatus = 'ready'; sysError = '';
  } catch (err) {
    sysStatus = 'error'; sysError = cleanErr(err);
  }
  matchEndpoints();
  applySysToUi();
  const ep = curSys();                                 // starting up: if anything is muted, say so and make it all agree
  if (ep) { const m = ep.muted || linkedEndpoints().some(e => e.muted); if (m !== state.muted || linkedEndpoints().some(e => e.muted !== m)) setAllMuted(m); }
}
// Store a fresh endpoint snapshot from Windows; returns true if level/mute changed.
export function storeSys(ep) {
  if (!ep || !ep.id) return false;
  const old = sysEndpoints.find(e => e.id === ep.id);
  if (!old) return false;
  const changed = old.volume !== ep.volume || old.muted !== ep.muted;
  old.volume = ep.volume; old.muted = ep.muted;
  return changed;
}
function sysFailed(err) { setStatus('Windows mic control failed: ' + cleanErr(err)); applySysToUi(); }
export function applySysToUi() {
  const ep = curSys();
  if (ep) {
    volSent = null;
    state.volume = Math.round(ep.volume * 100);
    if (ep.muted !== state.muted) setMutedUi(ep.muted);
    ui({ volumeHint: '', volumeHintTitle: '', volumeTitle: 'Sets the Windows mic level and mute · affects all apps' });
  } else {
    ui({
      volumeHint: !live ? 'No microphone'
        : sysStatus === 'connecting' ? 'Connecting to Windows audio…'
        : sysStatus === 'ready' ? "In this app only · couldn't match this mic to a Windows device"
        : sysStatus === 'error' ? 'In this app only · Windows control unavailable'
        : 'In this app only',
      volumeHintTitle: sysError, volumeTitle: ''
    });
  }
  ui({ muteTitle: ep ? 'Mute this mic in Windows (Ctrl+M)' : 'Toggle mute (Ctrl+M)' });
  updateVolumeGain();
}
// Something here just changed the Windows mic: hold off the background check for a moment.
export function touchSys() { sysTouched = performance.now(); }
// Send the latest slider value; at most one request in flight, extra moves collapse into one.
function pushSysVolume() {
  const ep = curSys();
  if (!ep) return;
  sysTouched = performance.now();
  if (volInflight) { volQueued = true; return; }
  const target = state.volume / 100;
  if (volSent && volSent.id === ep.id && volSent.level === target) return;   // nothing new to send
  volInflight = true;
  volSent = { id: ep.id, level: target };
  sysApi.setVolume(ep.id, target)
    .then(r => { storeSys(r); })
    .catch(err => { volSent = null; sysFailed(err); })
    .finally(() => {
      volInflight = false;
      if (volQueued) { volQueued = false; pushSysVolume(); }
    });
}
// Pick up changes made elsewhere (Windows Sound settings, other apps). Less often while hidden; the tray icon still follows.
let hiddenPolls = 0, sysPollFailures = 0;
async function pollSys() {
  const ep = curSys();
  if (!ep || volInflight || performance.now() - sysTouched < 1500) return;
  if (isHidden() && ++hiddenPolls % 5) return;
  try {
    const r = await sysApi.get(ep.id);
    if (sysPollFailures >= 3) setStatus('');
    sysPollFailures = 0;
    if (performance.now() - sysTouched < 1500 || curSys() !== ep) return;   // user acted meanwhile
    if (storeSys(r)) { applySysToUi(); setAllMuted(ep.muted); return; }      // the mic changed elsewhere: it wins
    for (const e of linkedEndpoints()) {
      if (e.id === ep.id) continue;
      const c = await sysApi.get(e.id);
      if (performance.now() - sysTouched < 1500) return;
      storeSys(c);
      if (c.muted !== state.muted) { setAllMuted(c.muted); return; }
    }
  } catch {
    if (++sysPollFailures === 3) setStatus('Lost contact with Windows mic control, so volume and mute may not apply. Still trying.');
  }
}

// ---- Where Listen and the mute sounds play ----
let appliedOutput = 'default';
async function setOutput(id) {
  if (id === appliedOutput) return;
  const sink = id === 'default' ? '' : id;
  await Promise.all([engine.setOutput(sink), muteSound.setSinkId(sink), unmuteSound.setSinkId(sink)]);
  appliedOutput = id;
}
export async function loadOutputs() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const outs = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications' && !isCableLabel(d.label));
    const list = outs.map(d => ({ id: d.deviceId, name: d.deviceId === 'default' ? 'Windows default' + (d.label ? ` (${d.label.replace(/^[^-]*-\s*/, '')})` : '') : d.label || 'Speakers' }));
    if (!outs.some(d => d.deviceId === 'default')) list.unshift({ id: 'default', name: 'Windows default' });
    const wanted = state.outputId === 'default' ? { deviceId: 'default' } : outs.find(d => d.deviceId === state.outputId) || outs.find(d => d.label === state.outputName);
    const pick = wanted ? wanted.deviceId : 'default';
    ui({ outputs: list, outputSelected: pick, outputHint: wanted ? '' : `${state.outputName || 'That device'} isn't connected. Using Windows default until it's back.` });
    await setOutput(pick);
  } catch (err) {
    ui({ outputHint: "Couldn't change where this plays: " + err.message });
  }
}
export function chooseOutput(id) {
  const o = view.outputs.find(x => x.id === id);
  if (!o) return;
  state.outputId = id;
  state.outputName = id === 'default' ? null : o.name;
  savePrefs();
  loadOutputs();
}

// ---- Mic test: record 5 s of what Olive sends, then play it back to you (the engine does the audio) ----
function showTest(label, phase, hint) { ui({ testLabel: label, testPhase: phase, ...(hint !== undefined ? { testHint: hint } : {}) }); }
const testHeard = e => (e.silent ? 'Nothing got through: the noise gate stayed shut. Talk louder, or turn the gate down'
  : e.toCable ? 'Playing back what Discord hears'
  : "Playing back Olive's sound. Send to Discord is off, so Discord hears your raw mic");
function onMicTest(e) {
  if (e.phase === 'recording') {
    showTest(`Recording · ${e.secondsLeft}`, 'recording', !e.first ? undefined : state.muted ? "Recording. You're muted, so nobody else hears this" : 'Recording. Talk the way you normally do');
  } else if (e.phase === 'playing') {
    showTest('Stop', 'playing', testHeard(e));
  } else {
    const hint = e.reason === 'error' ? "The mic test couldn't start: " + cleanErr(e.error)
      : e.reason === 'short' ? 'That was too short to play back. Try again'
      : e.reason === 'silent' ? testHeard(e) : '';
    showTest('Test mic', null, hint);
    ui({ testDisabled: !engine.capturing });
  }
}
export function pressTest() {
  const t = engine.micTest;
  if (!t) engine.startMicTest(onMicTest);
  else if (t.phase === 'recording') engine.finishRecording();
  else if (t.phase === 'playing') engine.endMicTest();
}

// ---- Start ----
export function start() {
  const savedPrefs = loadPrefs();
  setFreshInstall(!savedPrefs);
  if (state.send) sendHint('Connecting…');
  ui({ sendOn: state.send, eqPreset: presetShown() });
  renderDevices();
  engine.onChange(() => { shownGate = ''; refreshGateUi(); updateHints(); });
  engine.set({
    inputGain: volFactor(), gateDb: state.gateDb, gateAuto: state.gateAuto, nr: state.nr, nrAmount: state.nrAmount, mono: state.mono,
    comp: state.comp, compAmount: state.compAmount, eq, monitor: state.monitor, monitorVol: state.monitorVol,
    talking: talking(), talkFade: talkFade(), send: state.send
  });
  engine.init(EQ_BANDS);
  applyMono();
  updateGate(); updateHints(); updateCompHint();
  initStartup();
  initMuteHotkey();
  initPtt();
  initUpdates();
  applyMuteSoundVol();
  initBadge();
  if (eqBandsReset.length) {
    ui({ eqNotice: `${eqBandsReset.join(' and ')} had moved outside ${eqBandsReset.length > 1 ? 'their ranges' : 'its range'}, so ${eqBandsReset.length > 1 ? 'they were' : 'it was'} reset to flat.` });
    savePrefs();
  }
  if (window.appInfo) window.appInfo.notices().then(list => list.forEach(showNotice)).catch(() => {});
  syncTicker();
  applySysToUi();
  loadDevices();
  setInterval(pollSys, 2000);
  window.addEventListener('focus', pollSys);
  if (window.appInfo) window.appInfo.version().then(v => ui({ appVersion: 'Olive ' + v.replace(/\.0$/, '') })).catch(() => {});
  let deviceChangeTimer = null;
  navigator.mediaDevices.addEventListener('devicechange', () => { clearTimeout(deviceChangeTimer); deviceChangeTimer = setTimeout(loadDevices, 400); });
}

// For test-bridge.js: things it changes that only this file can.
export const storeTestVars = {
  startupRetries: [() => startupRetries, v => { startupRetries = v; }], startupRetryTimer: [() => startupRetryTimer],
  live: [() => live], devices: [() => devices]
};
