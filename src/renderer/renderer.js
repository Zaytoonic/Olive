let devices = [], devicesChecked = false;
let live = false;            // true when devices come from the system
const state = {
  deviceId: null,
  volume: 75, muted: false, gateDb: -45, gateAuto: true,
  nr: true, nrAmount: 100, monitor: false, monitorVol: 80, mono: false, send: true, comp: false, compAmount: 50, muteHotkey: true, muteAccel: 'Control+Alt+M', eqOpen: false,
  ptt: false, pttKey: null, outputId: 'default', outputName: null, setupDone: false, updateAuto: true,
  muteSounds: true, muteSoundVol: 100, badge: true, badgeCorner: 'top-left'
};

const $ = id => document.getElementById(id);
const MIN_DB = -60;
const dbToPct = db => Math.max(0, Math.min(100, (db - MIN_DB) / -MIN_DB * 100));
const ampToDb = a => (a <= 0 ? -Infinity : 20 * Math.log10(a));

// ---- Device list ----
function renderDevices() {
  const pick = $('micSelect');
  pick.innerHTML = '';
  pick.disabled = !devices.length;
  if (!devices.length) pick.add(new Option(devicesChecked ? 'No microphone found' : 'Looking for microphones…', ''));
  for (const d of devices) pick.add(new Option(d.name, d.id, false, d.id === state.deviceId));
  $('micNotice').textContent = live && prefDeviceName && !preferredDevice()
    ? `${prefDeviceName} isn't connected. Using ${currentDevice().name} until it's back.` : '';
}
function selectDevice(id) {
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
function bindControls() {
  $('volume').addEventListener('input', e => {
    state.volume = +e.target.value;
    $('volumeVal').textContent = state.volume + '%';
    if (curSys()) pushSysVolume(); else updateVolumeGain();
  });
  $('gate').addEventListener('input', e => { state.gateDb = +e.target.value; updateGate(); });
  $('gateAuto').addEventListener('change', e => { state.gateAuto = e.target.checked; updateGate(); });
  $('muteBtn').addEventListener('click', toggleMute);
  document.addEventListener('keydown', e => { if (e.ctrlKey && !e.altKey && !e.repeat && e.key.toLowerCase() === 'm') toggleMute(); });

  $('nrToggle').addEventListener('change', e => { state.nr = e.target.checked; $('nrAmount').disabled = !state.nr; applyNr(); updateHints(); });
  $('nrAmount').addEventListener('input', e => { state.nrAmount = +e.target.value; applyNr(); updateHints(); });
  $('monToggle').addEventListener('change', e => setMonitor(e.target.checked));
  $('listenBtn').addEventListener('click', () => setMonitor(!state.monitor));
  $('monoToggle').addEventListener('change', e => { state.mono = e.target.checked; applyMono(); });
  $('sendToggle').addEventListener('change', e => { sendWanted = e.target.checked; scheduleSave(); setSend(e.target.checked); });
  $('monVol').addEventListener('input', e => { state.monitorVol = +e.target.value; engine.set({ monitorVol: state.monitorVol }); updateHints(); });
  $('compToggle').addEventListener('change', e => { state.comp = e.target.checked; $('compAmount').disabled = !state.comp; applyComp(); updateHints(); });
  $('compAmount').addEventListener('input', e => { state.compAmount = +e.target.value; applyComp(); updateHints(); });
}
function toggleMute() { const m = !state.muted; setAllMuted(m); playMuteSound(m); }
// Only for a mute you asked for, not when syncing with Windows. Plays on your speakers only: it isn't part of the mic chain, so Discord never hears it.
// Both are made by tools/make-sounds.js: two notes stepping down for mute, up for unmute.
const muteSound = new Audio('../../assets/mute.wav'), unmuteSound = new Audio('../../assets/unmute.wav');
muteSound.preload = unmuteSound.preload = 'auto';
function playMuteSound(muting) {
  for (const s of [muteSound, unmuteSound]) { s.pause(); s.currentTime = 0; }
  if (state.muteSounds) (muting ? muteSound : unmuteSound).play().catch(() => {});
}
// The slider follows loudness rather than raw level: halfway sounds about half as loud.
function applyMuteSoundVol() {
  muteSound.volume = unmuteSound.volume = (state.muteSoundVol / 100) ** 2;
  $('soundVal').textContent = state.muteSounds ? state.muteSoundVol + '%' : 'Off';
  $('soundVol').disabled = !state.muteSounds;
  $('soundHint').textContent = state.muteSounds ? "Play where Listen plays. Discord doesn't hear them" : 'Off: muting and unmuting are silent';
}
function initMuteSounds() {
  $('soundToggle').checked = state.muteSounds;
  $('soundVol').value = state.muteSoundVol;
  applyMuteSoundVol();
  $('soundToggle').addEventListener('change', e => { state.muteSounds = e.target.checked; applyMuteSoundVol(); if (state.muteSounds) playMuteSound(true); });
  $('soundVol').addEventListener('input', e => { state.muteSoundVol = +e.target.value; applyMuteSoundVol(); });
  $('soundVol').addEventListener('change', () => playMuteSound(true));   // let go of the slider: hear the new level
}
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
  const b = $('muteBtn');
  b.classList.toggle('on', state.muted);
  b.textContent = state.muted ? 'Muted' : 'Mute';
  b.setAttribute('aria-pressed', state.muted);
  $('meterFill').parentElement.classList.toggle('muted', state.muted);
  $('mutedBanner').hidden = !state.muted;
  $('meterFill').closest('.hero').classList.toggle('is-muted', state.muted);
  syncTalking();
  updateSendStatus();
  if (window.appMute) window.appMute.setState(state.muted);
}
function setMonitor(on) {
  state.monitor = on;
  $('monToggle').checked = on;
  $('monVol').disabled = !on;
  const b = $('listenBtn');
  b.classList.toggle('on', on);
  b.textContent = on ? 'Listening' : 'Listen';
  b.setAttribute('aria-pressed', on);
  syncCompare();
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
  $('monoHint').textContent = state.mono ? 'On: left and right mixed, heard in both ears' : 'Off: stereo mics keep left and right separate';
  engine.set({ mono: state.mono });
}
// With Windows control the captured audio already has the Windows level applied, so the app adds no gain.
const volFactor = () => (curSys() ? 1 : state.volume / 75);
function updateVolumeGain() { engine.set({ inputGain: volFactor() }); }
function applyNr() { engine.set({ nr: state.nr, nrAmount: state.nrAmount }); }
function applyComp() {
  engine.set({ comp: state.comp, compAmount: state.compAmount });
  updateCompHint();
}
function updateCompHint() {
  if (!state.comp) { $('compHint').textContent = 'Your volume goes out as-is'; return; }
  const r = engine.compReduction();
  $('compHint').textContent = r < -0.5 ? `Evening out ${(-r).toFixed(1)} dB` : 'Evens out your volume';
}
// Mute and push to talk silence what leaves Olive (Listen and the cable).
function syncTalking() { engine.set({ talking: talking(), talkFade: talkFade() }); }
const gateDbNow = () => (state.gateAuto ? engine.autoGateDb : state.gateDb);
let shownGate = '';
function updateGate() {
  refreshGateUi();
  engine.set({ gateDb: state.gateDb, gateAuto: state.gateAuto });
}
function refreshGateUi() {
  const t = Math.round(gateDbNow()), st = engine.status();
  $('gate').disabled = state.gateAuto;          // the slider keeps your manual setting while Auto is on
  const byVoice = state.gateAuto && st.voiceGate;
  $('gateMark').hidden = byVoice;               // a voice gate has no volume threshold to mark
  const label = byVoice ? 'Voice' : t + ' dB';   // the Auto chip beside it says whether it's automatic
  if (label !== shownGate) {
    shownGate = label;
    $('gateVal').textContent = label;
    $('gateMark').style.left = dbToPct(t) + '%';
    $('gateHint').textContent = !byVoice && st.gateFailed ? 'Using the backup gate, which can clip the start of words' : byVoice ? 'Opens when it hears a voice, so fans and bumps stay out' : state.gateAuto ? 'Mutes you when you go quiet; follows your background noise' : "Mutes you when you're quieter than this";
  }
}
function updateHints() {
  const st = engine.status();
  $('nrVal').textContent = state.nr ? state.nrAmount + '%' : 'Off';
  $('compVal').textContent = state.comp ? state.compAmount + '%' : 'Off';
  $('monVal').textContent = state.monitor ? state.monitorVol + '%' : 'Off';
  $('nrHint').textContent = !state.nr ? 'Off: nothing is removed'
    : st.nrFailed ? 'Unavailable: the noise reduction engine could not start'
    : st.voiceFailed ? "Using the backup noise reduction: the voice engine couldn't start"
    : 'Lowers fans, rumble and hiss. Turn it down to mix your natural sound back in';
  $('monHint').textContent = !state.monitor ? "You won't hear yourself"
    : engine.capturing ? 'Use headphones to avoid echo'
    : 'On · microphone not open, nothing to play';
  if (!engine.micTest) $('testBtn').disabled = !engine.capturing;
}

