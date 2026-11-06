// For the mic test: collects what reaches it and hands it to the page in 100 ms blocks. It plays nothing.
// The page sends 'stop'; the last block follows, then a 'done' message.
const BLOCK = 4800;

class MicRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = null;
    this.filled = 0;
    this.stopping = false;
    this.port.onmessage = e => { if (e.data === 'stop') this.stopping = true; };
  }
  flush() {
    if (this.blocks && this.filled) this.port.postMessage(this.blocks.map(b => b.slice(0, this.filled)));
    this.blocks = null;
    this.filled = 0;
  }
  process(inputs) {
    if (this.stopping) { this.flush(); this.port.postMessage('done'); return false; }
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channels = Math.min(2, input.length);
    if (this.blocks && this.blocks.length !== channels) this.flush();
    if (!this.blocks) this.blocks = Array.from({ length: channels }, () => new Float32Array(BLOCK));
    const n = input[0].length;
    let from = 0;
    while (from < n) {
      const take = Math.min(n - from, BLOCK - this.filled);
      for (let c = 0; c < channels; c++) this.blocks[c].set(input[c].subarray(from, from + take), this.filled);
      this.filled += take;
      from += take;
      if (this.filled === BLOCK) this.flush(), this.blocks = Array.from({ length: channels }, () => new Float32Array(BLOCK));
    }
    return true;
  }
}

registerProcessor('mic-recorder', MicRecorder);
