// Mic Manager v1.3: real input devices, live metering + monitoring, mock fallback. Microphones only.

const MOCK_DEVICES = [
  { id: 'mic-1', name: 'USB Condenser Microphone', driver: 'USB Audio', channels: 'Mono · 48 kHz', isDefault: true, noise: 0.012, voice: 0.55 },
  { id: 'mic-2', name: 'Headset Microphone', driver: 'Bluetooth Hands-Free', channels: 'Mono · 16 kHz', noise: 0.03, voice: 0.4 },
  { id: 'mic-3', name: 'Webcam Microphone', driver: 'USB Video Device', channels: 'Stereo · 44.1 kHz', noise: 0.045, voice: 0.3 },
  { id: 'mic-4', name: 'Realtek Microphone Array', driver: 'Built-in', channels: 'Stereo · 48 kHz', noise: 0.06, voice: 0.35 }
];

let devices = MOCK_DEVICES;
let live = false;            // true when devices come from the system
const state = {
  deviceId: MOCK_DEVICES.find(d => d.isDefault).id,
  volume: 75, muted: false, gateDb: -45, gateAuto: true,
  nr: true, nrAmount: 60, monitor: false, monitorVol: 80, mono: false, send: true, comp: false, compAmount: 50
};

const $ = id => document.getElementById(id);
const MIN_DB = -60;
const dbToPct = db => Math.max(0, Math.min(100, (db - MIN_DB) / -MIN_DB * 100));
const ampToDb = a => (a <= 0 ? -Infinity : 20 * Math.log10(a));

// ---- Device list ----
function renderDevices() {
  const list = $('deviceList');
  list.innerHTML = '';
  for (const d of devices) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', d.id === state.deviceId);
    if (d.id === state.deviceId) li.classList.add('selected');
    li.innerHTML = `<span class="dev-name"></span><span class="dev-meta"></span>`;
    li.querySelector('.dev-name').textContent = d.name;
    li.querySelector('.dev-meta').innerHTML =
      `${[d.driver, d.channels].filter(Boolean).join(' · ')}${d.isDefault ? ' · <span class="dev-default">Default</span>' : ''}`;
    const pick = () => selectDevice(d.id);
    li.addEventListener('click', pick);
    li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    list.appendChild(li);
  }
}
function selectDevice(id) {
  state.deviceId = id;
  prefDeviceId = id;
  prefDeviceName = (devices.find(d => d.id === id) || {}).name || null;
  savePrefs();
  peak = MIN_DB; smoothed = MIN_DB;
  renderDevices();
  $('currentName').textContent = currentDevice().name;
  applySysToUi();
  if (live) startCapture();
}
const currentDevice = () => devices.find(d => d.id === state.deviceId) || devices[0];

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
  document.addEventListener('keydown', e => { if (e.ctrlKey && e.key.toLowerCase() === 'm') toggleMute(); });

  $('nrToggle').addEventListener('change', e => { state.nr = e.target.checked; $('nrAmount').disabled = !state.nr; applyNr(); updateHints(); });
  $('nrAmount').addEventListener('input', e => { state.nrAmount = +e.target.value; applyNr(); updateHints(); });
  $('monToggle').addEventListener('change', e => setMonitor(e.target.checked));
  $('listenBtn').addEventListener('click', () => setMonitor(!state.monitor));
  $('monoToggle').addEventListener('change', e => { state.mono = e.target.checked; applyMono(); });
  $('sendToggle').addEventListener('change', e => { sendWanted = e.target.checked; scheduleSave(); setSend(e.target.checked); });
  $('monVol').addEventListener('input', e => { state.monitorVol = +e.target.value; updateMonitorGain(); updateHints(); });
  $('compToggle').addEventListener('change', e => { state.comp = e.target.checked; $('compAmount').disabled = !state.comp; applyComp(); });
  $('compAmount').addEventListener('input', e => { state.compAmount = +e.target.value; applyComp(); });
}
function toggleMute() {
  setMutedUi(!state.muted);
  const ep = curSys();
  if (ep) {
    sysTouched = performance.now();
    sysApi.setMute(ep.id, state.muted).then(r => storeSys(r)).catch(sysFailed);
  }
}
function setMutedUi(m) {
  state.muted = m;
  const b = $('muteBtn');
  b.classList.toggle('on', state.muted);
  b.textContent = state.muted ? 'Muted' : 'Mute';
  b.setAttribute('aria-pressed', state.muted);
  $('meterFill').parentElement.classList.toggle('muted', state.muted);
  updateMonitorGain();
  updateSendGain();
}
function setMonitor(on) {
  state.monitor = on;
  $('monToggle').checked = on;
  $('monVol').disabled = !on;
  const b = $('listenBtn');
  b.classList.toggle('on', on);
  b.textContent = on ? 'Listening' : 'Listen';
  b.setAttribute('aria-pressed', on);
  if (on && audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  updateMonitorGain();
  updateHints();
}
// Smoothly move an AudioParam (avoids clicks).
function rampTo(param, value, tc = 0.02, ctx = audioCtx) {
  if (!param || !ctx) return;
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, tc);
}
// All live processing chains: the main one (meter + Listen) and, when sending, the one feeding the cable.
const chains = () => [eqNodes, sendNodes].filter(Boolean);
// Mono: the first EQ node downmixes to 1 channel ((L+R)/2), which then plays in both ears.
function applyMono() {
  $('monoHint').textContent = state.mono ? 'On: left and right mixed, heard in both ears' : 'Off: stereo mics keep left and right separate';
  chains().forEach(applyMonoTo);
}
function applyMonoTo(ch) {
  ch.input.channelCount = 1;
  ch.input.channelCountMode = state.mono ? 'explicit' : 'max';
  ch.input.channelInterpretation = 'speakers';
}
// With Windows control the captured audio already has the Windows level applied, so the app adds no gain.
const volFactor = () => (curSys() ? 1 : state.volume / 75);
// ---- Compressor / auto-level ----
// Strength 0-100% sets threshold -12..-40 dB and ratio 2:1..8:1; the compressor's built-in makeup gain
// brings quiet speech back up. Off = the compressor is taken out of the signal path entirely.
function compParams(a) {
  return { threshold: -12 - 28 * a, ratio: 2 + 6 * a, knee: 10, attack: 0.005, release: 0.25 };
}
function applyCompTo(ch) {
  const p = compParams(state.compAmount / 100), c = ch.comp;
  c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.knee.value = p.knee;
  c.attack.value = p.attack; c.release.value = p.release;
  if (ch.compOn === state.comp) return;
  try { ch.volGain.disconnect(); } catch {}
  ch.volGain.connect(state.comp ? c : (ch.gate || ch.gateGain));
  ch.compOn = state.comp;
}
function applyComp() {
  chains().forEach(applyCompTo);
  updateCompHint();
}
function updateCompHint() {
  if (!state.comp) { $('compHint').textContent = 'Off: your volume goes out as-is'; return; }
  const r = eqNodes && typeof eqNodes.comp.reduction === 'number' ? eqNodes.comp.reduction : 0;
  $('compHint').textContent = `On · strength ${state.compAmount}%` + (r < -0.5 ? ` · evening out ${(-r).toFixed(1)} dB` : '');
}
function updateVolumeGain() { chains().forEach(ch => rampTo(ch.volGain.gain, volFactor(), 0.02, ch.ctx)); }
function updateMonitorGain() {
  if (eqNodes) rampTo(eqNodes.outGain.gain, state.monitor && !state.muted ? state.monitorVol / 100 : 0, 0.02, eqNodes.ctx);
}
// Threshold in use right now: learned automatically, or the slider.
let autoGateDb = -51;
const gateDbNow = () => (state.gateAuto ? autoGateDb : state.gateDb);
let shownGate = '';
function updateGate() { refreshGateUi(); updateGateThreshold(); }
function refreshGateUi() {
  const t = Math.round(gateDbNow());
  $('gate').disabled = state.gateAuto;          // the slider keeps your manual setting while Auto is on
  const label = (state.gateAuto ? 'Auto · ' : '') + t + ' dB';
  if (label !== shownGate) {
    shownGate = label;
    $('gateVal').textContent = label;
    $('gateMark').style.left = dbToPct(t) + '%';
    $('gateHint').textContent = state.gateAuto ? 'Mutes you when you go quiet; follows your background noise' : "Mutes you when you're quieter than this";
  }
}
function updateHints() {
  $('nrHint').textContent = !state.nr ? 'Off'
    : !live ? `On · ${state.nrAmount}% (simulated)`
    : chains().some(ch => ch.nrFailed) ? 'Unavailable: the noise reduction engine could not start'
    : `On · ${state.nrAmount}% · lowers steady noise (fans, hum, hiss) by up to ${Math.round(state.nrAmount * NR_DB_PER_PERCENT)} dB`;
  $('monHint').textContent = !state.monitor ? "Off: you won't hear yourself"
    : analyser ? `On · ${state.monitorVol}% · use headphones to avoid echo`
    : live ? 'On · microphone not open, nothing to play'
    : 'On · mock mode has no real mic to play';
}

