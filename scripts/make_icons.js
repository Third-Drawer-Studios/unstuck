#!/usr/bin/env node
// Generates the Unstuck PWA icons as PNGs with zero dependencies.
// Draws an amber line that loops once and runs straight out as an arrow — unstuck.
// Usage: node scripts/make_icons.js   (writes icons/*.png)

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ png out

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // One filter byte (0 = none) per scanline, then the row's RGBA bytes.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const dst = y * (size * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ drawing

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
const mixRGB = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
const over = (dst, src, a) => mixRGB(dst, src, clamp(a, 0, 1));

/** Antialiased coverage from a signed distance in pixels. */
const cover = (d) => clamp(0.5 - d, 0, 1);

const BG_TOP = [0x16, 0x1b, 0x26];
const BG_BOT = [0x0b, 0x0e, 0x13];
const GLOW = [0xf4, 0xa1, 0x3c];
const LINE_START = [0xe0, 0x84, 0x1c];
const LINE_END = [0xff, 0xc9, 0x7a];

/**
 * The motif as polylines in abstract units: one loop of a prolate cycloid (it
 * loops while it travels), a straight run, and an open arrowhead, tilted upward.
 * Returns the strokes, the stroke width, and how far along the line each point is.
 */
function motif() {
  const a = 3.1;      // travel per radian
  const b = 12;       // loop radius; b > a is what makes it loop
  const width = 6.5;
  const run = 30;     // straight run after the loop
  const head = width * 1.9;
  const tilt = -28 * (Math.PI / 180);

  const line = [];
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const t = Math.PI + (2 * Math.PI * i) / steps;
    line.push([a * t - b * Math.sin(t), -b * Math.cos(t)]);
  }
  const [ex, ey] = line[line.length - 1];
  const tip = [ex + run, ey];
  line.push(tip);
  const arrow = [[tip[0] - head, ey - head], tip, [tip[0] - head, ey + head]];

  const rot = ([x, y]) => [x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt)];
  return { strokes: [line.map(rot), arrow.map(rot)], width, along: rot([1, 0]) };
}

/** Distance from a point to segment ab. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Fits the motif to a canvas: centred on its bounding box, scaled so its widest
 * reach fills `reach` of the size. Maskable and monochrome icons are cropped to a
 * circle by the platform, so they fit by radius to stay inside the safe zone.
 */
function placeMotif(size, reach, byRadius) {
  const { strokes, width, along } = motif();
  const pts = strokes.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = width / 2;
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const my = (Math.min(...ys) + Math.max(...ys)) / 2;
  const extent = byRadius
    ? Math.max(...pts.map(([x, y]) => Math.hypot(x - mx, y - my))) + pad
    : Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + pad;
  const k = (size * reach) / extent;
  const segs = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const [ax, ay] = stroke[i - 1];
      const [bx, by] = stroke[i];
      segs.push([(ax - mx) * k + size / 2, (ay - my) * k + size / 2, (bx - mx) * k + size / 2, (by - my) * k + size / 2]);
    }
  }
  const span = Math.max(...pts.map(([x, y]) => (x - mx) * along[0] + (y - my) * along[1])) * k;
  return { segs, half: (width / 2) * k, along, span };
}

function nearest(segs, px, py) {
  let d = Infinity;
  for (const [ax, ay, bx, by] of segs) {
    // Cheap reject: a segment whose box is already farther than the best is skipped.
    if (px < Math.min(ax, bx) - d || px > Math.max(ax, bx) + d || py < Math.min(ay, by) - d || py > Math.max(ay, by) + d) continue;
    d = Math.min(d, segDist(px, py, ax, ay, bx, by));
  }
  return d;
}

function renderIcon(size, kind) {
  const out = Buffer.alloc(size * size * 4);
  const mono = kind === 'monochrome';
  const { segs, half, along, span } = placeMotif(size, kind === 'any' ? 0.34 : 0.36, kind !== 'any');
  const c = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const at = (y * size + x) * 4;
      const d = nearest(segs, px, py) - half;

      if (mono) {
        // Android reads only the alpha of a monochrome icon.
        out[at] = out[at + 1] = out[at + 2] = 255;
        out[at + 3] = Math.round(cover(d) * 255);
        continue;
      }

      let rgb = mixRGB(BG_TOP, BG_BOT, clamp(py / size, 0, 1));
      const glow = Math.max(0, 1 - Math.hypot(px - c, py - c) / (size * 0.52));
      rgb = over(rgb, GLOW, Math.pow(glow, 2.6) * 0.22);

      // A soft halo hugging the line, so it reads as lit rather than drawn.
      rgb = over(rgb, GLOW, Math.exp(-Math.max(d, 0) / (size * 0.022)) * 0.32);

      // Darker where the line starts tangled, brighter where it runs free.
      const t = clamp(((px - c) * along[0] + (py - c) * along[1]) / (2 * span) + 0.5, 0, 1);
      rgb = over(rgb, mixRGB(LINE_START, LINE_END, t), cover(d));

      out[at] = Math.round(clamp(rgb[0], 0, 255));
      out[at + 1] = Math.round(clamp(rgb[1], 0, 255));
      out[at + 2] = Math.round(clamp(rgb[2], 0, 255));
      out[at + 3] = 255;
    }
  }

  return out;
}

// --------------------------------------------------------------------- main

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, kind: 'any' },
  { file: 'icon-512.png', size: 512, kind: 'any' },
  { file: 'icon-512-maskable.png', size: 512, kind: 'maskable' },
  { file: 'icon-512-monochrome.png', size: 512, kind: 'monochrome' },
];

for (const { file, size, kind } of targets) {
  const png = encodePNG(size, renderIcon(size, kind));
  fs.writeFileSync(path.join(outDir, file), png);
  console.log('wrote icons/' + file + ' (' + png.length + ' bytes)');
}
