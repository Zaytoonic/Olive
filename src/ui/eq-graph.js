// The EQ graph is the control: drag a point (left/right = frequency, up/down = gain), Ctrl + scroll to change width,
// double-click to reset, keys 1-6 to pick a band. Drawn on a canvas, outside React, so dragging never re-renders the page.
import { EQ_BANDS, EQ_F_MIN, EQ_F_MAX, EQ_G_MAX, EQ_RANGE, EQ_Q_MIN, EQ_Q_MAX, eq, bandDef, resetBand } from './eq-model.js';

const GRAPH = { gridZero: '#4a4944', grid: '#2e2d29', vertical: '#252421', label: '#9c9a91', fill: 'rgba(107,127,58,0.22)', curve: '#9AAF5E', ring: '#fff' };
const PAD = { l: 34, r: 10, t: 12, b: 20 };
const N = 240;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// api: { sel() -> key|null, select(key|null), edited(), editEnd() }
export function mountEqGraph(c, api) {
  let w = 0, h = 0, queued = false, disp = null, freqs = null, mag = null, ph = null, drag = null;
  const x = f => PAD.l + Math.log(f / EQ_F_MIN) / Math.log(EQ_F_MAX / EQ_F_MIN) * (w - PAD.l - PAD.r);
  const fOf = px => EQ_F_MIN * Math.pow(EQ_F_MAX / EQ_F_MIN, (px - PAD.l) / (w - PAD.l - PAD.r));
  const y = g => PAD.t + (1 - (Math.max(-EQ_RANGE, Math.min(EQ_RANGE, g)) + EQ_RANGE) / (2 * EQ_RANGE)) * (h - PAD.t - PAD.b);
  const gOf = py => (1 - (py - PAD.t) / (h - PAD.t - PAD.b)) * 2 * EQ_RANGE - EQ_RANGE;
  const point = key => { const s = eq.b[key]; return { x: x(s.f), y: y(s.g) }; };
  const bandAt = (px, py, radius = 16) => {
    let best = null, bd = radius;
    for (const d of EQ_BANDS) { const p = point(d.key); const dist = Math.hypot(p.x - px, p.y - py); if (dist <= bd) { bd = dist; best = d.key; } }
    return best;
  };
  // Exact filter responses, from an offline copy of the filters.
  const filters = () => {
    if (disp === null) {
      try { const o = new OfflineAudioContext(1, 128, 48000); disp = { hp: o.createBiquadFilter(), bands: EQ_BANDS.map(() => o.createBiquadFilter()) }; }
      catch { disp = false; }
    }
    return disp;
  };

  function draw() {
    const ctx = c.getContext('2d'), dpr = devicePixelRatio || 1;
    w = c.clientWidth; h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const d = filters(), sel = api.sel();
    if (!freqs) { freqs = new Float32Array(N); mag = new Float32Array(N); ph = new Float32Array(N); }
    const x0 = PAD.l, x1 = w - PAD.r;
    for (let i = 0; i < N; i++) freqs[i] = fOf(x0 + (x1 - x0) * i / (N - 1));

    ctx.lineWidth = 1; ctx.font = "11px system-ui, 'Segoe UI', sans-serif"; ctx.textBaseline = 'middle';
    for (const g of [-12, -6, 0, 6, 12]) {
      const py = Math.round(y(g)) + 0.5;
      ctx.strokeStyle = g === 0 ? GRAPH.gridZero : GRAPH.grid;
      ctx.beginPath(); ctx.moveTo(x0, py); ctx.lineTo(x1, py); ctx.stroke();
      ctx.fillStyle = GRAPH.label; ctx.textAlign = 'right'; ctx.fillText((g > 0 ? '+' : '') + g, x0 - 6, py);
    }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    for (const [f, t] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
      const px = Math.round(x(f)) + 0.5;
      ctx.strokeStyle = GRAPH.vertical; ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, h - PAD.b); ctx.stroke();
      ctx.fillStyle = GRAPH.label; ctx.fillText(t, px, h - 5);
    }
    if (!d) return;

    const setF = (f, type, freq, gain, q) => { f.type = type; f.frequency.value = freq; f.gain.value = gain; f.Q.value = q; };
    const total = new Float32Array(N);
    const add = (f, into) => { f.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < N; i++) into[i] += 20 * Math.log10(Math.max(mag[i], 1e-6)); };
    setF(d.hp, eq.on && eq.lowCut ? 'highpass' : 'lowshelf', 80, 0, 0.7);
    add(d.hp, total);
    let selCurve = null;
    EQ_BANDS.forEach((b, i) => {
      const s = eq.b[b.key];
      setF(d.bands[i], b.type, s.f, eq.on ? s.g : 0, s.q);
      add(d.bands[i], total);
      if (b.key === sel) { selCurve = new Float32Array(N); add(d.bands[i], selCurve); }
    });
    const path = arr => { ctx.beginPath(); for (let i = 0; i < N; i++) { const px = x0 + (x1 - x0) * i / (N - 1), py = y(arr[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } };
    const y0 = y(0);
    if (selCurve) {
      const b = bandDef(sel);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';            // how far this band can move
      ctx.fillRect(x(b.min), PAD.t, x(b.max) - x(b.min), h - PAD.t - PAD.b);
      path(selCurve); ctx.lineTo(x1, y0); ctx.lineTo(x0, y0); ctx.closePath();
      ctx.globalAlpha = 0.22; ctx.fillStyle = b.color; ctx.fill(); ctx.globalAlpha = 1;
    }
    path(total); ctx.lineTo(x1, y0); ctx.lineTo(x0, y0); ctx.closePath();
    ctx.fillStyle = GRAPH.fill; ctx.fill();
    path(total); ctx.strokeStyle = GRAPH.curve; ctx.lineWidth = 2; ctx.stroke();

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = "600 11px system-ui, 'Segoe UI', sans-serif";
    EQ_BANDS.forEach((b, i) => {
      const p = point(b.key);
      if (b.key === sel) { ctx.beginPath(); ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); ctx.strokeStyle = GRAPH.ring; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.beginPath(); ctx.arc(p.x, p.y, 8.5, 0, Math.PI * 2); ctx.fillStyle = b.color; ctx.fill();
      ctx.fillStyle = '#000'; ctx.fillText(String(i + 1), p.x, p.y + 0.5);
    });
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  }

  const local = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const setFromPoint = (key, px, py) => {
    const s = eq.b[key], d = bandDef(key);
    s.f = clamp(fOf(px), d.min, d.max);
    let g = clamp(gOf(py), -EQ_G_MAX, EQ_G_MAX);
    if (Math.abs(g) < 0.3) g = 0;                         // easy to land exactly on 0 dB
    s.g = Math.round(g * 10) / 10;
  };
  const on = {
    pointerdown: e => {
      if (e.button !== 0) return;
      const p = local(e), key = bandAt(p.x, p.y);
      if (!key) { api.select(null); return; }
      api.select(key);
      const pt = point(key);
      drag = { key, dx: pt.x - p.x, dy: pt.y - p.y };     // keep the grab offset so the point doesn't jump
      c.setPointerCapture(e.pointerId);
      c.classList.add('grabbing');
      e.preventDefault();
    },
    pointermove: e => {
      const p = local(e);
      if (!drag) { c.classList.toggle('grab', !!bandAt(p.x, p.y)); return; }
      setFromPoint(drag.key, p.x + drag.dx, p.y + drag.dy);
      api.edited();
    },
    pointerup: e => end(e), pointercancel: e => end(e),
    dblclick: e => {
      const p = local(e), key = bandAt(p.x, p.y);
      if (key) { resetBand(key); api.select(key); api.edited(); api.editEnd(); }
    },
    // Width needs Ctrl: a plain wheel must keep scrolling the page, or passing over the graph quietly changes your EQ.
    wheel: e => {
      if (!e.ctrlKey) return;
      e.preventDefault();                                 // and Ctrl + scroll here never zooms the page
      const p = local(e), key = bandAt(p.x, p.y, 40) || api.sel();
      if (!key || bandDef(key).type !== 'peaking') return;
      const s = eq.b[key];
      s.q = Math.round(clamp(s.q * Math.exp(-e.deltaY * 0.0015), EQ_Q_MIN, EQ_Q_MAX) * 100) / 100;
      if (api.sel() !== key) api.select(key);
      api.edited(); api.editEnd();
    },
    keydown: e => {
      const sel = api.sel();
      if (/^[1-6]$/.test(e.key)) { api.select(EQ_BANDS[+e.key - 1].key); e.preventDefault(); return; }
      if (e.key === 'Escape') { api.select(null); return; }
      if (!sel) { if (e.key.startsWith('Arrow')) { api.select(EQ_BANDS[0].key); e.preventDefault(); } return; }
      const s = eq.b[sel], fine = e.shiftKey, band = bandDef(sel);
      let handled = true;
      if (e.key === 'ArrowUp') s.g = clamp(Math.round((s.g + (fine ? 0.1 : 0.5)) * 10) / 10, -EQ_G_MAX, EQ_G_MAX);
      else if (e.key === 'ArrowDown') s.g = clamp(Math.round((s.g - (fine ? 0.1 : 0.5)) * 10) / 10, -EQ_G_MAX, EQ_G_MAX);
      else if (e.key === 'ArrowRight') s.f = clamp(s.f * (fine ? 1.01 : 1.06), band.min, band.max);
      else if (e.key === 'ArrowLeft') s.f = clamp(s.f / (fine ? 1.01 : 1.06), band.min, band.max);
      else if ((e.key === '+' || e.key === '=' || e.key === ']') && band.type === 'peaking') s.q = clamp(Math.round(s.q * 1.15 * 100) / 100, EQ_Q_MIN, EQ_Q_MAX);
      else if ((e.key === '-' || e.key === '[') && band.type === 'peaking') s.q = clamp(Math.round(s.q / 1.15 * 100) / 100, EQ_Q_MIN, EQ_Q_MAX);
      else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === '0') resetBand(sel);
      else handled = false;
      if (handled) { e.preventDefault(); api.edited(); api.editEnd(); }
    }
  };
  function end(e) {
    if (!drag) return;
    drag = null; c.classList.remove('grabbing');
    if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    api.editEnd();
  }
  for (const [ev, fn] of Object.entries(on)) c.addEventListener(ev, fn, ev === 'wheel' ? { passive: false } : undefined);
  // The canvas changes size without the window doing so (a scrollbar appearing), so watch it directly.
  const ro = new ResizeObserver(schedule);
  ro.observe(c);
  window.addEventListener('resize', schedule);            // also catches display scale changes
  schedule();
  return {
    draw: schedule, point,
    destroy() { ro.disconnect(); window.removeEventListener('resize', schedule); for (const [ev, fn] of Object.entries(on)) c.removeEventListener(ev, fn); }
  };
}
