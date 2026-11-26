// Voice cleanup on the audio thread (AudioWorklet): DeepFilterNet3 cleans the voice, RNNoise and Silero listen for it.
// - Noise: DeepFilterNet3 (vendor/deepfilter, built by tools/build-deepfilter.js) is a 48 kHz network that cleans each
//   10 ms frame in two stages, gains per frequency band and then a filter below 5 kHz that rebuilds the voice's
//   harmonics. Strength sets its attenuation limit: nothing is turned down more than strength x 0.3 dB (100% = no limit),
//   so a laugh it takes for noise can only be ducked. At 0 (noise reduction off) it doesn't run: the raw mic passes, on time.
// - Gate: opens on detected voice, not volume, so a fan gust or a keyboard isn't taken for a word. Two detectors, which
//   only run while the gate is on: RNNoise (vendor/rnnoise.wasm, via rnnoise-start.js, every 10 ms) and Silero VAD
//   (silero-vad.js, every 32 ms). The gate opens when Silero is sure it's voice, or when RNNoise hears voice and Silero
//   doesn't rule it out. Silero alone ignores keys and clicks but loses a voice talking over typing; RNNoise alone keeps
//   that voice but opens on keystrokes. On a room recording (Nov 2026) typing alone held RNNoise's gate open 42% of the
//   time and clicks 29%; combined, 5% and 9%, and the voice over typing came through (by ear: it can't be measured
//   apart from the keys). Both are known before DeepFilterNet's output of the same audio (which lags 40 ms), so the
//   gate is open when a word starts, and it stays open HOLD_MS after the last voice.
// - Mono: the networks run once, on the channels' average, and every output channel gets the result.
// The networks need 48 kHz; at other rates audio passes through unchanged. The page compiles both wasm files and fetches
// the model, and passes them in processorOptions (a worklet can't fetch files itself).
import './dfn-polyfill.js';
import { initSync, df_create, df_process_frame, df_set_atten_lim, df_set_post_filter_beta } from './vendor/deepfilter/df.js';
import { startRnnoise } from './rnnoise-start.js';
import { startSilero } from './silero-vad.js';

const FRAME = 480;
const DELAY = 1920;                    // DeepFilterNet's 1440 samples (STFT and 2 frames of look-ahead) + collecting a frame
// RNNoise's voice probability that counts as voice: at 0.8 room noise stays shut and every word start still opens it.
const VOICE_ON = 0.8;
// Silero's: at SILERO_SURE it opens on its own (its own default threshold). Below SILERO_VETO it overrules RNNoise: on
// the room recording Silero gave keys 0.002 and clicks 0.05 (medians, where RNNoise heard voice), a voice over typing 0.14.
const SILERO_SURE = 0.5, SILERO_VETO = 0.1;
const HOLD_MS = 300;
const RISE_MS = 2, FALL_MS = 80;
const limitFor = strength => (strength >= 100 ? 100 : Math.max(0.5, strength * 0.3));   // below 0.01 dB it skips its STFT (and its delay)

class VoiceCleanup extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'strength', defaultValue: 100, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'gate', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }    // 1 = gate on detected voice
    ];
  }

  constructor(options) {
    super();
    // Throws if a wasm or the model is missing or won't start; the page then sees a processor error and falls back.
    const { wasm, model, rnnoise, silero } = options.processorOptions;
    this.supported = sampleRate === 48000;
    initSync({ module: wasm });
    this.df = df_create(new Uint8Array(model), 100);     // about 0.4 s, once
    df_set_post_filter_beta(this.df, 0);                 // the post-filter only adds suppression (measured: 0.6 dB more on room noise)
    this.rnnVoice = startRnnoise(rnnoise);
    this.sileroVoice = startSilero(silero);
    this.silero = 0;                                     // Silero's latest probability (it scores 32 ms at a time)
    this.limit = 100;
    this.input = new Float32Array(FRAME);
    this.cur = new Float32Array(FRAME);                  // the cleaned frame being played; starts as a frame of silence
    this.dry = new Float32Array(DELAY);                  // the raw mic, DELAY behind, for noise reduction off
    this.pos = 0; this.dryPos = 0;
    this.gain = 0; this.hold = 0; this.open = false;
    this.holdSamples = Math.round(sampleRate * HOLD_MS / 1000);
    this.gainUp = Math.exp(-1 / (sampleRate * RISE_MS / 1000));
    this.gainDown = Math.exp(-1 / (sampleRate * FALL_MS / 1000));
    this.port.postMessage({ supported: this.supported, open: false });
    // A processor that returns true keeps running even once nothing is connected to it; the engine sends 'stop' when it takes one out.
    this.port.onmessage = e => { if (e.data === 'stop') this.stopped = true; };
  }

  process(inputs, outputs, parameters) {
    if (this.stopped) return false;
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;
    const src = input && input.length ? input : null, chans = src ? src.length : 0;
    if (!this.supported) {
      for (let c = 0; c < output.length; c++) if (src) output[c].set(src[c] || src[0]);
      return true;
    }
    const strength = parameters.strength[0], gateOn = parameters.gate[0] >= 0.5, off = strength <= 0;
    if (!off) { const lim = limitFor(strength); if (lim !== this.limit) { this.limit = lim; df_set_atten_lim(this.df, lim); } }
    const n = output[0].length, up = this.gainUp, down = this.gainDown, nch = output.length;
    let gain = this.gain, hold = this.hold, pos = this.pos, d = this.dryPos;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < chans; c++) x += src[c][i];
      if (chans > 1) x /= chans;
      this.input[pos] = x;
      const dry = this.dry[d]; this.dry[d] = x; if (++d === DELAY) d = 0;
      const y = off ? dry : this.cur[pos];
      if (++pos === FRAME) {
        pos = 0;
        if (gateOn) {
          const s = this.sileroVoice(this.input); if (s >= 0) this.silero = s;
          const r = this.rnnVoice(this.input);
          if (this.silero >= SILERO_SURE || (r >= VOICE_ON && this.silero >= SILERO_VETO)) hold = this.holdSamples;
        }
        if (!off) this.cur = df_process_frame(this.df, this.input);
      }
      if (hold > 0) hold--;
      const target = !gateOn || hold > 0 ? 1 : 0;
      gain = target > gain ? up * gain + (1 - up) * target : down * gain + (1 - down) * target;
      const out = y * gain;
      for (let c = 0; c < nch; c++) output[c][i] = out;
    }
    this.gain = gain; this.hold = hold; this.pos = pos; this.dryPos = d;
    const open = !gateOn || hold > 0;
    if (open !== this.open) { this.open = open; this.port.postMessage({ open }); }
    return true;
  }
}

registerProcessor('voice-cleanup', VoiceCleanup);
