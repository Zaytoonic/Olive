// Voice cleanup on the audio thread (AudioWorklet): RNNoise, a small neural network trained on speech and noise.
// One processor does both jobs below, because the network's voice detection and its cleaned audio arrive together.
// - Noise: the network cleans each 10 ms frame. Strength (0-100) blends the cleaned audio with the raw mic, time-aligned:
//   0 is the raw mic untouched, 100 is fully cleaned, and the raw part falls 0.3 dB per percent in between.
// - Gate: opens on detected voice instead of volume, so a fan gust isn't mistaken for a word. It stays open HOLD_MS after
//   the last voice, and because the network's audio lags its detection by a frame, it is already open when a word starts.
// RNNoise only works at 48 kHz, and needs samples scaled to 16-bit range. At other rates audio passes through unchanged.
import createRNNWasmModuleSync from 'app://local/rnnoise-sync.js';

const FRAME = 480;
const SCALE = 32768;
const NET_DELAY = 960;                 // the network's own delay, on top of collecting a frame (measured by correlation)
const DRY_DELAY = FRAME + NET_DELAY;
const VOICE_ON = 0.5;                  // network's voice probability that opens the gate
const HOLD_MS = 300;
const RISE_MS = 2, FALL_MS = 80;

const rnn = createRNNWasmModuleSync();

class ChannelState {
  constructor() {
    this.net = rnn._rnnoise_create(0);
    this.inPtr = rnn._malloc(FRAME * 4);
    this.outPtr = rnn._malloc(FRAME * 4);
    this.input = new Float32Array(FRAME);
    this.filled = 0;
    this.wet = new Float32Array(DRY_DELAY + FRAME);    // cleaned audio waiting to go out; starts with a frame of silence
    this.wetRead = 0; this.wetWrite = FRAME;
    this.dry = new Float32Array(DRY_DELAY);
    this.dryPos = 0;
  }

  // Runs the network on a full frame; returns its voice probability (0-1).
  run() {
    const inIdx = this.inPtr >> 2, outIdx = this.outPtr >> 2;
    const heap = rnn.HEAPF32;                          // read again each time: the wasm memory may have grown
    for (let i = 0; i < FRAME; i++) heap[inIdx + i] = this.input[i] * SCALE;
    const voice = rnn._rnnoise_process_frame(this.net, this.outPtr, this.inPtr);
    const out = rnn.HEAPF32;
    for (let i = 0; i < FRAME; i++) {
      this.wet[this.wetWrite] = out[outIdx + i] / SCALE;
      this.wetWrite = (this.wetWrite + 1) % this.wet.length;
    }
    this.filled = 0;
    return voice;
  }
}

class VoiceCleanup extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'strength', defaultValue: 0, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'gate', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }    // 1 = gate on detected voice
    ];
  }

  constructor() {
    super();
    this.supported = sampleRate === 48000;
    this.channels = [];
    this.gain = 0;
    this.hold = 0;
    this.holdSamples = Math.round(sampleRate * HOLD_MS / 1000);
    this.gainUp = Math.exp(-1 / (sampleRate * RISE_MS / 1000));
    this.gainDown = Math.exp(-1 / (sampleRate * FALL_MS / 1000));
    this.open = false;
    this.frameVoice = 0;
    this.port.postMessage({ supported: this.supported, open: false });
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;
    if (!this.supported) {
      for (let c = 0; c < output.length; c++) if (input && input[c]) output[c].set(input[c]);
      return true;
    }
    const strength = parameters.strength[0], gateOn = parameters.gate[0] >= 0.5;
    const dryGain = strength >= 100 ? 0 : Math.pow(10, -strength * 0.3 / 20);
    const wetGain = strength <= 0 ? 0 : 1 - dryGain;
    while (this.channels.length < output.length) this.channels.push(new ChannelState());
    const n = output[0].length;
    for (let i = 0; i < n; i++) {
      let voice = -1;
      for (let c = 0; c < output.length; c++) {
        const ch = this.channels[c], src = input && input.length ? (input[c] || input[0]) : null, x = src ? src[i] : 0;
        ch.input[ch.filled++] = x;
        if (ch.filled === FRAME) voice = Math.max(voice, ch.run());
      }
      if (voice >= 0) {
        this.frameVoice = voice;
        if (voice >= VOICE_ON) this.hold = this.holdSamples;
      }
      if (this.hold > 0) this.hold--;
      const target = !gateOn || this.hold > 0 ? 1 : 0;
      this.gain = target > this.gain ? this.gainUp * this.gain + (1 - this.gainUp) * target : this.gainDown * this.gain + (1 - this.gainDown) * target;
      for (let c = 0; c < output.length; c++) {
        const ch = this.channels[c], src = input && input.length ? (input[c] || input[0]) : null;
        const wet = ch.wet[ch.wetRead]; ch.wetRead = (ch.wetRead + 1) % ch.wet.length;
        const dry = ch.dry[ch.dryPos]; ch.dry[ch.dryPos] = src ? src[i] : 0; ch.dryPos = (ch.dryPos + 1) % DRY_DELAY;
        output[c][i] = (wet * wetGain + dry * dryGain) * this.gain;
      }
    }
    const open = !gateOn || this.hold > 0;
    if (open !== this.open) { this.open = open; this.port.postMessage({ open }); }
    return true;
  }
}

registerProcessor('voice-cleanup', VoiceCleanup);
