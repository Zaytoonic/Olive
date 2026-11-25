// Starts RNNoise (vendor/rnnoise.wasm) inside the voice worklet, where it only listens for voice: DeepFilterNet3 does the
// cleaning, RNNoise's voice probability drives the gate. The wasm is xiph's RNNoise at tag v0.2 (14 April 2024) with its
// model 0b50c45, built by tools/build-rnnoise.js as a reactor with no imports; anything it might still ask for (stdio) is
// answered with 0, since RNNoise never calls it.
export const RNN_FRAME = 480;
export const RNN_SCALE = 32768;                          // RNNoise wants samples in 16-bit range

export function startRnnoise(module) {
  const imports = {};
  for (const { module: m, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind === 'function') (imports[m] = imports[m] || {})[name] = () => 0;
  }
  const { exports } = new WebAssembly.Instance(module, imports);
  if (exports._initialize) exports._initialize();
  if (exports.rnnoise_get_frame_size() !== RNN_FRAME) throw new Error('unexpected RNNoise frame size');
  const net = exports.rnnoise_create(0);                 // 0: the built-in model
  const inPtr = exports.malloc(RNN_FRAME * 4), outPtr = exports.malloc(RNN_FRAME * 4);
  // The voice probability (0-1) of one 480-sample frame (floats in -1..1).
  return frame => {
    const heap = new Float32Array(exports.memory.buffer), at = inPtr >> 2;   // made again each time: growing memory detaches views
    for (let i = 0; i < RNN_FRAME; i++) heap[at + i] = frame[i] * RNN_SCALE;
    return exports.rnnoise_process_frame(net, outPtr, inPtr);
  };
}
