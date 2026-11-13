// ---- Level meters (outside React) ----
// Components hand their meter elements to setMeterEls(); a timer then moves them, touching only transforms and text.
// The timer runs only while the window is showing. The audio needs none here: the engine runs its own backup gate.
import { engine, MIN_DB, dbToPct, ampToDb, state } from './core.js';
import { pttOpen } from './keys.js';
import { redrawEqGraph } from './eq.js';
import { volFactor, updateCompHint, refreshGateUi } from './store.js';

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
// Another mic: start the level from the bottom.
export function resetLevel() { peak = MIN_DB; smoothed = MIN_DB; }

// Hidden = minimized / in the tray. Electron tells us via preload (document.hidden can't, see main.js).
export const isHidden = () => windowHidden || document.hidden;
if (window.appWindow) window.appWindow.onVisibility(v => { windowHidden = !v; if (v) redrawEqGraph(); syncTicker(); });
document.addEventListener('visibilitychange', () => syncTicker());
let tickTimer = null;
export function syncTicker() {
  const run = !isHidden();
  if (run === !!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
  if (run) { last = performance.now(); tickTimer = setInterval(tick, 33); }
}

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

// For test-bridge.js.
export const meterTestVars = { windowHidden: [() => windowHidden, v => { windowHidden = v; }] };