// ---- Simulated signal ----
// Speech-like bursts (syllables inside phrases) on top of a device-specific noise floor.
let t = 0, phraseOn = false, phraseLeft = 0, smoothed = MIN_DB, peak = MIN_DB, peakHold = 0;
function simulateAmplitude(dt) {
  const d = currentDevice();
  t += dt;
  phraseLeft -= dt;
  if (phraseLeft <= 0) { phraseOn = !phraseOn; phraseLeft = phraseOn ? 1 + Math.random() * 2.5 : 0.6 + Math.random() * 1.8; }

  let voice = 0;
  if (phraseOn) {
    const syllable = Math.max(0, Math.sin(t * 2 * Math.PI * 4.2)) ** 2;   // ~4 syllables/s
    voice = d.voice * (0.35 + 0.65 * syllable) * (0.8 + Math.random() * 0.4);
  }
  let noise = d.noise * (0.6 + Math.random() * 0.8);
  if (state.nr) noise *= 1 - 0.95 * (state.nrAmount / 100);   // mock NR shrinks the noise floor
  return voice + noise;
}

let last = performance.now(), gateOpen = null;
function tick() {
  // Hidden with the audio-thread gate on every chain: nothing to do on this thread at all.
  if (isHidden() && analyser && eqNodes.gate && (!sendNodes || sendNodes.gate)) { gateOpen = eqNodes.gateIsOpen; last = performance.now(); return; }
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const raw = analyser ? liveAmplitude() : simulateAmplitude(dt) * eqLevelFactor();
  let db = ampToDb(raw * volFactor());                       // in-app: 75% = unity
  // main chain (meter + Listen): audio-thread gate reports its state; otherwise gate here.
  // Mock mode (no live mic) shows the simulated gate on the meter.
  let open;
  if (!analyser) { trackFloor(raw * volFactor(), dt); open = db >= gateDbNow(); }   // mock: simulated gate
  else if (eqNodes.gate) open = eqNodes.gateIsOpen;
  else open = gateChain(eqNodes, raw, now);
  gateOpen = open;
  // send chain: same, from the audio that is actually going to Discord
  if (sendNodes && !sendNodes.gate) gateChain(sendNodes, sendSrc ? chainAmplitude(sendNodes) : 0, now);
  if (!open) db = -Infinity;                                 // noise gate closes
  if (state.muted) db = -Infinity;
  if (isHidden()) { smoothed = MIN_DB; peak = MIN_DB; return; }       // hidden in the tray: audio work only, no drawing

  const target = Math.max(MIN_DB, Math.min(6, db));
  smoothed = target > smoothed ? target : smoothed - 40 * dt; // fast attack, slow release
  smoothed = Math.max(MIN_DB, smoothed);
  if (smoothed >= peak) { peak = smoothed; peakHold = 1; } else if ((peakHold -= dt) <= 0) peak = Math.max(MIN_DB, peak - 20 * dt);

  levelPct = dbToPct(smoothed);
  peakPct = dbToPct(peak);
  if ((compTick = (compTick + 1) % 12) === 0) {          // ~4x per second
    if (state.comp && eqNodes) updateCompHint();
    if (state.gateAuto) refreshGateUi();
    paintRanges();
  }
}
let compTick = 0, levelPct = 0, peakPct = 0;

