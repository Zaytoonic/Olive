// npm run test:gate-live: compares the voice gate's rules on your real voice, live. Nothing is recorded: the page keeps only
// two numbers per 10 ms frame (the network's voice probability and the frame's level), and this script prints a summary.
// - A copy of Olive from this source, in its own profile (%LOCALAPPDATA%\olive-livecheck), with --mute-audio and Send to
//   Discord forced off (checked before it starts), so Discord and your speakers hear nothing from it.
// - It uses the mic your Olive uses (read from its settings, never written).
// - Its window shows what to do: stay quiet, talk normally, stay quiet. About 2 minutes.
// Both rules run on the same frames, so the only difference between them is the rule:
//   Olive's rule: open while the voice probability is 0.8 or more (held 300 ms)
//   hold variant: open at 0.8, then stay open while it's 0.5 or more (tried 2026-11-11 and not adopted: on a real voice it
//   kept 0.8% more speech and was open twice as often in quiet). Change keep below to try another variant.
const { spawn, execFileSync } = require('child_process'), fs = require('fs'), path = require('path');

const root = path.join(__dirname, '..', '..');
const exe = require(path.join(root, 'node_modules', 'electron'));
const profile = path.join(process.env.LOCALAPPDATA || path.join(root, 'dist'), 'olive-livecheck');
const PORT = 9362, KEY = 'olive.settings.v1', sleep = ms => new Promise(r => setTimeout(r, ms));
const SAFE = { send: false, muteHotkey: false, ptt: false, badge: false, updateAuto: false, setupDone: true };
const fake = process.argv.includes('--fake');              // a dry run on Chromium's fake mic, to check this script itself
const PHASES = [                                           // [name, seconds, what the window says]
  ['ready', 6, 'Get ready. Next: stay quiet'],
  ['quiet', 15, 'Stay quiet. Desk sounds are fine'],
  ['talk', 75, 'Talk normally, the way you do on Discord'],
  ['quiet2', 15, 'Stay quiet again'],
];

function realSettings() {                                   // as tools/preview.js: the newest saved settings in your Olive's profile
  try {
    const dir = path.join(process.env.APPDATA, 'olive', 'Local Storage', 'leveldb');
    const files = fs.readdirSync(dir).filter(f => /\.(log|ldb)$/.test(f)).map(f => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    let best = null;
    for (const f of files) {
      const raw = fs.readFileSync(f).toString('latin1');
      for (let i = raw.indexOf(KEY); i >= 0; i = raw.indexOf(KEY, i + 1)) {
        const s = raw.indexOf('{', i);
        if (s < 0 || s - i > 40) continue;
        let depth = 0, e = -1;
        for (let k = s; k < raw.length; k++) { if (raw[k] === '{') depth++; else if (raw[k] === '}' && !--depth) { e = k; break; } }
        if (e > 0) try { best = JSON.parse(raw.slice(s, e + 1)); } catch { /* a half-written record */ }
      }
    }
    return best;
  } catch { return null; }
}

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
        let id = 0; const pending = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
        const call = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const run = async expression => {
          const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
          if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text);
          return r.result && r.result.result ? r.result.result.value : undefined;
        };
        return { ws, call, run };
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("the check's window didn't open");
}
const kill = pid => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } };

// Runs in the page: a second, silent copy of the voice worklet on the same mic, reporting each frame's numbers.
const probe = phases => `(async () => {
  const st = olive.state, v = olive.getView();
  if (st.send || v.sendOn) throw new Error('Send to Discord is on in the copy, so the check stopped');
  if (!st.deviceId) throw new Error('the copy has no mic');
  let src = await (await fetch('app://local/voice-worklet.js')).text();
  const swap = (a, b) => { if (src.split(a).length !== 2) throw new Error('voice-worklet.js changed: ' + a); src = src.replace(a, b); };
  swap('ch.input[ch.filled++] = x;', 'ch.input[ch.filled++] = x; if (c === 0) this.ss = (this.ss || 0) + x * x;');
  swap('this.frameVoice = voice;', 'this.frameVoice = voice; this.port.postMessage([voice, Math.sqrt((this.ss || 0) / FRAME)]); this.ss = 0;');
  swap("registerProcessor('voice-cleanup'", "registerProcessor('voice-probe'");
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const wasm = await WebAssembly.compile(await (await fetch('app://local/rnnoise.wasm')).arrayBuffer());
  const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: st.deviceId }, noiseSuppression: false, echoCancellation: false, autoGainControl: false } });
  const node = new AudioWorkletNode(ctx, 'voice-probe', { processorOptions: { wasm }, parameterData: { strength: 100, gate: 1 } });
  const sink = ctx.createGain(); sink.gain.value = 0;
  ctx.createMediaStreamSource(s).connect(node); node.connect(sink); sink.connect(ctx.destination);
  await ctx.resume();
  const phases = ${JSON.stringify(phases)}, frames = [];
  let phase = 0, left = phases[0][1];
  node.port.onmessage = e => { if (Array.isArray(e.data)) frames.push([phase, +e.data[0].toFixed(3), +e.data[1].toExponential(3)]); };
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(12,12,10,.94);color:#f5f4f0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font:600 28px system-ui;text-align:center;padding:24px';
  const say = document.createElement('div'), count = document.createElement('div'), note = document.createElement('div');
  count.style.cssText = 'font-size:64px;font-variant-numeric:tabular-nums;color:#a3b86c';
  note.style.cssText = 'font:400 15px system-ui;opacity:.7;max-width:520px';
  note.textContent = 'Olive gate check · ' + s.getAudioTracks()[0].label + ' · nothing is recorded, only levels · Discord hears nothing from this window';
  box.append(say, count, note); document.body.append(box);
  const draw = () => { say.textContent = phases[phase][2]; count.textContent = Math.ceil(left); };
  draw();
  window.__gate = { frames, done: false, mic: s.getAudioTracks()[0].label };
  const t0 = performance.now(); let at = 0;
  const tick = setInterval(() => {
    const el = (performance.now() - t0) / 1000;
    while (phase < phases.length && el >= at + phases[phase][1]) { at += phases[phase][1]; phase++; }
    if (phase >= phases.length) {
      clearInterval(tick); node.port.onmessage = null; s.getTracks().forEach(t => t.stop()); ctx.close();
      say.textContent = 'Done, thank you. This window closes by itself.'; count.textContent = '✓';
      window.__gate.done = true; return;
    }
    left = at + phases[phase][1] - el; draw();
  }, 200);
  return window.__gate.mic;
})()`;

