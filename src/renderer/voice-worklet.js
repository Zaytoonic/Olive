// Voice cleanup on the audio thread (AudioWorklet): RNNoise, a small neural network trained on speech and noise.
// One processor does both jobs below, because the network's voice detection and its cleaned audio arrive together.
// - Noise: the network cleans each 10 ms frame. Strength (0-100) blends the cleaned audio with the raw mic, time-aligned:
//   0 is the raw mic untouched, 100 is fully cleaned, and the raw part falls 0.3 dB per percent in between.
// - Gate: opens on detected voice instead of volume, so a fan gust isn't mistaken for a word. It stays open HOLD_MS after
//   the last voice, and because the network's audio lags its detection by a frame, it is already open when a word starts.
// RNNoise only works at 48 kHz, and needs samples scaled to 16-bit range. At other rates audio passes through unchanged.
//
// The network is vendor/rnnoise.wasm: xiph's RNNoise at commit 70f1d256 (Feb 2025) with its official model 0a8755f8,
// compiled by @shiguredo/rnnoise-wasm 2025.1.5. That package's own loader can't run in an AudioWorklet, so the page
// compiles the wasm and passes it in processorOptions.wasm, and startRnnoise below starts it. It asks for only these imports.
function startRnnoise(module) {
  let memory = null;
  const { exports } = new WebAssembly.Instance(module, {
    env: {
      __assert_fail: () => { throw new Error('RNNoise assertion failed'); },
      emscripten_resize_heap: size => {
        const pages = Math.ceil(((size >>> 0) - memory.buffer.byteLength) / 65536);
        try { memory.grow(pages); return 1; } catch { return 0; }
      }
    },
    wasi_snapshot_preview1: {
      fd_write: (fd, iov, count, written) => {         // RNNoise doesn't print; this only reports the bytes as taken
        const u32 = new Uint32Array(memory.buffer);
        let n = 0;
        for (let i = 0; i < count; i++) n += u32[(iov >>> 2) + i * 2 + 1];
        u32[written >>> 2] = n;
        return 0;
      }
    }
  });
  memory = exports.memory;
  exports.emscripten_stack_init();
  exports.__wasm_call_ctors();
  if (exports.rnnoise_get_frame_size() !== FRAME) throw new Error('unexpected RNNoise frame size');
  return {
    create: () => exports.rnnoise_create(0),           // 0: the built-in model
    malloc: bytes => exports.malloc(bytes),
    process: (net, out, inp) => exports.rnnoise_process_frame(net, out, inp),
    heap: () => new Float32Array(memory.buffer)        // made again each time: growing the memory detaches the old view
  };
}

const FRAME = 480;
const SCALE = 32768;
const NET_DELAY = 960;                 // the network's own delay, on top of collecting a frame (measured by correlation)
const DRY_DELAY = FRAME + NET_DELAY;
// The network's voice probability that opens the gate. This model sometimes scores noise near 0.5 (the old one never
// did), and each such frame held the gate open for HOLD_MS; at 0.8 noise stays shut and every word start still opens it.
const VOICE_ON = 0.8;
const HOLD_MS = 300;
const RISE_MS = 2, FALL_MS = 80;

class ChannelState {
  constructor(rnn) {
    this.rnn = rnn;
    this.net = rnn.create();
    this.inPtr = rnn.malloc(FRAME * 4);
    this.outPtr = rnn.malloc(FRAME * 4);
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
    const heap = this.rnn.heap();
    for (let i = 0; i < FRAME; i++) heap[inIdx + i] = this.input[i] * SCALE;
    const voice = this.rnn.process(this.net, this.outPtr, this.inPtr);
    const out = this.rnn.heap();
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

  constructor(options) {
    super();
    // Throws if the wasm is missing or won't start; the page then sees a processor error and falls back.
    this.rnn = startRnnoise(options.processorOptions.wasm);
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
    while (this.channels.length < output.length) this.channels.push(new ChannelState(this.rnn));
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
