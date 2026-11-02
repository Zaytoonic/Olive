// Noise reduction on the audio thread (AudioWorklet), with an adjustable strength.
// Chromium's built-in suppressor is only on/off, so the app captures the raw mic and does this itself.
// - Each 1024-sample frame (hop 256, sqrt-Hann windows) is split into frequency bins.
// - Noise estimate per bin: an average over about 1 s of the moments with no speech in that bin. A bin counts as
//   speech-free while it stays near its lowest level of the last ~4 s.
// - Gain per bin: square root of a Wiener filter with decision-directed smoothing, then smoothed across neighbouring
//   bins and over time. Measured on a real fan: this keeps ~4 dB more voice and flickers ~30% less (the robotic sound).
// - Rumble: gusts below ~110 Hz change too fast to learn, and were most of the measured fan energy, so they are simply
//   turned down, as far as the strength allows.
// - Strength (0-100) sets how far a bin may be turned down (0.3 dB per percent) and how much the noise estimate is
//   raised (mildly until the top of the range, where it trades voice for depth).
//   At 0 every gain is exactly 1 and the audio passes through unchanged, only delayed by one frame.
// Adds one frame of latency (~21 ms at 48 kHz) whether or not it is reducing anything.

const N = 1024, HOP = 256, BINS = N / 2 + 1;
const DB_PER_PERCENT = 0.3;
const FRAMES_PER_SEC = sampleRate / HOP;
const SMOOTH = 0.85;             // smoothing of bin power for the speech detector
const MIN_FRAMES = Math.round(2 * FRAMES_PER_SEC);  // two windows of this = ~4 s of memory for a bin's lowest level
const SPEECH_RATIO = 5;          // above this many times that lowest level, a bin holds speech: don't learn from it
const NOISE_KEEP = Math.exp(-1 / FRAMES_PER_SEC);   // the noise average's ~1 s time constant
const RAISE_MAX = 3;             // how far 100% strength raises the noise estimate
const DD = 0.92;                 // decision-directed weight
const GAIN_FALL = 0.5;           // per frame; rises are immediate so word starts aren't dulled
const RUMBLE_HZ = 110;
const rumble = new Float32Array(BINS);
for (let k = 0; k < BINS; k++) rumble[k] = Math.min(1, Math.pow(k * sampleRate / N / RUMBLE_HZ, 4));

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
    this.noise = new Float32Array(BINS);
    this.minNow = new Float32Array(BINS).fill(Infinity);
    this.minOld = new Float32Array(BINS).fill(Infinity);
    this.prevClean = new Float32Array(BINS);           // last frame's cleaned power / noise
    this.rawGain = new Float32Array(BINS);
    this.gain = new Float32Array(BINS).fill(1);
    this.frames = 0; this.minFill = 0;
  }

  frame(floor, raise) {
    const { re, im, inRing, power, noise, minNow, minOld, prevClean, rawGain, gain } = this;
    for (let i = 0, p = this.inPos; i < N; i++, p = (p + 1) % N) { re[i] = inRing[p] * win[i]; im[i] = 0; }
    fft(re, im, -1);
    const first = this.frames === 0;
    for (let k = 0; k < BINS; k++) {
      const pw = re[k] * re[k] + im[k] * im[k];
      power[k] = first ? pw : SMOOTH * power[k] + (1 - SMOOTH) * pw;
      if (power[k] < minNow[k]) minNow[k] = power[k];
      if (first) noise[k] = pw;
      else if (power[k] < SPEECH_RATIO * Math.min(minNow[k], minOld[k])) noise[k] = NOISE_KEEP * noise[k] + (1 - NOISE_KEEP) * power[k];
      const gamma = pw / Math.max(raise * noise[k], 1e-14);   // signal-to-noise in this bin now
      const xi = DD * prevClean[k] + (1 - DD) * Math.max(gamma - 1, 0);
      const wiener = xi / (1 + xi);
      prevClean[k] = wiener * wiener * gamma;
      rawGain[k] = Math.sqrt(wiener);
    }
    for (let k = 0; k < BINS; k++) {
      const lo = rawGain[k > 0 ? k - 1 : k], hi = rawGain[k < BINS - 1 ? k + 1 : k];
      const target = (lo + 2 * rawGain[k] + hi) / 4;
      gain[k] = target > gain[k] ? target : gain[k] + (target - gain[k]) * GAIN_FALL;
      const g = floor >= 1 ? 1 : Math.max(Math.min(gain[k], rumble[k]), floor);
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
    const raise = 1 + (RAISE_MAX - 1) * (strength / 100) ** 2;
    for (let c = 0; c < output.length; c++) {
      if (!this.channels[c]) this.channels[c] = new Channel();
      const ch = this.channels[c];
      const src = input && input.length ? (input[c] || input[0]) : null;
      const dst = output[c];
      for (let i = 0; i < dst.length; i++) {
        dst[i] = ch.out[ch.outRead++];
        ch.inRing[ch.inPos] = src ? src[i] : 0;
        ch.inPos = (ch.inPos + 1) % N;
        if (++ch.sinceFrame === HOP) { ch.sinceFrame = 0; ch.frame(floor, raise); }
      }
    }
    return true;
  }
}

registerProcessor('noise-reduction', NoiseReduction);
