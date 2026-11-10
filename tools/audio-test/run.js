// Measures the app's real audio chain on a known test signal: npm run test:audio
//
// Runs a separate hidden, muted copy of the app with its own temporary settings folder and a fake microphone
// that plays a generated file. Your running app, your settings, your mic and the virtual cable are not touched.
// The rename check adds a fake login entry to Windows for a moment, then removes it.
// During the EQ check its window opens briefly, and during the mute check a "Muted" badge shows in the corners of the
// screen for a few seconds; a tray icon shows while it runs. Takes about 4 minutes.
// Exit code 1 if any check fails. To run one part: npm run test:audio -- nr | gate | mute | eq | app
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
      await h.call('ptt', 0);
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
  const ctx = vm.createContext({ AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } }, sampleRate: SR, Math, Float32Array, Uint32Array, Infinity, WebAssembly, Error, console, registerProcessor: (_, c) => { ctx.Proc = c; } });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(RENDERER, 'voice-worklet.js'), 'utf8'), ctx);
  voiceWasm = voiceWasm || new WebAssembly.Module(fs.readFileSync(path.join(RENDERER, 'vendor', 'rnnoise.wasm')));
  return new ctx.Proc({ processorOptions: { wasm: voiceWasm } });
}
let voiceWasm = null;
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
  // Windows the noise reduction alone already took below -110 dB (20 dB above toDb's floor) have nothing left to gate,
  // and both sides sitting at the floor would look "open"; they're skipped and counted.
  const openPct = (out, ref) => { let o = 0, c = 0, silent = 0; for (let i = SR * 2; i + 960 + D < n; i += 960) { let a = 0, b = 0; for (let k = 0; k < 960; k++) { a += out[i + D + k] ** 2; b += ref[i + D + k] ** 2; } if (toDb(b) < -110) { silent++; continue; } c++; if (toDb(a) >= toDb(b) - 20) o++; } return { pct: 100 * o / Math.max(1, c), silent: 100 * silent / (silent + c) }; };
  for (const [name, src, limit] of [['steady noise', noise, 5], ['gusty fan', fan, 10]]) {
    const { pct, silent } = openPct(runVoice(src, 100, 1), runVoice(src, 100, 0));
    check(`gate stays shut on ${name}`, pct <= limit, `open ${f1(pct)}% (limit ${limit}%)${silent ? `, of the ${f1(100 - silent)}% of the time noise reduction left anything` : ''}`);
  }
  // After a minute or so the network trusts a voice less than when it started, and a gate that needs high confidence
  // throughout then cuts words (it let through 50% of this file's loudest speech). Scored on the 4th pass through the file.
  const fx = makeFixture(), p = loadVoice(), prm = { strength: new Float32Array([100]), gate: new Float32Array([1]) };
  let said = 0, kept = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i + 128 <= fx.samples.length; i += 128) {
      p.process([[fx.samples.subarray(i, i + 128)]], [[new Float32Array(128)]], prm);
      const seg = fx.segmentAt(i / SR);
      if (pass === 3 && seg.kind === 'voice' && seg.level === fx.voiceLevels[0]) { said++; if (p.open) kept++; }
    }
  }
  check(`speech still opens the gate after ${Math.round(3 * fx.seconds)} s of running`, kept / said >= 0.9, `${f1(100 * kept / said)}% of the speech at ${fx.voiceLevels[0]} dB let through (at least 90%)`);
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

