// Measures the app's real audio chain on a known test signal: npm run test:audio
//
// Runs a separate hidden, muted copy of the app with its own temporary settings folder and a fake microphone
// that plays a generated file. Your running app, your settings, your mic and the virtual cable are not touched.
// During the EQ check its window opens briefly; a tray icon shows while it runs. Takes about 2 minutes.
// Exit code 1 if any check fails. To run one part: npm run test:audio -- nr | gate | eq
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, execFileSync } = require('child_process');
const { SR, NOISE_DB, makeFixture, writeWav, makeVoice, makeNoise } = require('./signal');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PORT = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toDb = power => 10 * Math.log10(power + 1e-13);
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');

// ---- Results ----
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

// ---- Offline: the worklet code itself, with the voice measured separately from the noise ----
function loadWorklet(file) {
  let Proc;
  vm.runInNewContext(fs.readFileSync(path.join(RENDERER, file), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor: (_, c) => { Proc = c; }, sampleRate: SR, Math, Float32Array, Uint16Array, Infinity
  });
  return new Proc();
}
function runNr(input, strength) {
  const p = loadWorklet('nr-worklet.js'), out = new Float32Array(input.length);
  const params = { strength: new Float32Array([strength]) };
  for (let i = 0; i + 128 <= input.length; i += 128) {
    const o = new Float32Array(128);
    p.process([[input.subarray(i, i + 128)]], [[o]], params);
    out.set(o, i);
  }
  return out;
}
function offlineChecks() {
  console.log('\nNoise reduction, offline');
  const LATENCY = 1024, n = SR * 24, start = SR * 8;
  const noise = makeNoise(n);
  const passthrough = runNr(noise, 0);
  let err = 0, pow = 0;
  for (let i = SR; i < n - LATENCY; i++) { err += (passthrough[i + LATENCY] - noise[i]) ** 2; pow += noise[i] ** 2; }
  const errDb = toDb(err) - toDb(pow);
  check('0% leaves audio unchanged', errDb < -80, `difference ${f1(errDb)} dB relative to the signal`);
  const voiceChange = (lvl, strength) => {
    const v = makeVoice(n, lvl, 8), mix = noise.map((x, i) => x + v[i]), out = runNr(mix, strength);
    let num = 0, den = 0;
    for (let i = start; i < n - LATENCY; i++) { num += out[i + LATENCY] * v[i]; den += v[i] * v[i]; }
    return 20 * Math.log10(Math.max(num / den, 1e-6));
  };
  for (const [lvl, limit] of [[-25, -3], [-35, -4]]) {
    const row = [25, 60, 100].map(s => voiceChange(lvl, s));
    check(`voice at ${lvl} dB survives`, row[1] >= limit, `change at 25/60/100%: ${row.map(f1).join(' / ')} dB (limit at 60%: ${limit})`);
  }
}

// The gate's decisions, sample-exact: it comes before the compressor, so noise reduction + gate is all that decides.
// Limits put words first: a gate that lets some leftover noise through at high strength beats one that cuts speech.
// Measured on a real voice in Nov 2026: this rule stayed open 99-100% across the speech range.
function gateChecks(fixture) {
  console.log('\nNoise gate, offline: does it cut speech?');
  const L = fixture.samples.length, n = L * 3, W = 960, NR_DELAY = 1024, GATE_DELAY = NR_DELAY + 240;
  const input = new Float32Array(n);
  for (let i = 0; i < n; i++) input[i] = fixture.samples[i % L];
  const level = (x, i) => { let e = 0; for (let k = i; k < i + W; k++) e += x[k] * x[k]; return toDb(e / W); };
  for (const [strength, noiseLimit] of [[0, 5], [25, 5], [60, 15], [100, 40]]) {
    const nr = loadWorklet('nr-worklet.js'), gate = loadWorklet('gate-worklet.js');
    const pN = { strength: new Float32Array([strength]) }, pG = { threshold: new Float32Array([-45]), auto: new Float32Array([1]) };
    const outN = new Float32Array(n), outG = new Float32Array(n);
    for (let i = 0; i + 128 <= n; i += 128) {
      const a = new Float32Array(128), b = new Float32Array(128);
      nr.process([[input.subarray(i, i + 128)]], [[a]], pN);
      gate.process([[a]], [[b]], pG);
      outN.set(a, i); outG.set(b, i);
    }
    const noise = [], voice = {}, onset = {};
    fixture.voiceLevels.forEach(l => { voice[l] = []; onset[l] = []; });
    for (let i = L; i + W + GATE_DELAY < n; i += W) {        // the first loop is the trackers learning
      const seg = fixture.segmentAt((i % L) / SR), open = level(outG, i + GATE_DELAY) >= level(outN, i + NR_DELAY) - 20;
      if (seg.kind === 'noise' && seg.settled) noise.push(open);
      else if (seg.kind === 'voice') { voice[seg.level].push(open); if (seg.intoPhrase < 0.06) onset[seg.level].push(open); }
    }
    const pct = l => 100 * l.filter(Boolean).length / Math.max(1, l.length);
    check(`NR ${strength}%: gate mostly shut on noise`, pct(noise) <= noiseLimit, `open ${f1(pct(noise))}% (limit ${noiseLimit}%), threshold ${f1(gate.autoThr)} dB`);
    for (const [lvl, limit, onsetLimit] of [[-25, 98, 90], [-35, 98, 90], [-42, 95, 50]]) {
      check(`NR ${strength}%: speech at ${lvl} dB not cut`, pct(voice[lvl]) >= limit && pct(onset[lvl]) >= onsetLimit, `open ${f1(pct(voice[lvl]))}% (limit ${limit}%), first 60 ms ${f1(pct(onset[lvl]))}% (limit ${onsetLimit}%)`);
    }
  }
}