// ---- Level meter ----
let smoothed = MIN_DB, peak = MIN_DB, peakHold = 0;
let last = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const on = engine.capturing;
  let db = ampToDb(on ? engine.rawAmplitude() * volFactor() : 0);   // in-app: 75% = unity
  const open = on && engine.gateOpen();
  if (state.muted) db = -Infinity;
  if (isHidden()) { smoothed = MIN_DB; peak = MIN_DB; return; }       // hidden in the tray: no drawing
  drawGateChip(open);

  const target = Math.max(MIN_DB, Math.min(6, db));
  smoothed = target > smoothed ? target : smoothed - 40 * dt; // fast attack, slow release
  smoothed = Math.max(MIN_DB, smoothed);
  if (smoothed >= peak) { peak = smoothed; peakHold = 1; } else if ((peakHold -= dt) <= 0) peak = Math.max(MIN_DB, peak - 20 * dt);

  levelPct = dbToPct(smoothed);
  peakPct = dbToPct(peak);
  if ((compTick = (compTick + 1) % 8) === 0) {           // ~4x per second
    if (state.comp) updateCompHint();
    if (state.gateAuto) refreshGateUi();
  }
  drawMeter(now);
}
let compTick = 0, levelPct = 0, peakPct = 0;

// Olive fill up to the knob on every slider.
function paintRanges() {
  for (const r of document.querySelectorAll('input[type=range]')) {
    const v = (((r.value - r.min) / (r.max - r.min)) * 100).toFixed(1) + '%';
    if (r.style.getPropertyValue('--fill') !== v) r.style.setProperty('--fill', v);
  }
}
document.addEventListener('input', e => { if (e.target.type === 'range') paintRanges(); });

// The meter only touches GPU transforms, and only when the value changed, so a quiet meter asks for no redraws at all.
// Text changes at most 5x per second. Slider fills only change with their sliders.
const ui = {};
let shownCover = '', shownPeak = '', shownDb = '', dbShownAt = 0, windowHidden = false;
// Hidden = minimized / in the tray. Electron tells us via preload (document.hidden can't, see main.js).
const isHidden = () => windowHidden || document.hidden;
if (window.appWindow) window.appWindow.onVisibility(v => { windowHidden = !v; if (v) scheduleEqDraw(); syncTicker(); });
document.addEventListener('visibilitychange', () => syncTicker());
let shownChip = null;
function drawGateChip(open) {
  const closedByKey = state.ptt && !pttOpen;
  const text = state.muted || !engine.capturing ? '' : closedByKey ? (state.pttKey ? `Hold ${state.pttKey.label} to talk` : 'Choose a talk key') : open ? 'Gate open' : 'Gate closed';
  if (text === shownChip) return;
  shownChip = text;
  const chip = $('gateChip');
  chip.textContent = text;
  chip.classList.toggle('open', text === 'Gate open');
}
function drawMeter(now) {
  const cover = 'scaleX(' + (1 - levelPct / 100).toFixed(3) + ')';
  if (cover !== shownCover) { ui.cover.style.transform = cover; shownCover = cover; }
  const pk = 'translateX(' + peakPct.toFixed(1) + '%)';
  if (pk !== shownPeak) { ui.peak.style.transform = pk; shownPeak = pk; }
  if (now - dbShownAt >= 200) {
    dbShownAt = now;
    const t = state.muted ? 'Muted' : (smoothed <= MIN_DB ? '-∞ dB' : smoothed.toFixed(1) + ' dB');
    if (t !== shownDb) { ui.levelDb.textContent = t; shownDb = t; }
    drawSendLevel();
  }
}
let sendShown = MIN_DB, shownSendDb = '', shownSendCover = '';
function drawSendLevel() {
  const amp = state.send ? engine.sendAmplitude() : null;
  if (amp === null) return;
  const db = Math.max(MIN_DB, ampToDb(amp));
  sendShown = db > sendShown ? db : Math.max(db, sendShown - 8);
  const cover = 'scaleX(' + (1 - dbToPct(sendShown) / 100).toFixed(3) + ')';
  if (cover !== shownSendCover) { $('sendCover').style.transform = cover; shownSendCover = cover; }
  const text = sendShown <= MIN_DB ? '-∞ dB' : sendShown.toFixed(1) + ' dB';
  if (text !== shownSendDb) { $('sendDb').textContent = text; shownSendDb = text; }
}


