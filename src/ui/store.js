// Everything the window does, without drawing anything: your settings, Windows mic control, hotkeys, push to talk,
// saving, updates, and driving the audio engine (audio-engine.js, loaded before this bundle as window.engine).
// React components read the view through useView(); actions below change it. The level meters skip React:
// bindMeter() hands their elements to the meter timer, which only touches transforms and text.
import { useSyncExternalStore } from 'react';
import { EQ_BANDS, EQ_PRESETS, eq, resetBand, restoreEq, snapshotEq, applyPreset, eqBandsReset } from './eq-model.js';

const engine = window.engine;
const MIN_DB = -60;
export const dbToPct = db => Math.max(0, Math.min(100, (db - MIN_DB) / -MIN_DB * 100));
const ampToDb = a => (a <= 0 ? -Infinity : 20 * Math.log10(a));

// ---- Settings (saved) and the view (what the window shows) ----
export const state = {
  deviceId: null,
  volume: 75, muted: false, gateDb: -45, gateAuto: true,
  nr: true, nrAmount: 100, monitor: false, monitorVol: 80, mono: false, send: true, comp: false, compAmount: 50, muteHotkey: true, muteAccel: 'Control+Alt+M', eqOpen: false,
  ptt: false, pttKey: null, outputId: 'default', outputName: null, setupDone: false, updateAuto: true,
  muteSounds: true, muteSoundVol: 100, badge: true, badgeCorner: 'top-left'
};
let view = {
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
function ui(p = {}) {
  view = { ...view, ...p, st: { ...state } };
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; listeners.forEach(fn => fn()); });
}
const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const getView = () => view;
export const useView = sel => useSyncExternalStore(subscribe, () => sel(view));

let devices = [], devicesChecked = false;
let live = false;            // true when devices come from the system