// ---- The test copy of the app ----
class Copy {
  constructor(profile, wav, extraArgs = []) {
    this.args = ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--mute-audio',
      '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, ...extraArgs];
    this.exe = require(path.join(ROOT, 'node_modules', 'electron'));
    this.proc = spawn(this.exe, this.args, { cwd: ROOT, stdio: 'ignore' });
  }
  async connect() {
    let page;
    for (let i = 0; i < 80 && !page; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url));
      } catch { /* not listening yet */ }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error('the test copy never opened its page');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.pending = new Map(); this.seq = 0;
    this.ws.onmessage = m => {
      const d = JSON.parse(m.data), cb = this.pending.get(d.id);
      if (cb) { this.pending.delete(d.id); cb(d); }
    };
  }
  // Runs a function in the page, where the app's own variables are in scope.
  call(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, d => {
        const r = d.result || {};
        if (r.exceptionDetails) reject(new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)));
        else resolve(r.result && r.result.value);
      });
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }
  stop() {
    try { if (this.ws) this.ws.close(); } catch {}
    try { execFileSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
}

// ---- Runs inside the page ----
const pageReady = async () => {
  for (let i = 0; i < 100; i++) {
    try { if (stream && eqNodes && eqNodes.nr && eqNodes.gate) return true; } catch { /* page script still loading */ }
    await new Promise(r => setTimeout(r, 200));
  }
  try { return JSON.stringify({ stream: !!stream, nr: !!(eqNodes && eqNodes.nr), gate: !!(eqNodes && eqNodes.gate), nrFailed: !!(eqNodes && eqNodes.nrFailed) }); } catch (err) { return err.message; }
};
const pageInfo = () => {
  const s = stream.getAudioTracks()[0].getSettings();
  return { suppression: s.noiseSuppression, sendConnected: !!sendNodes, comp: state.comp, nr: state.nr, amount: state.nrAmount, auto: state.gateAuto };
};
const pageNrLevels = async strength => {
  state.nr = strength > 0; state.nrAmount = strength; applyNr();
  await new Promise(r => setTimeout(r, 2500));
  const a = audioCtx.createAnalyser(), b = audioCtx.createAnalyser(); a.fftSize = b.fftSize = 2048;
  srcNode.connect(a); eqNodes.nr.connect(b);
  const ba = new Float32Array(2048), bb = new Float32Array(2048), la = [], lb = [];
  const rms = x => { let e = 0; for (const v of x) e += v * v; return 20 * Math.log10(Math.sqrt(e / x.length) + 1e-9); };
  const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    a.getFloatTimeDomainData(ba); b.getFloatTimeDomainData(bb);
    la.push(rms(ba)); lb.push(rms(bb));
    await new Promise(r => setTimeout(r, 40));
  }
  srcNode.disconnect(a); eqNodes.nr.disconnect(b);
  const p10 = l => [...l].sort((x, y) => x - y)[Math.floor(l.length * 0.1)];
  return { raw: p10(la), out: p10(lb) };
};
// Three synchronized tracks: mic, after noise reduction, and the end of the chain (before the output level).
const pageCapture = async secs => {
  const ctx = audioCtx, merge = ctx.createChannelMerger(3), stages = [srcNode, eqNodes.nr, eqNodes.gateGain];
  const taps = stages.map((node, i) => { const g = ctx.createGain(); g.channelCount = 1; g.channelCountMode = 'explicit'; node.connect(g); g.connect(merge, 0, i); return g; });
  const sp = ctx.createScriptProcessor(4096, 3, 1), blocks = [], thresholds = [];
  sp.onaudioprocess = e => { blocks.push([0, 1, 2].map(c => e.inputBuffer.getChannelData(c).slice())); thresholds.push(autoGateDb); };
  merge.connect(sp); sp.connect(ctx.destination);
  await new Promise(r => setTimeout(r, secs * 1000));
  sp.disconnect(); merge.disconnect();
  stages.forEach((node, i) => node.disconnect(taps[i]));
  const n = blocks.length * 4096, pcm = new Float32Array(n * 3);
  blocks.forEach((b, i) => b.forEach((ch, c) => ch.forEach((v, k) => { pcm[(i * 4096 + k) * 3 + c] = v; })));
  const bytes = new Uint8Array(pcm.buffer); let s = '';
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return { sr: ctx.sampleRate, n, threshold: thresholds[thresholds.length >> 1], b64: btoa(s) };
};
const pageEqStretch = async () => {
  const c = $('eqCurve'); let worst = 1, samples = 0; const t0 = performance.now();
  while (performance.now() - t0 < 1500) {
    const st = c.clientWidth * devicePixelRatio / c.width;
    if (Math.abs(st - 1) > Math.abs(worst - 1)) worst = st;
    samples++;
    await new Promise(r => setTimeout(r, 16));
  }
  return { worst, samples, hidden: windowHidden, collapsed: devicesCollapsed, css: c.clientWidth, bitmap: c.width };
};