// ---- Mic EQ ----
// Six bands plus a low cut. Every band has a frequency, a gain and (peaking bands) a width (Q).
// The graph is the control: drag a point (left/right = frequency, up/down = gain), scroll to change width.
const EQ_BANDS = [
  { key: 'bass',       name: 'Bass',       type: 'lowshelf',  freq: 100,   q: 0.7, min: 20,   max: 300,   color: '#0a84ff' },
  { key: 'lowmid',     name: 'Low mid',    type: 'peaking',   freq: 250,   q: 1.0, min: 100,  max: 800,   color: '#5e5ce6' },
  { key: 'mid',        name: 'Mid',        type: 'peaking',   freq: 1000,  q: 1.0, min: 300,  max: 3000,  color: '#bf5af2' },
  { key: 'presence',   name: 'Presence',   type: 'peaking',   freq: 4000,  q: 1.0, min: 1500, max: 8000,  color: '#ff375f' },
  { key: 'brilliance', name: 'Brilliance', type: 'peaking',   freq: 7000,  q: 1.4, min: 3000, max: 14000, color: '#ff9f0a' },
  { key: 'air',        name: 'Air',        type: 'highshelf', freq: 10000, q: 0.7, min: 5000, max: 20000, color: '#64d2ff' }
];
const EQ_F_MIN = 20, EQ_F_MAX = 20000, EQ_G_MAX = 12, EQ_RANGE = 15, EQ_Q_MIN = 0.3, EQ_Q_MAX = 8;
// A preset value is a gain in dB, or { g, f, q } to also set frequency and width.
const EQ_PRESETS = {
  // Fitted to your recording (Nov 2026): fills the 400-1000 Hz dip, tames the very bright 4-10 kHz range,
  // keeps a little extra clarity; low cut off because your voice goes down to ~74 Hz.
  myvoice:   { bass: 0, lowmid: { g: 3, f: 420, q: 0.7 }, mid: { g: 6, f: 800, q: 1.6 }, presence: { g: -5, f: 4000, q: 0.7 },
               brilliance: { g: -6, f: 6500, q: 0.7 }, air: -4, lowCut: false },
  flat:      { bass: 0,  lowmid: 0,  mid: 0,  presence: 0, brilliance: 0, air: 0, lowCut: false },
  clarity:   { bass: -2, lowmid: -2, mid: -1, presence: 4, brilliance: 2, air: 3, lowCut: true },
  broadcast: { bass: 4,  lowmid: -1, mid: -2, presence: 3, brilliance: 1, air: 2, lowCut: true },
  boom:      { bass: -6, lowmid: -3, mid: 0,  presence: 1, brilliance: 0, air: 0, lowCut: true }
};
const GRAPH_COLORS = { gridZero: '#4a4944', grid: '#2e2d29', vertical: '#252421', label: '#9c9a91', fill: 'rgba(107,127,58,0.22)', ring: '#fff' };
const eq = { on: true, lowCut: false, b: {} };          // b[key] = { f: Hz, g: dB, q }
const bandDef = key => EQ_BANDS.find(d => d.key === key);
function resetBand(key) { const d = bandDef(key); eq.b[key] = { f: d.freq, g: 0, q: d.q }; }
EQ_BANDS.forEach(d => resetBand(d.key));
let eqSel = null, eqBypass = false;
const eqBandsReset = [];
// Each mic keeps its own EQ, stored by name. A mic seen for the first time starts from the EQ in use.
const eqByMic = {};
let eqOwner = null;                                     // the mic the EQ on screen belongs to
function snapshotEq() {
  return { on: eq.on, lowCut: eq.lowCut, preset: $('eqPreset').value, bands: Object.fromEntries(EQ_BANDS.map(d => [d.key, { ...eq.b[d.key] }])) };
}
function restoreEq(src) {
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  eq.on = src.on !== false;
  eq.lowCut = src.lowCut === true;
  for (const d of EQ_BANDS) {
    const b = (src.bands && src.bands[d.key]) || {};
    // A band saved outside its range goes back to flat, not to the nearest edge: moving a boost across the spectrum would change your sound.
    if (typeof b.f === 'number' && (b.f < d.min || b.f > d.max)) {
      resetBand(d.key);
      if (!eqBandsReset.includes(d.name)) eqBandsReset.push(d.name);
      continue;
    }
    eq.b[d.key] = {
      f: num(b.f, d.min, d.max, d.freq),
      g: num(b.g, -EQ_G_MAX, EQ_G_MAX, 0),
      q: num(b.q, EQ_Q_MIN, EQ_Q_MAX, d.q)
    };
  }
  eqPresetPref = typeof src.preset === 'string' ? src.preset : 'flat';
}
function showEqPreset() {
  const sel = $('eqPreset');
  sel.value = [...sel.options].some(o => o.value === eqPresetPref) ? eqPresetPref : 'custom';
}
function switchEqTo(name) {
  if (!name) return;
  $('eqFor').textContent = 'Saved for ' + name;
  if (name === eqOwner) return;
  if (eqOwner) eqByMic[eqOwner] = snapshotEq();
  eqOwner = name;
  if (eqByMic[name]) { restoreEq(eqByMic[name]); showEqPreset(); syncEqUi(); }
}

function applyEq() {
  $('eqToggle').closest('.eq').classList.toggle('off', !eq.on);
  engine.set({ eq });
  scheduleEqDraw();
}
function eqEdited() {
  $('eqPreset').value = 'custom';
  applyEq();
  updateEqReadout();
  scheduleSave();
}
function syncEqUi() {
  $('lowCut').checked = eq.lowCut;
  $('eqToggle').checked = eq.on;
  applyEq();
  updateEqReadout();
}

// --- band chips + readout (DOM changes only when something changes) ---
function renderEqChips() {
  const wrap = $('eqChips');
  wrap.innerHTML = '';
  EQ_BANDS.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'eq-chip'; b.textContent = String(i + 1); b.dataset.key = d.key;
    b.setAttribute('role', 'tab'); b.title = d.name; b.style.setProperty('--band', d.color);
    b.addEventListener('click', () => selectBand(eqSel === d.key ? null : d.key));
    wrap.appendChild(b);
  });
}
function selectBand(key) {
  eqSel = key;
  for (const c of $('eqChips').children) c.setAttribute('aria-selected', String(c.dataset.key === key));
  updateEqReadout();
  scheduleEqDraw();
}
const fmtHz = f => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz' : Math.round(f) + ' Hz');
const fmtDb = g => (g > 0 ? '+' : '') + g.toFixed(1) + ' dB';
let shownReadout = '';
function updateEqReadout() {
  let html;
  if (!eqSel) {
    html = 'Drag a point to shape your sound · Ctrl + scroll over it to change its width · double-click to reset';
  } else {
    const d = bandDef(eqSel), s = eq.b[eqSel];
    html = `<b>${d.name}</b><span class="num">${fmtHz(s.f)}</span><span class="num">${fmtDb(s.g)}</span>` +
      (d.type === 'peaking' ? `<span class="num">Q ${s.q.toFixed(2)}</span>` : '<span>shelf</span>') +
      '<button type="button" id="eqResetBand">Reset band</button>';
  }
  if (html === shownReadout) return;
  shownReadout = html;
  $('eqReadout').innerHTML = html;
  const r = $('eqResetBand');
  if (r) r.addEventListener('click', () => { resetBand(eqSel); eqEdited(); });
}

// --- graph geometry ---
const EQ_PAD = { l: 34, r: 10, t: 12, b: 20 };
let eqW = 0, eqH = 0;
const eqX = f => EQ_PAD.l + Math.log(f / EQ_F_MIN) / Math.log(EQ_F_MAX / EQ_F_MIN) * (eqW - EQ_PAD.l - EQ_PAD.r);
const eqF = x => EQ_F_MIN * Math.pow(EQ_F_MAX / EQ_F_MIN, (x - EQ_PAD.l) / (eqW - EQ_PAD.l - EQ_PAD.r));
const eqY = g => EQ_PAD.t + (1 - (Math.max(-EQ_RANGE, Math.min(EQ_RANGE, g)) + EQ_RANGE) / (2 * EQ_RANGE)) * (eqH - EQ_PAD.t - EQ_PAD.b);
const eqG = y => (1 - (y - EQ_PAD.t) / (eqH - EQ_PAD.t - EQ_PAD.b)) * 2 * EQ_RANGE - EQ_RANGE;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Where a band's point is drawn, in CSS pixels inside the canvas (also used by the tests).
function eqPoint(key) { const s = eq.b[key]; return { x: eqX(s.f), y: eqY(s.g) }; }
function bandAt(x, y, radius = 16) {
  let best = null, bd = radius;
  for (const d of EQ_BANDS) { const p = eqPoint(d.key); const dist = Math.hypot(p.x - x, p.y - y); if (dist <= bd) { bd = dist; best = d.key; } }
  return best;
}

