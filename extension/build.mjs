import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const outdir = 'extension/dist';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const common = { bundle: true, target: 'chrome120', logLevel: 'silent', minify: false };

await Promise.all([
  build({ ...common, entryPoints: ['extension/src/spy.ts'], format: 'iife', outfile: `${outdir}/spy.js` }),
  build({ ...common, entryPoints: ['extension/src/content.ts'], format: 'iife', outfile: `${outdir}/content.js` }),
  build({ ...common, entryPoints: ['extension/src/background.ts'], format: 'esm', outfile: `${outdir}/background.js` }),
  build({ ...common, entryPoints: ['extension/src/popup.ts'], format: 'esm', outfile: `${outdir}/popup.js` }),
]);

// --- icons -------------------------------------------------------------------
// Grey square with a white R; overlays drawn bottom-right: orange "!" (server
// unreachable), red stop octagon (site blocked). Shapes live on a 16-unit grid,
// rasterized at 8x supersampling and box-downsampled for antialiasing. PNGs are
// encoded by hand (zlib) so the build stays dependency-free.

const GREY = [138, 138, 138];
const WHITE = [255, 255, 255];
const ORANGE = [224, 138, 0];
const RED = [217, 48, 37];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const rows = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    rows[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// All shape helpers take coordinates in the 16-unit grid, scaled to the
// canvas. Rounding to whole supersample px matters: typed arrays silently
// ignore non-integer indices, which would drop whole shape edges.
function iconCanvas(size) {
  const ss = 8;
  const W = size * ss;
  const img = new Uint8ClampedArray(W * W * 4);
  const u = (v) => Math.round((v * W) / 16);
  const unit = (p) => ((p + 0.5) / W) * 16; // SS px -> grid units
  const paint = (x, y, c) => {
    const i = (y * W + x) * 4;
    img[i] = c[0];
    img[i + 1] = c[1];
    img[i + 2] = c[2];
    img[i + 3] = 255;
  };
  const fillRect = (x0, y0, x1, y1, c) => {
    for (let y = Math.max(0, u(y0)); y < Math.min(W, u(y1)); y++)
      for (let x = Math.max(0, u(x0)); x < Math.min(W, u(x1)); x++) paint(x, y, c);
  };
  const segDist = (px, py, x0, y0, x1, y1) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
    const ex = px - (x0 + t * dx);
    const ey = py - (y0 + t * dy);
    return Math.hypot(ex, ey);
  };
  const fillLine = (x0, y0, x1, y1, hw, c) => {
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++)
        if (segDist(unit(x), unit(y), x0, y0, x1, y1) <= hw) paint(x, y, c);
  };
  const fillOct = (cx, cy, a, c) => {
    const b = a * 1.08239; // |dx|+|dy| bound for a regular octagon with flat top
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        const dx = Math.abs(unit(x) - cx);
        const dy = Math.abs(unit(y) - cy);
        if (dx <= a && dy <= a && dx + dy <= b) paint(x, y, c);
      }
  };
  const downsample = () => {
    const out = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < ss; sy++)
          for (let sx = 0; sx < ss; sx++) {
            const i = ((y * ss + sy) * W + x * ss + sx) * 4;
            r += img[i];
            g += img[i + 1];
            b += img[i + 2];
            a += img[i + 3];
          }
        const n = ss * ss;
        const o = (y * size + x) * 4;
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
        out[o + 3] = a / n;
      }
    return out;
  };
  return { fillRect, fillLine, fillOct, downsample };
}

function paintR(cv) {
  cv.fillRect(4.2, 3.6, 6.2, 12.4, WHITE); // stem
  cv.fillRect(4.2, 3.6, 10.6, 5.7, WHITE); // top of bowl
  cv.fillRect(8.6, 3.6, 10.6, 8.9, WHITE); // right of bowl
  cv.fillRect(4.2, 7.0, 10.6, 8.9, WHITE); // middle bar closes the bowl
  cv.fillLine(7.4, 8.9, 11.6, 12.4, 1.05, WHITE); // leg
}

// 16px gets a pixel-font R: the vector R's counter (bowl hole) is sub-pixel
// at 16 and its leg lands exactly where the corner overlays sit, so the small
// size uses a chunky glyph shifted left/up, keeping the corner free.
function paintRSmall(cv) {
  const P = (c, r, w) => cv.fillRect(4 + c, 4 + r, 4 + c + w, 4 + r + 1, WHITE);
  for (const r of [0, 3]) P(0, r, 4); // top bar / mid bar
  for (const r of [1, 2, 4, 5, 6, 7]) P(0, r, 1); // stem
  for (const r of [1, 2, 5]) P(3, r, 1); // right of bowl
  for (const [c, r] of [
    [2, 4],
    [3, 5],
    [4, 6],
    [5, 7],
  ])
    P(c, r, 1); // leg
}

function drawIcon(size, overlay) {
  const cv = iconCanvas(size);
  cv.fillRect(0, 0, 16, 16, GREY);
  if (size === 16) paintRSmall(cv);
  else paintR(cv);
  if (overlay === 'err') {
    cv.fillRect(10.55, 7.0, 13.65, 11.2, WHITE); // white halo
    cv.fillRect(10.55, 11.2, 13.65, 13.75, WHITE);
    cv.fillRect(11.2, 7.6, 13.0, 10.6, ORANGE); // ! bar
    cv.fillRect(11.2, 11.6, 13.0, 13.15, ORANGE); // ! dot
  } else if (overlay === 'stop') {
    cv.fillOct(12.3, 12.3, 3.6, WHITE); // border
    cv.fillOct(12.3, 12.3, 3.1, RED);
    cv.fillRect(9.9, 11.6, 14.7, 13.0, WHITE); // no-entry bar
  }
  return encodePNG(size, size, cv.downsample());
}

const iconDir = `${outdir}/icons`;
mkdirSync(iconDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  for (const overlay of ['base', 'err', 'stop']) {
    writeFileSync(`${iconDir}/icon${size}-${overlay}.png`, drawIcon(size, overlay));
  }
}

console.log('extension built -> extension/dist');
