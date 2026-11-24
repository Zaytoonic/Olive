// Builds src/renderer/vendor/deepfilter/ (DeepFilterNet3 for the "High quality" noise reduction trial):
//   node tools/build-deepfilter.js <DeepFilterNet folder> <cargo bin folder> <wasm-bindgen.exe>
// The folder is a checkout of https://github.com/chsotelo/DeepFilterNet branch pr/bump-tract-0.23 (commit 9b8790dc,
// upstream pull request #695: tract 0.21 -> 0.23, whose WebAssembly SIMD kernels make it about 20x faster in WASM).
// Rust with the wasm32-unknown-unknown target, and wasm-bindgen matching the version in its Cargo.lock (0.2.118).
//
// One change to the source, made here: libDF/src/wasm.rs uses the deep-filter CLI's thresholds (-15 / 35 / 35 dB)
// instead of default_with_ch's -10 / 30 / 20, which skip the DF stage on cleaner frames. In Olive's test those took
// 4.4 dB off speech; the CLI's values 0.2 dB (and the result 20.5 dB from the clean speech instead of 4.4).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');

const [src, cargoBin, bindgen] = process.argv.slice(2);
if (!src || !cargoBin || !bindgen) { console.error('usage: node tools/build-deepfilter.js <DeepFilterNet folder> <cargo bin folder> <wasm-bindgen.exe>'); process.exit(1); }
const wasmRs = path.join(src, 'libDF', 'src', 'wasm.rs');
let rs = fs.readFileSync(wasmRs, 'utf8');
const plain = 'let r_params = RuntimeParams::default_with_ch(channels).with_atten_lim(atten_lim);';
if (rs.includes(plain)) {
  rs = rs.replace(plain, 'let mut r_params = RuntimeParams::default_with_ch(channels).with_atten_lim(atten_lim);\n' +
    '        r_params.min_db_thresh = -15.;\n        r_params.max_db_erb_thresh = 35.;\n        r_params.max_db_df_thresh = 35.;');
  fs.writeFileSync(wasmRs, rs);
  console.log('wasm.rs: using the CLI thresholds');
} else if (!rs.includes('r_params.max_db_df_thresh = 35.')) { console.error('wasm.rs changed upstream; check the thresholds by hand'); process.exit(1); }

const env = { ...process.env, PATH: cargoBin + path.delimiter + process.env.PATH, RUSTFLAGS: '-C target-feature=+simd128' };
execFileSync(path.join(cargoBin, 'cargo'), ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'deep_filter', '--lib', '--no-default-features', '--features', 'wasm'], { cwd: src, env, stdio: 'inherit' });

const out = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'deepfilter');
fs.mkdirSync(out, { recursive: true });
execFileSync(bindgen, ['--target', 'web', '--no-typescript', '--remove-name-section', '--remove-producers-section', '--out-dir', out,
  path.join(src, 'target', 'wasm32-unknown-unknown', 'release', 'df.wasm')], { stdio: 'inherit' });
fs.copyFileSync(path.join(src, 'models', 'DeepFilterNet3_onnx.tar.gz'), path.join(out, 'DeepFilterNet3_onnx.tar.gz'));
const lic = ['LICENSE-MIT', 'LICENSE-APACHE'].map(f => `=============== DeepFilterNet: ${f} ===============\n\n` + fs.readFileSync(path.join(src, f), 'utf8')).join('\n\n');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex');
const commit = execFileSync('git', ['-C', src, 'log', '-1', '--format=%H %cs'], { encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(out, 'LICENSE.txt'),
  `DeepFilterNet3 WebAssembly build: vendor/deepfilter/ (df.js, df_bg.wasm, DeepFilterNet3_onnx.tar.gz)\n` +
  `Built by tools/build-deepfilter.js from https://github.com/chsotelo/DeepFilterNet (upstream pull request #695), ${commit},\n` +
  `with the deep-filter CLI's thresholds in libDF/src/wasm.rs. Code and model weights: MIT OR Apache-2.0.\n` +
  `sha256: df_bg.wasm ${sha('df_bg.wasm')}, DeepFilterNet3_onnx.tar.gz ${sha('DeepFilterNet3_onnx.tar.gz')}\n\n` + lic);
console.log(`Built ${out}: df_bg.wasm ${(fs.statSync(path.join(out, 'df_bg.wasm')).size / 1e6).toFixed(1)} MB; source ${commit}`);
