// Noise reduction on the audio thread with DeepFilterNet3 (the "High quality" trial; RNNoise in voice-worklet.js is the
// standard engine). A 48 kHz network that cleans each 10 ms frame in two stages: gains per frequency band, then a
// filter below 5 kHz that rebuilds the voice's harmonics. Offline on Olive's test speech it kept the voice much closer
// to the clean original than RNNoise (20.5 vs 11.9 dB from it) at about twice RNNoise's CPU (6.7% vs 3.4% of a core).
// - Strength sets DeepFilterNet's attenuation limit: nothing is turned down more than strength x 0.3 dB (100% = no limit),
//   so a laugh the network takes for noise can only be ducked, never erased.
// - It has no voice detector: the level gate (gate-worklet.js) does the gating after it.
// - Delay: the network's 30 ms plus collecting a 10 ms frame = 40 ms (RNNoise: 30 ms).
// The page compiles vendor/deepfilter/df_bg.wasm and fetches the model, and passes both in processorOptions.
import './dfn-polyfill.js';
import { initSync, df_create, df_process_frame, df_set_atten_lim, df_set_post_filter_beta } from './df.js';

const FRAME = 480;
const limitFor = strength => (strength >= 100 ? 100 : Math.max(0.5, strength * 0.3));   // below 0.01 dB it skips its STFT (and its delay)

class DeepFilterCleanup extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'strength', defaultValue: 100, minValue: 0, maxValue: 100, automationRate: 'k-rate' }];
  }

  constructor(options) {
    super();
    const { wasm, model } = options.processorOptions;
    initSync({ module: wasm });
    this.supported = sampleRate === 48000;
    this.st = df_create(new Uint8Array(model), 100);      // about 0.4 s, once
    df_set_post_filter_beta(this.st, 0);                 // the post-filter only adds suppression
    this.limit = 100;
    this.input = new Float32Array(FRAME);
    this.cur = new Float32Array(FRAME);                  // the cleaned frame being played; starts as a frame of silence
    this.pos = 0;
    this.port.postMessage({ supported: this.supported, ready: true });
    // A processor that returns true keeps running even once nothing is connected to it; the engine sends 'stop' when it takes one out.
    this.port.onmessage = e => { if (e.data === 'stop') this.stopped = true; };
  }

  process(inputs, outputs, parameters) {
    if (this.stopped) return false;
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;
    const src = input && input.length ? input : null;
    if (!this.supported) {
      for (let c = 0; c < output.length; c++) if (src) output[c].set(src[c] || src[0]);
      return true;
    }
    const lim = limitFor(parameters.strength[0]);
    if (lim !== this.limit) { this.limit = lim; df_set_atten_lim(this.st, lim); }
    const n = output[0].length, chans = src ? src.length : 0;
    for (let i = 0; i < n; i++) {
      let x = 0;                                         // mono: DeepFilterNet runs once, on the channels' average
      for (let c = 0; c < chans; c++) x += src[c][i];
      this.input[this.pos] = chans ? x / chans : 0;
      const y = this.cur[this.pos];
      for (let c = 0; c < output.length; c++) output[c][i] = y;
      if (++this.pos === FRAME) {
        this.cur = df_process_frame(this.st, this.input);
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('deepfilter-cleanup', DeepFilterCleanup);