// --- graph drawing (exact filter responses from an offline copy of the filters) ---
let eqDisp = null, eqDrawQueued = false;
function eqDisplayFilters() {
  if (eqDisp === null) {
    try {
      const c = new OfflineAudioContext(1, 128, 48000);
      eqDisp = { hp: c.createBiquadFilter(), bands: EQ_BANDS.map(() => c.createBiquadFilter()) };
    } catch { eqDisp = false; }
  }
  return eqDisp;
}
function scheduleEqDraw() {
  if (eqDrawQueued) return;
  eqDrawQueued = true;
  requestAnimationFrame(() => { eqDrawQueued = false; drawEqCurve(); });
}
const EQ_N = 240;
let eqFreqs = null, eqMag = null, eqPh = null;
function drawEqCurve() {
  const c = $('eqCurve'), ctx = c.getContext('2d');
  const dpr = devicePixelRatio || 1;
  eqW = c.clientWidth; eqH = c.clientHeight;
  if (!eqW || !eqH) return;
  if (c.width !== Math.round(eqW * dpr) || c.height !== Math.round(eqH * dpr)) { c.width = Math.round(eqW * dpr); c.height = Math.round(eqH * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, eqW, eqH);
  const disp = eqDisplayFilters();
  if (!eqFreqs) { eqFreqs = new Float32Array(EQ_N); eqMag = new Float32Array(EQ_N); eqPh = new Float32Array(EQ_N); }
  const x0 = EQ_PAD.l, x1 = eqW - EQ_PAD.r;
  for (let i = 0; i < EQ_N; i++) eqFreqs[i] = eqF(x0 + (x1 - x0) * i / (EQ_N - 1));

  ctx.lineWidth = 1; ctx.font = "11px system-ui, 'Segoe UI', sans-serif"; ctx.textBaseline = 'middle';
  for (const g of [-12, -6, 0, 6, 12]) {
    const y = Math.round(eqY(g)) + 0.5;
    ctx.strokeStyle = g === 0 ? GRAPH_COLORS.gridZero : GRAPH_COLORS.grid;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.fillStyle = GRAPH_COLORS.label; ctx.textAlign = 'right'; ctx.fillText((g > 0 ? '+' : '') + g, x0 - 6, y);
  }
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  for (const [f, t] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
    const x = Math.round(eqX(f)) + 0.5;
    ctx.strokeStyle = GRAPH_COLORS.vertical; ctx.beginPath(); ctx.moveTo(x, EQ_PAD.t); ctx.lineTo(x, eqH - EQ_PAD.b); ctx.stroke();
    ctx.fillStyle = GRAPH_COLORS.label; ctx.fillText(t, x, eqH - 5);
  }
  if (!disp) return;

  const set = (f, type, freq, gain, q) => { f.type = type; f.frequency.value = freq; f.gain.value = gain; f.Q.value = q; };
  const total = new Float32Array(EQ_N);
  const addResp = (f, into) => { f.getFrequencyResponse(eqFreqs, eqMag, eqPh); for (let i = 0; i < EQ_N; i++) into[i] += 20 * Math.log10(Math.max(eqMag[i], 1e-6)); };
  const cut = eq.on && eq.lowCut;
  set(disp.hp, cut ? 'highpass' : 'lowshelf', 80, 0, 0.7);
  addResp(disp.hp, total);
  let selCurve = null;
  EQ_BANDS.forEach((d, i) => {
    const s = eq.b[d.key];
    set(disp.bands[i], d.type, s.f, eq.on ? s.g : 0, s.q);
    addResp(disp.bands[i], total);
    if (d.key === eqSel) { selCurve = new Float32Array(EQ_N); addResp(disp.bands[i], selCurve); }
  });

  const path = arr => { ctx.beginPath(); for (let i = 0; i < EQ_N; i++) { const x = x0 + (x1 - x0) * i / (EQ_N - 1), y = eqY(arr[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } };
  const y0 = eqY(0);
  if (selCurve) {
    const d = bandDef(eqSel), col = d.color;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';            // how far this band can move
    ctx.fillRect(eqX(d.min), EQ_PAD.t, eqX(d.max) - eqX(d.min), eqH - EQ_PAD.t - EQ_PAD.b);
    path(selCurve); ctx.lineTo(x1, y0); ctx.lineTo(x0, y0); ctx.closePath();
    ctx.globalAlpha = 0.22; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
  }
  path(total); ctx.lineTo(x1, y0); ctx.lineTo(x0, y0); ctx.closePath();
  ctx.fillStyle = GRAPH_COLORS.fill; ctx.fill();
  path(total); ctx.strokeStyle = '#9AAF5E'; ctx.lineWidth = 2; ctx.stroke();

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = "600 11px system-ui, 'Segoe UI', sans-serif";
  EQ_BANDS.forEach((d, i) => {
    const p = eqPoint(d.key), sel = d.key === eqSel;
    if (sel) { ctx.beginPath(); ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); ctx.strokeStyle = GRAPH_COLORS.ring; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.beginPath(); ctx.arc(p.x, p.y, 8.5, 0, Math.PI * 2); ctx.fillStyle = d.color; ctx.fill();
    ctx.fillStyle = '#000'; ctx.fillText(String(i + 1), p.x, p.y + 0.5);
  });
}

// --- graph interaction: drag, scroll, double-click, keyboard ---
function bindEqGraph() {
  const c = $('eqCurve');
  let drag = null;
  const local = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const setFromPoint = (key, x, y) => {
    const s = eq.b[key];
    const d = bandDef(key);
    s.f = clamp(eqF(x), d.min, d.max);
    let g = clamp(eqG(y), -EQ_G_MAX, EQ_G_MAX);
    if (Math.abs(g) < 0.3) g = 0;                         // easy to land exactly on 0 dB
    s.g = Math.round(g * 10) / 10;
  };
  c.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const p = local(e), key = bandAt(p.x, p.y);
    if (!key) { selectBand(null); return; }
    selectBand(key);
    const pt = eqPoint(key);
    drag = { key, dx: pt.x - p.x, dy: pt.y - p.y };     // keep the grab offset so the point doesn't jump
    c.setPointerCapture(e.pointerId);
    c.classList.add('grabbing');
    e.preventDefault();
  });
  c.addEventListener('pointermove', e => {
    const p = local(e);
    if (!drag) { c.classList.toggle('grab', !!bandAt(p.x, p.y)); return; }
    setFromPoint(drag.key, p.x + drag.dx, p.y + drag.dy);
    eqEdited();
  });
  const end = e => {
    if (!drag) return;
    drag = null; c.classList.remove('grabbing');
    if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    savePrefs();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('dblclick', e => {
    const p = local(e), key = bandAt(p.x, p.y);
    if (key) { resetBand(key); selectBand(key); eqEdited(); }
  });
  // Width needs Ctrl: a plain wheel must keep scrolling the page, or passing over the graph quietly changes your EQ.
  c.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();                                 // and Ctrl + scroll here never zooms the page
    const p = local(e), key = bandAt(p.x, p.y, 40) || eqSel;
    if (!key || bandDef(key).type !== 'peaking') return;
    const s = eq.b[key];
    s.q = Math.round(clamp(s.q * Math.exp(-e.deltaY * 0.0015), EQ_Q_MIN, EQ_Q_MAX) * 100) / 100;
    if (eqSel !== key) selectBand(key);
    eqEdited();
  }, { passive: false });
  c.addEventListener('keydown', e => {
    if (/^[1-6]$/.test(e.key)) { selectBand(EQ_BANDS[+e.key - 1].key); e.preventDefault(); return; }
    if (e.key === 'Escape') { selectBand(null); return; }
    if (!eqSel) { if (e.key.startsWith('Arrow')) { selectBand(EQ_BANDS[0].key); e.preventDefault(); } return; }
    const s = eq.b[eqSel], fine = e.shiftKey, band = bandDef(eqSel);
    let handled = true;
    if (e.key === 'ArrowUp') s.g = clamp(Math.round((s.g + (fine ? 0.1 : 0.5)) * 10) / 10, -EQ_G_MAX, EQ_G_MAX);
    else if (e.key === 'ArrowDown') s.g = clamp(Math.round((s.g - (fine ? 0.1 : 0.5)) * 10) / 10, -EQ_G_MAX, EQ_G_MAX);
    else if (e.key === 'ArrowRight') s.f = clamp(s.f * (fine ? 1.01 : 1.06), band.min, band.max);
    else if (e.key === 'ArrowLeft') s.f = clamp(s.f / (fine ? 1.01 : 1.06), band.min, band.max);
    else if ((e.key === '+' || e.key === '=' || e.key === ']') && bandDef(eqSel).type === 'peaking') s.q = clamp(Math.round(s.q * 1.15 * 100) / 100, EQ_Q_MIN, EQ_Q_MAX);
    else if ((e.key === '-' || e.key === '[') && bandDef(eqSel).type === 'peaking') s.q = clamp(Math.round(s.q / 1.15 * 100) / 100, EQ_Q_MIN, EQ_Q_MAX);
    else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === '0') resetBand(eqSel);
    else handled = false;
    if (handled) { e.preventDefault(); eqEdited(); }
  });
}