// Both rules, frame by frame (10 ms frames; 300 ms hold = 30 frames).
function gate(frames, keep) {
  let hold = 0;
  return frames.map(([, v]) => { if (v >= (hold > 0 ? keep : 0.8)) hold = 30; const open = hold > 0; if (hold > 0) hold--; return open; });
}
const dB = r => 20 * Math.log10(Math.max(r, 1e-9));
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : -120; };

function report(frames, mic) {
  const idx = name => PHASES.findIndex(p => p[0] === name);
  const rules = { old: gate(frames, 0.8), new: gate(frames, 0.5) };
  const quiet = frames.filter(f => f[0] === idx('quiet')).map(f => dB(f[2]));
  const floor = median(quiet), loud = floor + 12;
  const talkAt = frames.map((f, i) => f[0] === idx('talk') ? i : -1).filter(i => i >= 0);
  const voiced = talkAt.filter(i => dB(frames[i][2]) > loud);
  const early = voiced.filter(i => i - talkAt[0] < 3000), late = voiced.filter(i => i - talkAt[0] >= 3000);
  const lines = [`Mic: ${mic}`, `Frames: ${frames.length} (10 ms each). Room noise ${floor.toFixed(1)} dB; speech counted above ${loud.toFixed(1)} dB.`];
  const band = list => { const v = list.map(i => frames[i][1]); return `voice score >=0.8: ${pct(v.filter(x => x >= 0.8).length, v.length)}, 0.5-0.8: ${pct(v.filter(x => x >= 0.5 && x < 0.8).length, v.length)}, below 0.5: ${pct(v.filter(x => x < 0.5).length, v.length)}`; };
  lines.push(`While talking, first 30 s: ${band(early)}`, `While talking, after 30 s: ${band(late)}`, '');
  for (const [name, open] of Object.entries(rules)) {
    const kept = list => pct(list.filter(i => open[i]).length, list.length);
    let cuts = 0;                                          // closed while you were still talking: speech in the next 300 ms
    for (const i of talkAt) if (open[i - 1] && !open[i]) { let n = 0; for (let k = i; k < i + 30 && k < frames.length; k++) if (dB(frames[k][2]) > loud) n++; if (n >= 10) cuts++; }
    const shut = ph => { const at = frames.map((f, i) => f[0] === idx(ph) ? i : -1).filter(i => i >= 0); return pct(at.filter(i => open[i]).length, at.length); };
    lines.push(`${name === 'old' ? "Olive's rule (0.8)       " : 'Hold variant (keep 0.5)  '}  speech kept: ${kept(voiced)} (first 30 s ${kept(early)}, after ${kept(late)})  ·  cut mid-speech: ${cuts}x  ·  open in quiet: ${shut('quiet')} before, ${shut('quiet2')} after`);
  }
  return lines.join('\n');
}

(async () => {
  if (!fs.existsSync(path.join(root, 'src', 'renderer', 'ui', 'olive.js'))) throw new Error('the window is not built: run npm run build:ui');
  const real = fake ? null : realSettings();
  if (!fake && !real) throw new Error("couldn't read your Olive's settings, so it can't tell which mic to use");
  const settings = { ...(real || {}), ...SAFE };
  const dir = fake ? fs.mkdtempSync(path.join(require('os').tmpdir(), 'olive-livecheck-')) : profile;
  fs.mkdirSync(dir, { recursive: true });
  const args = ['.', `--user-data-dir=${dir}`, '--mute-audio', `--remote-debugging-port=${PORT}`];
  if (fake) args.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--hidden');
  const app = spawn(exe, args, { cwd: root, stdio: 'ignore' });
  try {
    const p = await connect();
    await p.call('Page.enable');
    await p.call('Page.setBypassCSP', { enabled: true });  // only so this copy can load its probe; the app itself is unchanged
    await p.call('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(settings))}); } catch {}` });
    await p.call('Page.reload', { ignoreCache: true });
    await sleep(5000);
    const mic = await p.run(probe(PHASES));
    console.log(`Running on ${mic}. Follow the window: quiet, talk, quiet (about 2 minutes).`);
    const total = PHASES.reduce((a, ph) => a + ph[1], 0);
    for (let i = 0; i < total + 30 && !(await p.run('window.__gate.done')); i++) await sleep(1000);
    const frames = await p.run('window.__gate.frames');
    await sleep(1500);
    p.ws.close();
    console.log('\n' + report(frames, mic));
  } finally {
    kill(app.pid);
    if (fake) { await sleep(1500); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still closing */ } }
  }
})().catch(err => { console.error('Gate check stopped: ' + err.message); process.exit(1); });
