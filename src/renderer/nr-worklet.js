// Noise reduction on the audio thread (AudioWorklet), with an adjustable strength.
// Chromium's built-in suppressor is only on/off, so the app captures the raw mic and does this itself.
// - Each 1024-sample frame (hop 256, sqrt-Hann windows) is split into frequency bins.
// - Noise estimate per bin: the lowest smoothed level over the last ~1.5 s, so it follows steady noise
//   (fans, hum, hiss) and is not fooled by speech, which always has gaps in each bin.
// - Gain per bin: Wiener filter with decision-directed smoothing (avoids "musical noise").
// - Strength (0-100) sets how far a bin may be turned down (0.3 dB per percent, so 100 = 30 dB) and how much
//   the noise estimate is raised. Measured: a fixed low estimate never got past ~15 dB, a fixed high one costs quiet
//   speech up to 7 dB even at low settings, so low strengths stay gentle and only high ones trade voice for depth.
//   At 0 every gain is exactly 1 and the audio passes through unchanged, only delayed by one frame.
// Adds one frame of latency (~21 ms at 48 kHz) whether or not it is reducing anything.

const N = 1024, HOP = 256, BINS = N / 2 + 1;
const DB_PER_PERCENT = 0.3;
const SMOOTH = 0.85;             // smoothing of bin power for the noise tracker
const MIN_FRAMES = 140;          // ~0.75 s at 48 kHz; two windows of this = ~1.5 s of memory
const BIAS_MIN = 2, BIAS_RANGE = 6;  // the minimum of a smoothed level sits well below its average; see strength above
const DD = 0.96;                 // decision-directed weight

const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
const OLA_SCALE = HOP / (N / 2);  // squared windows at this overlap sum to N / (2 * HOP)

const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2), rev = new Uint16Array(N);
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = Math.sin(2 * Math.PI * i / N); }
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
  rev[i] = r;
}
// In-place radix-2 FFT. sign = -1 forward, +1 inverse (not scaled).
function fft(re, im, sign) {
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= N; size *= 2) {
    const half = size / 2, step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const c = cosT[k * step], s = sign * sinT[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

class Channel {
  constructor() {
    this.inRing = new Float32Array(N); this.inPos = 0; this.sinceFrame = 0;
    this.out = new Float32Array(N); this.outRead = 0;  // overlap-add buffer
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.power = new Float32Array(BINS);
    this.minNow = new Float32Array(BINS).fill(Infinity);
    this.minOld = new Float32Array(BINS).fill(Infinity);
    this.prevClean = new Float32Array(BINS);           // last frame's cleaned power / noise
    this.frames = 0; this.minFill = 0;
  }

  frame(floor, bias) {
    const { re, im, inRing, power, minNow, minOld, prevClean } = this;
    for (let i = 0, p = this.inPos; i < N; i++, p = (p + 1) % N) { re[i] = inRing[p] * win[i]; im[i] = 0; }
    fft(re, im, -1);
    const first = this.frames === 0;
    for (let k = 0; k < BINS; k++) {
      const pw = re[k] * re[k] + im[k] * im[k];
      power[k] = first ? pw : SMOOTH * power[k] + (1 - SMOOTH) * pw;
      if (power[k] < minNow[k]) minNow[k] = power[k];
      const noise = Math.max(bias * Math.min(minNow[k], minOld[k]), 1e-14);
      const gamma = pw / noise;                        // signal-to-noise in this bin now
      const xi = DD * prevClean[k] + (1 - DD) * Math.max(gamma - 1, 0);
      const wiener = xi / (1 + xi);
      prevClean[k] = wiener * wiener * gamma;
      const g = floor >= 1 ? 1 : Math.max(wiener, floor);
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    this.frames++;
    if (++this.minFill >= MIN_FRAMES) {                // slide the minimum's memory window
      this.minFill = 0;
      minOld.set(minNow);
      minNow.fill(Infinity);
    }
    fft(re, im, 1);
    // Shift the finished hop out, then overlap-add the new frame.
    const out = this.out;
    out.copyWithin(0, HOP); out.fill(0, N - HOP);
    for (let i = 0; i < N; i++) out[i] += re[i] / N * win[i] * OLA_SCALE;
    this.outRead = 0;
  }
}

class NoiseReduction extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'strength', defaultValue: 0, minValue: 0, maxValue: 100, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.channels = [];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;
    const strength = parameters.strength[0];
    const floor = strength <= 0 ? 1 : Math.pow(10, -strength * DB_PER_PERCENT / 20);
    const bias = BIAS_MIN + BIAS_RANGE * strength / 100;
    for (let c = 0; c < output.length; c++) {
      if (!this.channels[c]) this.channels[c] = new Channel();
      const ch = this.channels[c];
      const src = input && input.length ? (input[c] || input[0]) : null;
      const dst = output[c];
      for (let i = 0; i < dst.length; i++) {
        dst[i] = ch.out[ch.outRead++];
        ch.inRing[ch.inPos] = src ? src[i] : 0;
        ch.inPos = (ch.inPos + 1) % N;
        if (++ch.sinceFrame === HOP) { ch.sinceFrame = 0; ch.frame(floor, bias); }
      }
    }
    return true;
  }
}

registerProcessor('noise-reduction', NoiseReduction);