// Evaluates an expression in another page of the test copy (like the muted badge). null if there's no such page.
async function evalIn(match, expression) {
  const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x => x.type === 'page' && match.test(x.url));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const r = await new Promise(res => {
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  ws.close();
  return r && r.result ? r.result.value : null;
}

// ---- Runs inside the page ----
const pageReady = async () => {
  for (let i = 0; i < 100; i++) {
    try { if (engine.stream && engine.mainChain && engine.mainChain.voice && engine.mainChain.gate) return true; } catch { /* page script still loading */ }
    await new Promise(r => setTimeout(r, 200));
  }
  try { return JSON.stringify({ stream: !!engine.stream, nr: !!(engine.mainChain && engine.mainChain.nr), gate: !!(engine.mainChain && engine.mainChain.gate), nrFailed: !!(engine.mainChain && engine.mainChain.nrFailed) }); } catch (err) { return err.message; }
};
const pageInfo = () => {
  const s = engine.stream.getAudioTracks()[0].getSettings();
  return { suppression: s.noiseSuppression, sendConnected: !!engine.sendChain, comp: state.comp, nr: state.nr, amount: state.nrAmount, auto: state.gateAuto, engine: !!engine.mainChain.voice };
};
const pageNrLevels = async strength => {
  state.nr = strength > 0; state.nrAmount = strength; applyNr();
  if (engine.mainChain.voice) engine.mainChain.voice.parameters.get('gate').setValueAtTime(0, engine.audioCtx.currentTime);   // measure the noise part alone
  await new Promise(r => setTimeout(r, 6000));         // the noise estimate has a ~4 s memory
  const a = engine.audioCtx.createAnalyser(), b = engine.audioCtx.createAnalyser(); a.fftSize = b.fftSize = 2048;
  engine.source.connect(a); engine.mainChain.nr.connect(b);
  const ba = new Float32Array(2048), bb = new Float32Array(2048), la = [], lb = [];
  const rms = x => { let e = 0; for (const v of x) e += v * v; return 20 * Math.log10(Math.sqrt(e / x.length) + 1e-9); };
  const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    a.getFloatTimeDomainData(ba); b.getFloatTimeDomainData(bb);
    la.push(rms(ba)); lb.push(rms(bb));
    await new Promise(r => setTimeout(r, 40));
  }
  engine.source.disconnect(a); engine.mainChain.nr.disconnect(b);
  if (engine.mainChain.voice) engine.mainChain.voice.parameters.get('gate').setValueAtTime(state.gateAuto ? 1 : 0, engine.audioCtx.currentTime);
  const p10 = l => [...l].sort((x, y) => x - y)[Math.floor(l.length * 0.1)];
  return { raw: p10(la), out: p10(lb) };
};
// Three synchronized tracks: mic, after noise reduction, and the end of the chain (before the output level).
const pageCapture = async secs => {
  const ctx = engine.audioCtx, merge = ctx.createChannelMerger(3), stages = [engine.source, engine.mainChain.nr, engine.mainChain.gateGain];
  const taps = stages.map((node, i) => { const g = ctx.createGain(); g.channelCount = 1; g.channelCountMode = 'explicit'; node.connect(g); g.connect(merge, 0, i); return g; });
  const sp = ctx.createScriptProcessor(4096, 3, 1), blocks = [], thresholds = [];
  sp.onaudioprocess = e => { blocks.push([0, 1, 2].map(c => e.inputBuffer.getChannelData(c).slice())); thresholds.push(engine.autoGateDb); };
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
  const a = engine.audioCtx.createAnalyser(), b = new Float32Array(2048); a.fftSize = 2048;
  engine.mainChain.outGain.connect(a);
  let pk = 0; const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) {
    a.getFloatTimeDomainData(b);
    for (const v of b) { const m = Math.abs(v); if (m > pk) pk = m; }
    await new Promise(r => setTimeout(r, 20));
  }
  engine.mainChain.outGain.disconnect(a);
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
function pressKey(vk, up) {
  const ps = "Add-Type -Name K -Namespace T -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);';" +
    `[T.K]::keybd_event(${vk},0,${up ? 2 : 0},[UIntPtr]::Zero)`;
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
const wanted = part => !ONLY || ONLY.split(',').includes(part);   // one part, or several: nr,gate

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

    if (wanted('gate')) {
      // Right after start, before the other parts: once the network has run a minute it treats the test file's synthetic
      // speech as noise and turns it down about 12 dB (real speech it leaves alone: Windows TTS speech loses 0.5 dB either way).
      // The gate's long-running behaviour is checked offline instead ("speech still opens the gate after ...").
      console.log('\nWhole chain, 30 s of noise and speech: noise reduction 100%, compressor on');
      await copy.call(s => { state.nr = true; state.nrAmount = s; applyNr(); }, 100);
      await sleep(7000);                 // the gate's noise floor has a 6 s memory
      const cap = await copy.call(pageCapture, 30);
      check('the audio clock keeps up after an output device was chosen', cap.n >= 30 * cap.sr * 0.98, `${cap.n} of ${30 * cap.sr} samples in 30 s`);
      const g = analyseGate(cap, fixture);
      const placed = Math.abs(g.micNoise - NOISE_DB) < 3 && g.voice[-25].mic > g.voice[-35].mic + 5 && g.voice[-35].mic > g.voice[-42].mic + 2;
      check('capture lines up with the test file', placed, `mic levels: noise ${f1(g.micNoise)}, speech ${[-25, -35, -42].map(l => f1(g.voice[l].mic)).join(' / ')} dB`);
      console.log(`        noise going in ${f1(g.micNoise)} dB, coming out ${f1(g.noise.endLevel)} dB`);
      check('gate shuts on noise', g.noise.openPct <= 30, `open ${f1(g.noise.openPct)}% of ${f1(g.noise.seconds)} s, ${g.noise.flips} flips`);
      check('speech reaches the end of the chain', g.voice[-25].openPct >= 80 && g.voice[-25].endLevel > g.micNoise + 10, `open ${f1(g.voice[-25].openPct)}%, output ${f1(g.voice[-25].endLevel)} dB`);
      check('output does not clip', g.peakDb < -0.5, `peak ${f1(g.peakDb)} dB`);
    }

    if (wanted('app')) {
      console.log('\nA new install');
      const fresh = await copy.call(() => ({ gains: EQ_BANDS.map(d => eq.b[d.key].g), preset: $('eqPreset').value, comp: state.comp }));
      check('a new install starts flat, with the compressor off', fresh.gains.every(g => g === 0) && fresh.preset === 'flat' && fresh.comp === false, `gains ${fresh.gains.join()}, preset ${fresh.preset}, compressor ${fresh.comp}`);
      console.log('\nStart with Windows');
      const startup = await copy.call(async () => { await openSettings(); const r = { api: await window.appStartup.get(), disabled: $('startupToggle').disabled, hint: $('startupHint').textContent }; await closeSettings(); return r; });
      check('a copy run from source cannot register itself at login', startup.api.supported === false && startup.disabled, `toggle disabled: ${startup.disabled}, hint: "${startup.hint}"`);
      console.log('\nChoosing a mic');
      const mic = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), [a, b] = devices, out = {};
        const startBands = snapshotEq();
        const realList = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
        const micOptions = () => [...$('micSelect').options].filter(o => o.value).length;
        out.names = [a.name, b.name]; out.options = micOptions();
        $('micSelect').value = b.id; $('micSelect').dispatchEvent(new Event('change', { bubbles: true })); await wait(500);
        out.picked = state.deviceId === b.id && prefDeviceName === b.name;
        out.firstTimeInherits = eq.b.bass.g === startBands.bands.bass.g;   // this mic has no EQ of its own yet
        eq.b.bass.g = 5; eqEdited();
        selectDevice(a.id); await wait(300);
        eq.b.bass.g = -4; eqEdited();
        selectDevice(b.id); await wait(300); out.bBass = eq.b.bass.g;
        selectDevice(a.id); await wait(300); out.aBass = eq.b.bass.g;
        selectDevice(b.id); await wait(500);
        const capturedBefore = engine.stream;
        await loadDevices(); await wait(500);
        out.rescanKeepsCapture = engine.stream === capturedBefore;
        navigator.mediaDevices.enumerateDevices = async () => (await realList()).filter(d => d.deviceId !== b.id);
        await loadDevices(); await wait(800);
        out.unplugged = { current: currentDevice().name, notice: $('micNotice').textContent, bass: eq.b.bass.g, stillPreferred: prefDeviceName };
        delete navigator.mediaDevices.enumerateDevices;
        await loadDevices(); await wait(800);
        out.replugged = { current: currentDevice().name, notice: $('micNotice').textContent, bass: eq.b.bass.g, capturing: engine.capturedId === state.deviceId };
        const pickBox = document.querySelector('.olive-mic-select').getBoundingClientRect(), refreshBox = $('refreshBtn').getBoundingClientRect(), optionsBefore = micOptions();
        out.refreshBeside = refreshBox.width > 0 && refreshBox.left >= pickBox.right - 1 && Math.abs((refreshBox.top + refreshBox.bottom) - (pickBox.top + pickBox.bottom)) / 2 < 8;
        out.panelGone = !$('devicesPanel') && !$('deviceList') && !$('devToggle');
        navigator.mediaDevices.enumerateDevices = async () => (await realList()).filter(d => d.deviceId !== state.deviceId);
        $('refreshBtn').click(); await wait(800);
        out.refreshRemoved = micOptions() === optionsBefore - 1;
        delete navigator.mediaDevices.enumerateDevices;
        $('refreshBtn').click(); await wait(800);
        out.refreshRestored = micOptions() === optionsBefore;
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
      const look = await copy.call(async () => {
        savePrefs();
        await openSettings();
        const version = $('appVersion').textContent;
        await closeSettings();
        return {
          picker: !!document.getElementById('themeSelect'), attr: document.documentElement.dataset.theme || null, text: getComputedStyle(document.body).color,
          accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), names: [document.title, document.querySelector('h1').textContent, version.split(' ')[0]],
          sheets: [...document.styleSheets].filter(s => s.href).map(s => s.href.split('/').pop()), saved: 'theme' in JSON.parse(localStorage.getItem(PREFS_KEY))
        };
      });
      check('there is one look, with no picker', !look.picker && look.attr === 'dark' && !look.saved && look.text === 'rgb(245, 244, 240)' && look.sheets.join() === 'olive.css', `picker: ${look.picker}, stylesheets: ${look.sheets.join()}, text: ${look.text}`);
      check('the window is branded Olive', look.accent.toUpperCase() === '#6B7F3A' && look.names.every(n => n === 'Olive'), `accent ${look.accent}, title / heading / settings: ${look.names.join(' / ')}`);
      console.log('\nSettings panel');
      const panel = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), shown = () => !!$('settingsPanel');
        const pageHidden = () => { const m = document.querySelector('main'); return m.inert || !!m.closest('[aria-hidden="true"], [inert]'); };
        const out = { closedAtStart: !shown() };
        $('settingsBtn').focus(); $('settingsBtn').click(); await wait(500);
        out.inPanel = shown() && ['muteKeyToggle', 'pttToggle', 'soundToggle', 'badgeToggle', 'updateAuto', 'startupToggle'].every(id => $('settingsPanel').contains($(id)));
        out.opened = shown() && $('settingsBtn').getAttribute('aria-expanded') === 'true' && pageHidden();
        const inside = $('settingsPanel').contains(document.activeElement) ? document.activeElement : $('settingsPanel');   // a hidden window has no focus to follow
        inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await wait(600);
        out.escCloses = !shown() && !pageHidden();
        out.focusBack = document.activeElement === $('settingsBtn');
        $('settingsBtn').click(); await wait(500);
        const bd = $('settingsScrim'), r = bd.getBoundingClientRect(), at = { clientX: r.left + 20, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
        bd.dispatchEvent(new PointerEvent('pointerdown', at)); bd.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 })); bd.dispatchEvent(new MouseEvent('click', at)); await wait(600);
        out.scrimCloses = !shown();
        setView({ muteKeyHint: 'Ctrl+Alt+M is already in use by another app' }); await wait(50);
        out.dotOn = !$('settingsDot').hidden && /hotkey/.test($('settingsBtn').title);
        setView({ muteKeyHint: 'Ctrl+Alt+M mutes your mic from anywhere' }); await wait(50);
        out.dotOff = $('settingsDot').hidden;
        await applyMuteHotkey();
        return out;
      });
      check('one-time settings live in a panel behind the gear, closed at start', panel.closedAtStart && panel.inPanel, `closed: ${panel.closedAtStart}, all six settings inside: ${panel.inPanel}`);
      check('it opens, and Esc or a click outside closes it', panel.opened && panel.escCloses && panel.scrimCloses, `opens: ${panel.opened}, Esc: ${panel.escCloses} (focus back on the gear: ${panel.focusBack}), outside: ${panel.scrimCloses}`);
      check('a dot on the gear flags something that needs you', panel.dotOn && panel.dotOff, `hotkey taken: dot ${panel.dotOn}, cleared: ${panel.dotOff}`);
      console.log('\nNo microphone');
      const none = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), md = navigator.mediaDevices, realList = md.enumerateDevices.bind(md), out = {};
        const trigger = () => document.querySelector('.olive-mic-select button'), listed = () => [...$('micSelect').options].filter(o => o.value).map(o => o.textContent);
        const read = () => ({ options: listed().length ? listed() : [document.querySelector('.olive-mic-select [data-slot="select-value"]').textContent], disabled: trigger().disabled || trigger().hasAttribute('data-disabled'), status: $('devStatus').textContent, level: $('levelDb').textContent, chip: $('gateChip').textContent, capturing: !!engine.stream });
        const fail = name => { md.getUserMedia = async () => { throw new DOMException('test', name); }; };
        try {
          md.enumerateDevices = async () => (await realList()).filter(d => d.kind !== 'audioinput');
          fail('NotFoundError');
          await loadDevices(); await wait(500);
          out.missing = read();
          fail('NotAllowedError');
          await loadDevices(); await wait(300);
          out.blocked = read();
        } finally {
          delete md.enumerateDevices; delete md.getUserMedia;
          await loadDevices(); await wait(1000);
        }
        out.back = read();
        out.backMeter = engine.rawAmplitude(engine.meterChain()) > 0;
        return out;
      });
      check('no mic: the list says so, with no made-up mics', none.missing.options.join() === 'No microphone found' && none.missing.disabled && !none.missing.capturing, `list: ${none.missing.options.join()}, disabled: ${none.missing.disabled}`);
      check('no mic: it says what to do, and the meter is silent', /Plug in/.test(none.missing.status) && /∞/.test(none.missing.level) && none.missing.chip === '', `"${none.missing.status}", meter ${none.missing.level}, chip "${none.missing.chip}"`);
      check('mic access blocked: Windows privacy is named', /Privacy/.test(none.blocked.status) && none.blocked.options.join() === 'No microphone found', `"${none.blocked.status}"`);
      check('a mic coming back starts working again', none.back.capturing && !none.back.disabled && none.back.options[0] !== 'No microphone found' && none.backMeter, `${none.back.options.length} mics, capturing: ${none.back.capturing}, signal: ${none.backMeter}`);

      console.log('\nThe level meter');
      const meter = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), keep = state.gateAuto, closed = [], chips = new Set();
        state.gateAuto = true; updateGate();
        windowHidden = false; syncTicker();
        const t0 = performance.now();
        while (performance.now() - t0 < 16000) {
          await wait(100);
          if (!engine.meterChain().gateIsOpen) { closed.push(20 * Math.log10(engine.rawAmplitude(engine.meterChain()) + 1e-9)); chips.add($('gateChip').textContent); }
        }
        windowHidden = true; syncTicker();
        state.gateAuto = keep; updateGate();
        closed.sort((a, b) => a - b);
        return { samples: closed.length, median: closed[closed.length >> 1], chips: [...chips] };
      });
      check('the meter shows the mic even with the gate shut', meter.samples > 5 && meter.median > -55 && meter.median < -32, `median ${f1(meter.median)} dB over ${meter.samples} samples with the gate shut (the file's noise is ${NOISE_DB} dB)`);
      check('it says the gate is closed', meter.chips.includes('Gate closed'), `showed: ${meter.chips.join(', ')}`);

      console.log('\nEQ limits and compare');
      const limits = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), keep = snapshotEq(), out = {};
        eqBandsReset.length = 0;
        restoreEq({ bands: { presence: { f: 20, g: 9.6, q: 8 }, bass: { f: 112, g: 12, q: 0.7 } } });
        out.presence = { ...eq.b.presence }; out.bass = { ...eq.b.bass }; out.reset = [...eqBandsReset];
        selectBand('presence');
        for (let i = 0; i < 60; i++) $('eqCurve').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        out.lowest = eq.b.presence.f;
        selectBand(null);
        eq.on = true; eq.b.bass.g = 6; applyEq();
        out.disabledWithoutListen = $('eqCompare').disabled;
        setMonitor(true); await wait(300);
        out.enabled = !$('eqCompare').disabled;
        out.before = engine.mainChain.bands[0].gain.value;
        $('eqCompare').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); await wait(300);
        out.held = engine.mainChain.bands[0].gain.value; out.heldWanted = eq.b.bass.g;
        $('eqCompare').dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true })); await wait(300);
        out.after = engine.mainChain.bands[0].gain.value;
        setMonitor(false);
        restoreEq(keep); showEqPreset(); syncEqUi(); eqBandsReset.length = 0;
        return out;
      });
      check('a band saved far out of range goes flat, others stay', limits.presence.f === 4000 && limits.presence.g === 0 && limits.bass.g === 12 && limits.reset.join() === 'Presence', `Presence ${limits.presence.f} Hz ${limits.presence.g} dB, bass ${limits.bass.g} dB`);
      check('a band can only move within its range', limits.lowest === 1500, `Presence stopped at ${Math.round(limits.lowest)} Hz`);
      check('compare bypasses the EQ only while held', limits.disabledWithoutListen && limits.enabled && Math.abs(limits.before - 6) < 0.1 && Math.abs(limits.held) < 0.1 && Math.abs(limits.after - 6) < 0.1 && limits.heldWanted === 6, `bass ${f1(limits.before)} -> ${f1(limits.held)} -> ${f1(limits.after)} dB`);

      console.log('\nOutput device');
      const output = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
        await loadOutputs();
        const pick = $('outputSelect');
        out.options = [...pick.options].map(o => o.value);
        out.cableListed = [...pick.options].some(o => isCableLabel(o.textContent));
        const real = out.options.find(v => v !== 'default');
        if (real) {
          pick.value = real; pick.dispatchEvent(new Event('change', { bubbles: true })); await wait(800);
          out.ctxSink = engine.audioCtx.sinkId === real; out.soundSink = muteSound.sinkId === real && unmuteSound.sinkId === real;
          out.saved = JSON.parse(localStorage.getItem(PREFS_KEY)).outputId === real;
        }
        state.outputId = 'not-a-device'; state.outputName = 'Gone speakers';
        await loadOutputs(); await wait(200);
        out.goneHint = $('outputHint').textContent; out.goneValue = pick.value; out.goneCtx = engine.audioCtx.sinkId; out.keptName = state.outputName;
        state.outputId = 'default'; state.outputName = null;
        await loadOutputs();
        out.hasReal = !!real;
        return out;
      });
      check('Listen and the mute sounds follow the chosen device', !output.hasReal || (output.ctxSink && output.soundSink && output.saved), output.hasReal ? `${output.options.length} outputs, both moved, saved: ${output.saved}` : 'only the default exists here');
      check('the cable is not offered as a place to listen', !output.cableListed, `${output.options.length} outputs listed`);
      check('a missing device falls back and says so', output.goneValue === 'default' && output.goneCtx === '' && output.goneHint.includes('Gone speakers') && output.keptName === 'Gone speakers', `"${output.goneHint}"`);

      console.log('\nFirst-run setup');
      const setup = await copy.call(async () => {
        const out = {}, realFind = findCable, keepFresh = freshInstall, keepDone = state.setupDone;
        const shown = () => !$('setupCard').hidden;
        try {
          const settle = () => new Promise(r => setTimeout(r, 60));   // React draws the change a moment later
          findCable = async () => null; state.setupDone = false; freshInstall = false; await updateSetup(); await settle();
          out.noCable = { shown: shown(), text: $('setupCable').textContent, download: !$('setupDownload').hidden };
          $('setupDone').click(); await new Promise(r => setTimeout(r, 100));
          out.dismissed = { shown: shown(), reopen: !$('setupOpen').hidden, saved: JSON.parse(localStorage.getItem(PREFS_KEY)).setupDone };
          findCable = async () => ({ deviceId: 'x' }); state.setupDone = false; freshInstall = true; await updateSetup(); await settle();
          out.freshWithCable = { shown: shown(), download: !$('setupDownload').hidden };
          state.setupDone = false; freshInstall = false; await updateSetup(); await settle();
          out.upgradeWithCable = { shown: shown(), done: state.setupDone };
        } finally { findCable = realFind; freshInstall = keepFresh; state.setupDone = keepDone; await updateSetup(); }
        return out;
      });
      check('no cable: the steps show, with a download button', setup.noCable.shown && setup.noCable.download && /Not found/.test(setup.noCable.text), `"${setup.noCable.text}"`);
      check('dismissed: stays hidden but can be reopened, and is saved', !setup.dismissed.shown && setup.dismissed.reopen && setup.dismissed.saved === true, `reopen button: ${setup.dismissed.reopen}`);
      check('a new install with a cable still gets the Discord step', setup.freshWithCable.shown && !setup.freshWithCable.download, 'no download button');
      check('an existing user with a cable is not bothered', !setup.upgradeWithCable.shown && setup.upgradeWithCable.done, 'stays hidden');

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
        startupRetries = 0;   // every earlier rescan used up a try, and this test needs some left
        navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('not ready', 'AbortError'); };
        await loadDevices();
        const during = { live, status: $('devStatus').textContent, retrying: startupRetries > 0 };
        delete navigator.mediaDevices.getUserMedia;
        await wait(6500);
        return { during, recovered: live, capturing: !!engine.stream, status: $('devStatus').textContent };
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
        const wait = ms => new Promise(r => setTimeout(r, ms)), level = async () => { let p = 0; for (let i = 0; i < 100; i++) { p = Math.max(p, engine.chainAmplitude(engine.meterChain())); await wait(30); } return 20 * Math.log10(p + 1e-9); };
        const saved = state.nrAmount; state.nr = false; applyNr();
        state.gateAuto = false; state.gateDb = -60;      // gate wide open: the file's noise-only part must still reach the meter
        updateGate();
        const ctx = new AudioContext({ sampleRate: 48000 }); engine.useSendContext(ctx);
        await wait(2500);                                // lets its worklets load
        const sending = { main: engine.audioCtx.state, send: ctx.state, meterIsSend: engine.meterChain() === engine.sendChain, level: await level() };
        setMonitor(true); await wait(1000);
        const listening = { main: engine.audioCtx.state, meterIsMain: engine.meterChain() === engine.mainChain, level: await level() };
        setMonitor(false); await wait(800);
        const back = engine.audioCtx.state;
        engine.closeSend(); await wait(800);
        const after = { main: engine.audioCtx.state, meterIsMain: engine.meterChain() === engine.mainChain, level: await level() };
        state.nr = true; state.nrAmount = saved; state.gateAuto = true; applyNr(); updateGate();
        return { sending, listening, back, after };
      });
      check('while sending, the second engine sleeps and the meter still reads', chainUse.sending.main === 'suspended' && chainUse.sending.send === 'running' && chainUse.sending.meterIsSend && chainUse.sending.level > -70, `second engine ${chainUse.sending.main}, sending engine ${chainUse.sending.send}, meter ${f1(chainUse.sending.level)} dB`);
      check('Listen wakes it, and it sleeps again', chainUse.listening.main === 'running' && chainUse.listening.meterIsMain && chainUse.listening.level > -70 && chainUse.back === 'suspended', `with Listen ${chainUse.listening.main}, meter ${f1(chainUse.listening.level)} dB; afterwards ${chainUse.back}`);
      check('it runs again when sending stops', chainUse.after.main === 'running' && chainUse.after.meterIsMain && chainUse.after.level > -70, `${chainUse.after.main}, meter ${f1(chainUse.after.level)} dB`);

      console.log('\nMic test');
      // Gate wide open and noise reduction off, so the file's background noise counts as sound whatever part of it plays.
      const micTestRun = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
        clearTimeout(startupRetryTimer); startupRetries = 99;
        state.nr = false; applyNr(); state.gateAuto = false; state.gateDb = -60; updateGate();
        setMonitor(true); await wait(1500);
        out.enabled = !$('testBtn').disabled;
        $('testBtn').click(); await wait(400);
        out.recording = !!engine.micTest && engine.micTest.phase === 'recording' && /^Recording/.test($('testBtn').textContent);
        out.listenWhileRecording = engine.mainChain.outGain.gain.value;
        await wait(5200);
        const t = engine.micTest;
        out.playing = !!t && t.phase === 'playing';
        out.seconds = t && t.seconds; out.peak = t && t.peakDb;
        out.ownOutput = !!(t && t.src && t.src.context === engine.audioCtx);
        await wait(300);
        out.listenWhilePlaying = engine.mainChain.outGain.gain.value;
        $('testBtn').click(); await wait(300);
        out.stopped = !engine.micTest && $('testBtn').textContent === 'Test mic';
        out.listenAfter = engine.mainChain.outGain.gain.value;
        // Muted: it still records, and nothing leaves Olive meanwhile
        toggleMute(); await wait(300);
        $('testBtn').click(); await wait(400);
        out.mutedHint = $('testHint').textContent; out.mutedOut = engine.mainChain.outGain.gain.value;
        await wait(5200);
        out.mutedPeak = engine.micTest && engine.micTest.peakDb;
        if (engine.micTest) engine.endMicTest();
        toggleMute();
        // The gate shut the whole time: it says so
        state.gateDb = -10; updateGate(); await wait(800);
        $('testBtn').click(); await wait(5600);
        out.shutHint = $('testHint').textContent;
        if (engine.micTest) engine.endMicTest();
        setMonitor(false);
        // While sending: recorded from the sending engine, played on your output, and that engine sleeps again afterwards
        state.gateDb = -60; updateGate();
        const ctx = new AudioContext({ sampleRate: 48000 }); engine.useSendContext(ctx);
        await wait(2500);
        $('testBtn').click(); await wait(5500);
        const s = engine.micTest;
        out.sendRecordedFrom = s && s.ch === engine.sendChain; out.sendPlayedOn = s && s.src && s.src.context === engine.audioCtx; out.sendPeak = s && s.peakDb;
        out.mainWhilePlaying = engine.audioCtx.state;
        if (s) engine.endMicTest();
        await wait(500);
        out.mainAfter = engine.audioCtx.state;
        engine.closeSend(); await wait(500);
        state.nr = true; applyNr(); state.gateAuto = true; updateGate();
        return out;
      });
      const mt = micTestRun;
      check('Test mic records 5 s of the processed sound', mt.enabled && mt.recording && mt.playing && Math.abs(mt.seconds - 5) < 0.25 && mt.peak > -50, `${f1(mt.seconds)} s recorded, peak ${f1(mt.peak)} dB`);
      check('it plays back on your output, with Listen quiet meanwhile', mt.ownOutput && mt.listenWhileRecording > 0.5 && mt.listenWhilePlaying < 0.01 && mt.listenAfter > 0.5, `Listen ${mt.listenWhileRecording.toFixed(2)} -> ${mt.listenWhilePlaying.toFixed(3)} -> ${mt.listenAfter.toFixed(2)}`);
      check('Stop ends it', mt.stopped, `stopped: ${mt.stopped}`);
      check('it works while muted, and nothing leaves Olive', mt.mutedPeak > -50 && /muted/.test(mt.mutedHint) && mt.mutedOut < 0.001, `peak ${f1(mt.mutedPeak)} dB, output level ${mt.mutedOut}, "${mt.mutedHint}"`);
      check('it says so when nothing got through the gate', /Nothing got through/.test(mt.shutHint), `"${mt.shutHint}"`);
      check('while sending: recorded from the sending engine, never played into it', mt.sendRecordedFrom && mt.sendPlayedOn && mt.sendPeak > -50 && mt.mainWhilePlaying === 'running' && mt.mainAfter === 'suspended', `peak ${f1(mt.sendPeak)} dB; your output engine ${mt.mainWhilePlaying} while playing, ${mt.mainAfter} after`);
    }

    if (wanted('nr')) console.log('\nNoise reduction slider');
    const drops = [];
    for (const [s, min, max] of wanted('nr') ? [[0, -0.5, 0.5], [25, 4, 9], [60, 12, 25], [100, 20, 200]] : []) {
      const r = await copy.call(pageNrLevels, s), drop = r.raw - r.out;
      check(`${s}% lowers steady noise by ${min}-${max} dB`, drop >= min && drop <= max && (!drops.length || drop > drops[drops.length - 1]), `measured ${f1(drop)} dB (${f1(r.raw)} -> ${f1(r.out)})`);
      drops.push(drop);
    }

    if (wanted('mute')) {
      console.log('\nMute');
      await copy.call(() => { state.nr = true; state.nrAmount = 100; state.gateAuto = false; updateGate(); applyNr(); setMonitor(true); return openSettings(); });
      await sleep(7000);
      const on = await copy.call(pageOutPeak, 14);       // longer than the file's 8 s without speech
      check('sound flows when unmuted', on > -50, `output peak ${f1(on)} dB`);
      await copy.call(() => toggleMute());
      await sleep(300);
      const off = await copy.call(pageOutPeak, 14);
      check('muting silences the output', off < -90, `output peak ${f1(off)} dB`);
      await copy.call(() => toggleMute());
      const TALK_KEY = 0x87;                             // F24, which nothing on a normal keyboard uses
      try {
        const chosen = await copy.call(k => { state.gateAuto = false; state.gateDb = -60; updateGate(); state.ptt = true; state.pttKey = { vk: k, label: 'F24' }; return applyPtt().then(() => $('pttHint').textContent); }, TALK_KEY);
        await sleep(800);
        const released = await copy.call(pageOutPeak, 14);
        pressKey(TALK_KEY, false); await sleep(120);
        const held = await copy.call(pageOutPeak, 14);
        const wasOpen = await copy.call(() => pttOpen);
        pressKey(TALK_KEY, true); await sleep(600);
        const after = await copy.call(pageOutPeak, 14);
        const closedAgain = await copy.call(() => pttOpen);
        check('push to talk: silent until the key is held', released < -90, `output peak ${f1(released)} dB ("${chosen}")`);
        check('push to talk: sound flows while it is held', held > -50 && wasOpen, `output peak ${f1(held)} dB`);
        check('push to talk: silent again after release', after < -90 && !closedAgain, `output peak ${f1(after)} dB`);
      } finally {
        pressKey(TALK_KEY, true);
        await copy.call(() => { state.ptt = false; state.pttKey = null; return applyPtt(); });
      }
      await copy.call(() => toggleMute());
      const sound = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), playing = s => !s.paused && s.currentTime > 0;
        const out = { durations: [muteSound.duration, unmuteSound.duration] };
        toggleMute(); await wait(100);                 // starts muted: this unmutes
        out.unmuteOnUnmute = playing(unmuteSound) && muteSound.paused;
        toggleMute(); await wait(100);
        out.muteOnMute = playing(muteSound) && unmuteSound.paused && unmuteSound.currentTime === 0;
        toggleMute(); await wait(100);
        out.muteCutOff = muteSound.paused && muteSound.currentTime === 0 && playing(unmuteSound);
        toggleMute();
        return out;
      });
      check('each way has its own short sound, and a new one cuts off the last', sound.durations.every(d => d > 0.2 && d < 1) && sound.unmuteOnUnmute && sound.muteOnMute && sound.muteCutOff, `${sound.durations.map(f1).join(' s and ')} s long, unmute: ${sound.unmuteOnUnmute}, mute: ${sound.muteOnMute}, cut off: ${sound.muteCutOff}`);
      await copy.call(() => toggleMute());
      // The sound settings, through the real controls
      const soundSet = await copy.call(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
        // React keeps its own copy of an input's value, so a value set from outside goes through the native setter.
        const setValue = (el, v) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
        const s = $('soundVol'), sw = $('soundToggle'), out = {};
        // Set 50%, then nudge with the arrow keys and back: a key press is a release, like letting go after a drag.
        const key = k => s.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        setValue(s, 50); fire(s, 'input'); await wait(80); key('ArrowRight'); await wait(80); key('ArrowLeft'); await wait(100);
        out.volume = muteSound.volume; out.preview = !muteSound.paused; out.shown = $('soundVal').textContent;
        if (sw.checked) sw.click();
        toggleMute(); await wait(100); out.silent = muteSound.paused && unmuteSound.paused;
        toggleMute(); await wait(100); out.silent = out.silent && muteSound.paused && unmuteSound.paused;
        const saved = JSON.parse(localStorage.getItem(PREFS_KEY));
        out.saved = saved.muteSounds === false && saved.muteSoundVol === 50;
        if (!sw.checked) sw.click(); setValue(s, 100); fire(s, 'input');
        return out;
      });
      check('the mute sounds have a volume that previews on release', Math.abs(soundSet.volume - 0.25) < 0.001 && soundSet.preview && soundSet.shown === '50%', `50% plays at ${soundSet.volume} (by loudness), preview: ${soundSet.preview}`);
      check('the mute sounds can be turned off, and that is saved', soundSet.silent && soundSet.saved, `silent: ${soundSet.silent}, saved: ${soundSet.saved}`);
      // The muted badge: its own window, read through its own page
      const badgeAt = () => evalIn(/badge\.html/, '({ vis: document.visibilityState, left: screenX - screen.availLeft, top: screenY - screen.availTop, right: screen.availLeft + screen.availWidth - screenX - outerWidth, bottom: screen.availTop + screen.availHeight - screenY - outerHeight })');
      const pick = corner => copy.call(c => { const p = $('badgeCorner'); p.value = c; p.dispatchEvent(new Event('change', { bubbles: true })); }, corner);
      await copy.call(() => { if (!$('badgeToggle').checked) $('badgeToggle').click(); state.badgeCorner = 'top-left'; setView({}); return window.appBadge.set(true, 'top-left', false); });
      const before = await badgeAt();
      await copy.call(() => toggleMute()); await sleep(1500);
      const onMute = await badgeAt();
      await pick('bottom-right'); await sleep(500);
      const moved = await badgeAt();
      await copy.call(() => toggleMute()); await sleep(500);
      const unmuted = await badgeAt();
      check('a Muted badge shows in the chosen corner while muted', (!before || before.vis === 'hidden') && onMute && onMute.vis === 'visible' && onMute.left <= 20 && onMute.top <= 20 && moved.vis === 'visible' && moved.right <= 20 && moved.bottom <= 20, onMute ? `top left at ${onMute.left},${onMute.top}; bottom right ${moved.right},${moved.bottom} from the edges` : 'no badge window');
      check('it goes away on unmute', unmuted && unmuted.vis === 'hidden', unmuted ? unmuted.vis : 'no badge window');
      await pick('top-left'); await sleep(500);
      const preview = await badgeAt(); await sleep(2700);
      const afterPreview = await badgeAt();
      check('choosing a corner shows it for a moment', preview.vis === 'visible' && preview.left <= 20 && afterPreview.vis === 'hidden', `${preview.vis}, then ${afterPreview.vis}`);
      await copy.call(() => { const t = $('badgeToggle'); if (t.checked) t.click(); toggleMute(); });
      await sleep(500);
      const badgeOff = await badgeAt();
      await copy.call(() => { toggleMute(); const t = $('badgeToggle'); if (!t.checked) t.click(); });
      check('no badge when it is turned off', badgeOff.vis === 'hidden', `muted with the badge off: ${badgeOff.vis}`);
      await sleep(2800);
      const hotkey = await copy.call(() => $('muteKeyHint').textContent);
      if (/in use/.test(hotkey)) {
        console.log('  SKIP  hotkey press: another Olive or app holds Ctrl+Alt+M');
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
      await copy.call(() => { setMonitor(false); return closeSettings(); });
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
        const at = raw.lastIndexOf('olive.settings.v1');
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

// ---- The update check, against made-up GitHub replies ----
async function updateChecks() {
  console.log('\nUpdate check');
  const { isNewer, checkForUpdate } = require(path.join(ROOT, 'src', 'main', 'updates.js'));
  const url = 'https://github.com/Zaytoonic/olive/releases/tag/v1.7.0';
  const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  check('versions compare as numbers', isNewer('v1.10.0', '1.9.0') && !isNewer('1.6.0', '1.6.0') && !isNewer('1.5.9', '1.6.0') && !isNewer('nonsense', '1.6.0'), '1.10 is newer than 1.9');
  const found = await checkForUpdate('1.6.0', reply(200, { tag_name: 'v1.7.0', html_url: url }));
  check('a newer release is reported', found.status === 'available' && found.version === '1.7.0' && found.url === url, `${found.status} ${found.version}`);
  check('the same version is not', (await checkForUpdate('1.7.0', reply(200, { tag_name: 'v1.7.0', html_url: url }))).status === 'current', 'current');
  check('a release link off the repo is refused', (await checkForUpdate('1.6.0', reply(200, { tag_name: 'v1.7.0', html_url: 'https://example.com/x' }))).status === 'unavailable', 'unavailable');
  const failures = await Promise.all([reply(404, {}), reply(500, {}), async () => { throw new Error('offline'); }].map(f => checkForUpdate('1.6.0', f)));
  check('failures give a reason instead of crashing', failures.every(r => r.status === 'unavailable' && r.reason), failures.map(r => r.reason).join(' / '));

  console.log('\nOne-click update download');
  const { downloadInstaller } = require(path.join(ROOT, 'src', 'main', 'updates.js'));
  const data = crypto.randomBytes(400000), sha = crypto.createHash('sha256').update(data).digest('hex');
  const asset = { name: 'Olive-Setup-1.7.0.exe', size: data.length, digest: 'sha256:' + sha, browser_download_url: 'https://github.com/Zaytoonic/Olive/releases/download/v1.7.0/Olive-Setup-1.7.0.exe' };
  const withAssets = assets => checkForUpdate('1.6.0', reply(200, { tag_name: 'v1.7.0', html_url: url, assets }));
  const offered = (await withAssets([{ ...asset, name: 'Olive-Setup-1.6.9.exe' }, asset])).installer;
  check("the release's installer is found, with its size and checksum", offered && offered.size === data.length && offered.sha256 === sha && offered.url === asset.browser_download_url, offered ? `${offered.name}, ${offered.size} bytes` : 'none');
  const refused = await Promise.all([
    withAssets([{ ...asset, digest: undefined }]), withAssets([{ ...asset, browser_download_url: 'https://example.com/Olive-Setup-1.7.0.exe' }]),
    withAssets([{ ...asset, name: 'Olive-Setup-1.6.9.exe' }]), withAssets(undefined)
  ]);
  check('no checksum, off the repo, another version or none: nothing to install', refused.every(r => r.status === 'available' && r.installer === null), 'only the release page is offered');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-update-test-')), dest = path.join(folder, asset.name);
  const serve = (body, status = 200) => async () => new Response(body, { status });
  const attempt = body => downloadInstaller(offered, typeof body === 'function' ? body : serve(body), dest).then(() => null, err => err.message);
  try {
    const progress = [];
    await downloadInstaller(offered, serve(data), dest, p => progress.push(p));
    check('a download that matches is kept', fs.readFileSync(dest).equals(data) && progress[progress.length - 1] === 1 && !fs.existsSync(dest + '.part'), `${progress.length} progress updates, file in place`);
    fs.rmSync(dest);
    const tampered = Buffer.from(data); tampered[12345] ^= 1;
    const bad = await attempt(tampered);
    check("a download that doesn't match the checksum is thrown away", /doesn't match/.test(bad) && !fs.existsSync(dest) && !fs.existsSync(dest + '.part'), bad);
    const others = [await attempt(data.subarray(0, 1000)), await attempt(Buffer.concat([data, Buffer.from('x')])), await attempt(serve('', 404)), await attempt(async () => { throw new Error('offline'); })];
    check('short, oversized and failed downloads are refused', /cut short/.test(others[0]) && /bigger/.test(others[1]) && /404/.test(others[2]) && /offline/.test(others[3]) && !fs.existsSync(dest), others.join(' / '));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

// ---- From the old name: real saved settings in an old folder, opened by a real copy of the app under the new one ----
async function renameChecks(dir, wav) {
  console.log('\nMoving from the old name');
  const { migrateSettings, moveLoginEntry, repairLoginEntry, reg, RUN, APPROVED } = require(path.join(ROOT, 'src', 'main', 'migrate.js'));
  const root = path.join(dir, 'appdata'), oldDir = path.join(root, 'mic-manager'), newDir = path.join(root, 'olive');
  fs.mkdirSync(root);
  check('nothing to move on a fresh install', migrateSettings(oldDir, path.join(dir, 'fresh')) === 'none', 'no old folder, nothing copied');

  let copy = new Copy(oldDir, wav, ['--hidden']);
  try {
    await copy.connect();
    await copy.call(pageReady);
    await copy.call(() => {
      state.compAmount = 37; eq.b.bass.g = -7; state.eqOpen = true; sendWanted = false;
      savePrefs();
      localStorage.setItem(OLD_PREFS_KEY, localStorage.getItem(PREFS_KEY));
      localStorage.removeItem(PREFS_KEY);
    });
    const onDisk = () => {
      try {
        const folder = path.join(oldDir, 'Local Storage', 'leveldb');
        return fs.readdirSync(folder).filter(f => f.endsWith('.log')).some(f => fs.readFileSync(path.join(folder, f)).toString('latin1').includes('micManager.settings.v1'));
      } catch { return false; }
    };
    for (let i = 0; i < 180 && !onDisk(); i++) await sleep(500);
  } finally { copy.stop(); }
  await sleep(2000);
  // The copy is killed before Chromium writes this file, so give it a salt, shaped like the real one, to carry across.
  const SALT = '19A7FB1A00000000D43CE60F00000000';
  fs.writeFileSync(path.join(oldDir, 'Preferences'), JSON.stringify({ electron: { media: { device_id_salt: SALT } } }));

  copy = new Copy(newDir, wav, ['--hidden']);                 // the app itself finds the old folder beside its own and copies from it
  try {
    await copy.connect();
    await copy.call(pageReady);
    const got = await copy.call(() => ({ send: state.send, sendBox: $('sendToggle').checked, comp: state.compAmount, bass: eq.b.bass.g, eqOpen: state.eqOpen, oldKey: localStorage.getItem(OLD_PREFS_KEY) !== null, newKey: localStorage.getItem(PREFS_KEY) !== null }));
    check('settings and EQ come across', got.comp === 37 && got.bass === -7 && got.eqOpen === true, `compressor ${got.comp}, bass ${got.bass}, EQ open ${got.eqOpen}`);
    check('Send to Discord stays off after a restart', got.send === false && got.sendBox === false, `send: ${got.send}, switch: ${got.sendBox}`);
    check('they move to the new settings name', got.newKey && !got.oldKey, `new: ${got.newKey}, old: ${got.oldKey}`);
    const salt = d => { try { return JSON.parse(fs.readFileSync(path.join(d, 'Preferences'), 'utf8')).electron.media.device_id_salt; } catch { return null; } };
    check('saved mic IDs stay valid', salt(newDir) === SALT, `salt came across: ${salt(newDir) === SALT}`);
  } finally { copy.stop(); }
  await sleep(2000);
  check('the old folder is left alone', fs.existsSync(path.join(oldDir, 'Local Storage')), 'still there');
  check('existing settings are never overwritten', migrateSettings(oldDir, newDir) === 'exists', 'second run copies nothing');

  fs.writeFileSync(path.join(dir, 'a-file'), '');
  check('a failed copy is reported, not hidden', migrateSettings(oldDir, path.join(dir, 'a-file', 'olive')) === 'failed', 'returns failed');

  // The login entry, using a fake name and a path that doesn't exist, so the real entry is never touched.
  const fake = 'Olive test entry (safe to delete)';
  const exists = key => reg('query', key, '/v', fake) !== null;
  try {
    reg('add', RUN, '/v', fake, '/t', 'REG_SZ', '/d', '"C:\\does-not-exist.exe" --hidden', '/f');
    reg('add', APPROVED, '/v', fake, '/t', 'REG_BINARY', '/d', '030000000000000000000000', '/f');
    const refused = moveLoginEntry(() => false, fake);
    check('the old login entry stays if the new one fails', refused === 'failed' && exists(RUN), `${refused}, old entry there: ${exists(RUN)}`);
    let asked = null;
    const moved = moveLoginEntry(enabled => { asked = enabled; return true; }, fake);
    check('the login entry moves, and stays off if it was off', moved === 'moved-off' && asked === false && !exists(RUN) && !exists(APPROVED), `${moved}, old entry there: ${exists(RUN) || exists(APPROVED)}`);
    reg('add', RUN, '/v', fake, '/t', 'REG_SZ', '/d', '"C:\\does-not-exist.exe" --hidden', '/f');
    let repairedOn = null;
    check('a login entry pointing at nothing gets repaired', repairLoginEntry('C:\\new\\Olive.exe', e => { repairedOn = e; return true; }, fake) === 'repaired' && repairedOn === true, 'repaired');
    reg('add', RUN, '/v', fake, '/t', 'REG_SZ', '/d', `"${process.execPath}" --hidden`, '/f');
    check('a login entry for a copy that exists is left alone', repairLoginEntry('C:\\new\\Olive.exe', () => { throw new Error('should not run'); }, fake) === 'fine', 'fine');
    reg('delete', RUN, '/v', fake, '/f');
    check('no old login entry: nothing happens', moveLoginEntry(() => { throw new Error('should not run'); }, fake) === 'none', 'none');
  } finally {
    reg('delete', RUN, '/v', fake, '/f');
    reg('delete', APPROVED, '/v', fake, '/f');
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-audio-test-'));
  const fixture = makeFixture();
  const wav = path.join(dir, 'fixture.wav');
  writeWav(wav, fixture.samples);
  console.log(`Test signal: ${fixture.seconds} s, steady noise at ${NOISE_DB} dB, speech-like phrases at ${fixture.voiceLevels.join(', ')} dB`);
  try {
    if (wanted('app')) await helperChecks();
    if (wanted('nr')) { voiceChecks(); offlineChecks(); }
    if (wanted('gate')) gateChecks(fixture);
    await liveChecks(path.join(dir, 'profile'), wav, fixture);
    if (wanted('app')) { await renameChecks(dir, wav); await updateChecks(); }
  } catch (err) {
    check('test run finished', false, err.message);
  }
  await sleep(1500);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {}
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