// Blue fill up to the knob on every slider (also catches values set from code).
function paintRanges() {
  for (const r of document.querySelectorAll('input[type=range]')) {
    const v = (((r.value - r.min) / (r.max - r.min)) * 100).toFixed(1) + '%';
    if (r.style.getPropertyValue('--fill') !== v) r.style.setProperty('--fill', v);
  }
}
document.addEventListener('input', e => { if (e.target.type === 'range') paintRanges(); });

// Drawing runs once per screen frame and only touches GPU transforms; text changes at most 10x per second.
const ui = {};
let shownCover = '', shownPeak = '', shownDb = '', dbShownAt = 0, drawing = false, windowHidden = false;
// Hidden = minimized / in the tray. Electron tells us via preload (document.hidden can't, see main.js).
const isHidden = () => windowHidden || document.hidden;
function startDrawing() { if (!drawing && !isHidden()) { drawing = true; requestAnimationFrame(draw); } }
if (window.appWindow) window.appWindow.onVisibility(v => { windowHidden = !v; if (v) { startDrawing(); scheduleEqDraw(); } });
document.addEventListener('visibilitychange', startDrawing);
function draw(now) {
  if (isHidden()) { drawing = false; return; }        // stop the frame loop entirely until shown again
  requestAnimationFrame(draw);
  const cover = 'scaleX(' + (1 - levelPct / 100).toFixed(3) + ')';
  if (cover !== shownCover) { ui.cover.style.transform = cover; shownCover = cover; }
  const pk = 'translateX(' + peakPct.toFixed(1) + '%)';
  if (pk !== shownPeak) { ui.peak.style.transform = pk; shownPeak = pk; }
  if (now - dbShownAt >= 100) {
    dbShownAt = now;
    const t = state.muted ? 'Muted' : (smoothed <= MIN_DB ? '-∞ dB' : smoothed.toFixed(1) + ' dB');
    if (t !== shownDb) { ui.levelDb.textContent = t; shownDb = t; }
  }
}

let stream = null, srcNode = null, audioCtx = null, analyser = null, buf = null, captureToken = 0;
let eqNodes = null;                 // main chain (meter + Listen) on audioCtx
let sendCtx = null, sendNodes = null, sendSrc = null, sendCableId = null;   // send chain -> virtual cable