function applyPreset(p) {
  EQ_BANDS.forEach(d => {
    resetBand(d.key);
    const v = p[d.key];
    if (typeof v === 'number') eq.b[d.key].g = v;
    else if (v) Object.assign(eq.b[d.key], v);
  });
  eq.lowCut = p.lowCut;
}
// The EQ opens like a dropdown: closed by default, and the choice is remembered. Closed, nothing in it can be changed by accident.
function syncCompare() {
  const b = $('eqCompare');
  b.disabled = !(state.monitor && eq.on);
}
function setEqOpen(open) {
  state.eqOpen = open === true;
  const b = $('eqExpand');
  b.setAttribute('aria-expanded', String(state.eqOpen));
  $('eqBody').hidden = !state.eqOpen;
  if (state.eqOpen) {
    scheduleEqDraw();
    requestAnimationFrame(() => $('eqBody').scrollIntoView({ block: 'nearest' }));
  } else selectBand(null);
}
function bindEq() {
  $('eqExpand').addEventListener('click', () => { setEqOpen(!state.eqOpen); savePrefs(); });
  renderEqChips();
  bindEqGraph();
  $('eqPreset').addEventListener('change', e => {
    const p = EQ_PRESETS[e.target.value]; if (!p) return;
    applyPreset(p); syncEqUi();
  });
  $('eqToggle').addEventListener('change', e => { eq.on = e.target.checked; applyEq(); syncCompare(); });
  const compare = $('eqCompare');
  const holdCompare = on => {
    if (eqBypass === on) return;
    eqBypass = on;
    compare.classList.toggle('holding', on);
    compare.textContent = on ? 'Hearing without EQ' : 'Hold to compare';
    engine.set({ eqBypass: on });
  };
  compare.addEventListener('pointerdown', e => { if (e.button === 0 && !compare.disabled) { compare.setPointerCapture(e.pointerId); holdCompare(true); } });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) compare.addEventListener(ev, () => holdCompare(false));
  compare.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); holdCompare(true); } });
  compare.addEventListener('keyup', () => holdCompare(false));
  $('lowCut').addEventListener('change', e => { eq.lowCut = e.target.checked; $('eqPreset').value = 'custom'; applyEq(); });
  window.addEventListener('resize', scheduleEqDraw);    // also catches display scale changes
  // The canvas also changes size without the window doing so (a scrollbar appearing), so watch it directly.
  new ResizeObserver(scheduleEqDraw).observe($('eqCurve'));
  syncEqUi();
}

// ---- Live input ----
function stopCapture() { engine.stopCapture(); }
async function startCapture() {
  try { if (await engine.capture(state.deviceId)) setStatus(''); }
  catch (err) { setStatus(micError(err)); }
  updateHints();
}

function setStatus(msg) { $('devStatus').textContent = msg; }
function showNotice(msg) {
  const n = $('appNotice');
  if (!n.textContent.includes(msg)) n.textContent = (n.textContent ? n.textContent + ' ' : '') + msg;
}
function micError(err) {
  if (err.name === 'NotAllowedError') return 'Windows is blocking microphone access. Check Settings > Privacy & security > Microphone.';
  if (err.name === 'NotReadableError') return "This microphone isn't responding, or another app has taken it over.";
  if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return "This microphone isn't connected any more.";
  return `Couldn't open this microphone (${err.name}).`;
}
const captureIsCurrent = () => engine.isCapturing(state.deviceId);

