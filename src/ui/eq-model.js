// The mic EQ's data: six bands plus a low cut. Every band has a frequency, a gain and (peaking bands) a width (Q).
export const EQ_BANDS = [
  { key: 'bass',       name: 'Bass',       type: 'lowshelf',  freq: 100,   q: 0.7, min: 20,   max: 300,   color: '#0a84ff' },
  { key: 'lowmid',     name: 'Low mid',    type: 'peaking',   freq: 250,   q: 1.0, min: 100,  max: 800,   color: '#5e5ce6' },
  { key: 'mid',        name: 'Mid',        type: 'peaking',   freq: 1000,  q: 1.0, min: 300,  max: 3000,  color: '#bf5af2' },
  { key: 'presence',   name: 'Presence',   type: 'peaking',   freq: 4000,  q: 1.0, min: 1500, max: 8000,  color: '#ff375f' },
  { key: 'brilliance', name: 'Brilliance', type: 'peaking',   freq: 7000,  q: 1.4, min: 3000, max: 14000, color: '#ff9f0a' },
  { key: 'air',        name: 'Air',        type: 'highshelf', freq: 10000, q: 0.7, min: 5000, max: 20000, color: '#64d2ff' }
];
export const EQ_F_MIN = 20, EQ_F_MAX = 20000, EQ_G_MAX = 12, EQ_RANGE = 15, EQ_Q_MIN = 0.3, EQ_Q_MAX = 8;
// A preset value is a gain in dB, or { g, f, q } to also set frequency and width.
export const EQ_PRESETS = {
  // Fitted to your recording (Nov 2026): fills the 400-1000 Hz dip, tames the very bright 4-10 kHz range,
  // keeps a little extra clarity; low cut off because your voice goes down to ~74 Hz.
  myvoice:   { bass: 0, lowmid: { g: 3, f: 420, q: 0.7 }, mid: { g: 6, f: 800, q: 1.6 }, presence: { g: -5, f: 4000, q: 0.7 },
               brilliance: { g: -6, f: 6500, q: 0.7 }, air: -4, lowCut: false },
  flat:      { bass: 0,  lowmid: 0,  mid: 0,  presence: 0, brilliance: 0, air: 0, lowCut: false },
  clarity:   { bass: -2, lowmid: -2, mid: -1, presence: 4, brilliance: 2, air: 3, lowCut: true },
  broadcast: { bass: 4,  lowmid: -1, mid: -2, presence: 3, brilliance: 1, air: 2, lowCut: true },
  boom:      { bass: -6, lowmid: -3, mid: 0,  presence: 1, brilliance: 0, air: 0, lowCut: true }
};
export const PRESET_NAMES = [
  ['myvoice', 'My voice (tuned)'], ['flat', 'Flat'], ['clarity', 'Voice clarity'], ['broadcast', 'Broadcast'], ['boom', 'Reduce boom']
];

export const eq = { on: true, lowCut: false, b: {} };          // b[key] = { f: Hz, g: dB, q }
export const bandDef = key => EQ_BANDS.find(d => d.key === key);
export function resetBand(key) { const d = bandDef(key); eq.b[key] = { f: d.freq, g: 0, q: d.q }; }
EQ_BANDS.forEach(d => resetBand(d.key));
export const eqBandsReset = [];                                  // bands found outside their range when loading

export function snapshotEq(preset) {
  return { on: eq.on, lowCut: eq.lowCut, preset, bands: Object.fromEntries(EQ_BANDS.map(d => [d.key, { ...eq.b[d.key] }])) };
}
// Loads a saved EQ; returns the preset it was saved with.
export function restoreEq(src) {
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
  return typeof src.preset === 'string' ? src.preset : 'flat';
}
export function applyPreset(p) {
  EQ_BANDS.forEach(d => {
    resetBand(d.key);
    const v = p[d.key];
    if (typeof v === 'number') eq.b[d.key].g = v;
    else if (v) Object.assign(eq.b[d.key], v);
  });
  eq.lowCut = p.lowCut;
}
export const fmtHz = f => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz' : Math.round(f) + ' Hz');
export const fmtDb = g => (g > 0 ? '+' : '') + g.toFixed(1) + ' dB';