// ---- Device list ----
function renderDevices() {
  ui({
    devices: devices.map(d => ({ id: d.id, name: d.name })), micDisabled: !devices.length,
    micPlaceholder: devicesChecked ? 'No microphone found' : 'Looking for microphones…',
    micNotice: live && prefDeviceName && !preferredDevice() ? `${prefDeviceName} isn't connected. Using ${currentDevice().name} until it's back.` : ''
  });
}
export function selectDevice(id) {
  if (!id || id === state.deviceId) return;
  state.deviceId = id;
  prefDeviceId = id;
  prefDeviceName = (devices.find(d => d.id === id) || {}).name || null;
  if (live) switchEqTo(prefDeviceName);
  savePrefs();
  peak = MIN_DB; smoothed = MIN_DB;
  renderDevices();
  applySysToUi();
  if (live) startCapture();
}
const currentDevice = () => devices.find(d => d.id === state.deviceId) || devices[0] || null;
// The mic you chose, if it's connected right now. Device IDs can change between launches, so its name counts too.
function preferredDevice() {
  const byId = devices.find(d => d.id === prefDeviceId);
  if (byId) return byId;
  const byName = prefDeviceName ? devices.filter(d => d.name === prefDeviceName) : [];
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
export function setSendWanted(on) { sendWanted = on; savePrefs(); setSend(on); }
export function setMonitorVol(v) { state.monitorVol = v; engine.set({ monitorVol: v }); updateHints(); scheduleSave(); }
export function setComp(on) { state.comp = on; applyComp(); updateHints(); savePrefs(); }
export function setCompAmount(v) { state.compAmount = v; applyComp(); updateHints(); scheduleSave(); }
document.addEventListener('keydown', e => { if (e.ctrlKey && !e.altKey && !e.repeat && e.key.toLowerCase() === 'm' && !hotkeyChoosing && !pttChoosing) toggleMute(); });

export function toggleMute() { const m = !state.muted; setAllMuted(m); playMuteSound(m); }
// Only for a mute you asked for, not when syncing with Windows. Plays on your speakers only: it isn't part of the mic chain, so Discord never hears it.
const muteSound = new Audio('../../assets/mute.wav'), unmuteSound = new Audio('../../assets/unmute.wav');
muteSound.preload = unmuteSound.preload = 'auto';
function playMuteSound(muting) {
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
function setAllMuted(m) {
  setMutedUi(m);
  const ep = curSys();
  if (!ep) return;
  sysTouched = performance.now();
  sysApi.setMute(ep.id, m).then(r => storeSys(r)).catch(sysFailed);
  for (const e of linkedEndpoints()) if (e.id !== ep.id && e.muted !== m) sysApi.setMute(e.id, m).then(r => storeSys(r)).catch(sysFailed);
}
const linkedEndpoints = () => sysEndpoints.filter(e => e.isDefault || isCableLabel(e.name));
function setMutedUi(m) {
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
// The meter's timer runs only while the window is showing. The audio needs none here: the engine runs its own backup gate.
let tickTimer = null;
function syncTicker() {
  const run = !isHidden();
  if (run === !!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
  if (run) { last = performance.now(); tickTimer = setInterval(tick, 33); }
}
function applyMono() {
  ui({ monoHint: state.mono ? 'On: left and right mixed, heard in both ears' : 'Off: stereo mics keep left and right separate' });
  engine.set({ mono: state.mono });
}
// With Windows control the captured audio already has the Windows level applied, so the app adds no gain.
const volFactor = () => (curSys() ? 1 : state.volume / 75);
function updateVolumeGain() { engine.set({ inputGain: volFactor() }); }
function applyNr() { engine.set({ nr: state.nr, nrAmount: state.nrAmount }); }
function applyComp() { engine.set({ comp: state.comp, compAmount: state.compAmount }); updateCompHint(); }
function updateCompHint() {
  if (!state.comp) { ui({ compHint: 'Your volume goes out as-is' }); return; }
  const r = engine.compReduction();
  const text = r < -0.5 ? `Evening out ${(-r).toFixed(1)} dB` : 'Evens out your volume';
  if (text !== view.compHint) ui({ compHint: text });
}
// Mute and push to talk silence what leaves Olive (Listen and the cable).
function syncTalking() { engine.set({ talking: talking(), talkFade: talkFade() }); }
const gateDbNow = () => (state.gateAuto ? engine.autoGateDb : state.gateDb);
let shownGate = '';
function updateGate() {
  shownGate = '';                                // the hint depends on Auto too, not only on the number shown
  refreshGateUi();
  engine.set({ gateDb: state.gateDb, gateAuto: state.gateAuto });
  ui();
}
function refreshGateUi() {
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
function updateHints() {
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

// ---- Level meters (outside React) ----
let smoothed = MIN_DB, peak = MIN_DB, peakHold = 0, last = performance.now();
let compTick = 0, windowHidden = false;
const meter = {};
let shownCover = '', shownPeak = '', shownDb = '', dbShownAt = 0, shownChip = null;
let sendShown = MIN_DB, shownSendDb = '', shownSendCover = '';
// Components hand over their meter elements: { cover, peak, levelDb, chip } and { sendCover, sendDb }.
// Returns the function that takes them back.
export function setMeterEls(els) {
  Object.assign(meter, els);
  shownCover = shownPeak = shownDb = shownSendDb = shownSendCover = ''; shownChip = null;
  return () => { for (const k of Object.keys(els)) if (meter[k] === els[k]) meter[k] = null; };
}
// Hidden = minimized / in the tray. Electron tells us via preload (document.hidden can't, see main.js).
const isHidden = () => windowHidden || document.hidden;
if (window.appWindow) window.appWindow.onVisibility(v => { windowHidden = !v; if (v && eqGraph) eqGraph.draw(); syncTicker(); });
document.addEventListener('visibilitychange', () => syncTicker());
function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const on = engine.capturing;
  let db = ampToDb(on ? engine.rawAmplitude() * volFactor() : 0);   // in-app: 75% = unity
  const open = on && engine.gateOpen();
  if (state.muted) db = -Infinity;
  if (isHidden()) { smoothed = MIN_DB; peak = MIN_DB; return; }   // hidden in the tray: no drawing
  drawGateChip(open);
  const target = Math.max(MIN_DB, Math.min(6, db));
  smoothed = target > smoothed ? target : smoothed - 40 * dt; // fast attack, slow release
  smoothed = Math.max(MIN_DB, smoothed);
  if (smoothed >= peak) { peak = smoothed; peakHold = 1; } else if ((peakHold -= dt) <= 0) peak = Math.max(MIN_DB, peak - 20 * dt);
  if ((compTick = (compTick + 1) % 8) === 0) {           // ~4x per second
    if (state.comp) updateCompHint();
    if (state.gateAuto) refreshGateUi();
  }
  // Only GPU-friendly transforms, and only when the value changed; text at most 5x per second.
  const cover = 'scaleX(' + (1 - dbToPct(smoothed) / 100).toFixed(3) + ')';
  if (cover !== shownCover && meter.cover) { meter.cover.style.transform = cover; shownCover = cover; }
  const pk = 'translateX(' + dbToPct(peak).toFixed(1) + '%)';
  if (pk !== shownPeak && meter.peak) { meter.peak.style.transform = pk; shownPeak = pk; }
  if (now - dbShownAt >= 200) {
    dbShownAt = now;
    const t = state.muted ? 'Muted' : (smoothed <= MIN_DB ? '-∞ dB' : smoothed.toFixed(1) + ' dB');
    if (t !== shownDb && meter.levelDb) { meter.levelDb.textContent = t; shownDb = t; }
    drawSendLevel();
  }
}
function drawGateChip(open) {
  const closedByKey = state.ptt && !pttOpen;
  const text = state.muted || !engine.capturing ? '' : closedByKey ? (state.pttKey ? `Hold ${state.pttKey.label} to talk` : 'Choose a talk key') : open ? 'Gate open' : 'Gate closed';
  if (text === shownChip || !meter.chip) return;
  shownChip = text;
  meter.chip.textContent = text;
  meter.chip.dataset.state = text === 'Gate open' ? 'open' : text ? 'closed' : 'none';
}
function drawSendLevel() {
  const amp = state.send ? engine.sendAmplitude() : null;
  if (amp === null || !meter.sendCover) return;
  const db = Math.max(MIN_DB, ampToDb(amp));
  sendShown = db > sendShown ? db : Math.max(db, sendShown - 8);
  const cover = 'scaleX(' + (1 - dbToPct(sendShown) / 100).toFixed(3) + ')';
  if (cover !== shownSendCover) { meter.sendCover.style.transform = cover; shownSendCover = cover; }
  const text = sendShown <= MIN_DB ? '-∞ dB' : sendShown.toFixed(1) + ' dB';
  if (text !== shownSendDb && meter.sendDb) { meter.sendDb.textContent = text; shownSendDb = text; }
}

// ---- Mic EQ ----
// Each mic keeps its own EQ, stored by name. A mic seen for the first time starts from the EQ in use.
const eqByMic = {};
let eqOwner = null, eqPresetPref = 'flat', eqGraph = null;
export function attachEqGraph(g) { eqGraph = g; return () => { if (eqGraph === g) eqGraph = null; }; }
const presetShown = () => (EQ_PRESETS[eqPresetPref] ? eqPresetPref : 'custom');
function switchEqTo(name) {
  if (!name) return;
  ui({ eqFor: 'Saved for ' + name });
  if (name === eqOwner) return;
  if (eqOwner) eqByMic[eqOwner] = snapshotEq(view.eqPreset);
  eqOwner = name;
  if (eqByMic[name]) { eqPresetPref = restoreEq(eqByMic[name]); ui({ eqPreset: presetShown() }); applyEq(); }
}
function applyEq() {
  engine.set({ eq });
  if (eqGraph) eqGraph.draw();
  ui({ eqVersion: view.eqVersion + 1 });
}
// The graph changed a band (dragging, keys, scroll): it's no longer a preset.
export function eqEdited() { if (view.eqPreset !== 'custom') ui({ eqPreset: 'custom' }); eqPresetPref = 'custom'; applyEq(); scheduleSave(); }
export const eqEditEnd = () => savePrefs();
export function selectBand(key) { ui({ eqSel: key }); if (eqGraph) eqGraph.draw(); }
export function resetSelectedBand() { if (view.eqSel) { resetBand(view.eqSel); eqEdited(); savePrefs(); } }
export function choosePreset(key) {
  const p = EQ_PRESETS[key]; if (!p) return;
  applyPreset(p); eqPresetPref = key; ui({ eqPreset: key }); applyEq(); savePrefs();
}
export function setEqOn(on) { eq.on = on; applyEq(); savePrefs(); }
export function setLowCut(on) { eq.lowCut = on; eqPresetPref = 'custom'; ui({ eqPreset: 'custom' }); applyEq(); savePrefs(); }
export function setEqOpen(open) {
  state.eqOpen = open === true;
  if (!state.eqOpen) ui({ eqSel: null }); else ui();
  savePrefs();
}
// Hold to compare: what you hear skips the EQ; what's sent keeps it.
export function holdCompare(on) { if (view.eqBypass === on) return; engine.set({ eqBypass: on }); ui({ eqBypass: on }); }

// ---- Live input ----
function stopCapture() { engine.stopCapture(); }
async function startCapture() {
  try { if (await engine.capture(state.deviceId)) setStatus(''); }
  catch (err) { setStatus(micError(err)); }
  updateHints();
}
function setStatus(msg) { ui({ devStatus: msg }); }
function showNotice(msg) { if (!view.appNotice.includes(msg)) ui({ appNotice: (view.appNotice ? view.appNotice + ' ' : '') + msg }); }
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
  if (sendWanted) await setSend(true);   // (re)connect the cable at start-up, after a rescan or a device change
  if (live) await loadOutputs();
  await updateSetup();
  retryWhileAudioStartsUp();
}
// Right after login, Windows audio can still be starting: no mics or no cable yet, and no event when they appear.
// Keep looking for a minute after that (or after any device change or refresh), and stop as soon as everything is there.
let startupRetries = 0, startupRetryTimer = null;
function retryWhileAudioStartsUp() {
  clearTimeout(startupRetryTimer);
  if (live && (!sendWanted || engine.hasSend)) { startupRetries = 0; return; }
  if (startupRetries >= 12) {
    if (!live) setStatus('Still no microphone after a minute, so Olive stopped looking. Plug one in, or press refresh to try again.');
    return;
  }
  startupRetries++;
  startupRetryTimer = setTimeout(() => loadDevices({ retry: true }), 5000);
}

// ---- Send to other apps (VB-Audio Virtual Cable) ----
const isCableLabel = l => /\bCABLE\b.*VB-Audio|VB-Audio Virtual Cable/i.test(l || '');
let sendToken = 0, sendWanted = true;
function sendHint(text, cls) {
  ui({
    sendHint: text, sendHintCls: cls || '',
    sendTitle: cls === 'on' ? 'Sending to the virtual cable. In Discord, choose "CABLE Output (VB-Audio Virtual Cable)" as your input device.' : 'Send the processed mic to VB-Audio Virtual Cable'
  });
}
// What other apps get right now, in words. The level bar only shows while the cable is connected.
function updateSendStatus() {
  const connected = engine.hasSend && state.send && live;
  ui({ sendLevelShown: connected });
  if (!connected) return;
  if (state.muted) sendHint('Muted: nothing is being sent', 'on');
  else if (state.ptt && !pttOpen) sendHint(state.pttKey ? `Push to talk: hold ${state.pttKey.label} to send` : 'Push to talk: choose a key below', 'on');
  else sendHint('Sending. In Discord, choose "CABLE Output" as your input', 'on');
}
let findCable = async function findCable() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const outs = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return outs.find(d => /CABLE Input/i.test(d.label)) || outs.find(d => isCableLabel(d.label)) || null;
};
function stopSending() { state.send = false; engine.set({ send: false }); engine.closeSend(); ui({ sendOn: false }); }
async function setSend(on) {
  const token = ++sendToken;
  if (!on) {
    stopSending();
    sendHint('Off: other apps hear your raw mic');
    updateSendStatus();
    return;
  }
  ui({ sendOn: true });
  try {
    const cable = await findCable();
    if (token !== sendToken) return;
    if (!cable) {
      stopSending();
      sendHint('VB-Audio Virtual Cable not found. Install it from vb-audio.com/Cable, restart the PC, then try again.', 'warn');
      updateSendStatus();
      return;
    }
    if (!engine.sendingTo(cable.deviceId)) {
      sendHint('Connecting…');
      state.send = false; engine.set({ send: false });
      if (!(await engine.openSend(cable.deviceId)) || token !== sendToken) return;
    }
    state.send = true;
    engine.set({ send: true });
    if (live) updateSendStatus(); else sendHint('On · but there is no microphone to send', 'warn');
    ui();
  } catch (err) {
    if (token !== sendToken) return;
    stopSending();
    sendHint("Couldn't send to the virtual cable (" + (err.name || 'Error') + ': ' + err.message + ')', 'warn');
    updateSendStatus();
  }
}

// ---- Windows microphone control (volume + mute) ----
// window.sysMic comes from preload.js (Electron on Windows). Elsewhere it is missing and everything stays in-app.
const sysApi = window.sysMic || null;
let sysStatus = sysApi ? 'connecting' : 'none';   // connecting | ready | error | none
let sysError = '', sysEndpoints = [];
const sysMap = new Map();                          // browser deviceId -> Windows endpoint
let sysTouched = 0, volInflight = false, volQueued = false, volSent = null;   // volSent: last {id, level} sent
const curSys = () => (live && sysStatus === 'ready' && sysMap.get(state.deviceId)) || null;
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
const cleanErr = err => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
// Store a fresh endpoint snapshot from Windows; returns true if level/mute changed.
function storeSys(ep) {
  if (!ep || !ep.id) return false;
  const old = sysEndpoints.find(e => e.id === ep.id);
  if (!old) return false;
  const changed = old.volume !== ep.volume || old.muted !== ep.muted;
  old.volume = ep.volume; old.muted = ep.muted;
  return changed;
}
function sysFailed(err) { setStatus('Windows mic control failed: ' + cleanErr(err)); applySysToUi(); }
function applySysToUi() {
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

// ---- Saved settings ----
// Restored on start: mic, volume (in-app), gate, mono, noise reduction, monitor level, EQ, send.
// Not restored on purpose: Listen (could cause feedback at launch) and Mute (Windows keeps its own).
export const PREFS_KEY = 'olive.settings.v1';
const OLD_PREFS_KEY = 'micManager.settings.v1';   // the old name, from before the rebrand
let prefDeviceId = null, prefDeviceName = null, saveTimer = null;
function loadPrefs() {
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
  if (typeof p.deviceId === 'string') { prefDeviceId = p.deviceId; state.deviceId = p.deviceId; }
  if (typeof p.deviceName === 'string') prefDeviceName = p.deviceName;
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
  if (typeof p.send === 'boolean') { sendWanted = p.send; state.send = p.send; }
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
  if (p.eqByMic && typeof p.eqByMic === 'object') Object.assign(eqByMic, p.eqByMic);
  const startEq = (prefDeviceName && eqByMic[prefDeviceName]) || p.eq;
  if (startEq && typeof startEq === 'object') eqPresetPref = restoreEq(startEq);
  eqOwner = prefDeviceName;
  return p;
}
export function savePrefs() {
  clearTimeout(saveTimer); saveTimer = null;
  const p = {
    deviceId: prefDeviceId, deviceName: prefDeviceName, volume: state.volume, gateDb: state.gateDb, gateAuto: state.gateAuto, mono: state.mono,
    nr: state.nr, nrStrength: state.nrAmount, monitorVol: state.monitorVol, send: sendWanted,
    ptt: state.ptt, pttKey: state.pttKey, outputId: state.outputId, outputName: state.outputName, setupDone: state.setupDone, updateAuto: state.updateAuto,
    comp: state.comp, compAmount: state.compAmount, muteHotkey: state.muteHotkey, muteAccel: state.muteAccel, eqOpen: state.eqOpen,
    muteSounds: state.muteSounds, muteSoundVol: state.muteSoundVol, badge: state.badge, badgeCorner: state.badgeCorner,
    eq: snapshotEq(view.eqPreset),
    eqByMic: eqOwner ? { ...eqByMic, [eqOwner]: snapshotEq(view.eqPreset) } : eqByMic
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (err) { showNotice("Your settings couldn't be saved, so changes will be lost when Olive closes: " + err.message); }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(savePrefs, 300); }
window.addEventListener('beforeunload', () => { if (saveTimer) savePrefs(); });

// ---- The laptop's mic key ----
// ASUS's own software answers the key by flipping mute on the Windows default recording device. So wait for that to land,
// then follow it. If nothing flipped (that software isn't running), an odd number of presses is a toggle.
// Everything compares with the state before the first press: the background check can notice ASUS's change and mute
// the app first, and comparing with the state at that point would read as "nothing flipped" and undo the mute.
const micKeyResult = (before, presses, defaultMuted) =>
  (defaultMuted !== null && defaultMuted !== before ? defaultMuted : presses % 2 ? !before : before);
let micKeyPresses = 0, micKeyTimer = null, micKeyBefore = false;
function onMicKey() {
  if (micKeyPresses === 0) micKeyBefore = state.muted;
  micKeyPresses++;
  sysTouched = performance.now();                      // hold off the background check while this settles
  clearTimeout(micKeyTimer);
  micKeyTimer = setTimeout(settleMicKey, 250);
}
async function settleMicKey() {
  const presses = micKeyPresses, before = micKeyBefore;
  micKeyPresses = 0;
  let def = null;
  if (sysApi && live && sysStatus === 'ready') {
    try { const list = await sysApi.list(); list.forEach(e => storeSys(e)); sysEndpoints.forEach(e => { const n = list.find(x => x.id === e.id); if (n) e.isDefault = n.isDefault; }); def = list.find(e => e.isDefault); } catch { /* use what we know */ }
  }
  const m = micKeyResult(before, presses, def ? def.muted : null);
  setAllMuted(m);
  if (m !== before) playMuteSound(m);
}

// ---- Mute hotkey and tray ----
// window.appMute comes from preload.js. The window may have been hidden for a while, so ask Windows for the
// current mute state first: otherwise the toggle could go the wrong way after something else changed it.
async function toggleMuteFromOutside() {
  const ep = curSys();
  if (ep) { try { storeSys(await sysApi.get(ep.id)); applySysToUi(); } catch { /* toggle from what we know */ } }
  toggleMute();
}
export const hotkeyLabel = a => a.replace('Control', 'Ctrl').replace('Super', 'Win');
async function applyMuteHotkey() {
  const label = hotkeyLabel(state.muteAccel);
  if (!state.muteHotkey) { await window.appMute.setHotkey(null); ui({ muteKeyHint: 'Off: Ctrl+M still works while this window has focus' }); return; }
  const ok = await window.appMute.setHotkey(state.muteAccel);
  ui({ muteKeyHint: ok ? `${label} mutes your mic from anywhere` : `${label} is already in use by another app` });
}
export function setMuteHotkeyOn(on) { state.muteHotkey = on; applyMuteHotkey(); savePrefs(); ui(); }
// Changing the shortcut: the next key combination pressed in this window becomes it.
// The old one is released while choosing, otherwise pressing it again would never reach this window.
let hotkeyChoosing = false;
function hotkeyFromEvent(e) {
  const letter = /^Key([A-Z])$/.exec(e.code), digit = /^Digit(\d)$/.exec(e.code), fn = /^F(?:[1-9]|1\d|2[0-4])$/.test(e.code);
  const key = letter ? letter[1] : digit ? digit[1] : fn ? e.code : null;
  if (!key) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (!fn && !mods.some(m => m !== 'Shift')) return null;   // a plain letter would stop typing it anywhere
  return [...mods, key].join('+');
}
function setHotkeyChoosing(on) { hotkeyChoosing = on; ui({ hotkeyChoosing: on }); }
export async function startChoosingHotkey() {
  if (hotkeyChoosing || !window.appMute) return;
  setHotkeyChoosing(true);
  await window.appMute.setHotkey(null);
  ui({ muteKeyHint: 'Press the new shortcut, or Esc to cancel' });
}
async function finishChoosingHotkey(accelerator) {
  setHotkeyChoosing(false);
  if (!accelerator) return applyMuteHotkey();
  if (await window.appMute.setHotkey(accelerator)) {
    state.muteAccel = accelerator;
    savePrefs();
    return applyMuteHotkey();
  }
  await applyMuteHotkey();
  ui({ muteKeyHint: `${hotkeyLabel(accelerator)} is already in use by another app. Keeping ${hotkeyLabel(state.muteAccel)}` });
}
window.addEventListener('keydown', e => {
  if (!hotkeyChoosing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code === 'Escape') { finishChoosingHotkey(null); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;   // still holding modifiers
  const accelerator = hotkeyFromEvent(e);
  if (accelerator) finishChoosingHotkey(accelerator);
  else ui({ muteKeyHint: 'Use Ctrl, Alt or Win with a letter or number, or an F key. Esc cancels' });
}, true);
window.addEventListener('blur', () => { if (hotkeyChoosing) finishChoosingHotkey(null); });
function initMuteHotkey() {
  if (!window.appMute) { ui({ muteKeyAvailable: false, muteKeyHint: 'Only in the Windows app' }); return; }
  window.appMute.onToggle(toggleMuteFromOutside);
  window.appMute.onMicKey(onMicKey);
  applyMuteHotkey();
}

// ---- Push to talk ----
// Silences what leaves Olive (the cable and Listen) unless the key is held. It doesn't touch Windows mute: that takes too long to follow a key.
const PTT_TAIL_MS = 200;                       // keeps the end of the last word after the key comes up
let pttOpen = false, pttTail = null, pttChoosing = false;
const talking = () => !state.muted && (!state.ptt || pttOpen);
const talkFade = () => (state.ptt && pttOpen ? 0.005 : 0.02);
function setPttOpen(open) { pttOpen = open; syncTalking(); updateSendStatus(); }
function onPttKey(down) {
  clearTimeout(pttTail);
  if (down) setPttOpen(true);
  else pttTail = setTimeout(() => setPttOpen(false), PTT_TAIL_MS);
}
function vkFromCode(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return { vk: m[1].charCodeAt(0), label: m[1] };
  if ((m = /^Digit(\d)$/.exec(code))) return { vk: 0x30 + +m[1], label: m[1] };
  if ((m = /^F(\d+)$/.exec(code)) && +m[1] >= 1 && +m[1] <= 24) return { vk: 0x6f + +m[1], label: code };
  if ((m = /^Numpad(\d)$/.exec(code))) return { vk: 0x60 + +m[1], label: 'Numpad ' + m[1] };
  const named = { Space: [0x20, 'Space'], CapsLock: [0x14, 'Caps Lock'], Tab: [0x09, 'Tab'], Backquote: [0xc0, '`'], ShiftLeft: [0xa0, 'Left Shift'], ShiftRight: [0xa1, 'Right Shift'],
    ControlLeft: [0xa2, 'Left Ctrl'], ControlRight: [0xa3, 'Right Ctrl'], AltLeft: [0xa4, 'Left Alt'], AltRight: [0xa5, 'Right Alt'], Insert: [0x2d, 'Insert'], Pause: [0x13, 'Pause'], ScrollLock: [0x91, 'Scroll Lock'] };
  return named[code] ? { vk: named[code][0], label: named[code][1] } : null;
}
function showPttHint() {
  let h;
  if (!state.ptt) h = 'Off: your mic is open unless you mute it';
  else if (!state.pttKey) h = 'Choose a key to hold while you talk';
  else if (!state.send) h = `Hold ${state.pttKey.label} to talk. Turn on Send to Discord too: apps using your mic directly aren't affected`;
  else h = /^[A-Z0-9]$/.test(state.pttKey.label) ? `Hold ${state.pttKey.label} to talk. It still types ${state.pttKey.label} in other apps` : `Hold ${state.pttKey.label} to talk`;
  ui({ pttHint: h, pttNotice: false });
}
async function applyPtt() {
  clearTimeout(pttTail);
  setPttOpen(false);
  showPttHint();
  shownChip = null;
  if (!window.appPtt) return;
  try {
    await window.appPtt.set(state.ptt && state.pttKey ? state.pttKey.vk : 0);
  } catch (err) {
    // Fails closed: staying silent is safer than an open mic you think is off.
    ui({ pttHint: "Couldn't watch the key, so your mic stays silent. Turn this off to talk: " + cleanErr(err), pttNotice: true });
  }
}
export function setPtt(on) {
  state.ptt = on;
  if (on && !state.pttKey) startChoosingPtt();
  applyPtt(); savePrefs(); ui();
}
function finishChoosingPtt(key) {
  pttChoosing = false;
  ui({ pttChoosing: false });
  if (key) { state.pttKey = key; savePrefs(); }
  applyPtt();
}
export function startChoosingPtt() {
  if (pttChoosing) return;
  pttChoosing = true;
  ui({ pttChoosing: true, pttHint: 'Press a key or a side mouse button, or Esc to cancel', pttNotice: false });
}
window.addEventListener('keydown', e => {
  if (!pttChoosing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code === 'Escape') { finishChoosingPtt(null); return; }
  const key = vkFromCode(e.code);
  if (key) finishChoosingPtt(key);
  else ui({ pttHint: "That key can't be used. Try a letter, an F key, Space, or a side mouse button. Esc cancels" });
}, true);
window.addEventListener('pointerdown', e => {
  if (!pttChoosing) return;
  const key = { 1: { vk: 0x04, label: 'Middle mouse' }, 3: { vk: 0x05, label: 'Mouse 4' }, 4: { vk: 0x06, label: 'Mouse 5' } }[e.button];
  if (!key) return;
  e.preventDefault(); e.stopImmediatePropagation();
  finishChoosingPtt(key);
}, true);
window.addEventListener('blur', () => { if (pttChoosing) finishChoosingPtt(null); });
function initPtt() {
  if (!window.appPtt) { ui({ pttAvailable: false, pttHint: 'Only in the Windows app' }); return; }
  window.appPtt.onKey(onPttKey);
  applyPtt();
}

// ---- Where Listen and the mute sounds play ----
let appliedOutput = 'default';
async function setOutput(id) {
  if (id === appliedOutput) return;
  const sink = id === 'default' ? '' : id;
  await Promise.all([engine.setOutput(sink), muteSound.setSinkId(sink), unmuteSound.setSinkId(sink)]);
  appliedOutput = id;
}
async function loadOutputs() {
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

// ---- First-run setup ----
let freshInstall = false;
async function updateSetup() {
  let found = false;
  try { found = !!(await findCable()); } catch { /* treated as not found */ }
  if (found && !freshInstall && !state.setupDone) { state.setupDone = true; savePrefs(); }
  ui({ setupCable: found ? 'Found: the virtual cable is installed.' : 'Not found yet.', setupDownloadShown: !found, setupCardShown: !state.setupDone, setupOpenShown: !found && state.setupDone });
}
export const setupDownload = () => { if (window.appInfo) window.appInfo.open('vbcable'); };
export const setupCheck = () => loadDevices();
export function setupFinished() { state.setupDone = true; savePrefs(); updateSetup(); }
export function setupShow() { state.setupDone = false; freshInstall = true; updateSetup(); }

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

// ---- Muted badge ----
// The badge is its own small window, made by main.js; this only says whether it's wanted and where.
function applyBadge(preview) {
  ui({ badgeHint: state.badge ? "Shows over other apps and windowed games while you're muted" : 'Off: the tray icon still turns red while muted' });
  if (window.appBadge) window.appBadge.set(state.badge, state.badgeCorner, preview).catch(() => {});
}
export function setBadge(on) { state.badge = on; applyBadge(true); savePrefs(); }
export function setBadgeCorner(c) { state.badgeCorner = c; applyBadge(true); savePrefs(); }
function initBadge() {
  if (!window.appBadge) { ui({ badgeAvailable: false, badgeHint: 'Only in the Windows app' }); return; }
  applyBadge(false);
}

// ---- Updates ----
// Install downloads the new installer, checks it against GitHub, and lets it replace this copy and open it again.
// A copy that wasn't installed (a build folder) gets Download instead, which opens the release page.
const UPDATE_EVERY_MS = 24 * 3600 * 1000;
let updating = false;
async function checkUpdates(asked) {
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
function initUpdates() {
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
async function initStartup() {
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

// ---- Start ----
export function start() {
  const savedPrefs = loadPrefs();
  freshInstall = !savedPrefs;
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
// ---- For the audio test (tools/audio-test), which drives the window from outside ----
// It was written against the old page, whose functions and settings were page globals; these give it the same names.
// $(id) finds elements by their old ids, including the hidden native <select> and switch inputs that React Aria
// renders inside its components (changing those drives the real components).
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
  restoreEq: src => { eqPresetPref = restoreEq(src); },
  snapshotEq: () => snapshotEq(view.eqPreset),
  showEqPreset: () => ui({ eqPreset: presetShown() }),
  syncEqUi: () => applyEq(),
  eqPoint: key => (eqGraph ? eqGraph.point(key) : null),
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
  freshInstall: [() => freshInstall, v => { freshInstall = v; }], startupRetries: [() => startupRetries, v => { startupRetries = v; }],
  startupRetryTimer: [() => startupRetryTimer], live: [() => live], findCable: [() => findCable, v => { findCable = v; }],
  pttOpen: [() => pttOpen], prefDeviceName: [() => prefDeviceName], devices: [() => devices],
  sendWanted: [() => sendWanted, v => { sendWanted = v; }], windowHidden: [() => windowHidden, v => { windowHidden = v; }]
};
for (const [k, [get, set]] of Object.entries(testVars)) Object.defineProperty(window, k, { get, set: set || (() => {}), configurable: true });