// ---- Gate analysis: every 20 ms frame is matched to its known position in the fixture ----
function analyseGate(cap, fixture) {
  const raw = Buffer.from(cap.b64, 'base64');
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const W = Math.round(cap.sr * 0.02), frames = Math.floor(cap.n / W);
  const level = c => { const o = new Float32Array(frames); for (let f = 0; f < frames; f++) { let e = 0; for (let k = 0; k < W; k++) { const v = pcm[(f * W + k) * 3 + c]; e += v * v; } o[f] = toDb(e / W); } return o; };
  const mic = level(0), nr = level(1), end = level(2);

  // Where in the looping file did the capture start?
  const fl = fixture.levels(W), L = fl.length, span = Math.min(frames, L);
  const mean = (a, len) => { let t = 0; for (let i = 0; i < len; i++) t += a[i]; return t / len; };
  const mMean = mean(mic, span), fMean = mean(fl, L);
  let best = -Infinity, offset = 0;
  for (let o = 0; o < L; o++) {
    let c = 0;
    for (let f = 0; f < span; f++) c += (mic[f] - mMean) * (fl[(f + o) % L] - fMean);
    if (c > best) { best = c; offset = o; }
  }

  const skip = Math.round(2 / 0.02), shut = f => end[f] < nr[f] - 20;
  const groups = { noise: [] }; fixture.voiceLevels.forEach(l => { groups[l] = []; });
  const onset = {}; fixture.voiceLevels.forEach(l => { onset[l] = []; });
  for (let f = skip; f < frames; f++) {
    const seg = fixture.segmentAt(((f + offset) % L) * 0.02);
    if (seg.kind === 'noise' && seg.settled) groups.noise.push(f);
    else if (seg.kind === 'voice') { groups[seg.level].push(f); if (seg.intoPhrase < 0.06) onset[seg.level].push(f); }
  }
  const openPct = list => 100 * list.filter(f => !shut(f)).length / Math.max(1, list.length);
  let flips = 0;
  for (let i = 1; i < groups.noise.length; i++) {
    const a = groups.noise[i - 1], b = groups.noise[i];
    if (b === a + 1 && shut(a) !== shut(b)) flips++;
  }
  const out = {
    threshold: cap.threshold,
    noise: { frames: groups.noise.length, openPct: openPct(groups.noise), flips, seconds: groups.noise.length * 0.02, endLevel: median(groups.noise.map(f => end[f])), nrLevel: median(groups.noise.map(f => nr[f])) },
    micNoise: median(groups.noise.map(f => mic[f])),
    voice: {}
  };
  for (const l of fixture.voiceLevels) {
    const interior = groups[l].filter(f => !onset[l].includes(f));
    out.voice[l] = {
      mic: median(interior.map(f => mic[f])),
      frames: groups[l].length, openPct: openPct(groups[l]),
      onsetOpenPct: openPct(onset[l]),
      gainChange: median(interior.map(f => end[f] - nr[f])),
      endLevel: median(interior.map(f => end[f]))
    };
  }
  let peak = 0;
  for (let i = 2; i < pcm.length; i += 3) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  out.peakDb = 20 * Math.log10(peak + 1e-9);
  return out;
}

const ONLY = process.argv[2];
const wanted = part => !ONLY || ONLY === part;

