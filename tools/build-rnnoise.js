// Builds src/renderer/vendor/rnnoise.wasm from xiph's RNNoise source: node tools/build-rnnoise.js <rnnoise folder> <zig.exe>
// The folder is a checkout of https://github.com/xiph/rnnoise at tag v0.2 (14 April 2024) with its model unpacked
// (rnnoise_data-0b50c45.tar.gz from media.xiph.org, the version in its model_version file).
// Why v0.2 and not the latest: xiph's later weights (Aug 2024 - Jan 2025) treat a wider range of sounds as noise, laughs
// included, and cut parts of words; werman's noise-suppression-for-voice reverted them in v1.22 (Oct 2026) for that reason.
// v0.2's weights and its network code (the output layers read only the last GRU) belong together, so both come from the tag.
//
// Zig builds it as a WebAssembly reactor (a library: call _initialize, then the rnnoise_* functions) with SIMD on.
// The few WASI imports it asks for are only for stdio, which RNNoise never uses; voice-worklet.js stubs them.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');

const [src, zig] = process.argv.slice(2);
if (!src || !zig) { console.error('usage: node tools/build-rnnoise.js <rnnoise folder> <zig.exe>'); process.exit(1); }
const need = ['include/rnnoise.h', 'src/denoise.c', 'src/rnnoise_data.c', 'model_version'];
for (const f of need) if (!fs.existsSync(path.join(src, f))) { console.error(`${f} not found in ${src} (is the model unpacked?)`); process.exit(1); }

const out = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'rnnoise.wasm');
const sources = ['denoise.c', 'rnn.c', 'pitch.c', 'kiss_fft.c', 'celt_lpc.c', 'nnet.c', 'nnet_default.c', 'parse_lpcnet_weights.c', 'rnnoise_data.c', 'rnnoise_tables.c']
  .map(f => path.join(src, 'src', f));
const exportsList = ['rnnoise_create', 'rnnoise_destroy', 'rnnoise_process_frame', 'rnnoise_get_frame_size', 'malloc', 'free'];
execFileSync(zig, [
  'cc', '-target', 'wasm32-wasi', '-mexec-model=reactor', '-O3', '-msimd128', '-DNDEBUG', '-DDISABLE_DEBUG_FLOAT',   // as xiph's own build (configure.ac): 8-bit weights, not the float debug copies
  '-I', path.join(src, 'include'), '-I', path.join(src, 'src'), '-I', path.join(__dirname, 'rnnoise-shim'),   // os_support.h, missing from v0.2
  ...sources, ...exportsList.map(e => `-Wl,--export=${e}`), '-o', out
], { stdio: 'inherit' });

const wasm = fs.readFileSync(out), mod = new WebAssembly.Module(wasm);
const sha = crypto.createHash('sha256').update(wasm).digest('hex');
console.log(`Built ${out}: ${(wasm.length / 1e6).toFixed(2)} MB, sha256 ${sha}`);
console.log('imports:', WebAssembly.Module.imports(mod).map(i => `${i.module}.${i.name}`).join(', ') || 'none');
console.log('exports:', WebAssembly.Module.exports(mod).map(e => e.name).join(', '));
console.log(`source: ${execFileSync('git', ['-C', src, 'log', '-1', '--format=%H %cs'], { encoding: 'utf8' }).trim()}, model ${fs.readFileSync(path.join(src, 'model_version'), 'utf8').trim()}`);
