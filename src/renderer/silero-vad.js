// Silero VAD v6 (MIT, github.com/snakers4/silero-vad), its 16 kHz network written out in plain JavaScript so it runs
// in the audio worklet with no runtime. Weights: silero_vad_16k.bin (float32, in the order read below), made from
// silero_vad.onnx by tools/build-silero.js. The model's first layer is a Hann-windowed 256-point DFT, done here by FFT.
// startSilero(buffer) returns feed(x48) -> voice probability (0..1) or -1 when no new chunk was finished yet:
// it takes 48 kHz audio in any block size, resamples to 16 kHz and scores each 512-sample (32 ms) chunk.
export const SILERO_CHUNK = 512, SILERO_CONTEXT = 64;

// 48 kHz -> 16 kHz: windowed-sinc low-pass at 7.2 kHz, then every 3rd sample.
const TAPS = 63, LP = (() => {
  const h = new Float32Array(TAPS), fc = 7200 / 48000; let s = 0;
  for (let i = 0; i < TAPS; i++) { const n = i - (TAPS - 1) / 2, w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (TAPS - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (TAPS - 1)); h[i] = (n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n)) * w; s += h[i]; }
  for (let i = 0; i < TAPS; i++) h[i] /= s; return h;
})();

export function sileroNet(buffer) {
  const W = new Float32Array(buffer); let at = 0;
  const take = n => { const a = W.subarray(at, at + n); at += n; return a; };
  const win = new Float32Array(256).map((_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / 256));   // periodic Hann
  const re = new Float32Array(256), im = new Float32Array(256), cosT = new Float32Array(128), sinT = new Float32Array(128), rev = new Uint8Array(256);
  for (let k = 0; k < 128; k++) { cosT[k] = Math.cos(2 * Math.PI * k / 256); sinT[k] = -Math.sin(2 * Math.PI * k / 256); }
  for (let i = 0; i < 256; i++) { let r = 0; for (let b = 0; b < 8; b++) r |= ((i >> b) & 1) << (7 - b); rev[i] = r; }
  function fft() {
    for (let size = 2; size <= 256; size <<= 1) {
      const half = size >> 1, step = 256 / size;
      for (let s0 = 0; s0 < 256; s0 += size) for (let j = 0; j < half; j++) {
        const a = s0 + j, b = a + half, wr = cosT[j * step], wi = sinT[j * step];
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  const enc = [[129, 128, 1], [128, 64, 2], [64, 64, 2], [64, 128, 1]].map(([cin, cout, stride]) => ({ cin, cout, stride, w: take(cout * cin * 3), b: take(cout) }));
  const wih = take(512 * 128), whh = take(512 * 128), bih = take(512), bhh = take(512), dw = take(128), db = take(1)[0];
  if (at !== W.length) throw new Error('Silero weights are the wrong size');
  const bias = bih.map((v, i) => v + bhh[i]);
  const padded = new Float32Array(640), mag = new Float32Array(129 * 4), gates = new Float32Array(512);
  const bufs = [new Float32Array(128 * 4), new Float32Array(64 * 2), new Float32Array(64), new Float32Array(128)];
  const h = new Float32Array(128), c = new Float32Array(128);
  const sig = x => 1 / (1 + Math.exp(-x));
  function conv(L, x, tin, y) {   // kernel 3, padding 1
    const tout = Math.floor((tin - 1) / L.stride) + 1;
    for (let o = 0; o < L.cout; o++) for (let t = 0; t < tout; t++) {
      let s = L.b[o]; const t0 = t * L.stride - 1;
      const k0 = t0 < 0 ? -t0 : 0, k1 = Math.min(3, tin - t0), w = L.w;
      for (let i = 0; i < L.cin; i++) { const wo = (o * L.cin + i) * 3, xo = i * tin + t0; for (let k = k0; k < k1; k++) s += w[wo + k] * x[xo + k]; }
      y[o * tout + t] = s > 0 ? s : 0;   // every encoder conv is followed by ReLU
    }
    return tout;
  }
  // x: 576 samples (64 of context + 512 new) at 16 kHz
  function run(x) {
    padded.set(x); for (let i = 0; i < 64; i++) padded[576 + i] = x[574 - i];   // reflect pad 64 on the right
    for (let f = 0; f < 4; f++) {
      const xo = f * 128;
      for (let n = 0; n < 256; n++) { re[rev[n]] = padded[xo + n] * win[n]; im[rev[n]] = 0; }
      fft();
      for (let k = 0; k < 129; k++) mag[k * 4 + f] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    let t = conv(enc[0], mag, 4, bufs[0]); t = conv(enc[1], bufs[0], t, bufs[1]); t = conv(enc[2], bufs[1], t, bufs[2]); conv(enc[3], bufs[2], t, bufs[3]);
    const xin = bufs[3];   // 128 x 1
    for (let g = 0; g < 512; g++) { let s = bias[g]; const o = g * 128; for (let i = 0; i < 128; i++) s += wih[o + i] * xin[i] + whh[o + i] * h[i]; gates[g] = s; }
    let out = db;
    for (let i = 0; i < 128; i++) {
      c[i] = sig(gates[128 + i]) * c[i] + sig(gates[i]) * Math.tanh(gates[256 + i]);
      h[i] = sig(gates[384 + i]) * Math.tanh(c[i]);
      out += dw[i] * (h[i] > 0 ? h[i] : 0);
    }
    return sig(out);
  }
  const reset = () => { h.fill(0); c.fill(0); };
  return { run, reset, state: { h, c } };
}

export function startSilero(buffer) {
  const net = sileroNet(buffer);
  const hist = new Float32Array(TAPS), x = new Float32Array(SILERO_CONTEXT + SILERO_CHUNK);
  let hp = 0, phase = 0, fill = SILERO_CONTEXT;
  return function feed(x48) {
    let p = -1;
    for (let j = 0; j < x48.length; j++) {
      hist[hp] = x48[j]; hp = (hp + 1) % TAPS;
      if (++phase < 3) continue;
      phase = 0;
      let s = 0; for (let k = 0, q = hp; k < TAPS; k++) { s += LP[k] * hist[q]; if (++q === TAPS) q = 0; }
      x[fill++] = s;
      if (fill === x.length) { p = net.run(x); x.copyWithin(0, SILERO_CHUNK); fill = SILERO_CONTEXT; }
    }
    return p;
  };
}
