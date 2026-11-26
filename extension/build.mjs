import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

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
// Base = assets/logo.png, the brand tile (dark rounded square, bold white iR —
// same mark as the tray icon), decoded, corner-masked with alpha and
// box-resampled to each size. Overlays drawn bottom-right on a supersampled
// transparent layer, alpha-composited on top: orange "!" (server unreachable),
// red stop octagon (site blocked). Overlay shapes live on a 16-unit grid.
// PNG decode/encode by hand (zlib) so the build stays dependency-free.

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

// PNG decode (8-bit, color type 2 RGB or 6 RGBA — covers assets/logo.png and
// anything headless Chrome writes if the master is ever regenerated).
function decodePNG(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  let idat = [];
  let depth = 0;
  let colorType = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
  }
  if (depth !== 8 || (colorType !== 2 && colorType !== 6))
    throw new Error(`unexpected PNG: depth=${depth} color=${colorType}`);
  const ch = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= ch ? px[row + x - ch] : 0;
      const up = y > 0 ? px[row - stride + x] : 0;
      const ul = x >= ch && y > 0 ? px[row - stride + x - ch] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, ul);
      px[row + x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = px[i * ch];
    rgba[i * 4 + 1] = px[i * ch + 1];
    rgba[i * 4 + 2] = px[i * ch + 2];
    rgba[i * 4 + 3] = ch === 4 ? px[i * 4 + 3] : 255;
  }
  return { w, h, rgba };
}

// Box resample (premultiplied, so transparent edges never bleed color).
function resample(src, sw, dw) {
  const out = Buffer.alloc(dw * dw * 4);
  const scale = sw / dw;
  for (let y = 0; y < dw; y++) {
    const sy0 = y * scale;
    const sy1 = (y + 1) * scale;
    for (let x = 0; x < dw; x++) {
      const sx0 = x * scale;
      const sx1 = (x + 1) * scale;
      let r = 0;
      let g = 0;
      let b = 0;
      let aSum = 0;
      let n = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++)
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const cov =
            (Math.min(sx + 1, sx1) - Math.max(sx, sx0)) * (Math.min(sy + 1, sy1) - Math.max(sy, sy0));
          if (cov <= 0) continue;
          const i = (sy * sw + sx) * 4;
          const af = src[i + 3] / 255;
          r += src[i] * af * cov;
          g += src[i + 1] * af * cov;
          b += src[i + 2] * af * cov;
          aSum += src[i + 3] * cov;
          n += cov;
        }
      const o = (y * dw + x) * 4;
      const a = aSum / n;
      const af = a / 255;
      out[o] = af > 0 ? r / n / af : 0;
      out[o + 1] = af > 0 ? g / n / af : 0;
      out[o + 2] = af > 0 ? b / n / af : 0;
      out[o + 3] = a;
    }
  }
  return out;
}

// Source-over composite of `over` (non-premultiplied RGBA) onto `base`.
function composite(base, over) {
  for (let i = 0; i < base.length; i += 4) {
    const oa = over[i + 3] / 255;
    if (oa >= 1) {
      base[i] = over[i];
      base[i + 1] = over[i + 1];
      base[i + 2] = over[i + 2];
      base[i + 3] = 255;
      continue;
    }
    const ba = base[i + 3] / 255;
    const outA = oa + ba * (1 - oa);
    if (outA <= 0) {
      base[i + 3] = 0;
      continue;
    }
    base[i] = (over[i] * oa + base[i] * ba * (1 - oa)) / outA;
    base[i + 1] = (over[i + 1] * oa + base[i + 1] * ba * (1 - oa)) / outA;
    base[i + 2] = (over[i + 2] * oa + base[i + 2] * ba * (1 - oa)) / outA;
    base[i + 3] = outA * 255;
  }
}

// Brand master: the rendered logo tile, corners cut with alpha (rx=112 on the
// 512 grid, same as logo.svg). RGB zeroed under the mask so resample can't
// bleed the old baked-in background into the rounded edge.
const LOGO = (() => {
  const { w, h, rgba } = decodePNG(readFileSync(new URL('../assets/logo.png', import.meta.url)));
  const r = Math.round(Math.min(w, h) * 0.21875); // 112/512
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      if (dx < r && dy < r && (r - dx) ** 2 + (r - dy) ** 2 > r ** 2) {
        const i = (y * w + x) * 4;
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 0;
      }
    }
  return { w, h, rgba };
})();

function drawIcon(size, overlay, base) {
  const img = Buffer.from(base);
  if (overlay) {
    const cv = iconCanvas(size);
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
    composite(img, cv.downsample());
  }
  return encodePNG(size, size, img);
}

const iconDir = `${outdir}/icons`;
mkdirSync(iconDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const base = resample(LOGO.rgba, LOGO.w, size);
  for (const overlay of ['base', 'err', 'stop']) {
    writeFileSync(`${iconDir}/icon${size}-${overlay}.png`, drawIcon(size, overlay, base));
  }
}

console.log('extension built -> extension/dist');