async function loadDevices() {
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
  if (!live && !$('devStatus').textContent) setStatus('Plug in a microphone, then press refresh.');
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
// Keep looking for a minute, and stop as soon as everything is there.
let startupRetries = 0, startupRetryTimer = null;
function retryWhileAudioStartsUp() {
  clearTimeout(startupRetryTimer);
  if (live && (!sendWanted || engine.hasSend)) { startupRetries = 0; return; }
  if (startupRetries >= 12) {
    if (!live) setStatus('Still no microphone after a minute, so Olive stopped looking. Plug one in, or press refresh to try again.');
    return;
  }
  startupRetries++;
  startupRetryTimer = setTimeout(loadDevices, 5000);
}

// ---- Send to other apps (VB-Audio Virtual Cable) ----
const isCableLabel = l => /\bCABLE\b.*VB-Audio|VB-Audio Virtual Cable/i.test(l || '');
let sendToken = 0;

function sendHint(text, cls) {
  const h = $('sendHint');
  h.textContent = text;
  h.className = 'hint' + (cls ? ' ' + cls : '');
  $('sendToggle').parentElement.title = cls === 'on'
    ? 'Sending to the virtual cable. In Discord, choose "CABLE Output (VB-Audio Virtual Cable)" as your input device.'
    : 'Send the processed mic to VB-Audio Virtual Cable';
}
// What other apps get right now, in words. The level bar only shows while the cable is connected.
function updateSendStatus() {
  const connected = engine.hasSend && state.send && live;
  $('sendLevel').hidden = !connected;
  if (!connected) return;
  if (state.muted) sendHint('Muted: nothing is being sent', 'on');
  else if (state.ptt && !pttOpen) sendHint(state.pttKey ? `Push to talk: hold ${state.pttKey.label} to send` : 'Push to talk: choose a key below', 'on');
  else sendHint('Sending. In Discord, choose "CABLE Output" as your input', 'on');
}
async function findCable() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const outs = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return outs.find(d => /CABLE Input/i.test(d.label)) || outs.find(d => isCableLabel(d.label)) || null;
}
function stopSending() { state.send = false; engine.set({ send: false }); engine.closeSend(); $('sendToggle').checked = false; }
async function setSend(on) {
  const token = ++sendToken;
  if (!on) {
    stopSending();
    sendHint('Off: other apps hear your raw mic');
    updateSendStatus();
    return;
  }
  $('sendToggle').checked = true;
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
let sysError = '';
let sysEndpoints = [];
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

function sysFailed(err) {
  setStatus('Windows mic control failed: ' + cleanErr(err));
  applySysToUi();
}

function applySysToUi() {
  const ep = curSys();
  const hint = $('volumeHint');
  if (ep) {
    volSent = null;
    state.volume = Math.round(ep.volume * 100);
    $('volume').value = state.volume;
    $('volumeVal').textContent = state.volume + '%';
    paintRanges();
    if (ep.muted !== state.muted) setMutedUi(ep.muted);
    hint.textContent = '';
    hint.title = '';
    $('volume').title = 'Sets the Windows mic level and mute · affects all apps';
  } else {
    hint.textContent = !live ? 'No microphone'
      : sysStatus === 'connecting' ? 'Connecting to Windows audio…'
      : sysStatus === 'ready' ? "In this app only · couldn't match this mic to a Windows device"
      : sysStatus === 'error' ? 'In this app only · Windows control unavailable'
      : 'In this app only';
    hint.title = sysError;
    $('volume').title = '';
  }
  $('muteBtn').title = ep ? 'Mute this mic in Windows (Ctrl+M)' : 'Toggle mute (Ctrl+M)';
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
    if (++sysPollFailures === 3) setStatus("Lost contact with Windows mic control, so volume and mute may not apply. Still trying.");
  }
}

// ---- Saved settings ----
// Restored on start: mic, volume (in-app), gate, mono, noise reduction, monitor level, EQ, send.
// Not restored on purpose: Listen (could cause feedback at launch) and Mute (Windows keeps its own).
const PREFS_KEY = 'olive.settings.v1', OLD_PREFS_KEY = 'micManager.settings.v1';   // the old name, from before the rebrand
let prefDeviceId = null, prefDeviceName = null, saveTimer = null;
let sendWanted = true;

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
  if (startEq && typeof startEq === 'object') restoreEq(startEq);
  eqOwner = prefDeviceName;
  return p;
}
let eqPresetPref = 'flat';

// Put restored values into the controls (before their listeners are attached).
function showPrefsInUi() {
  $('volume').value = state.volume; $('volumeVal').textContent = state.volume + '%';
  $('gate').value = state.gateDb;
  $('gateAuto').checked = state.gateAuto;
  $('monoToggle').checked = state.mono;
  $('nrToggle').checked = state.nr; $('nrAmount').disabled = !state.nr; $('nrAmount').value = state.nrAmount;
  $('monVol').value = state.monitorVol;
  $('compToggle').checked = state.comp; $('compAmount').disabled = !state.comp; $('compAmount').value = state.compAmount;
  $('sendToggle').checked = state.send;
  if (state.send) sendHint('Connecting…');
  showEqPreset();
}

