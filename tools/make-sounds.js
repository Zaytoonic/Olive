// Makes the mute and unmute sounds from code: npm run make-sounds
// Outputs to assets/: mute.wav (two notes stepping down) and unmute.wav (the same two stepping up). Needs nothing installed.
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const RATE = 48000, PEAK = 0.4;                          // about -8 dB at the loudest point: clear, not startling
const HIGH = 880, LOW = 587.33;                          // A5 and D5, a fourth apart
const GAP = 0.085, LENGTH = 0.42;                        // second note starts 85 ms after the first

// A soft mallet-like note: a quick fade in, a decay that's faster for the overtones, and a short fade out at the end.
function note(out, start, freq) {
  const first = Math.round(start * RATE);
  for (let i = first; i < out.length; i++) {
    const t = (i - first) / RATE;
    const attack = Math.min(1, t / 0.004);
    const body = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.11);
    const ring = 0.22 * Math.sin(2 * Math.PI * freq * 2 * t) * Math.exp(-t / 0.045);
    const tine = 0.06 * Math.sin(2 * Math.PI * freq * 3.01 * t) * Math.exp(-t / 0.02);
    out[i] += attack * (body + ring + tine);
  }
}

function make(freqs) {
  const out = new Float32Array(Math.round(LENGTH * RATE));
  freqs.forEach((f, n) => note(out, n * GAP, f));
  const fade = Math.round(0.03 * RATE);
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  const top = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return out.map(v => v / top * PEAK);
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

fs.writeFileSync(path.join(ASSETS, 'mute.wav'), wav(make([HIGH, LOW])));
fs.writeFileSync(path.join(ASSETS, 'unmute.wav'), wav(make([LOW, HIGH])));
console.log('Made assets/mute.wav and assets/unmute.wav');
