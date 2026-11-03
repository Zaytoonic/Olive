// Measures the app's real audio chain on a known test signal: npm run test:audio
//
// Runs a separate hidden, muted copy of the app with its own temporary settings folder and a fake microphone
// that plays a generated file. Your running app, your settings, your mic and the virtual cable are not touched.
// During the EQ check its window opens briefly; a tray icon shows while it runs. Takes about 3 minutes.
// Exit code 1 if any check fails. To run one part: npm run test:audio -- nr | gate | mute | eq | app
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, execFileSync } = require('child_process');
const { SR, NOISE_DB, makeFixture, writeWav, makeVoice, makeNoise, makeGustyFan } = require('./signal');

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
// The Windows helper: the compiled exe and the PowerShell fallback must both answer.
async function helperChecks() {
  console.log('\nWindows audio helper');
  const { HelperClient } = require(path.join(ROOT, 'src', 'main', 'sysmic-client.js'));
  const main = path.join(ROOT, 'src', 'main');
  for (const [name, cmd, args] of [['compiled helper', path.join(main, 'win-audio.exe'), []], ['PowerShell fallback', 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-MTA', '-ExecutionPolicy', 'Bypass', '-File', path.join(main, 'win-audio.ps1')]]]) {
    const h = new HelperClient(cmd, args), t0 = Date.now();
    try {
      const list = await h.call('list');
      const one = await h.call('get', list[0].id);
      const pid = h.proc.pid; h.proc.stdin.end();
      await sleep(800);
      let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
      check(`${name} answers and exits with the app`, Array.isArray(list) && list.length > 0 && one.id === list[0].id && !alive, `${list.length} devices, first answer in ${Date.now() - t0 - 800} ms, still running after stdin closed: ${alive}`);
      if (alive) h.proc.kill();
    } catch (err) { check(`${name} answers and exits with the app`, false, err.message); h.stop(); }
  }
}

function offlineChecks() {
  console.log('\nFallback noise reduction, offline (used if the voice engine cannot start)');
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
  const fan = makeGustyFan(n), level = x => { let e = 0; for (let i = SR * 6; i < n - LATENCY; i++) e += x[i] * x[i]; return toDb(e); };
  const fanDrops = [25, 60, 100].map(s => level(fan) - level(runNr(fan, s)));
  const fanVoice = makeVoice(n, -30, 8), mixed = fan.map((x, i) => x + fanVoice[i]), mixedOut = runNr(mixed, 60);
  let num = 0, den = 0;
  for (let i = start; i < n - LATENCY; i++) { num += mixedOut[i + LATENCY] * fanVoice[i]; den += fanVoice[i] * fanVoice[i]; }
  const voiceOverFan = 20 * Math.log10(Math.max(num / den, 1e-6));
  // Slow start: silence, then noise. Reduction should be working soon after the sound begins, including after a mic switch.
  const startup = new Float32Array(SR * 16); startup.set(noise.subarray(0, SR * 7), SR);
  startup.set(fan.subarray(SR, SR * 8), SR * 9);                  // 1 s silence: a second mic with different noise
  const startupOut = runNr(startup, 60), segDrop = (a, b) => { const lvl = (x, d) => { let e = 0; for (let i = Math.round(a * SR); i < b * SR; i++) e += x[i + d] ** 2; return toDb(e); }; return lvl(startup, 0) - lvl(startupOut, LATENCY); };
  const settled = segDrop(5, 7.5), soon = segDrop(1.75, 3), soonAfterSwitch = segDrop(9.75, 11);
  check('noise reduction works within 2 s of starting', soon >= settled * 0.6, `${f1(soon)} dB at 0.75-2 s after sound starts, ${f1(settled)} dB once settled (at least 60% of settled)`);
  check('and again after switching mics', soonAfterSwitch >= 6, `${f1(soonAfterSwitch)} dB at 0.75-2 s after a 1 s silence`);
  check('gusty fan rumble comes down', fanDrops[1] >= 10 && fanDrops[2] > fanDrops[0], `drop at 25/60/100%: ${fanDrops.map(f1).join(' / ')} dB (at least 10 at 60%)`);
  check('voice survives over the fan', voiceOverFan >= -6, `${f1(voiceOverFan)} dB at 60% (limit -6)`);
}

// The gate's decisions, sample-exact: it comes before the compressor, so noise reduction + gate is all that decides.
// Limits put words first: a gate that lets some leftover noise through at high strength beats one that cuts speech.
// Measured on a real voice in Nov 2026: this rule stayed open 99-100% across the speech range.
function gateChecks(fixture) {
  console.log('\nFallback volume gate, offline: does it cut speech? (also used when the gate is set by hand)');
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

// ---- The voice engine (RNNoise), offline ----
const VOICE_DELAY = 1440;
function loadVoice() {
  const ctx = vm.createContext({ AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } }, sampleRate: SR, Math, Float32Array, Uint16Array, Infinity, WebAssembly, console, setTimeout, clearTimeout, atob: t => Buffer.from(t, 'base64').toString('latin1'), registerProcessor: (_, c) => { ctx.Proc = c; } });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(RENDERER, 'vendor', 'rnnoise-sync.js'), 'utf8').replace('import.meta.url', '""').replace(/export default createRNNWasmModuleSync;\s*$/, 'globalThis.createRNN = createRNNWasmModuleSync;'), ctx);
  vm.runInContext(fs.readFileSync(path.join(RENDERER, 'voice-worklet.js'), 'utf8').replace(/import createRNNWasmModuleSync from [^\n]*\n/, 'const createRNNWasmModuleSync = globalThis.createRNN;\n'), ctx);
  return new ctx.Proc();
}
function runVoice(input, strength, gate) {
  const p = loadVoice(), out = new Float32Array(input.length), params = { strength: new Float32Array([strength]), gate: new Float32Array([gate]) };
  for (let i = 0; i + 128 <= input.length; i += 128) { const o = new Float32Array(128); p.process([[input.subarray(i, i + 128)]], [[o]], params); out.set(o, i); }
  return out;
}
function voiceChecks() {
  console.log('\nVoice engine, offline');
  const n = SR * 24, D = VOICE_DELAY, noise = makeNoise(n), fan = makeGustyFan(n);
  const dry = runVoice(noise, 0, 0); let err = 0, pow = 0;
  for (let i = SR; i < n - D; i++) { err += (dry[i + D] - noise[i]) ** 2; pow += noise[i] ** 2; }
  check('0% leaves audio unchanged', toDb(err) - toDb(pow) < -80, `difference ${f1(toDb(err) - toDb(pow))} dB relative to the signal`);
  const level = (x, d = 0) => { let e = 0; for (let i = SR * 3; i < n - D; i++) e += x[i + d] ** 2; return toDb(e); };
  for (const [name, src, min60, min100] of [['steady noise', noise, 12, 20], ['gusty fan', fan, 8, 8]]) {
    const drops = [25, 60, 100].map(v => level(src) - level(runVoice(src, v, 0), D));
    check(`${name} comes down`, drops[1] >= min60 && drops[2] >= min100, `drop at 25/60/100%: ${drops.map(f1).join(' / ')} dB (at least ${min60} at 60%, ${min100} at 100%)`);
  }
  // The gate's job: shut on noise, even gusts, with no volume threshold to fool.
  const openPct = (out, ref) => { let o = 0, c = 0; for (let i = SR * 2; i + 960 + D < n; i += 960) { let a = 0, b = 0; for (let k = 0; k < 960; k++) { a += out[i + D + k] ** 2; b += ref[i + D + k] ** 2; } c++; if (toDb(a) >= toDb(b) - 20) o++; } return 100 * o / c; };
  for (const [name, src, limit] of [['steady noise', noise, 5], ['gusty fan', fan, 10]]) {
    const pct = openPct(runVoice(src, 100, 1), runVoice(src, 100, 0));
    check(`gate stays shut on ${name}`, pct <= limit, `open ${f1(pct)}% (limit ${limit}%)`);
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
    try { if (stream && eqNodes && eqNodes.voice && eqNodes.gate) return true; } catch { /* page script still loading */ }
    await new Promise(r => setTimeout(r, 200));
  }
  try { return JSON.stringify({ stream: !!stream, nr: !!(eqNodes && eqNodes.nr), gate: !!(eqNodes && eqNodes.gate), nrFailed: !!(eqNodes && eqNodes.nrFailed) }); } catch (err) { return err.message; }
};
const pageInfo = () => {
  const s = stream.getAudioTracks()[0].getSettings();
  return { suppression: s.noiseSuppression, sendConnected: !!sendNodes, comp: state.comp, nr: state.nr, amount: state.nrAmount, auto: state.gateAuto, engine: !!eqNodes.voice };
};
const pageNrLevels = async strength => {
  state.nr = strength > 0; state.nrAmount = strength; applyNr();
  if (eqNodes.voice) eqNodes.voice.parameters.get('gate').setValueAtTime(0, audioCtx.currentTime);   // measure the noise part alone
  await new Promise(r => setTimeout(r, 6000));         // the noise estimate has a ~4 s memory
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
  if (eqNodes.voice) eqNodes.voice.parameters.get('gate').setValueAtTime(state.gateAuto ? 1 : 0, audioCtx.currentTime);
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
// Loudest sample leaving the chain over some seconds, read after the output level (Listen on; the copy is muted).
const pageOutPeak = async secs => {
  const a = audioCtx.createAnalyser(), b = new Float32Array(2048); a.fftSize = 2048;
  eqNodes.outGain.connect(a);
  let pk = 0; const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) {
    a.getFloatTimeDomainData(b);
    for (const v of b) { const m = Math.abs(v); if (m > pk) pk = m; }
    await new Promise(r => setTimeout(r, 20));
  }
  eqNodes.outGain.disconnect(a);
  return 20 * Math.log10(pk + 1e-9);
};
// Presses Ctrl+Alt+M for real, through Windows.
function pressHotkey(holdRepeats = 0, letterVk = 0x4D) {
  const ps = "Add-Type -Name K -Namespace T -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);';" +
    `foreach ($k in 0x11,0x12,${letterVk}) { [T.K]::keybd_event($k,0,0,[UIntPtr]::Zero) };` +
    (holdRepeats ? `Start-Sleep -Milliseconds 500; 1..${holdRepeats} | ForEach-Object { [T.K]::keybd_event(${letterVk},0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 33 };` : 'Start-Sleep -Milliseconds 40;') +
    `foreach ($k in ${letterVk},0x12,0x11) { [T.K]::keybd_event($k,0,2,[UIntPtr]::Zero) }`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
}
const pageEqStretch = async () => {
  const c = $('eqCurve'); let worst = 1, samples = 0; const t0 = performance.now();
  while (performance.now() - t0 < 1500) {
    const st = c.clientWidth * devicePixelRatio / c.width;
    if (Math.abs(st - 1) > Math.abs(worst - 1)) worst = st;
    samples++;
    await new Promise(r => setTimeout(r, 16));
  }
  return { worst, samples, hidden: windowHidden, css: c.clientWidth, bitmap: c.width };
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

  const skip = Math.round(2 / 0.02), shut = f => end[f] < mic[f] - 40;
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
    check('the voice engine is running', info.engine === true, `voice engine active: ${info.engine}`);
    check('nothing reaches the real cable', info.sendConnected === false, `send chain connected: ${info.sendConnected}`);

    if (wanted('app')) {
      console.log('\nStart with Windows');
      const startup = await copy.call(async () => ({ api: await window.appStartup.get(), disabled: $('startupToggle').disabled, hint: $('startupHint').textContent }));
      check('a copy run from source cannot register itself at login', startup.api.supported === false && startup.disabled, `toggle disabled: ${startup.disabled}, hint: "${startup.hint}"`);
      console.log('\nChoosing a mic');
      const mic = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), [a, b] = devices, out = {};
        const startBands = snapshotEq();
        const realList = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
        out.names = [a.name, b.name]; out.options = $('micSelect').options.length;
        $('micSelect').value = b.id; $('micSelect').dispatchEvent(new Event('change', { bubbles: true })); await wait(500);
        out.picked = state.deviceId === b.id && prefDeviceName === b.name;
        out.firstTimeInherits = eq.b.bass.g === startBands.bands.bass.g;   // this mic has no EQ of its own yet
        eq.b.bass.g = 5; eqEdited();
        selectDevice(a.id); await wait(300);
        eq.b.bass.g = -4; eqEdited();
        selectDevice(b.id); await wait(300); out.bBass = eq.b.bass.g;
        selectDevice(a.id); await wait(300); out.aBass = eq.b.bass.g;
        selectDevice(b.id); await wait(500);
        const capturedBefore = stream;
        await loadDevices(); await wait(500);
        out.rescanKeepsCapture = stream === capturedBefore;
        navigator.mediaDevices.enumerateDevices = async () => (await realList()).filter(d => d.deviceId !== b.id);
        await loadDevices(); await wait(800);
        out.unplugged = { current: currentDevice().name, notice: $('micNotice').textContent, bass: eq.b.bass.g, stillPreferred: prefDeviceName };
        delete navigator.mediaDevices.enumerateDevices;
        await loadDevices(); await wait(800);
        out.replugged = { current: currentDevice().name, notice: $('micNotice').textContent, bass: eq.b.bass.g, capturing: capturedId === state.deviceId };
        const pickBox = $('micSelect').getBoundingClientRect(), refreshBox = $('refreshBtn').getBoundingClientRect(), optionsBefore = $('micSelect').options.length;
        out.refreshBeside = refreshBox.width > 0 && refreshBox.left >= pickBox.right - 1 && Math.abs((refreshBox.top + refreshBox.bottom) - (pickBox.top + pickBox.bottom)) / 2 < 8;
        out.panelGone = !$('devicesPanel') && !$('deviceList') && !$('devToggle');
        navigator.mediaDevices.enumerateDevices = async () => (await realList()).filter(d => d.deviceId !== state.deviceId);
        $('refreshBtn').click(); await wait(800);
        out.refreshRemoved = $('micSelect').options.length === optionsBefore - 1;
        delete navigator.mediaDevices.enumerateDevices;
        $('refreshBtn').click(); await wait(800);
        out.refreshRestored = $('micSelect').options.length === optionsBefore;
        const saved = JSON.parse((savePrefs(), localStorage.getItem(PREFS_KEY)));
        out.savedPerMic = [saved.eqByMic[a.name] && saved.eqByMic[a.name].bands.bass.g, saved.eqByMic[b.name] && saved.eqByMic[b.name].bands.bass.g];
        selectDevice(a.id); await wait(300);
        restoreEq(startBands); showEqPreset(); syncEqUi(); savePrefs();
        return out;
      });
      check('the picker lists mics and switches', mic.options === mic.names.length && mic.picked, `${mic.options} mics listed, picked: ${mic.picked}`);
      check('each mic keeps its own EQ', mic.firstTimeInherits && mic.bBass === 5 && mic.aBass === -4 && mic.savedPerMic[0] === -4 && mic.savedPerMic[1] === 5, `bass ${mic.bBass} on one, ${mic.aBass} on the other; saved ${mic.savedPerMic.join(' / ')}`);
      check('the refresh button sits beside the dropdown and updates the list', mic.refreshBeside && mic.panelGone && mic.refreshRemoved && mic.refreshRestored, `beside: ${mic.refreshBeside}, side panel gone: ${mic.panelGone}, list updated: ${mic.refreshRemoved} / ${mic.refreshRestored}`);
      check('a rescan does not restart a healthy capture', mic.rescanKeepsCapture, `capture kept: ${mic.rescanKeepsCapture}`);
      check('unplugged: falls back and says so', mic.unplugged.current === mic.names[0] && mic.unplugged.notice.includes(mic.names[1]) && mic.unplugged.bass === -4 && mic.unplugged.stillPreferred === mic.names[1], `using ${mic.unplugged.current}, "${mic.unplugged.notice}"`);
      check('plugged back in: returns to the preferred mic', mic.replugged.current === mic.names[1] && !mic.replugged.notice && mic.replugged.bass === 5 && mic.replugged.capturing, `using ${mic.replugged.current}, EQ bass ${mic.replugged.bass}`);
      console.log('\nAppearance');
      const look = await copy.call(() => {
        savePrefs();
        return {
          picker: !!document.getElementById('themeSelect'), attr: document.documentElement.dataset.theme || null, text: getComputedStyle(document.body).color,
          sheets: [...document.styleSheets].map(s => s.href.split('/').pop()), saved: 'theme' in JSON.parse(localStorage.getItem(PREFS_KEY))
        };
      });
      check('Classic is the only look, with no picker', !look.picker && !look.attr && !look.saved && look.text === 'rgb(245, 245, 247)' && look.sheets.join() === 'styles.css', `picker: ${look.picker}, stylesheets: ${look.sheets.join()}, text: ${look.text}`);
      console.log('\nEQ dropdown and scrolling');
      const eqUi = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), out = { startsClosed: $('eqBody').hidden && state.eqOpen === false && $('eqExpand').getAttribute('aria-expanded') === 'false' };
        $('eqExpand').click(); await wait(250);
        out.opens = !$('eqBody').hidden && $('eqExpand').getAttribute('aria-expanded') === 'true' && $('eqCurve').clientWidth > 100;
        out.savedOpen = JSON.parse(localStorage.getItem(PREFS_KEY)).eqOpen;
        const before = JSON.stringify(eq.b), c = $('eqCurve'), r = c.getBoundingClientRect(), pt = eqPoint('mid');
        const wheel = ctrlKey => { const e = new WheelEvent('wheel', { deltaY: -400, clientX: r.left + pt.x, clientY: r.top + pt.y, ctrlKey, bubbles: true, cancelable: true }); c.dispatchEvent(e); return e.defaultPrevented; };
        out.plainPrevented = wheel(false);
        out.plainUnchanged = JSON.stringify(eq.b) === before;
        out.ctrlPrevented = wheel(true);
        out.ctrlChanged = JSON.stringify(eq.b) !== before;
        $('eqExpand').click(); await wait(250);
        out.closes = $('eqBody').hidden;
        out.savedClosed = JSON.parse(localStorage.getItem(PREFS_KEY)).eqOpen;
        return out;
      });
      check('the EQ starts closed, opens, closes, and remembers', eqUi.startsClosed && eqUi.opens && eqUi.savedOpen === true && eqUi.closes && eqUi.savedClosed === false, JSON.stringify({ startsClosed: eqUi.startsClosed, opens: eqUi.opens, closes: eqUi.closes }));
      check('a plain scroll over the graph changes nothing and keeps scrolling the page', eqUi.plainUnchanged && !eqUi.plainPrevented, `EQ unchanged: ${eqUi.plainUnchanged}, scroll blocked: ${eqUi.plainPrevented}`);
      check('Ctrl + scroll still changes the width', eqUi.ctrlChanged && eqUi.ctrlPrevented, `changed: ${eqUi.ctrlChanged}`);
      console.log('\nStart-up and recovery');
      const retry = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('not ready', 'AbortError'); };
        await loadDevices();
        const during = { live, status: $('devStatus').textContent, retrying: startupRetries > 0 };
        delete navigator.mediaDevices.getUserMedia;
        await wait(6500);
        return { during, recovered: live, capturing: !!stream, status: $('devStatus').textContent };
      });
      check('audio not ready at login: it keeps trying and recovers', retry.during.live === false && retry.during.retrying && retry.recovered && retry.capturing && !retry.status, `first attempt live: ${retry.during.live}, recovered: ${retry.recovered}, capturing: ${retry.capturing}`);
      const helperPid = () => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='win-audio.exe'" | Where-Object { $_.ParentProcessId -eq ${copy.proc.pid} }).ProcessId`]).toString().trim(); } catch { return ''; } };
      const pidBefore = helperPid();
      if (pidBefore) {
        execFileSync('taskkill', ['/PID', pidBefore, '/F'], { stdio: 'ignore' });
        await sleep(5000);
        const pidAfter = helperPid();
        const answers = await copy.call(async () => { const l = await sysApi.list(); return Array.isArray(l) && !!(await sysApi.get(l[0].id)).id; });
        check('the Windows helper restarts itself after a crash', !!pidAfter && pidAfter !== pidBefore && answers, `helper ${pidBefore} killed, now ${pidAfter}, answering: ${answers}`);
      } else check('the Windows helper restarts itself after a crash', false, 'could not find this copy\'s helper');
      console.log('\nOne engine at a time');
      // The fake mic has no virtual cable, so this builds a send chain on the default (muted) output instead.
      const chainUse = await copy.call(async () => {
        clearTimeout(startupRetryTimer); startupRetries = 99;   // no cable here: stop looking, or the retry removes the stand-in chain
        const wait = ms => new Promise(r => setTimeout(r, ms)), level = async () => { let p = 0; for (let i = 0; i < 100; i++) { p = Math.max(p, chainAmplitude(meterChain())); await wait(30); } return 20 * Math.log10(p + 1e-9); };
        const saved = state.nrAmount; state.nr = false; applyNr();
        state.gateAuto = false; state.gateDb = -60;      // gate wide open: the file's noise-only part must still reach the meter
        updateGate();
        const ctx = new AudioContext({ sampleRate: 48000 }); sendCtx = ctx; sendNodes = buildChain(ctx); connectSendSource(); syncChains();
        await wait(2500);                                // lets its worklets load
        const sending = { main: audioCtx.state, send: ctx.state, meterIsSend: meterChain() === sendNodes, level: await level() };
        setMonitor(true); await wait(1000);
        const listening = { main: audioCtx.state, meterIsMain: meterChain() === eqNodes, level: await level() };
        setMonitor(false); await wait(800);
        const back = audioCtx.state;
        teardownSend(); await wait(800);
        const after = { main: audioCtx.state, meterIsMain: meterChain() === eqNodes, level: await level() };
        state.nr = true; state.nrAmount = saved; state.gateAuto = true; applyNr(); updateGate();
        return { sending, listening, back, after };
      });
      check('while sending, the second engine sleeps and the meter still reads', chainUse.sending.main === 'suspended' && chainUse.sending.send === 'running' && chainUse.sending.meterIsSend && chainUse.sending.level > -70, `second engine ${chainUse.sending.main}, sending engine ${chainUse.sending.send}, meter ${f1(chainUse.sending.level)} dB`);
      check('Listen wakes it, and it sleeps again', chainUse.listening.main === 'running' && chainUse.listening.meterIsMain && chainUse.listening.level > -70 && chainUse.back === 'suspended', `with Listen ${chainUse.listening.main}, meter ${f1(chainUse.listening.level)} dB; afterwards ${chainUse.back}`);
      check('it runs again when sending stops', chainUse.after.main === 'running' && chainUse.after.meterIsMain && chainUse.after.level > -70, `${chainUse.after.main}, meter ${f1(chainUse.after.level)} dB`);
    }

    if (wanted('nr')) console.log('\nNoise reduction slider');
    const drops = [];
    for (const [s, min, max] of wanted('nr') ? [[0, -0.5, 0.5], [25, 4, 9], [60, 12, 25], [100, 20, 200]] : []) {
      const r = await copy.call(pageNrLevels, s), drop = r.raw - r.out;
      check(`${s}% lowers steady noise by ${min}-${max} dB`, drop >= min && drop <= max && (!drops.length || drop > drops[drops.length - 1]), `measured ${f1(drop)} dB (${f1(r.raw)} -> ${f1(r.out)})`);
      drops.push(drop);
    }

    if (wanted('gate')) {
      console.log('\nWhole chain, 30 s of noise and speech: noise reduction 100%, compressor on');
      await copy.call(s => { state.nr = true; state.nrAmount = s; applyNr(); }, 100);
      await sleep(7000);                 // the gate's noise floor has a 6 s memory
      const g = analyseGate(await copy.call(pageCapture, 30), fixture);
      const placed = Math.abs(g.micNoise - NOISE_DB) < 3 && g.voice[-25].mic > g.voice[-35].mic + 5 && g.voice[-35].mic > g.voice[-42].mic + 2;
      check('capture lines up with the test file', placed, `mic levels: noise ${f1(g.micNoise)}, speech ${[-25, -35, -42].map(l => f1(g.voice[l].mic)).join(' / ')} dB`);
      console.log(`        noise going in ${f1(g.micNoise)} dB, coming out ${f1(g.noise.endLevel)} dB`);
      check('gate shuts on noise', g.noise.openPct <= 30, `open ${f1(g.noise.openPct)}% of ${f1(g.noise.seconds)} s, ${g.noise.flips} flips`);
      check('speech reaches the end of the chain', g.voice[-25].openPct >= 80 && g.voice[-25].endLevel > g.micNoise + 10, `open ${f1(g.voice[-25].openPct)}%, output ${f1(g.voice[-25].endLevel)} dB`);
      check('output does not clip', g.peakDb < -0.5, `peak ${f1(g.peakDb)} dB`);
    }

    if (wanted('mute')) {
      console.log('\nMute');
      await copy.call(() => { state.nr = true; state.nrAmount = 100; state.gateAuto = false; updateGate(); applyNr(); setMonitor(true); });
      await sleep(7000);
      const on = await copy.call(pageOutPeak, 14);       // longer than the file's 8 s without speech
      check('sound flows when unmuted', on > -50, `output peak ${f1(on)} dB`);
      await copy.call(() => toggleMute());
      await sleep(300);
      const off = await copy.call(pageOutPeak, 14);
      check('muting silences the output', off < -90, `output peak ${f1(off)} dB`);
      const sound = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), out = { duration: muteSound.duration };
        toggleMute(); await wait(100);
        out.quietOnUnmute = muteSound.paused;
        toggleMute(); await wait(300);
        out.playedOnMute = !muteSound.paused && muteSound.currentTime > 0;
        toggleMute(); await wait(100);
        out.stoppedOnUnmute = muteSound.paused && muteSound.currentTime === 0;
        toggleMute();
        return out;
      });
      check('the mute sound plays on mute and stops on unmute', sound.duration > 0.5 && sound.duration < 1.5 && sound.quietOnUnmute && sound.playedOnMute && sound.stoppedOnUnmute, `${f1(sound.duration)} s long, played: ${sound.playedOnMute}, silent on unmute: ${sound.quietOnUnmute && sound.stoppedOnUnmute}`);
      await copy.call(() => toggleMute());
      const hotkey = await copy.call(() => $('muteKeyHint').textContent);
      if (/in use/.test(hotkey)) {
        console.log('  SKIP  hotkey press: another Mic Manager or app holds Ctrl+Alt+M');
      } else {
        const states = [await copy.call(() => state.muted)];
        for (let i = 0; i < 2; i++) { pressHotkey(); await sleep(600); states.push(await copy.call(() => state.muted)); }
        check('Ctrl+Alt+M toggles mute, once per press', states.join() === 'false,true,false', `mute state after each press: ${states.join(' -> ')}`);
        pressHotkey(45); await sleep(800);               // like a real keyboard: press, 500 ms, then 2 s of repeats
        const held = await copy.call(() => state.muted);
        check('holding the keys toggles once', held === true, `muted after holding: ${held}`);
        await copy.call(() => { if (state.muted) toggleMute(); });
        // Choosing a new shortcut, through the real button and a real key press
        const key = (code, more = {}) => `window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', cancelable: true, ...${JSON.stringify(more)} }))`;
        const hint = () => copy.call(() => $('muteKeyHint').textContent);
        await copy.call(() => { $('muteKeyChange').click(); });
        await sleep(300);
        await copy.call(new Function(key('Escape')));
        await sleep(400);
        const cancelled = await hint();
        await copy.call(() => { $('muteKeyChange').click(); });
        await sleep(300);
        await copy.call(new Function(key('KeyJ')));              // no modifier: must be refused
        const refused = await hint();
        await copy.call(new Function(key('KeyJ', { ctrlKey: true, altKey: true })));
        await sleep(500);
        const changed = await hint();
        pressHotkey(0, 0x4A); await sleep(800);
        const muted = await copy.call(() => state.muted);
        await sleep(700); pressHotkey(0, 0x4A); await sleep(800);
        const backOn = await copy.call(() => state.muted);
        const savedKey = await copy.call(() => JSON.parse((savePrefs(), localStorage.getItem(PREFS_KEY))).muteAccel);
        check('a new shortcut can be chosen and works', /Ctrl\+Alt\+J/.test(changed) && muted === true && backOn === false && savedKey === 'Control+Alt+J', `"${changed}", muted ${muted} then ${backOn}, saved ${savedKey}`);
        check('choosing is safe: Esc cancels, plain keys are refused', /Ctrl\+Alt\+M/.test(cancelled) && /Use Ctrl/.test(refused), `"${cancelled}" / "${refused}"`);
        await copy.call(() => { state.muteAccel = 'Control+Alt+M'; return applyMuteHotkey(); });
      }
      await copy.call(() => setMonitor(false));
      // The mic key: follow what ASUS did, always judged from before the press. Each row is [before, presses, default device now, expected].
      const keyRows = await copy.call(() => [[false, 1, true, true], [true, 1, false, false], [false, 1, false, true], [true, 1, true, false], [false, 2, false, false], [false, 2, true, true], [false, 1, null, true], [true, 2, null, true]].map(([b, p, d, want]) => ({ b, p, d, want, got: micKeyResult(b, p, d) })));
      check('mic key decisions', keyRows.every(r => r.got === r.want), keyRows.filter(r => r.got !== r.want).map(r => JSON.stringify(r)).join(' ') || `${keyRows.length} cases, including the background check arriving first`);
      const burst = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), was = state.muted;
        onMicKey(); onMicKey(); onMicKey();
        setMutedUi(!was);                                // something changes the state between the press and the settle
        await wait(700);
        const three = state.muted;
        setMutedUi(was);
        return { was, three };
      });
      check('the state is judged from the first press of a burst', burst.three === !burst.was, `before ${burst.was}, after three quick presses ${burst.three}`);
    }

    if (!wanted('eq')) return;
    console.log('\nEQ graph');
    await copy.call(() => { setEqOpen(true); savePrefs(); });
    // Chromium writes saved settings to disk in its own time, later after a burst of saves. Wait until they're really there.
    const savedOnDisk = () => {
      const dirPath = path.join(profile, 'Local Storage', 'leveldb');
      try {
        const raw = fs.readdirSync(dirPath).filter(f => f.endsWith('.log')).map(f => fs.readFileSync(path.join(dirPath, f)).toString('latin1')).join('');
        const at = raw.lastIndexOf('micManager.settings.v1');
        const saved = raw.slice(at, at + 900);
        return at >= 0 && saved.includes('"eqOpen":true');
      } catch { return false; }
    };
    for (let i = 0; i < 180 && !savedOnDisk(); i++) await sleep(500);
    copy.stop(); await sleep(2000);
    copy = new Copy(profile, wav, ['--hidden']);
    await copy.connect();
    await copy.call(pageReady);
    await sleep(1500);
    const hiddenEq = await copy.call(pageEqStretch);
    check('graph is not stretched while hidden', Math.abs(hiddenEq.worst - 1) < 0.01, `worst ${hiddenEq.worst.toFixed(2)}x (${hiddenEq.css} px layout, ${hiddenEq.bitmap} px bitmap)`);
    spawn(copy.exe, copy.args.filter(a => a !== '--hidden'), { cwd: ROOT, stdio: 'ignore' });   // a second launch shows the window
    await sleep(500);
    const eq = await copy.call(pageEqStretch);
    check('graph is not stretched after a hidden start', Math.abs(eq.worst - 1) < 0.01, `worst ${eq.worst.toFixed(2)}x over ${eq.samples} samples (${eq.css} px layout, ${eq.bitmap} px bitmap)`);
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
    if (wanted('app')) await helperChecks();
    if (wanted('nr')) { voiceChecks(); offlineChecks(); }
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
