// For deepfilter-worklet.js: the AudioWorklet's global scope has no TextDecoder or crypto, and DeepFilterNet's
// wasm-bindgen glue (vendor/deepfilter/df.js) makes a TextDecoder when it loads and asks crypto for random bytes.
// Text is only decoded for error messages, and the random bytes only seed hash maps, so these simple versions are enough.
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class {
    decode(bytes) {
      if (!bytes) return '';
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      try { return decodeURIComponent(escape(s)); } catch { return s; }
    }
  };
}
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } };
}