async function liveChecks(profile, wav, fixture) {
  console.log('\nThe app, on a fake mic');
  let copy = new Copy(profile, wav, ['--hidden']);
  try {
    await copy.connect();
    const ready = await copy.call(pageReady);
    if (ready !== true) { check('audio chain starts', false, 'not ready: ' + ready); return; }
    await sleep(1000);
    const info = await copy.call(pageInfo);
    check('mic is captured raw', info.suppression === false, `Chromium noise suppression reports ${info.suppression}`);
    check('nothing reaches the real cable', info.sendConnected === false, `send chain connected: ${info.sendConnected}`);

    if (wanted('nr')) console.log('\nNoise reduction slider');
    for (const s of wanted('nr') ? [0, 25, 60, 100] : []) {
      const r = await copy.call(pageNrLevels, s);
      const drop = r.raw - r.out, want = s * 0.3;
      check(`${s}% lowers noise by ${want} dB`, Math.abs(drop - want) <= 1.5, `measured ${f1(drop)} dB (${f1(r.raw)} -> ${f1(r.out)})`);
    }

    if (wanted('gate')) {
      console.log('\nWhole chain, 30 s of noise and speech: noise reduction 60%, compressor on');
      await copy.call(s => { state.nr = true; state.nrAmount = s; applyNr(); }, 60);
      await sleep(7000);                 // the gate's noise floor has a 6 s memory
      const g = analyseGate(await copy.call(pageCapture, 30), fixture);
      const placed = Math.abs(g.micNoise - NOISE_DB) < 3 && g.voice[-25].mic > g.voice[-35].mic + 5 && g.voice[-35].mic > g.voice[-42].mic + 2;
      check('capture lines up with the test file', placed, `mic levels: noise ${f1(g.micNoise)}, speech ${[-25, -35, -42].map(l => f1(g.voice[l].mic)).join(' / ')} dB`);
      console.log(`        auto threshold ${f1(g.threshold)} dB; noise going in ${f1(g.noise.nrLevel)} dB, coming out ${f1(g.noise.endLevel)} dB`);
      check('gate shuts on noise', g.noise.openPct <= 30, `open ${f1(g.noise.openPct)}% of ${f1(g.noise.seconds)} s, ${g.noise.flips} flips`);
      check('speech reaches the end of the chain', g.voice[-25].openPct >= 80 && g.voice[-25].endLevel > g.noise.nrLevel + 20, `open ${f1(g.voice[-25].openPct)}%, output ${f1(g.voice[-25].endLevel)} dB`);
      check('output does not clip', g.peakDb < -0.5, `peak ${f1(g.peakDb)} dB`);
    }

    if (!wanted('eq')) return;
    console.log('\nEQ graph');
    await copy.call(() => { if (!devicesCollapsed) $('devToggle').click(); });
    await sleep(12000);                  // Chromium writes saved settings to disk a few seconds later
    copy.stop(); await sleep(2000);
    copy = new Copy(profile, wav, ['--hidden']);
    await copy.connect();
    await copy.call(pageReady);
    await sleep(1500);
    const hiddenEq = await copy.call(pageEqStretch);
    check('graph is not stretched while hidden', hiddenEq.collapsed && Math.abs(hiddenEq.worst - 1) < 0.01, `worst ${hiddenEq.worst.toFixed(2)}x (${hiddenEq.css} px layout, ${hiddenEq.bitmap} px bitmap, panel collapsed: ${hiddenEq.collapsed})`);
    spawn(copy.exe, copy.args.filter(a => a !== '--hidden'), { cwd: ROOT, stdio: 'ignore' });   // a second launch shows the window
    await sleep(500);
    const eq = await copy.call(pageEqStretch);
    check('graph is not stretched after a hidden start', eq.collapsed && Math.abs(eq.worst - 1) < 0.01, `worst ${eq.worst.toFixed(2)}x over ${eq.samples} samples (${eq.css} px layout, ${eq.bitmap} px bitmap, panel collapsed: ${eq.collapsed})`);
  } finally {
    copy.stop();
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mic-manager-audio-test-'));
  const fixture = makeFixture();
  const wav = path.join(dir, 'fixture.wav');
  writeWav(wav, fixture.samples);
  console.log(`Test signal: ${fixture.seconds} s, steady noise at ${NOISE_DB} dB, speech-like phrases at ${fixture.voiceLevels.join(', ')} dB`);
  try {
    if (wanted('nr')) offlineChecks();
    if (wanted('gate')) gateChecks(fixture);
    await liveChecks(path.join(dir, 'profile'), wav, fixture);
  } catch (err) {
    check('test run finished', false, err.message);
  }
  await sleep(1500);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {}
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
