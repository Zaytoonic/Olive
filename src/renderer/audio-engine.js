// The audio chain: mic capture, noise reduction, EQ, volume, gate, compressor, and the two ways out
// (Listen on your output, and the send chain on the virtual cable). It never touches the page, saved settings or Windows:
// the window tells it what you set with engine.set({...}) and reads levels and status back.
// Loaded before renderer.js. A different window (a React one, say) can drive it the same way.
const engine = (() => {
  // What the window has set. inputGain is the in-app volume (1 when Windows controls the mic level itself).
  // talking is false while muted or while the push-to-talk key is up; talkFade is how fast that change ramps.
  const cfg = {
    inputGain: 1, gateDb: -45, gateAuto: true, nr: true, nrAmount: 100, mono: false, comp: false, compAmount: 50,
    eq: null, eqBypass: false, monitor: false, monitorVol: 80, talking: true, talkFade: 0.02, send: false
  };
  let bands = [];                                // the EQ's bands: { key, type, freq, q }, in order
  let listener = () => {};
  const changed = () => { try { listener(); } catch (err) { console.error(err); } };
  const ampToDb = a => (a <= 0 ? -Infinity : 20 * Math.log10(a));

  let audioCtx = null, mainChain = null;          // main chain (meter + Listen) on audioCtx
  let stream = null, srcNode = null, srcLinked = false, capturing = false, capturedId = null, captureToken = 0;
  let sendCtx = null, sendChain = null, sendSrc = null, sendCableId = null, sendToken = 0;   // send chain -> virtual cable
  let autoGateDb = -51;
  let micTest = null, testPlaying = false;

  function rampTo(param, value, tc = 0.02, ctx = audioCtx) {
    if (!param || !ctx) return;
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(value, ctx.currentTime, tc);
  }
  // All live processing chains: the main one and, when sending, the one feeding the cable.
  const chains = () => [mainChain, sendChain].filter(Boolean);
  // One running engine is enough unless you're listening: while sending, the send chain also drives the meter,
  // and the main chain sleeps (its engine used half the app's CPU just to feed a meter).
  const mainNeeded = () => cfg.monitor || !sendChain;
  const meterChain = () => (mainNeeded() ? mainChain : sendChain);
  function syncChains() {
    if (!audioCtx || !mainChain) return;
    const need = mainNeeded();
    if (need && audioCtx.state === 'suspended') audioCtx.resume();
    if (srcNode && need && !srcLinked) { srcNode.connect(mainChain.head); srcLinked = true; }
    if (srcNode && !need && srcLinked) { try { srcNode.disconnect(mainChain.head); } catch {} srcLinked = false; }
    if (!need && audioCtx.state === 'running' && !testPlaying) audioCtx.suspend();   // a mic test plays back on this context
    syncGateTimer();
  }

  // ---- Building a chain ----
  function init(bandDefs) {
    bands = bandDefs.map(b => ({ key: b.key, type: b.type, freq: b.freq, q: b.q }));
    try {
      audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      mainChain = buildChain(audioCtx);   // its analyser (~21 ms per reading) also drives the level meter
      // After setSinkId, 30 s of pure silence slows this context's clock to about 72%. A signal far too quiet to hear (-140 dB) keeps it at full speed.
      const keepClock = audioCtx.createConstantSource();
      keepClock.offset.value = 1e-7;
      keepClock.connect(audioCtx.destination);
      keepClock.start();
    } catch (err) { audioCtx = null; mainChain = null; console.error('Audio engine unavailable:', err); }
    return !!mainChain;
  }
  // One processing chain: noise reduction -> [mono] EQ -> volume -> gate -> output level -> this context's output device.
  function buildChain(ctx) {
    const hp = ctx.createBiquadFilter(); hp.type = 'lowshelf'; hp.frequency.value = 80; hp.gain.value = 0; hp.Q.value = 0.7;
    const filters = bands.map(b => { const f = ctx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.freq; f.Q.value = b.q; return f; });
    [hp, ...filters].reduce((a, b) => (a.connect(b), b));
    const head = ctx.createGain();                // the mic connects here; noise reduction is inserted after it
    const rawMeter = ctx.createAnalyser();        // the mic before any processing: what the Input level meter shows
    rawMeter.fftSize = 1024;
    head.connect(rawMeter);
    head.connect(hp);
    const output = filters[filters.length - 1];
    const volGain = ctx.createGain(), gateGain = ctx.createGain(), outGain = ctx.createGain();
    volGain.gain.value = cfg.inputGain;
    gateGain.gain.value = 0;                      // opens on the first loud reading of this chain's own audio
    outGain.gain.value = 0;
    outGain.channelCount = 2; outGain.channelCountMode = 'explicit';  // always stereo out: mono plays in both ears
    outGain.channelInterpretation = 'speakers';
    const comp = ctx.createDynamicsCompressor();
    output.connect(volGain); gateGain.connect(outGain); outGain.connect(ctx.destination);
    // Each chain measures its own audio for the noise gate: the send engine hears the mic a little later
    // than the main one, so a gate driven by the other engine's audio would clip the starts/ends of words.
    const meter = ctx.createAnalyser();
    meter.fftSize = 1024;
    output.connect(meter);
    const outMeter = ctx.createAnalyser();        // what actually leaves this chain, after gate, compressor and mute
    outMeter.fftSize = 1024;
    outGain.connect(outMeter);
    const ch = { ctx, head, rawMeter, hp, bands: filters, input: hp, output, volGain, comp, compOn: null, gateGain, outGain,
                 meter, meterBuf: new Float32Array(meter.fftSize), outMeter, gateIsOpen: false, holdUntil: 0 };
    applyCompTo(ch);
    applyMonoTo(ch);
    applyEqTo(ch);
    attachGate(ch);
    attachVoice(ch);
    return ch;
  }

  // ---- Settings ----
  // Mono: the first EQ node downmixes to 1 channel ((L+R)/2), which then plays in both ears.
  function applyMonoTo(ch) {
    ch.input.channelCount = 1;
    ch.input.channelCountMode = cfg.mono ? 'explicit' : 'max';
    ch.input.channelInterpretation = 'speakers';
    if (ch.voice) {                                // mono: the voice engine runs its network once, not per channel
      ch.voice.channelCount = cfg.mono ? 1 : 2;
      ch.voice.channelCountMode = cfg.mono ? 'explicit' : 'max';
      ch.voice.channelInterpretation = 'speakers';
    }
  }
  // Compressor strength 0-100% sets threshold -12..-40 dB and ratio 2:1..8:1; its built-in makeup gain
  // brings quiet speech back up. Off = the compressor is taken out of the signal path entirely.
  function applyCompTo(ch) {
    const a = cfg.compAmount / 100, c = ch.comp;
    c.threshold.value = -12 - 28 * a; c.ratio.value = 2 + 6 * a; c.knee.value = 10;
    c.attack.value = 0.005; c.release.value = 0.25;
    if (ch.compOn === cfg.comp) return;
    routeChain(ch);
    ch.compOn = cfg.comp;
  }
  // volume -> gate -> [compressor] -> gateGain. The gate goes first: the compressor lifts noise by about 14 dB,
  // which left the gate open on noise alone (62% of the time, measured). Without the worklet, gateGain is the gate.
  function routeChain(ch) {
    const levelGate = ch.voice && cfg.gateAuto ? null : ch.gate;    // on Auto, the voice engine does the gating
    const path = [ch.volGain, levelGate, cfg.comp && ch.comp, ch.gateGain].filter(Boolean);
    for (const node of [ch.volGain, ch.gate, ch.comp]) if (node) { try { node.disconnect(); } catch {} }
    path.reduce((a, b) => (a.connect(b), b));
  }
  function applyEqTo(ch) {
    const eq = cfg.eq;
    if (!eq) return;
    const on = eq.on && !(cfg.eqBypass && ch === mainChain);    // comparing only changes what you hear, not what's sent
    bands.forEach((d, i) => {
      const s = eq.b[d.key], f = ch.bands[i];
      rampTo(f.frequency, s.f, 0.012, ch.ctx);            // short glide: no clicks while dragging
      rampTo(f.gain, on ? s.g : 0, 0.012, ch.ctx);
      rampTo(f.Q, s.q, 0.012, ch.ctx);
    });
    // Low cut on: 80 Hz high-pass. Off: a 0 dB shelf, which passes audio unchanged.
    const cut = on && eq.lowCut;
    ch.hp.type = cut ? 'highpass' : 'lowshelf';
    ch.hp.frequency.value = 80;
    ch.hp.gain.value = 0;
  }
  const nrStrengthNow = () => (cfg.nr ? cfg.nrAmount : 0);
  function applyNr() {
    for (const ch of chains()) if (ch.nr) ch.nr.parameters.get('strength').setValueAtTime(nrStrengthNow(), ch.ctx.currentTime);
  }
  function applyGate() {
    for (const ch of chains()) {
      if (ch.gate) {
        ch.gate.parameters.get('threshold').setValueAtTime(cfg.gateDb, ch.ctx.currentTime);
        ch.gate.parameters.get('auto').setValueAtTime(cfg.gateAuto ? 1 : 0, ch.ctx.currentTime);
      }
      if (ch.voice) { ch.voice.parameters.get('gate').setValueAtTime(cfg.gateAuto ? 1 : 0, ch.ctx.currentTime); routeChain(ch); }
    }
  }
  // Listen goes quiet while a mic test plays back, so you hear only the recording.
  function updateMonitorGain() {
    if (mainChain) rampTo(mainChain.outGain.gain, cfg.monitor && cfg.talking && !testPlaying ? cfg.monitorVol / 100 : 0, cfg.talkFade, mainChain.ctx);
  }
  function updateSendGain() {
    if (sendChain) rampTo(sendChain.outGain.gain, cfg.send && cfg.talking ? 1 : 0, cfg.talkFade, sendCtx);
  }
  // Takes any of the cfg fields above and applies only what they affect. eq is { on, lowCut, b: { key: { f, g, q } } };
  // pass it again after changing it.
  function set(p) {
    Object.assign(cfg, p);
    const has = k => k in p;
    if (has('inputGain')) chains().forEach(ch => rampTo(ch.volGain.gain, cfg.inputGain, 0.02, ch.ctx));
    if (has('mono')) chains().forEach(applyMonoTo);
    if (has('comp') || has('compAmount')) chains().forEach(applyCompTo);
    if (has('nr') || has('nrAmount')) applyNr();
    if (has('gateDb') || has('gateAuto')) applyGate();
    if (has('eq') || has('eqBypass')) chains().forEach(applyEqTo);
    if (has('monitor')) syncChains();
    if (has('monitor') || has('monitorVol') || has('talking') || has('talkFade')) updateMonitorGain();
    if (has('send') || has('talking') || has('talkFade')) updateSendGain();
  }

  // ---- Levels ----
  function chainAmplitude(ch, meter = ch.meter) {
    const b = ch.meterBuf;
    meter.getFloatTimeDomainData(b);
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
    return Math.sqrt(sum / b.length) * 1.41;                   // RMS -> roughly peak-scaled
  }
  const rawAmplitude = (ch = meterChain()) => chainAmplitude(ch, ch.rawMeter);
  // What actually leaves for the cable, or null when nothing is being sent.
  function sendAmplitude() {
    if (!sendChain) return null;
    return chainAmplitude(sendChain, sendChain.outMeter);
  }
  function compReduction() {
    const mc = mainChain && meterChain();
    return mc && typeof mc.comp.reduction === 'number' ? mc.comp.reduction : 0;
  }
  function status() {
    const all = chains();
    return {
      gateFailed: all.some(ch => ch.gateFailed), voiceFailed: all.some(ch => ch.voiceFailed), nrFailed: all.some(ch => ch.nrFailed),
      voiceGate: !!(mainChain && mainChain.voice)       // a voice gate has no volume threshold
    };
  }

  // ---- Noise gate ----
  // Preferred: gate-worklet.js on the audio thread (sample-accurate, 5 ms look-ahead, 150 ms hold).
  // Fallback if it can't load: a gate run every 20 ms from this thread (can clip word starts).
  const GATE_WORKLET_URL = 'app://local/gate-worklet.js', NR_WORKLET_URL = 'app://local/nr-worklet.js', VOICE_WORKLET_URL = 'app://local/voice-worklet.js';
  const RNNOISE_WASM_URL = 'app://local/rnnoise.wasm';
  const gateModules = new WeakMap(), nrModules = new WeakMap();
  function loadGateModule(ctx) {
    if (!gateModules.has(ctx)) gateModules.set(ctx, ctx.audioWorklet.addModule(GATE_WORKLET_URL));
    return gateModules.get(ctx);
  }
  async function attachGate(ch) {
    try {
      if (!ch.ctx.audioWorklet) throw new Error('AudioWorklet not supported');
      await loadGateModule(ch.ctx);
      if (ch.ctx.state === 'closed') return;
      const node = new AudioWorkletNode(ch.ctx, 'noise-gate', { numberOfInputs: 1, numberOfOutputs: 1, parameterData: { threshold: cfg.gateDb, auto: cfg.gateAuto ? 1 : 0 } });
      node.port.onmessage = e => {
        const d = e.data || {};
        if (ch.voice && cfg.gateAuto) return;       // the voice engine reports open/closed instead
        ch.gateIsOpen = !!d.open;
        if (ch === meterChain() && typeof d.threshold === 'number') autoGateDb = d.threshold;   // learned on the running chain
      };
      node.onprocessorerror = () => detachGate(ch);
      ch.gate = node;
      routeChain(ch);
      rampTo(ch.gateGain.gain, 1, 0.003, ch.ctx);  // gateGain is no longer the gate
      syncGateTimer();
    } catch (err) {
      console.warn('Audio-thread noise gate unavailable, using the fallback:', err && err.message);
      ch.gateFailed = true;
      syncGateTimer();
      changed();
    }
  }
  function detachGate(ch) {                         // worklet crashed: fall back to the main-thread gate
    const node = ch.gate; if (!node) return;
    ch.gate = null;
    ch.gateFailed = true;
    try { node.disconnect(); } catch {}
    routeChain(ch);
    ch.gateIsOpen = !ch.gateIsOpen; gateChain(ch, 0, performance.now());
    syncGateTimer();
    changed();
  }
  // Fallback automatic threshold (same rule as the worklet): noise floor = the lowest 100 ms peak of the last 6 s,
  // threshold = floor + 9 dB, kept between -70 and -25 dBFS.
  const floorMins = new Array(60).fill(-60);
  let floorSlotPeak = -Infinity, floorSlotT = 0, floorIdx = 0;
  function trackFloor(amp, dt) {
    const d = ampToDb(amp);
    const lvl = isFinite(d) ? d : -120;
    if (lvl > floorSlotPeak) floorSlotPeak = lvl;
    floorSlotT += dt;
    if (floorSlotT >= 0.1) {
      floorMins[floorIdx] = floorSlotPeak; floorIdx = (floorIdx + 1) % floorMins.length;
      floorSlotPeak = -Infinity; floorSlotT = 0;
      const floor = Math.min(-35, Math.max(-90, Math.min(...floorMins)));
      autoGateDb = Math.min(-25, Math.max(-70, floor + 9));
    }
  }
  // Fallback noise gate for one chain, from that chain's own audio. Opens at once; stays open 150 ms after you
  // go quiet (hold) so word endings aren't cut, then fades out.
  const GATE_HOLD_MS = 150;
  function gateChain(ch, amp, now) {
    if (ch === meterChain()) trackFloor(amp * cfg.inputGain, 0.02);
    const loud = ampToDb(amp * cfg.inputGain) >= (cfg.gateAuto ? autoGateDb : cfg.gateDb);
    if (loud) ch.holdUntil = now + GATE_HOLD_MS;
    const open = loud || now < ch.holdUntil;
    if (open !== ch.gateIsOpen) {
      ch.gateIsOpen = open;
      rampTo(ch.gateGain.gain, open ? 1 : 0, open ? 0.003 : 0.05, ch.ctx);
    }
    return open;
  }
  // The fallback gate runs every 20 ms, only while a chain needs it, whether or not the window is showing.
  let gateTimer = null;
  function syncGateTimer() {
    const need = capturing && chains().some(ch => !ch.gate);
    if (need && !gateTimer) gateTimer = setInterval(runFallbackGates, 20);
    else if (!need && gateTimer) { clearInterval(gateTimer); gateTimer = null; }
  }
  function runFallbackGates() {
    const now = performance.now(), mc = meterChain();
    if (mc && !mc.gate) gateChain(mc, chainAmplitude(mc), now);
    if (sendChain && !sendChain.gate && mc !== sendChain) gateChain(sendChain, sendSrc ? chainAmplitude(sendChain) : 0, now);
  }

  // ---- Voice cleanup ----
  // voice-worklet.js: RNNoise plus a gate that opens on detected voice. If it can't run, nr-worklet.js and the volume gate remain.
  // The network (vendor/rnnoise.wasm) is compiled once here and handed to each worklet, which can't fetch files itself.
  let rnnoiseWasm = null;
  function loadRnnoise() {
    if (!rnnoiseWasm) {
      rnnoiseWasm = fetch(RNNOISE_WASM_URL)
        .then(r => { if (!r.ok) throw new Error('rnnoise.wasm: ' + r.status); return r.arrayBuffer(); })
        .then(bytes => WebAssembly.compile(bytes));
      rnnoiseWasm.catch(() => { rnnoiseWasm = null; });    // try again next time instead of keeping the failure
    }
    return rnnoiseWasm;
  }
  async function attachVoice(ch) {
    try {
      if (ch.ctx.sampleRate !== 48000) throw new Error('needs 48 kHz, got ' + ch.ctx.sampleRate);
      const [wasm] = await Promise.all([loadRnnoise(), ch.ctx.audioWorklet.addModule(VOICE_WORKLET_URL)]);
      if (ch.ctx.state === 'closed') return;
      const node = new AudioWorkletNode(ch.ctx, 'voice-cleanup', { numberOfInputs: 1, numberOfOutputs: 1, processorOptions: { wasm }, parameterData: { strength: nrStrengthNow(), gate: cfg.gateAuto ? 1 : 0 } });
      node.port.onmessage = e => { if (cfg.gateAuto && typeof (e.data || {}).open === 'boolean') ch.gateIsOpen = e.data.open; };
      node.onprocessorerror = () => { console.warn('Voice cleanup crashed; using the older noise reduction'); detachNr(ch); ch.voice = null; ch.voiceFailed = true; routeChain(ch); attachNr(ch); changed(); };
      ch.nr = node; ch.voice = node;
      applyMonoTo(ch);
      connectHead(ch, node);
      node.connect(ch.hp);
      routeChain(ch);
      changed();
    } catch (err) {
      console.warn('Voice cleanup unavailable, using the older noise reduction:', err && err.message);
      ch.voiceFailed = true;
      attachNr(ch);
      changed();
    }
  }
  // ---- Fallback noise reduction ----
  // nr-worklet.js on the raw mic, if the voice engine can't run. Strength never rebuilds anything, so moving the slider doesn't interrupt the audio.
  async function attachNr(ch) {
    try {
      if (!ch.ctx.audioWorklet) throw new Error('AudioWorklet not supported');
      if (!nrModules.has(ch.ctx)) nrModules.set(ch.ctx, ch.ctx.audioWorklet.addModule(NR_WORKLET_URL));
      await nrModules.get(ch.ctx);
      if (ch.ctx.state === 'closed') return;
      const node = new AudioWorkletNode(ch.ctx, 'noise-reduction', { numberOfInputs: 1, numberOfOutputs: 1, parameterData: { strength: nrStrengthNow() } });
      node.onprocessorerror = () => { detachNr(ch); ch.nrFailed = true; changed(); };
      ch.nr = node;
      connectHead(ch, node);
      node.connect(ch.hp);
    } catch (err) {
      ch.nrFailed = true;
      changed();
      console.warn('Noise reduction unavailable:', err && err.message);
    }
  }
  function detachNr(ch) {
    const node = ch.nr; if (!node) return;
    ch.nr = null;
    try { node.disconnect(); } catch {}
    connectHead(ch, ch.hp);
  }
  function connectHead(ch, next) {
    ch.head.disconnect();
    ch.head.connect(ch.rawMeter);
    ch.head.connect(next);
  }

  // ---- Capture ----
  function stopCapture() {
    if (stream) stream.getTracks().forEach(tr => tr.stop());
    if (srcNode) { try { srcNode.disconnect(); } catch {} }
    if (sendSrc) { try { sendSrc.disconnect(); } catch {} }
    stream = null; srcNode = null; sendSrc = null; capturing = false; capturedId = null; srcLinked = false;
    syncGateTimer();
    changed();
  }
  // Opens a mic raw and feeds it to every chain. Resolves true once it's running, false if another capture started meanwhile;
  // throws the browser's error (NotAllowedError, NotReadableError…) if the mic couldn't be opened.
  async function capture(deviceId) {
    const token = ++captureToken;
    stopCapture();
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          noiseSuppression: false, echoCancellation: false, autoGainControl: false   // raw mic: Olive does its own noise reduction
        }
      });
      if (token !== captureToken) { s.getTracks().forEach(tr => tr.stop()); return false; }
      stream = s;
      capturedId = deviceId;
      if (!audioCtx || !mainChain) throw Object.assign(new Error('No audio engine'), { name: 'AudioEngineError' });
      if (mainNeeded() && audioCtx.state === 'suspended') await audioCtx.resume();
      srcNode = audioCtx.createMediaStreamSource(stream);
      srcLinked = false;
      capturing = true;
      connectSendSource();
      syncChains();
      changed();
      return true;
    } catch (err) {
      if (token !== captureToken) return false;
      changed();
      throw err;
    }
  }
  const isCapturing = deviceId => !!stream && capturedId === deviceId && stream.getAudioTracks().every(tr => tr.readyState === 'live');

  // ---- Where Listen plays ----
  const setOutput = sink => (audioCtx ? audioCtx.setSinkId(sink) : Promise.resolve());

  // ---- Sending to the virtual cable ----
  // The send chain reads the mic directly (its own source node) so nothing sits between it and the cable.
  function connectSendSource() {
    if (sendSrc) { try { sendSrc.disconnect(); } catch {} sendSrc = null; }
    if (!sendChain || !stream) return;
    sendSrc = sendCtx.createMediaStreamSource(stream);
    sendSrc.connect(sendChain.head);
  }
  function teardownSend() {
    if (sendSrc) { try { sendSrc.disconnect(); } catch {} }
    if (sendCtx) sendCtx.close().catch(() => {});
    sendCtx = null; sendChain = null; sendSrc = null; sendCableId = null;
    syncChains();
  }
  function useSendContext(ctx, cableId = null) {
    sendCtx = ctx; sendCableId = cableId;
    sendChain = buildChain(ctx);
    connectSendSource();
    syncChains();
    updateSendGain();
  }
  const sendingTo = cableId => !!sendChain && sendCableId === cableId && sendCtx.state !== 'closed';
  // Builds a send chain playing on that output device. Resolves true when it's running, false if closeSend or another
  // openSend came first; throws if the device couldn't be used. What it sends follows set({ send }).
  async function openSend(cableId) {
    const token = ++sendToken;
    if (sendingTo(cableId)) return true;
    teardownSend();
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    try {
      await ctx.setSinkId(cableId);
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (err) { ctx.close().catch(() => {}); throw err; }
    if (token !== sendToken) { ctx.close().catch(() => {}); return false; }
    useSendContext(ctx, cableId);
    return true;
  }
  function closeSend() { ++sendToken; updateSendGain(); teardownSend(); }

  // ---- Mic test: record 5 s of what Olive sends, then play it back on your own output ----
  // Recorded after noise reduction, EQ, volume, gate and compressor, and before mute and push to talk: what Discord gets
  // while you talk. So it works while muted, with nobody else hearing it. report() hears each step:
  // { phase: 'recording', secondsLeft, first }, { phase: 'playing', silent, toCable }, { phase: 'ended', reason, silent, error }
  // with reason 'error' | 'short' | 'silent' | 'done' | 'stopped'.
  const TEST_SECONDS = 5, RECORDER_URL = 'app://local/recorder-worklet.js';
  const recorderModules = new WeakMap();
  async function startMicTest(report = () => {}) {
    const ch = capturing && meterChain();
    if (!ch || micTest) return false;
    const t = micTest = { ch, chunks: [], phase: 'starting', report };
    try {
      if (!recorderModules.has(ch.ctx)) recorderModules.set(ch.ctx, ch.ctx.audioWorklet.addModule(RECORDER_URL));
      await recorderModules.get(ch.ctx);
      t.rec = new AudioWorkletNode(ch.ctx, 'mic-recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
    } catch (err) {
      endTest(t, 'error', err);
      return false;
    }
    if (micTest !== t) return false;
    t.done = new Promise(resolve => { t.rec.port.onmessage = e => { if (e.data === 'done') resolve(); else t.chunks.push(e.data); }; });
    ch.gateGain.connect(t.rec);
    t.phase = 'recording';
    const ends = performance.now() + TEST_SECONDS * 1000;
    let first = true;
    const count = () => {
      if (t.phase !== 'recording') return;
      const left = ends - performance.now();
      if (left <= 0) { finishRecording(t); return; }
      t.report({ phase: 'recording', secondsLeft: Math.ceil(left / 1000), first });
      first = false;
      t.timer = setTimeout(count, left % 1000 || 1000);
    };
    count();
    return true;
  }
  async function finishRecording(t = micTest) {
    if (!t || t.phase !== 'recording') return;
    t.phase = 'stopping';
    clearTimeout(t.timer);
    t.rec.port.postMessage('stop');
    await Promise.race([t.done, new Promise(r => setTimeout(r, 1000))]);   // a chain that was switched off sends nothing more
    try { t.ch.gateGain.disconnect(t.rec); } catch {}
    if (micTest !== t) return;
    const rate = t.ch.ctx.sampleRate, frames = t.chunks.reduce((n, c) => n + c[0].length, 0);
    if (frames < rate * 0.3 || !audioCtx) { endTest(t, 'short'); return; }
    const channels = Math.max(...t.chunks.map(c => c.length)), buf = audioCtx.createBuffer(channels, frames, rate);
    let at = 0, peak = 0;
    for (const c of t.chunks) {
      for (let k = 0; k < channels; k++) buf.getChannelData(k).set(c[Math.min(k, c.length - 1)], at);
      for (const v of c[0]) { const a = Math.abs(v); if (a > peak) peak = a; }
      at += c[0].length;
    }
    t.chunks = null;
    t.seconds = frames / rate; t.peakDb = ampToDb(peak);
    t.silent = t.peakDb < -50;
    t.phase = 'playing';
    testPlaying = true;
    updateMonitorGain();
    try { if (audioCtx.state !== 'running') await audioCtx.resume(); } catch { /* plays when it can */ }
    if (micTest !== t) return;
    const src = t.src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);           // your output only: the cable is on a different context
    src.onended = () => endTest(t, t.silent ? 'silent' : 'done');
    src.start();
    t.report({ phase: 'playing', silent: t.silent, toCable: !!sendChain && cfg.send });
  }
  function endTest(t, reason, error) {
    if (micTest !== t) return;
    micTest = null;
    clearTimeout(t.timer);
    if (t.rec) { try { t.ch.gateGain.disconnect(t.rec); } catch {} t.rec.port.postMessage('stop'); }
    if (t.src) { t.src.onended = null; try { t.src.stop(); } catch {} try { t.src.disconnect(); } catch {} }
    testPlaying = false;
    updateMonitorGain();
    syncChains();
    t.report({ phase: 'ended', reason, silent: !!t.silent, error });
  }
  // Stops the test wherever it is: recording, playing or still starting.
  const endMicTest = () => { if (micTest) endTest(micTest, 'stopped'); };

  return {
    init, set, capture, stopCapture, isCapturing, setOutput, openSend, closeSend, sendingTo,
    startMicTest, finishRecording, endMicTest,
    rawAmplitude, chainAmplitude, sendAmplitude, compReduction, status, meterChain,
    gateOpen: () => capturing && !!meterChain() && meterChain().gateIsOpen,
    onChange(fn) { listener = fn; },
    get capturing() { return capturing; },
    get hasSend() { return !!sendChain; },
    get autoGateDb() { return autoGateDb; },
    get micTest() { return micTest; },
    // For the tests in tools/audio-test, which measure inside the chain.
    get audioCtx() { return audioCtx; }, get mainChain() { return mainChain; }, get sendChain() { return sendChain; },
    get stream() { return stream; }, get source() { return srcNode; }, get capturedId() { return capturedId; },
    useSendContext
  };
})();
window.engine = engine;   // the React window's bundle reads it from here (a top-level const isn't a window property)
