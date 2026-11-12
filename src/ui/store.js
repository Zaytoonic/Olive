// The window's main logic, without drawing anything: the mic list, the controls, the level meters, the EQ, capture,
// sending to the virtual cable, Windows mic control, where sounds play, first-run setup, the mic test, and start().
// Other parts live beside it: core.js (settings, view, helpers), prefs.js (saving), keys.js (mic key, mute hotkey,
// push to talk), app-settings.js (badge, updates, start with Windows) and test-bridge.js (for tools/audio-test).
// Components import everything from here. The level meters skip React: setMeterEls() hands their elements to the
// meter timer, which only touches transforms and text.
import { EQ_PRESETS, EQ_BANDS, eq, resetBand, restoreEq, snapshotEq, applyPreset, eqBandsReset } from './eq-model.js';
import { engine, MIN_DB, dbToPct, ampToDb, state, view, ui, setStatus, showNotice, cleanErr } from './core.js';
import { pref, loadPrefs, savePrefs, scheduleSave } from './prefs.js';
import { hotkeyChoosing, pttChoosing, pttOpen, talking, talkFade, initMuteHotkey, initPtt } from './keys.js';
import { initBadge, initUpdates, initStartup } from './app-settings.js';

// What the components use from the other parts.
export { dbToPct, state, getView, useView } from './core.js';
export { PREFS_KEY, savePrefs } from './prefs.js';
export { hotkeyLabel, setMuteHotkeyOn, startChoosingHotkey, setPtt, startChoosingPtt } from './keys.js';
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
  peak = MIN_DB; smoothed = MIN_DB;
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
// The meter's timer runs only while the window is showing. The audio needs none here: the engine runs its own backup gate.
let tickTimer = null;
export function syncTicker() {
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
export function applyNr() { engine.set({ nr: state.nr, nrAmount: state.nrAmount }); }
function applyComp() { engine.set({ comp: state.comp, compAmount: state.compAmount }); updateCompHint(); }
function updateCompHint() {
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
export function resetGateChip() { shownChip = null; }
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
export function applyEq() {
  engine.set({ eq });
  if (eqGraph) eqGraph.draw();
  ui({ eqVersion: view.eqVersion + 1 });
}
// For prefs.js: restore the EQ from saved settings (the chosen mic's own, if it has one), and what to save.
export function loadEqPrefs(p, deviceName) {
  if (p.eqByMic && typeof p.eqByMic === 'object') Object.assign(eqByMic, p.eqByMic);
  const startEq = (deviceName && eqByMic[deviceName]) || p.eq;
  if (startEq && typeof startEq === 'object') eqPresetPref = restoreEq(startEq);
  eqOwner = deviceName;
}
export const eqPrefs = () => ({
  eq: snapshotEq(view.eqPreset),
  eqByMic: eqOwner ? { ...eqByMic, [eqOwner]: snapshotEq(view.eqPreset) } : eqByMic
});
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

// ---- Send to other apps (VB-Audio Virtual Cable) ----
export const isCableLabel = l => /\bCABLE\b.*VB-Audio|VB-Audio Virtual Cable/i.test(l || '');
let sendToken = 0;
function sendHint(text, cls) {
  ui({
    sendHint: text, sendHintCls: cls || '',
    sendTitle: cls === 'on' ? 'Sending to the virtual cable. In Discord, choose "CABLE Output (VB-Audio Virtual Cable)" as your input device.' : 'Send the processed mic to VB-Audio Virtual Cable'
  });
}
// What other apps get right now, in words. The level bar only shows while the cable is connected.
export function updateSendStatus() {
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

// ---- First-run setup ----
let freshInstall = false;
export async function updateSetup() {
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

// For test-bridge.js: things it changes that only this file can.
export const testHooks = {
  restoreEq: src => { eqPresetPref = restoreEq(src); },
  showEqPreset: () => ui({ eqPreset: presetShown() }),
  eqPoint: key => (eqGraph ? eqGraph.point(key) : null),
  vars: {
    freshInstall: [() => freshInstall, v => { freshInstall = v; }], startupRetries: [() => startupRetries, v => { startupRetries = v; }],
    startupRetryTimer: [() => startupRetryTimer], live: [() => live], findCable: [() => findCable, v => { findCable = v; }],
    devices: [() => devices], windowHidden: [() => windowHidden, v => { windowHidden = v; }]
  }
};