function savePrefs() {
  clearTimeout(saveTimer); saveTimer = null;
  const p = {
    deviceId: prefDeviceId, deviceName: prefDeviceName, volume: state.volume, gateDb: state.gateDb, gateAuto: state.gateAuto, mono: state.mono,
    nr: state.nr, nrStrength: state.nrAmount, monitorVol: state.monitorVol, send: sendWanted,
    ptt: state.ptt, pttKey: state.pttKey, outputId: state.outputId, outputName: state.outputName, setupDone: state.setupDone, updateAuto: state.updateAuto,
    comp: state.comp, compAmount: state.compAmount, muteHotkey: state.muteHotkey, muteAccel: state.muteAccel, eqOpen: state.eqOpen,
    muteSounds: state.muteSounds, muteSoundVol: state.muteSoundVol, badge: state.badge, badgeCorner: state.badgeCorner,
    eq: snapshotEq(),
    eqByMic: eqOwner ? { ...eqByMic, [eqOwner]: snapshotEq() } : eqByMic
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (err) { showNotice("Your settings couldn't be saved, so changes will be lost when Olive closes: " + err.message); }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(savePrefs, 300); }
// Any control the user touches -> save shortly after (handlers run first, so state is current).
// While dragging ('input') save shortly after; on release / toggle / select ('change') save right away.
document.addEventListener('input', scheduleSave);
document.addEventListener('dblclick', scheduleSave);
document.addEventListener('change', () => savePrefs());
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
const hotkeyLabel = a => a.replace('Control', 'Ctrl').replace('Super', 'Win');
async function applyMuteHotkey() {
  const hint = $('muteKeyHint'), label = hotkeyLabel(state.muteAccel);
  $('muteKeyChange').disabled = !state.muteHotkey;
  if (!state.muteHotkey) { await window.appMute.setHotkey(null); hint.textContent = 'Off: Ctrl+M still works while this window has focus'; return; }
  const ok = await window.appMute.setHotkey(state.muteAccel);
  hint.textContent = ok ? `${label} mutes your mic from anywhere` : `${label} is already in use by another app`;
}
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
function setHotkeyChoosing(on) {
  hotkeyChoosing = on;
  const b = $('muteKeyChange');
  b.classList.toggle('capturing', on);
  b.textContent = on ? 'Press keys…' : 'Change';
}
async function startChoosingHotkey() {
  if (hotkeyChoosing) return;
  setHotkeyChoosing(true);
  await window.appMute.setHotkey(null);
  $('muteKeyHint').textContent = 'Press the new shortcut, or Esc to cancel';
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
  $('muteKeyHint').textContent = `${hotkeyLabel(accelerator)} is already in use by another app. Keeping ${hotkeyLabel(state.muteAccel)}`;
}
window.addEventListener('keydown', e => {
  if (!hotkeyChoosing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code === 'Escape') { finishChoosingHotkey(null); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;   // still holding modifiers
  const accelerator = hotkeyFromEvent(e);
  if (accelerator) finishChoosingHotkey(accelerator);
  else $('muteKeyHint').textContent = 'Use Ctrl, Alt or Win with a letter or number, or an F key. Esc cancels';
}, true);
window.addEventListener('blur', () => { if (hotkeyChoosing) finishChoosingHotkey(null); });
function initMuteHotkey() {
  const t = $('muteKeyToggle');
  if (!window.appMute) { t.disabled = true; t.checked = false; $('muteKeyHint').textContent = 'Only in the Windows app'; return; }
  window.appMute.onToggle(toggleMuteFromOutside);
  window.appMute.onMicKey(onMicKey);
  t.checked = state.muteHotkey;
  t.addEventListener('change', () => { state.muteHotkey = t.checked; applyMuteHotkey(); });
  $('muteKeyChange').addEventListener('click', startChoosingHotkey);
  applyMuteHotkey();
}

// ---- Push to talk ----
// Silences what leaves Olive (the cable and Listen) unless the key is held. It doesn't touch Windows mute: that takes too long to follow a key.
const PTT_TAIL_MS = 200;                       // keeps the end of the last word after the key comes up
let pttOpen = false, pttTail = null, pttChoosing = false;
const talking = () => !state.muted && (!state.ptt || pttOpen);
const talkFade = () => (state.ptt && pttOpen ? 0.005 : 0.02);
function setPttOpen(open) {
  pttOpen = open;
  syncTalking();
  updateSendStatus();
}
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
  const h = $('pttHint');
  h.classList.remove('notice');
  if (!state.ptt) h.textContent = 'Off: your mic is open unless you mute it';
  else if (!state.pttKey) h.textContent = 'Choose a key to hold while you talk';
  else if (!state.send) h.textContent = `Hold ${state.pttKey.label} to talk. Turn on Send to Discord too: apps using your mic directly aren't affected`;
  else h.textContent = /^[A-Z0-9]$/.test(state.pttKey.label) ? `Hold ${state.pttKey.label} to talk. It still types ${state.pttKey.label} in other apps` : `Hold ${state.pttKey.label} to talk`;
  $('pttChange').textContent = state.pttKey ? 'Change key' : 'Choose key';
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
    $('pttHint').textContent = "Couldn't watch the key, so your mic stays silent. Turn this off to talk: " + cleanErr(err);
    $('pttHint').classList.add('notice');
  }
}
function finishChoosingPtt(key) {
  pttChoosing = false;
  $('pttChange').classList.remove('capturing');
  if (key) { state.pttKey = key; savePrefs(); }
  applyPtt();
}
function startChoosingPtt() {
  if (pttChoosing) return;
  pttChoosing = true;
  $('pttChange').classList.add('capturing');
  $('pttChange').textContent = 'Press a key…';
  $('pttHint').textContent = 'Press a key or a side mouse button, or Esc to cancel';
}
window.addEventListener('keydown', e => {
  if (!pttChoosing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code === 'Escape') { finishChoosingPtt(null); return; }
  const key = vkFromCode(e.code);
  if (key) finishChoosingPtt(key);
  else $('pttHint').textContent = 'That key can\'t be used. Try a letter, an F key, Space, or a side mouse button. Esc cancels';
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
  const t = $('pttToggle');
  if (!window.appPtt) { t.disabled = true; $('pttChange').disabled = true; $('pttHint').textContent = 'Only in the Windows app'; return; }
  window.appPtt.onKey(onPttKey);
  t.checked = state.ptt;
  t.addEventListener('change', () => {
    state.ptt = t.checked;
    if (state.ptt && !state.pttKey) startChoosingPtt();
    applyPtt();
  });
  $('pttChange').addEventListener('click', startChoosingPtt);
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
  const hint = $('outputHint'), pick = $('outputSelect');
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const outs = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications' && !isCableLabel(d.label));
    pick.innerHTML = '';
    for (const d of outs) {
      const name = d.deviceId === 'default' ? 'Windows default' + (d.label ? ` (${d.label.replace(/^[^-]*-\s*/, '')})` : '') : d.label || 'Speakers';
      pick.add(new Option(name, d.deviceId));
    }
    if (!outs.some(d => d.deviceId === 'default')) pick.add(new Option('Windows default', 'default'), 0);
    const wanted = state.outputId === 'default' ? { deviceId: 'default' } : outs.find(d => d.deviceId === state.outputId) || outs.find(d => d.label === state.outputName);
    pick.value = wanted ? wanted.deviceId : 'default';
    hint.textContent = wanted ? '' : `${state.outputName || 'That device'} isn't connected. Using Windows default until it's back.`;
    await setOutput(pick.value);
  } catch (err) {
    hint.textContent = "Couldn't change where this plays: " + err.message;
  }
}
function bindOutput() {
  $('outputSelect').addEventListener('change', e => {
    const pick = e.target;
    state.outputId = pick.value;
    state.outputName = pick.value === 'default' ? null : pick.selectedOptions[0].textContent;
    loadOutputs();
  });
}

// ---- First-run setup ----
let freshInstall = false;
async function updateSetup() {
  let found = false;
  try { found = !!(await findCable()); } catch { /* treated as not found */ }
  if (found && !freshInstall && !state.setupDone) { state.setupDone = true; savePrefs(); }
  $('setupCable').textContent = found ? 'Found: the virtual cable is installed.' : 'Not found yet.';
  $('setupDownload').hidden = found;
  $('setupCard').hidden = state.setupDone;
  $('setupOpen').hidden = found || !state.setupDone;
}
function bindSetup() {
  $('setupDownload').addEventListener('click', () => { if (window.appInfo) window.appInfo.open('vbcable'); });
  $('setupCheck').addEventListener('click', () => loadDevices());
  $('setupDone').addEventListener('click', () => { state.setupDone = true; savePrefs(); updateSetup(); });
  $('setupOpen').addEventListener('click', () => { state.setupDone = false; freshInstall = true; updateSetup(); });
}

// ---- Mic test: record 5 s of what Olive sends, then play it back to you (the engine does the audio) ----
function showTest(label, phase, hint) {
  const b = $('testBtn');
  b.textContent = label;
  b.classList.toggle('recording', phase === 'recording');
  b.classList.toggle('playing', phase === 'playing');
  if (hint !== undefined) $('testHint').textContent = hint;
}
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
    $('testBtn').disabled = !engine.capturing;
  }
}
function bindMicTest() {
  $('testBtn').addEventListener('click', () => {
    const t = engine.micTest;
    if (!t) engine.startMicTest(onMicTest);
    else if (t.phase === 'recording') engine.finishRecording();
    else if (t.phase === 'playing') engine.endMicTest();
  });
}

// ---- Muted badge ----
// The badge is its own small window, made by main.js; this only says whether it's wanted and where.
function initBadge() {
  const t = $('badgeToggle'), pick = $('badgeCorner');
  if (!window.appBadge) { t.disabled = true; t.checked = false; pick.disabled = true; $('badgeHint').textContent = 'Only in the Windows app'; return; }
  t.checked = state.badge;
  pick.value = state.badgeCorner;
  const apply = preview => {
    pick.disabled = !state.badge;
    $('badgeHint').textContent = state.badge ? "Shows over other apps and windowed games while you're muted" : 'Off: the tray icon still turns red while muted';
    window.appBadge.set(state.badge, state.badgeCorner, preview).catch(() => {});
  };
  t.addEventListener('change', () => { state.badge = t.checked; apply(true); });
  pick.addEventListener('change', () => { state.badgeCorner = pick.value; apply(true); });
  apply(false);
}

