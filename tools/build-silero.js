// Builds src/renderer/vendor/silero/silero_vad_16k.bin, the weights silero-vad.js runs, from Silero VAD's ONNX model:
// node tools/build-silero.js
// It downloads silero_vad.onnx (v6.3, MIT, github.com/snakers4/silero-vad at commit 57053ec, 20 Nov 2026), checks it
// against the checksum below, and writes the 16 kHz network's weights as little-endian float32 in the order silero-vad.js
// reads them. The model's STFT basis is left out: it is a Hann-windowed DFT, which silero-vad.js does by FFT.
// No npm packages: the ONNX file is read with the small protobuf reader below.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const COMMIT = '57053ec6ef95ab4704d380e3ff5b98c2f093586c';
const URL = `https://raw.githubusercontent.com/snakers4/silero-vad/${COMMIT}/src/silero_vad/data/silero_vad.onnx`;
const SHA256 = 'f6f4407b41e05e277e7f5cfd9b9ae957b1dfe763c6076a934734c0b448e09b31';
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'silero', 'silero_vad_16k.bin');
const WANT = [...[0, 1, 2, 3].flatMap(i => [`encoder.${i}.reparam_conv.weight`, `encoder.${i}.reparam_conv.bias`]),
  'decoder.rnn.weight_ih', 'decoder.rnn.weight_hh', 'decoder.rnn.bias_ih', 'decoder.rnn.bias_hh', 'decoder.decoder.2.weight', 'decoder.decoder.2.bias'];

// Protobuf: a message is a list of (field number, wire type, value); length-delimited values are sub-messages or bytes.
function fields(buf) {
  const out = []; let i = 0;
  const varint = () => { let v = 0n, s = 0n; for (;;) { const b = buf[i++]; v |= BigInt(b & 127) << s; if (b < 128) return v; s += 7n; } };
  while (i < buf.length) {
    const key = Number(varint()), no = key >> 3, wt = key & 7;
    if (wt === 0) out.push([no, varint()]);
    else if (wt === 2) { const n = Number(varint()); out.push([no, buf.subarray(i, i + n)]); i += n; }
    else if (wt === 1) { out.push([no, buf.subarray(i, i + 8)]); i += 8; }
    else if (wt === 5) { out.push([no, buf.subarray(i, i + 4)]); i += 4; }
    else throw new Error('unexpected protobuf wire type ' + wt);
  }
  return out;
}
const get = (msg, no) => msg.filter(f => f[0] === no).map(f => f[1]);
// ModelProto.graph = 7; GraphProto.node = 1, .initializer = 5; NodeProto.op_type = 4, .attribute = 5;
// AttributeProto.name = 1, .g = 6; TensorProto.dims = 1, .data_type = 2, .float_data = 4, .name = 8, .raw_data = 9.
function sixteenKBranch(model) {
  const graph = fields(get(fields(model), 7)[0]);
  for (const node of get(graph, 1).map(fields)) {
    if (Buffer.from(get(node, 4)[0] || []).toString() !== 'If') continue;
    for (const a of get(node, 5).map(fields)) if (Buffer.from(get(a, 1)[0]).toString() === 'then_branch') return fields(get(a, 6)[0]);
  }
  throw new Error("the model has no 16 kHz branch (If/then_branch): not the expected Silero VAD layout");
}

(async () => {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const model = Buffer.from(await res.arrayBuffer());
  const sha = crypto.createHash('sha256').update(model).digest('hex');
  if (sha !== SHA256) throw new Error(`silero_vad.onnx checksum ${sha} isn't the expected ${SHA256}`);
  const tensors = new Map();
  for (const t of get(sixteenKBranch(model), 5).map(fields)) {
    const name = Buffer.from(get(t, 8)[0]).toString(), type = Number(get(t, 2)[0]);
    const raw = get(t, 9)[0], packed = get(t, 4)[0];
    if (type === 1) tensors.set(name.replace(/^16k\//, ''), Buffer.from(raw || packed));
  }
  const parts = WANT.map(w => { const b = tensors.get(w); if (!b) throw new Error('missing weight ' + w); return b; });
  const out = Buffer.concat(parts);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log(`Built ${OUT}: ${(out.length / 1e6).toFixed(2)} MB, sha256 ${crypto.createHash('sha256').update(out).digest('hex')}`);
})().catch(err => { console.error('build-silero: ' + err.message); process.exit(1); });
