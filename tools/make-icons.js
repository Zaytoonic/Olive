// Draws every icon from code, so the small sizes are drawn for their size instead of being shrunk: npm run make-icons
// Outputs to assets/: olive-icon-1024.png, icon.png, icon.ico, tray icons and the muted variants. Needs nothing installed.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const OLIVE = [0x6b, 0x7f, 0x3a], RED = [0xd6, 0x2f, 0x28], WHITE = [255, 255, 255];
const SAMPLES = 8;                                       // each pixel is the average of 8 x 8 points

// ---- Shapes: each takes a point in 0..1 and says whether it's inside ----
const rotate = (x, y, cx, cy, deg) => {
  const a = deg * Math.PI / 180, dx = x - cx, dy = y - cy;
  return [dx * Math.cos(a) + dy * Math.sin(a), -dx * Math.sin(a) + dy * Math.cos(a)];
};
const roundedSquare = r => (x, y) => {
  const dx = Math.max(r - x, x - (1 - r), 0), dy = Math.max(r - y, y - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
};
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const ellipse = (cx, cy, rx, ry, deg) => (x, y) => {
  const [u, v] = rotate(x, y, cx, cy, deg);
  return (u / rx) ** 2 + (v / ry) ** 2 <= 1;
};
const leaf = (cx, cy, len, width, deg) => {             // two overlapping circles make a pointed leaf
  const r = (len * len / 4 + width * width / 4) / width, off = r - width / 2;
  return (x, y) => {
    const [u, v] = rotate(x, y, cx, cy, deg);
    return u * u + (v - off) ** 2 <= r * r && u * u + (v + off) ** 2 <= r * r;
  };
};
const bar = (x0, y0, x1, y1, w) => (x, y) => {          // a line with square-cut ends
  const dx = x1 - x0, dy = y1 - y0, t = ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy);
  if (t < 0 || t > 1) return false;
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= w / 2;
};

// ---- The mark, by pixel size. A leaf turns to mush below 32 px, so small sizes are a bigger olive with its pimento. ----
const TILT = -38;
function mark(size, bg, slashed) {
  const layers = [], cos = Math.cos(TILT * Math.PI / 180), sin = Math.sin(TILT * Math.PI / 180);
  if (slashed) {                                         // no pimento or leaf: the slash would leave fragments of them
    layers.push([ellipse(0.5, 0.5, 0.39, 0.285, TILT), WHITE]);
  } else if (size < 32) {
    layers.push([ellipse(0.5, 0.5, 0.39, 0.285, TILT), WHITE]);
    layers.push([circle(0.5 + 0.235 * cos, 0.5 + 0.235 * sin, Math.max(0.085, 1.25 / size)), bg]);
  } else {
    const cx = 0.47, cy = 0.56;
    layers.push([ellipse(cx, cy, 0.3, 0.215, TILT), WHITE]);
    layers.push([circle(cx + 0.185 * cos, cy + 0.185 * sin, 0.052), bg]);
    layers.push([leaf(0.655, 0.235, 0.27, 0.115, -8), WHITE]);
  }
  if (slashed) {                                         // a white line with a gap each side, so it stays visible on the white olive
    const w = Math.max(0.1, 1.7 / size), gap = Math.max(0.065, 1.05 / size), a = 0.12, b = 0.88;
    layers.push([bar(a, a, b, b, w + 2 * gap), bg]);
    layers.push([bar(a, a, b, b, w), WHITE]);
  }
  return layers;
}
const appIcon = size => [[roundedSquare(0.225), OLIVE], ...mark(size, OLIVE, false)];
const trayIcon = size => [[roundedSquare(0.2), OLIVE], ...mark(size, OLIVE, false)];
const trayMuted = size => [[roundedSquare(0.2), RED], ...mark(size, RED, true)];
const mutedBadge = size => [[circle(0.5, 0.5, 0.5), RED], ...mark(size, RED, true)];

// ---- Pixels and files ----
function render(size, layers) {
  const px = Buffer.alloc(size * size * 4), n = SAMPLES * SAMPLES;
  for (let py = 0; py < size; py++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SAMPLES) / size, v = (py + (sy + 0.5) / SAMPLES) / size;
          for (let l = layers.length - 1; l >= 0; l--) {
            if (layers[l][0](u, v)) { r += layers[l][1][0]; g += layers[l][1][1]; b += layers[l][1][2]; a++; break; }
          }
        }
      }
      const i = (py * size + x) * 4;
      if (a) { px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a); px[i + 3] = Math.round(a / n * 255); }
    }
  }
  return px;
}
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}
function png(width, height, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const pngOf = (size, draw) => png(size, size, render(size, draw(size)));
function ico(sizes, draw) {
  const images = sizes.map(s => pngOf(s, draw));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let at = head.length;
  sizes.forEach((s, i) => {
    const o = 6 + i * 16;
    head[o] = s === 256 ? 0 : s; head[o + 1] = s === 256 ? 0 : s;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(images[i].length, o + 8); head.writeUInt32LE(at, o + 12);
    at += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

if (require.main === module) {
  const write = (name, data) => fs.writeFileSync(path.join(ASSETS, name), data);
  write('olive-icon-1024.png', pngOf(1024, appIcon));
  write('icon.png', pngOf(256, appIcon));
  write('icon.ico', ico([16, 20, 24, 32, 40, 48, 64, 128, 256], appIcon));
  for (const [name, draw] of [['tray-icon', trayIcon], ['tray-icon-muted', trayMuted]]) {
    for (const [suffix, size] of [['', 16], ['@1.25x', 20], ['@1.5x', 24], ['@2x', 32]]) write(`${name}${suffix}.png`, pngOf(size, draw));
  }
  write('taskbar-muted-badge.png', pngOf(16, mutedBadge));
  write('taskbar-muted-badge@2x.png', pngOf(32, mutedBadge));
  console.log('Icons written to assets/');
}
module.exports = { render, png, appIcon, trayIcon, trayMuted, mutedBadge };