// ---- Updates ----
// Install downloads the new installer, checks it against GitHub, and lets it replace this copy and open it again.
// A copy that wasn't installed (a build folder) gets Download instead, which opens the release page.
const UPDATE_EVERY_MS = 24 * 3600 * 1000;
let updateAvailable = null, updating = false;
async function checkUpdates(asked) {
  if (!window.appInfo || updating) return;
  const hint = $('updateHint'), btn = $('updateBtn');
  if (asked) { hint.textContent = 'Checking…'; btn.disabled = true; }
  let r;
  try { r = await window.appInfo.checkForUpdate(); } catch (err) { r = { status: 'unavailable', reason: cleanErr(err) }; }
  btn.disabled = false;
  if (r.status === 'available') {
    updateAvailable = r;
    hint.textContent = r.canInstall ? `Olive ${r.version} is available. Installing closes Olive for a few seconds` : `Olive ${r.version} is available`;
    btn.textContent = r.canInstall ? 'Install' : 'Download';
    $('updateNotes').hidden = !r.canInstall;   // Download already opens the release page
  } else if (asked) {
    hint.textContent = r.status === 'current' ? "You're on the latest version" : "Couldn't check for updates: " + r.reason;
  }
}
async function installUpdate() {
  const hint = $('updateHint'), btn = $('updateBtn');
  updating = true;
  btn.disabled = true;
  hint.textContent = 'Downloading… 0%';
  try {
    await window.appInfo.installUpdate();
    hint.textContent = 'Installing. Olive will close and open again in a few seconds';
  } catch (err) {
    updating = false;
    btn.disabled = false;
    hint.textContent = `Couldn't update: ${cleanErr(err)}. Try again, or download it from What's new`;
  }
}
function initUpdates() {
  const t = $('updateAuto');
  t.checked = state.updateAuto;
  t.addEventListener('change', () => { state.updateAuto = t.checked; });
  $('updateBtn').addEventListener('click', () => {
    if (!updateAvailable) checkUpdates(true);
    else if (updateAvailable.canInstall) installUpdate();
    else window.appInfo.open('release');
  });
  $('updateNotes').addEventListener('click', () => window.appInfo.open('release'));
  if (window.appInfo) {
    window.appInfo.onUpdateProgress(p => { if (updating) $('updateHint').textContent = `Downloading… ${Math.floor(p * 100)}%`; });
    window.appInfo.updateResult().then(r => {
      if (r.error) showNotice(`The update couldn't be installed, so Olive is still on ${r.version}: ${r.error}`);
      else if (r.updated) $('updateHint').textContent = `Updated to Olive ${r.version}`;
    }).catch(() => {});
  }
  const auto = () => { if (state.updateAuto) checkUpdates(false); };
  setTimeout(auto, 20000);
  setInterval(auto, UPDATE_EVERY_MS);
}

// ---- Start with Windows ----
// window.appStartup comes from preload.js; Windows keeps the setting (Settings > Apps > Startup).
async function initStartup() {
  const t = $('startupToggle'), hint = $('startupHint');
  const api = window.appStartup || null;
  const off = msg => { t.disabled = true; t.checked = false; hint.textContent = msg; };
  if (!api) return off('Only in the Windows app');
  try {
    const r = await api.get();
    if (!r.supported) return off(r.reason || 'Windows only');
    t.checked = r.enabled;
  } catch (err) { return off('Unavailable: ' + cleanErr(err)); }
  t.addEventListener('change', async () => {
    const want = t.checked;
    try {
      const r = await api.set(want);
      t.checked = r.enabled;
      hint.textContent = r.enabled === want ? 'Opens hidden in the tray when you log in'
        : 'Windows did not accept the change (check Settings > Apps > Startup)';
    } catch (err) {
      t.checked = !want;
      hint.textContent = "Couldn't change it: " + cleanErr(err);
    }
  });
}

// ---- Settings panel ----
// Things you set once live behind the gear. While it's open the rest of the window can't be reached by Tab.
const settingsOpen = () => $('settingsPanel').classList.contains('open');
function setSettingsOpen(open) {
  $('settingsPanel').classList.toggle('open', open);
  $('settingsScrim').classList.toggle('open', open);
  $('settingsBtn').setAttribute('aria-expanded', open);
  document.querySelector('main').inert = open;
  document.querySelector('.toolbar').inert = open;
  (open ? $('settingsPanel') : $('settingsBtn')).focus();
}
// A dot on the gear when something in there needs you, so nothing important hides behind it.
function updateSettingsDot() {
  const reasons = [];
  if (updateAvailable) reasons.push(`Olive ${updateAvailable.version} is available`);
  if (/in use/.test($('muteKeyHint').textContent)) reasons.push('the mute hotkey is taken by another app');
  if ($('pttHint').classList.contains('notice')) reasons.push("push to talk can't watch its key");
  $('settingsDot').hidden = !reasons.length;
  $('settingsBtn').title = reasons.length ? 'Settings: ' + reasons.join('; ') : 'Settings';
}
function bindSettings() {
  $('settingsBtn').addEventListener('click', () => setSettingsOpen(true));
  $('settingsClose').addEventListener('click', () => setSettingsOpen(false));
  $('settingsScrim').addEventListener('click', () => setSettingsOpen(false));
  // Choosing a hotkey or talk key catches Esc first (in the capture phase), so Esc there cancels the choice, not the panel.
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && settingsOpen()) setSettingsOpen(false); });
  const watch = new MutationObserver(updateSettingsDot);
  for (const id of ['muteKeyHint', 'pttHint', 'updateHint']) watch.observe($(id), { childList: true, characterData: true, subtree: true, attributes: true });
  updateSettingsDot();
}

// ---- Init ----
const savedPrefs = loadPrefs();
freshInstall = !savedPrefs;
showPrefsInUi();
renderDevices();
$('micSelect').addEventListener('change', e => selectDevice(e.target.value));
engine.onChange(() => { shownGate = ''; refreshGateUi(); updateHints(); });
engine.set({
  inputGain: volFactor(), gateDb: state.gateDb, gateAuto: state.gateAuto, nr: state.nr, nrAmount: state.nrAmount, mono: state.mono,
  comp: state.comp, compAmount: state.compAmount, eq, monitor: state.monitor, monitorVol: state.monitorVol,
  talking: talking(), talkFade: talkFade(), send: state.send
});
engine.init(EQ_BANDS);
applyMono();
bindControls(); bindEq(); updateGate(); updateHints(); updateCompHint(); paintRanges();
setEqOpen(state.eqOpen);
initStartup();
initMuteHotkey();
initPtt();
bindOutput();
bindSetup();
initUpdates();
initMuteSounds();
initBadge();
bindMicTest();
if (eqBandsReset.length) {
  $('eqNotice').textContent = `${eqBandsReset.join(' and ')} had moved outside ${eqBandsReset.length > 1 ? 'their ranges' : 'its range'}, so ${eqBandsReset.length > 1 ? 'they were' : 'it was'} reset to flat.`;
  savePrefs();
}
if (window.appInfo) window.appInfo.notices().then(list => list.forEach(showNotice)).catch(() => {});
ui.cover = $('meterCover'); ui.peak = $('meterPeak'); ui.levelDb = $('levelDb');
syncTicker();
applySysToUi();
loadDevices();
setInterval(pollSys, 2000);
window.addEventListener('focus', pollSys);
$('refreshBtn').addEventListener('click', loadDevices);
if (window.appInfo) window.appInfo.version().then(v => { $('appVersion').textContent = 'Olive ' + v.replace(/\.0$/, ''); }).catch(() => {});
bindSettings();
let deviceChangeTimer = null;
navigator.mediaDevices.addEventListener('devicechange', () => { clearTimeout(deviceChangeTimer); deviceChangeTimer = setTimeout(loadDevices, 400); });
