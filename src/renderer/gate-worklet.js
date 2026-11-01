// Noise gate on the audio thread (AudioWorklet), so it reacts within a sample instead of polling.
// - Detector: follows the loudest channel's peak level (0.5 ms rise, 10 ms fall).
// - Look-ahead: the audio is delayed 5 ms, so the gate is already open when a word starts.
// - Hold: stays open 150 ms after the level drops, so word endings and short pauses aren't cut.
// - Fades: opens in ~2 ms, closes over ~80 ms (no clicks).
// - Automatic threshold (auto = 1): the noise floor is the lowest level of the last 3 seconds (speech always
//   has short gaps, so this lands on the background), and the threshold sits 9 dB above it,
//   kept between -70 and -25 dBFS. Adapts to a new room within ~3 s and doesn't creep up while you talk.
// Threshold (dBFS, used when auto = 0) and auto are AudioParams; open/closed changes and the automatic
// threshold are posted to the page for the meter.

class NoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -45, minValue: -120, maxValue: 0, automationRate: 'k-rate' },
      { name: 'auto', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.look = Math.max(1, Math.round(sr * 0.005));
    this.rings = [];
    this.pos = 0;
    this.env = 0;
    this.gain = 0;
    this.hold = 0;
    this.holdSamples = Math.round(sr * 0.15);
    this.envUp = Math.exp(-1 / (sr * 0.0005));
    this.envDown = Math.exp(-1 / (sr * 0.010));
    this.gainUp = Math.exp(-1 / (sr * 0.002));
    this.gainDown = Math.exp(-1 / (sr * 0.080));
    this.open = false;
    this.floor = -60;                                  // learned noise floor (dBFS, peak envelope)
    this.autoThr = -51;
    this.slot = Math.round(sr * 0.1);                  // 100 ms slots, 30 of them = 3 s window
    this.mins = new Float32Array(30).fill(-60);
    this.slotMin = 0; this.slotFill = 0; this.slotIdx = 0;
    this.sinceReport = 0;
    this.port.postMessage({ open: false, threshold: this.autoThr });
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;
    const n = output[0].length;
    const auto = parameters.auto[0] >= 0.5;
    const thr = Math.pow(10, (auto ? this.autoThr : parameters.threshold[0]) / 20);
    let blockMax = 0;
    while (this.rings.length < output.length) this.rings.push(new Float32Array(this.look));
    const chans = input ? input.length : 0;
    let env = this.env, gain = this.gain, hold = this.hold, pos = this.pos;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < chans; c++) { const v = input[c][i]; const a = v < 0 ? -v : v; if (a > x) x = a; }
      env = x > env ? this.envUp * env + (1 - this.envUp) * x : this.envDown * env + (1 - this.envDown) * x;
      if (env > blockMax) blockMax = env;
      if (env >= thr) hold = this.holdSamples; else if (hold > 0) hold--;
      const target = hold > 0 ? 1 : 0;
      gain = target > gain ? this.gainUp * gain + (1 - this.gainUp) * target : this.gainDown * gain + (1 - this.gainDown) * target;
      for (let c = 0; c < output.length; c++) {
        const ring = this.rings[c];
        const src = chans ? (input[c] || input[0]) : null;
        const delayed = ring[pos];
        ring[pos] = src ? src[i] : 0;
        output[c][i] = delayed * gain;
      }
      pos = pos + 1 === this.look ? 0 : pos + 1;
    }
    this.env = env; this.gain = gain; this.hold = hold; this.pos = pos;
    // noise floor: lowest block level in the last 3 s (one minimum per 100 ms slot)
    const blockDb = 20 * Math.log10(blockMax + 1e-9);
    if (this.slotFill === 0 || blockDb < this.slotMin) this.slotMin = blockDb;
    this.slotFill += n;
    if (this.slotFill >= this.slot) {
      this.mins[this.slotIdx] = this.slotMin;
      this.slotIdx = (this.slotIdx + 1) % this.mins.length;
      this.slotFill = 0;
      let lo = Infinity; for (let i = 0; i < this.mins.length; i++) if (this.mins[i] < lo) lo = this.mins[i];
      this.floor = Math.min(-35, Math.max(-90, lo));
      this.autoThr = Math.min(-25, Math.max(-70, this.floor + 9));
    }
    const open = hold > 0;
    this.sinceReport += n;
    if (open !== this.open) { this.open = open; this.port.postMessage({ open, threshold: this.autoThr }); }
    else if (auto && this.sinceReport >= sampleRate / 4) { this.sinceReport = 0; this.port.postMessage({ open, threshold: this.autoThr }); }
    return true;
  }
}

registerProcessor('noise-gate', NoiseGate);