// ---- Mic EQ ----
// Six bands plus a low cut. Every band has a frequency, a gain and (peaking bands) a width (Q).
// The graph is the control: drag a point (left/right = frequency, up/down = gain), scroll to change width.
const EQ_BANDS = [
  { key: 'bass',       name: 'Bass',       type: 'lowshelf',  freq: 100,   q: 0.7, color: '#0a84ff' },
  { key: 'lowmid',     name: 'Low mid',    type: 'peaking',   freq: 250,   q: 1.0, color: '#5e5ce6' },
  { key: 'mid',        name: 'Mid',        type: 'peaking',   freq: 1000,  q: 1.0, color: '#bf5af2' },
  { key: 'presence',   name: 'Presence',   type: 'peaking',   freq: 4000,  q: 1.0, color: '#ff375f' },
  { key: 'brilliance', name: 'Brilliance', type: 'peaking',   freq: 7000,  q: 1.4, color: '#ff9f0a' },
  { key: 'air',        name: 'Air',        type: 'highshelf', freq: 10000, q: 0.7, color: '#64d2ff' }
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
const eq = { on: true, lowCut: false, b: {} };          // b[key] = { f: Hz, g: dB, q }
const bandDef = key => EQ_BANDS.find(d => d.key === key);
function resetBand(key) { const d = bandDef(key); eq.b[key] = { f: d.freq, g: 0, q: d.q }; }
EQ_BANDS.forEach(d => resetBand(d.key));
let eqSel = null;                                       // selected band key

function audioCtxInit() {
  try {
    audioCtx = new AudioContext({ latencyHint: 'interactive' });
    eqNodes = buildChain(audioCtx);       // its analyser (~21 ms per reading) also drives the level meter
    eqNodes.monGain = eqNodes.outGain;     // Listen level
    buf = eqNodes.meterBuf;
  } catch (err) { audioCtx = null; eqNodes = null; console.error('Audio engine unavailable:', err); }
}
// One processing chain: noise reduction -> [mono] EQ -> volume -> gate -> output level -> this context's output device.
function buildChain(ctx) {
  const hp = ctx.createBiquadFilter(); hp.type = 'lowshelf'; hp.frequency.value = 80; hp.gain.value = 0; hp.Q.value = 0.7;
  const bands = EQ_BANDS.map(b => { const f = ctx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.freq; f.Q.value = b.q; return f; });
  [hp, ...bands].reduce((a, b) => (a.connect(b), b));
  const head = ctx.createGain();                // the mic connects here; noise reduction is inserted after it
  head.connect(hp);
  const output = bands[bands.length - 1];
  const volGain = ctx.createGain(), gateGain = ctx.createGain(), outGain = ctx.createGain();
  volGain.gain.value = volFactor();
  gateGain.gain.value = 0;                      // opens on the first loud reading of this chain's own audio
  outGain.gain.value = 0;
  outGain.channelCount = 2; outGain.channelCountMode = 'explicit';  // always stereo out: mono plays in both ears
  outGain.channelInterpretation = 'speakers';
  const comp = ctx.createDynamicsCompressor();
  output.connect(volGain); comp.connect(gateGain); gateGain.connect(outGain); outGain.connect(ctx.destination);
  // Each chain measures its own audio for the noise gate: the send engine hears the mic a little later
  // than the main one, so a gate driven by the other engine's audio would clip the starts/ends of words.
  const meter = ctx.createAnalyser();
  meter.fftSize = 1024;
  output.connect(meter);
  const ch = { ctx, head, hp, bands, input: hp, output, volGain, comp, compOn: null, gateGain, outGain,
               meter, meterBuf: new Float32Array(meter.fftSize), gateIsOpen: false, holdUntil: 0 };
  applyCompTo(ch);                              // connects volume -> (compressor ->) gate
  applyMonoTo(ch);
  applyEqTo(ch);
  attachGate(ch);                               // swaps in the audio-thread gate once it has loaded
  attachNr(ch);                                 // and the noise reduction
  return ch;
}
function applyEq() {
  $('eqToggle').closest('.eq').classList.toggle('off', !eq.on);
  chains().forEach(ch => applyEqTo(ch));
  scheduleEqDraw();
}
function applyEqTo(ch) {
  EQ_BANDS.forEach((d, i) => {
    const s = eq.b[d.key], f = ch.bands[i];
    rampTo(f.frequency, s.f, 0.012, ch.ctx);            // short glide: no clicks while dragging
    rampTo(f.gain, eq.on ? s.g : 0, 0.012, ch.ctx);
    rampTo(f.Q, s.q, 0.012, ch.ctx);
  });
  // Low cut on: 80 Hz high-pass. Off: a 0 dB shelf, which passes audio unchanged.
  const cut = eq.on && eq.lowCut;
  ch.hp.type = cut ? 'highpass' : 'lowshelf';
  ch.hp.frequency.value = 80;
  ch.hp.gain.value = 0;
}
// Rough gain the EQ adds to a voice-like signal, used to move the simulated meter.
function eqLevelFactor() {
  if (!eq.on) return 1;
  const g = k => eq.b[k].g;
  const db = 0.2 * g('bass') + 0.2 * g('lowmid') + 0.25 * g('mid') + 0.15 * g('presence') + 0.1 * g('brilliance') + 0.1 * g('air') - (eq.lowCut ? 0.5 : 0);
  return Math.pow(10, db / 20);
}
function eqEdited() {                                   // user changed a band
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
    html = 'Drag a point to shape your sound · scroll over it to change its width · double-click to reset';
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

  // grid
  ctx.lineWidth = 1; ctx.font = "11px system-ui, 'Segoe UI', sans-serif"; ctx.textBaseline = 'middle';
  for (const g of [-12, -6, 0, 6, 12]) {
    const y = Math.round(eqY(g)) + 0.5;
    ctx.strokeStyle = g === 0 ? '#48484a' : '#2c2c2e';
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.fillStyle = '#98989d'; ctx.textAlign = 'right'; ctx.fillText((g > 0 ? '+' : '') + g, x0 - 6, y);
  }
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  for (const [f, t] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
    const x = Math.round(eqX(f)) + 0.5;
    ctx.strokeStyle = '#232325'; ctx.beginPath(); ctx.moveTo(x, EQ_PAD.t); ctx.lineTo(x, eqH - EQ_PAD.b); ctx.stroke();
    ctx.fillStyle = '#98989d'; ctx.fillText(t, x, eqH - 5);
  }
  if (!disp) return;

  // response of each filter
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
  if (selCurve) {                                       // selected band's own shape
    const col = bandDef(eqSel).color;
    path(selCurve); ctx.lineTo(x1, y0); ctx.lineTo(x0, y0); ctx.closePath();
    ctx.globalAlpha = 0.22; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
  }
  path(total); ctx.lineTo(x1, y0); ctx.lineTo(x0, y0); ctx.closePath();
  ctx.fillStyle = 'rgba(0,102,204,0.16)'; ctx.fill();
  path(total); ctx.strokeStyle = '#2997ff'; ctx.lineWidth = 2; ctx.stroke();

  // points
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = "600 11px system-ui, 'Segoe UI', sans-serif";
  EQ_BANDS.forEach((d, i) => {
    const p = eqPoint(d.key), sel = d.key === eqSel;
    if (sel) { ctx.beginPath(); ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
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
    s.f = clamp(eqF(x), EQ_F_MIN, EQ_F_MAX);
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
  c.addEventListener('wheel', e => {
    const p = local(e), key = bandAt(p.x, p.y, 40) || eqSel;
    if (!key || bandDef(key).type !== 'peaking') return;
    e.preventDefault();
    const s = eq.b[key];
    s.q = Math.round(clamp(s.q * Math.exp(-e.deltaY * 0.0015), EQ_Q_MIN, EQ_Q_MAX) * 100) / 100;
    if (eqSel !== key) selectBand(key);
    eqEdited();
  }, { passive: false });
  c.addEventListener('keydown', e => {
    if (/^[1-6]$/.test(e.key)) { selectBand(EQ_BANDS[+e.key - 1].key); e.preventDefault(); return; }
    if (e.key === 'Escape') { selectBand(null); return; }
    if (!eqSel) { if (e.key.startsWith('Arrow')) { selectBand(EQ_BANDS[0].key); e.preventDefault(); } return; }
    const s = eq.b[eqSel], fine = e.shiftKey;
    let handled = true;
    if (e.key === 'ArrowUp') s.g = clamp(Math.round((s.g + (fine ? 0.1 : 0.5)) * 10) / 10, -EQ_G_MAX, EQ_G_MAX);
    else if (e.key === 'ArrowDown') s.g = clamp(Math.round((s.g - (fine ? 0.1 : 0.5)) * 10) / 10, -EQ_G_MAX, EQ_G_MAX);
    else if (e.key === 'ArrowRight') s.f = clamp(s.f * (fine ? 1.01 : 1.06), EQ_F_MIN, EQ_F_MAX);
    else if (e.key === 'ArrowLeft') s.f = clamp(s.f / (fine ? 1.01 : 1.06), EQ_F_MIN, EQ_F_MAX);
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
function bindEq() {
  renderEqChips();
  bindEqGraph();
  $('eqPreset').addEventListener('change', e => {
    const p = EQ_PRESETS[e.target.value]; if (!p) return;
    applyPreset(p); syncEqUi();
  });
  $('eqToggle').addEventListener('change', e => { eq.on = e.target.checked; applyEq(); });
  $('lowCut').addEventListener('change', e => { eq.lowCut = e.target.checked; $('eqPreset').value = 'custom'; applyEq(); });
  window.addEventListener('resize', scheduleEqDraw);    // also catches display scale changes
  // The canvas also changes size without the window doing so (devices panel, scrollbar), so watch it directly.
  new ResizeObserver(scheduleEqDraw).observe($('eqCurve'));
  syncEqUi();
}

// ---- Live input (Web Audio) ----


function liveAmplitude() { return chainAmplitude(eqNodes); }
function chainAmplitude(ch) {
  const b = ch.meterBuf;
  ch.meter.getFloatTimeDomainData(b);
  let sum = 0;
  for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
  return Math.sqrt(sum / b.length) * 1.41;                   // RMS -> roughly peak-scaled
}
// ---- Noise gate ----
// Preferred: gate-worklet.js on the audio thread (sample-accurate, 5 ms look-ahead, 150 ms hold).
// Fallback if it can't load: gate from the main thread below (reacts every 20 ms, can clip word starts).
const GATE_WORKLET_URL = window.GATE_WORKLET_URL || (location.protocol === 'file:' ? 'app://local/gate-worklet.js' : 'gate-worklet.js');
const NR_WORKLET_URL = window.NR_WORKLET_URL || (location.protocol === 'file:' ? 'app://local/nr-worklet.js' : 'nr-worklet.js');
const gateModules = new WeakMap(), nrModules = new WeakMap();
let gateMode = 'loading';                       // loading | audio-thread | main-thread
function loadGateModule(ctx) {
  if (!gateModules.has(ctx)) gateModules.set(ctx, ctx.audioWorklet.addModule(GATE_WORKLET_URL));
  return gateModules.get(ctx);
}
async function attachGate(ch) {
  try {
    if (!ch.ctx.audioWorklet) throw new Error('AudioWorklet not supported');
    await loadGateModule(ch.ctx);
    if (ch.ctx.state === 'closed') return;
    const node = new AudioWorkletNode(ch.ctx, 'noise-gate', { numberOfInputs: 1, numberOfOutputs: 1, parameterData: { threshold: state.gateDb, auto: state.gateAuto ? 1 : 0 } });
    node.port.onmessage = e => {
      const d = e.data || {};
      ch.gateIsOpen = !!d.open;
      if (ch === eqNodes && typeof d.threshold === 'number') autoGateDb = d.threshold;   // learned on the main chain
    };
    node.onprocessorerror = () => detachGate(ch);
    ch.gate = node;
    try { ch.comp.disconnect(); } catch {}
    ch.comp.connect(node);
    node.connect(ch.gateGain);
    ch.compOn = null; applyCompTo(ch);          // route volume -> (compressor ->) worklet gate
    rampTo(ch.gateGain.gain, 1, 0.003, ch.ctx);  // gateGain is no longer the gate
    gateMode = 'audio-thread';
  } catch (err) {
    if (gateMode !== 'audio-thread') gateMode = 'main-thread';
    console.warn('Audio-thread noise gate unavailable, using the fallback:', err && err.message);
  }
}
function detachGate(ch) {                         // worklet crashed: fall back to the main-thread gate
  const node = ch.gate; if (!node) return;
  ch.gate = null;
  try { node.disconnect(); ch.comp.disconnect(); } catch {}
  ch.comp.connect(ch.gateGain);
  ch.compOn = null; applyCompTo(ch);
  ch.gateIsOpen = !ch.gateIsOpen; gateChain(ch, 0, performance.now());
}
// ---- Noise reduction ----
// nr-worklet.js on the raw mic. Strength never rebuilds anything, so moving the slider doesn't interrupt the audio.
const NR_DB_PER_PERCENT = 0.3;                    // same value as in nr-worklet.js
async function attachNr(ch) {
  try {
    if (!ch.ctx.audioWorklet) throw new Error('AudioWorklet not supported');
    if (!nrModules.has(ch.ctx)) nrModules.set(ch.ctx, ch.ctx.audioWorklet.addModule(NR_WORKLET_URL));
    await nrModules.get(ch.ctx);
    if (ch.ctx.state === 'closed') return;
    const node = new AudioWorkletNode(ch.ctx, 'noise-reduction', { numberOfInputs: 1, numberOfOutputs: 1, parameterData: { strength: nrStrengthNow() } });
    node.onprocessorerror = () => { detachNr(ch); ch.nrFailed = true; updateHints(); };
    ch.nr = node;
    ch.head.disconnect();
    ch.head.connect(node);
    node.connect(ch.hp);
  } catch (err) {
    ch.nrFailed = true;
    updateHints();
    console.warn('Noise reduction unavailable:', err && err.message);
  }
}
function detachNr(ch) {
  const node = ch.nr; if (!node) return;
  ch.nr = null;
  try { ch.head.disconnect(); node.disconnect(); } catch {}
  ch.head.connect(ch.hp);
}
const nrStrengthNow = () => (state.nr ? state.nrAmount : 0);
function applyNr() {
  for (const ch of chains()) if (ch.nr) ch.nr.parameters.get('strength').setValueAtTime(nrStrengthNow(), ch.ctx.currentTime);
}

function updateGateThreshold() {
  for (const ch of chains()) if (ch.gate) {
    ch.gate.parameters.get('threshold').setValueAtTime(state.gateDb, ch.ctx.currentTime);
    ch.gate.parameters.get('auto').setValueAtTime(state.gateAuto ? 1 : 0, ch.ctx.currentTime);
  }
}

// Fallback automatic threshold (same rule as the worklet): noise floor = lowest level of the last 3 s
// (one minimum per 100 ms), threshold = floor + 9 dB, kept between -70 and -25 dBFS.
const floorMins = new Array(30).fill(-60);
let floorSlotMin = Infinity, floorSlotT = 0, floorIdx = 0;
function trackFloor(amp, dt) {
  const d = ampToDb(amp);
  const lvl = isFinite(d) ? d : -120;
  if (lvl < floorSlotMin) floorSlotMin = lvl;
  floorSlotT += dt;
  if (floorSlotT >= 0.1) {
    floorMins[floorIdx] = floorSlotMin; floorIdx = (floorIdx + 1) % floorMins.length;
    floorSlotMin = Infinity; floorSlotT = 0;
    const floor = Math.min(-35, Math.max(-90, Math.min(...floorMins)));
    autoGateDb = Math.min(-25, Math.max(-70, floor + 9));
  }
}

// Fallback noise gate for one chain, from that chain's own audio. Opens at once; stays open 150 ms after you
// go quiet (hold) so word endings aren't cut, then fades out.
const GATE_HOLD_MS = 150;
function gateChain(ch, amp, now) {
  if (ch === eqNodes) trackFloor(amp * volFactor(), 0.02);
  const loud = ampToDb(amp * volFactor()) >= gateDbNow();
  if (loud) ch.holdUntil = now + GATE_HOLD_MS;
  const open = loud || now < ch.holdUntil;
  if (open !== ch.gateIsOpen) {
    ch.gateIsOpen = open;
    rampTo(ch.gateGain.gain, open ? 1 : 0, open ? 0.003 : 0.05, ch.ctx);
  }
  return open;
}

function stopCapture() {
  if (stream) stream.getTracks().forEach(tr => tr.stop());
  if (srcNode) { try { srcNode.disconnect(); } catch {} }
  if (sendSrc) { try { sendSrc.disconnect(); } catch {} }
  stream = null; srcNode = null; sendSrc = null; analyser = null;
  updateHints();
}

async function startCapture() {
  const token = ++captureToken;
  stopCapture();
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: state.deviceId },
        noiseSuppression: false, echoCancellation: false, autoGainControl: false   // raw mic: nr-worklet.js does the noise reduction
      }
    });
    if (token !== captureToken) { s.getTracks().forEach(tr => tr.stop()); return; }
    stream = s;
    if (!audioCtx || !eqNodes) throw Object.assign(new Error('No audio engine'), { name: 'AudioEngineError' });
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    srcNode = audioCtx.createMediaStreamSource(stream);
    srcNode.connect(eqNodes.head);
    analyser = eqNodes.meter;                                // marks live capture as active
    connectSendSource();
    setStatus('');
    updateHints();
  } catch (err) {
    if (token !== captureToken) return;
    setStatus(`Couldn't open this microphone (${err.name}). Showing simulated level.`);
    updateHints();
  }
}

function setStatus(msg) { $('devStatus').textContent = msg; }

async function loadDevices() {
  setStatus('');
  let found = [];
  try {
    // Ask once so Windows reveals device names.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach(tr => tr.stop());
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications' && !isCableLabel(d.label));
    const def = inputs.find(d => d.deviceId === 'default');
    found = inputs.filter(d => d.deviceId !== 'default').map(d => ({
      id: d.deviceId,
      name: d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '') || 'Microphone',
      driver: 'System device', channels: '', noise: 0.02, voice: 0.45,
      isDefault: !!def && d.groupId === def.groupId
    }));
  } catch (err) {
    setStatus(`Microphone access unavailable (${err.name}). Using mock devices.`);
  }

  live = found.length > 0;
  devices = live ? found : MOCK_DEVICES;
  if (!live && !$('devStatus').textContent) setStatus('No microphones found. Using mock devices.');
  if (!devices.some(d => d.id === state.deviceId)) {
    // Device IDs can change between launches; fall back to the saved mic's name, then the Windows default.
    const byId = devices.find(d => d.id === prefDeviceId);
    const byName = prefDeviceName ? devices.filter(d => d.name === prefDeviceName) : [];
    const pick = byId || (byName.length === 1 && byName[0]) || devices.find(d => d.isDefault) || devices[0];
    state.deviceId = pick.id;
  }

  const badge = $('sourceBadge');
  badge.textContent = live ? 'Live input' : 'Mock audio';
  badge.classList.toggle('live', live);
  renderDevices();
  $('currentName').textContent = currentDevice().name;
  updateHints();
  if (live) startCapture(); else { stopCapture(); }
  syncSystem();
  if (sendWanted) setSend(true);   // (re)connect the cable at start-up, after a rescan or a device change
}

// ---- Send to other apps (VB-Audio Virtual Cable) ----
const isCableLabel = l => /\bCABLE\b.*VB-Audio|VB-Audio Virtual Cable/i.test(l || '');
let sendToken = 0;

function sendHint(text, cls) {
  const h = $('sendHint');
  h.textContent = text;
  h.className = 'hint' + (cls ? ' ' + cls : '');
  h.dataset.state = cls || 'neutral';
  $('sendToggle').parentElement.title = cls === 'on'
    ? 'Sending to the virtual cable. In Discord, choose "CABLE Output (VB-Audio Virtual Cable)" as your input device.'
    : 'Send the processed mic to VB-Audio Virtual Cable';
}
function updateSendGain() {
  if (sendNodes) rampTo(sendNodes.outGain.gain, state.send && !state.muted ? 1 : 0, 0.02, sendCtx);
}
// The send chain reads the mic directly (its own source node) so nothing sits between it and the cable.
function connectSendSource() {
  if (sendSrc) { try { sendSrc.disconnect(); } catch {} sendSrc = null; }
  if (!sendNodes || !stream) return;
  sendSrc = sendCtx.createMediaStreamSource(stream);
  sendSrc.connect(sendNodes.head);
}
function teardownSend() {
  if (sendSrc) { try { sendSrc.disconnect(); } catch {} }
  if (sendCtx) sendCtx.close().catch(() => {});
  sendCtx = null; sendNodes = null; sendSrc = null; sendCableId = null;
}
async function findCable() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const outs = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return outs.find(d => /CABLE Input/i.test(d.label)) || outs.find(d => isCableLabel(d.label)) || null;
}
async function setSend(on) {
  const token = ++sendToken;
  if (!on) {
    state.send = false; updateSendGain(); teardownSend();
    $('sendToggle').checked = false; sendHint('Off: other apps hear your raw mic');
    return;
  }
  $('sendToggle').checked = true;
  try {
    const cable = await findCable();
    if (token !== sendToken) return;
    if (!cable) {
      state.send = false; teardownSend();
      $('sendToggle').checked = false;
      sendHint('VB-Audio Virtual Cable not found. Install it from vb-audio.com/Cable, restart the PC, then try again.', 'warn');
      return;
    }
    if (!(sendNodes && sendCableId === cable.deviceId && sendCtx.state !== 'closed')) {
      // New low-latency audio engine whose output device is the cable itself.
      sendHint('Connecting…');
      state.send = false; teardownSend();
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      try {
        await ctx.setSinkId(cable.deviceId);
        if (ctx.state === 'suspended') await ctx.resume();
      } catch (err) { ctx.close().catch(() => {}); throw err; }
      if (token !== sendToken) { ctx.close().catch(() => {}); return; }
      sendCtx = ctx; sendCableId = cable.deviceId;
      sendNodes = buildChain(ctx);
      connectSendSource();
    }
    state.send = true;
    updateSendGain();
    sendHint(live ? '' : 'On · but mock mode has no real mic to send', live ? 'on' : 'warn');
  } catch (err) {
    if (token !== sendToken) return;
    state.send = false; teardownSend();
    $('sendToggle').checked = false;
    sendHint("Couldn't send to the virtual cable (" + (err.name || 'Error') + ': ' + err.message + ')', 'warn');
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
  hint.classList.toggle('sys', !!ep);
  if (ep) {
    volSent = null;
    state.volume = Math.round(ep.volume * 100);
    $('volume').value = state.volume;
    $('volumeVal').textContent = state.volume + '%';
    if (ep.muted !== state.muted) setMutedUi(ep.muted);
    hint.textContent = '';                                  // normal state: no extra text
    hint.title = '';
    $('volume').title = 'Sets the Windows mic level and mute · affects all apps';
  } else {
    hint.textContent = !live ? 'Simulated (mock mode)'
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

// Pick up changes made elsewhere (Windows Sound settings, other apps).
async function pollSys() {
  const ep = curSys();
  if (!ep || volInflight || isHidden() || performance.now() - sysTouched < 1500) return;
  try {
    const r = await sysApi.get(ep.id);
    if (performance.now() - sysTouched < 1500 || curSys() !== ep) return;   // user acted meanwhile
    if (storeSys(r)) applySysToUi();
  } catch (err) { /* transient; next poll retries */ }
}

// ---- Saved settings ----
// Restored on start: mic, volume (in-app), gate, mono, noise reduction, monitor level, EQ, send.
// Not restored on purpose: Listen (could cause feedback at launch) and Mute (Windows keeps its own).
const PREFS_KEY = 'micManager.settings.v1';
let prefDeviceId = null, prefDeviceName = null, sendWanted = true, saveTimer = null, devicesCollapsed = false;

function loadPrefs() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { p = null; }
  if (!p || typeof p !== 'object') return null;
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  if (typeof p.deviceId === 'string') { prefDeviceId = p.deviceId; state.deviceId = p.deviceId; }
  if (typeof p.deviceName === 'string') prefDeviceName = p.deviceName;
  state.volume = num(p.volume, 0, 100, state.volume);
  state.gateDb = num(p.gateDb, -60, -10, state.gateDb);
  if (typeof p.gateAuto === 'boolean') state.gateAuto = p.gateAuto;
  state.mono = p.mono === true;
  if (typeof p.nr === 'boolean') state.nr = p.nr;   // remembered (on by default)
  state.nrAmount = num(p.nrStrength, 0, 100, state.nrAmount);   // not the old nrAmount: that slider never changed the live audio
  state.monitorVol = num(p.monitorVol, 0, 100, state.monitorVol);
  state.comp = p.comp === true;
  state.compAmount = num(p.compAmount, 0, 100, state.compAmount);
  sendWanted = true;                             // Send to Discord is always on at launch;
  state.send = true;                             // loadDevices() connects the cable once devices are known
  devicesCollapsed = p.devicesCollapsed === true;
  if (p.eq && typeof p.eq === 'object') {
    eq.on = p.eq.on !== false;
    eq.lowCut = p.eq.lowCut === true;
    for (const d of EQ_BANDS) {
      const src = (p.eq.bands && p.eq.bands[d.key]) || {};
      const legacy = p.eq.gains && p.eq.gains[d.key];          // settings saved by v1.1 and earlier
      eq.b[d.key] = {
        f: num(src.f, EQ_F_MIN, EQ_F_MAX, d.freq),
        g: num(src.g !== undefined ? src.g : legacy, -EQ_G_MAX, EQ_G_MAX, 0),
        q: num(src.q, EQ_Q_MIN, EQ_Q_MAX, d.q)
      };
    }
    eqPresetPref = typeof p.eq.preset === 'string' ? p.eq.preset : 'flat';
  }
  return p;
}
let eqPresetPref = 'flat';

// One time only: switch to the EQ + compressor tuned from your recording. Afterwards it's just a preset.
function applyTunedOnce(p) {
  if (p && p.tunedVoice === 1) return;
  applyPreset(EQ_PRESETS.myvoice);
  eq.on = true;
  eqPresetPref = 'myvoice';
  state.comp = true;
  state.compAmount = 75;
}

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
  setDevicesCollapsed(devicesCollapsed);
  const sel = $('eqPreset');
  sel.value = [...sel.options].some(o => o.value === eqPresetPref) ? eqPresetPref : 'custom';
}

function savePrefs() {
  clearTimeout(saveTimer); saveTimer = null;
  const p = {
    deviceId: prefDeviceId, deviceName: prefDeviceName, volume: state.volume, gateDb: state.gateDb, gateAuto: state.gateAuto, mono: state.mono, tunedVoice: 1,
    nr: state.nr, nrStrength: state.nrAmount, monitorVol: state.monitorVol, send: sendWanted,
    comp: state.comp, compAmount: state.compAmount, devicesCollapsed,
    eq: { on: eq.on, lowCut: eq.lowCut, preset: $('eqPreset').value,
          bands: Object.fromEntries(EQ_BANDS.map(d => [d.key, { ...eq.b[d.key] }])) }
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable: settings just won't persist */ }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(savePrefs, 300); }
// Any control the user touches -> save shortly after (handlers run first, so state is current).
// While dragging ('input') save shortly after; on release / toggle / select ('change') save right away.
document.addEventListener('input', scheduleSave);
document.addEventListener('dblclick', scheduleSave);
document.addEventListener('change', () => savePrefs());
window.addEventListener('beforeunload', () => { if (saveTimer) savePrefs(); });

// ---- Start with Windows ----
// window.appStartup comes from preload.js; Windows keeps the setting (Settings > Apps > Startup).
async function initStartup() {
  const t = $('startupToggle'), hint = $('startupHint');
  const api = window.appStartup || null;
  const off = msg => { t.disabled = true; t.checked = false; hint.textContent = msg; };
  if (!api) return off('Only in the Windows app');
  try {
    const r = await api.get();
    if (!r.supported) return off('Windows only');
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

// ---- Collapsible input devices panel ----
function setDevicesCollapsed(c) {
  devicesCollapsed = c;
  document.body.classList.toggle('devices-collapsed', c);
  const b = $('devToggle');
  b.setAttribute('aria-expanded', String(!c));
  b.title = c ? 'Show input devices' : 'Hide input devices';
  $('devicesPanel').setAttribute('aria-hidden', String(c));
  $('devicesPanel').inert = c;                    // no tabbing into the hidden list
}
$('devToggle').addEventListener('click', () => { setDevicesCollapsed(!devicesCollapsed); savePrefs(); });

// ---- Init ----
applyTunedOnce(loadPrefs());
showPrefsInUi();
renderDevices();
$('currentName').textContent = currentDevice().name;
audioCtxInit();
applyMono();
bindControls(); bindEq(); updateGate(); updateHints(); updateCompHint(); paintRanges();
initStartup();
ui.cover = $('meterCover'); ui.peak = $('meterPeak'); ui.levelDb = $('levelDb');
setInterval(tick, 20);                 // audio + noise gate, 50x per second (keeps running in the tray)
startDrawing();                        // meter drawing, only while the window is visible
applySysToUi();
loadDevices();
setInterval(pollSys, 2000);
window.addEventListener('focus', pollSys);
$('refreshBtn').addEventListener('click', loadDevices);
navigator.mediaDevices.addEventListener('devicechange', () => { clearTimeout(window._dc); window._dc = setTimeout(loadDevices, 400); });
