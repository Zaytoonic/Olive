// The known test signal: steady noise, then speech-like phrases at three levels.
const fs = require('fs');

const SR = 48000;
const NOISE_DB = -45;                   // about the raw room noise measured on the laptop mic (Nov 2026)
const VOICE_LEVELS = [-25, -35, -42];   // normal, quiet, and barely above the noise
const NOISE_SECS = 8, PHRASE_EVERY = 3, PHRASE_LEN = 2, SECONDS = 26;

function makeNoise(n) {
  let seed = 12345, b0 = 0, b1 = 0, b2 = 0, e = 0;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const w = seed / 4294967296 * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
    x[i] = 0.6 * (b0 + b1 + b2 + w * 0.1848) / 3 + 0.4 * w;
    e += x[i] * x[i];
  }
  const g = Math.pow(10, NOISE_DB / 20) / Math.sqrt(e / n);
  for (let i = 0; i < n; i++) x[i] *= g;
  return x;
}

// Harmonics under three formants, four syllables a second. levelFor(phraseIndex) gives each phrase's RMS in dB.
function makePhrases(n, levelFor, startSecs) {
  const x = new Float32Array(n);
  const energy = new Map();
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (t < startSecs || (t - startSecs) % PHRASE_EVERY >= PHRASE_LEN) continue;
    const f0 = 120 + 25 * Math.sin(2 * Math.PI * 0.7 * t);
    ph += 2 * Math.PI * f0 / SR;
    let s = 0;
    for (let h = 1; h <= 30; h++) {
      const f = f0 * h;
      const form = Math.exp(-(((f - 600) / 300) ** 2)) + 0.6 * Math.exp(-(((f - 1500) / 400) ** 2)) + 0.3 * Math.exp(-(((f - 2800) / 500) ** 2)) + 0.08;
      s += form * Math.sin(h * ph) / Math.sqrt(h);
    }
    x[i] = s * (0.25 + 0.75 * Math.max(0, Math.sin(2 * Math.PI * 4 * (t - startSecs))) ** 2);
    const k = Math.floor((t - startSecs) / PHRASE_EVERY), en = energy.get(k) || { e: 0, c: 0 };
    en.e += x[i] * x[i]; en.c++;
    energy.set(k, en);
  }
  const gains = new Map([...energy].map(([k, en]) => [k, Math.pow(10, levelFor(k) / 20) / Math.sqrt(en.e / en.c)]));
  for (let i = 0; i < n; i++) {
    if (!x[i]) continue;
    x[i] *= gains.get(Math.floor((i / SR - startSecs) / PHRASE_EVERY));
  }
  return x;
}
const makeVoice = (n, db, startSecs) => makePhrases(n, () => db, startSecs);

function makeFixture() {
  const n = SR * SECONDS, noise = makeNoise(n);
  const voice = makePhrases(n, k => VOICE_LEVELS[k % VOICE_LEVELS.length], NOISE_SECS);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = noise[i] + voice[i];
  return {
    samples, seconds: SECONDS, voiceLevels: VOICE_LEVELS,
    // Mean level in dB of each frame of W samples, for locating a capture inside the looping file.
    levels(W) {
      const out = new Float32Array(Math.floor(n / W));
      for (let f = 0; f < out.length; f++) { let e = 0; for (let k = 0; k < W; k++) e += samples[f * W + k] ** 2; out[f] = 10 * Math.log10(e / W + 1e-13); }
      return out;
    },
    // What the file contains at t seconds. "settled" noise leaves time for the gate's hold and fade after the last phrase.
    segmentAt(t) {
      if (t < NOISE_SECS) return { kind: 'noise', settled: t >= 1 };
      const into = (t - NOISE_SECS) % PHRASE_EVERY;
      if (into >= PHRASE_LEN) return { kind: 'gap' };
      return { kind: 'voice', level: VOICE_LEVELS[Math.floor((t - NOISE_SECS) / PHRASE_EVERY) % VOICE_LEVELS.length], intoPhrase: into };
    }
  };
}

function writeWav(file, samples) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

module.exports = { SR, NOISE_DB, makeFixture, makeNoise, makeVoice, writeWav };
