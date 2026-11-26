// Generate src-tauri/icons/tray-ir-warn.png: the tray glyph with a yellow
// warning badge, drawn in full color (rendered non-template so the yellow
// survives on light + dark menu bars). Geometry comes from the base icon's
// alpha channel, so the glyph never drifts from tray-ir.png.
// Run: node scripts/gen-tray-warn.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src-tauri', 'icons', 'tray-ir.png');
const OUT = path.join(import.meta.dirname, '..', 'src-tauri', 'icons', 'tray-ir-warn.png');

const GREY = [138, 138, 138];
const YELLOW = [245, 185, 66];

// --- PNG decode (assumes the generator wrote filter:0 rows — tray-ir.png did) ---
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
  if (depth !== 8 || colorType !== 6) throw new Error(`unexpected PNG: depth=${depth} color=${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const rgba = Buffer.alloc(w * h * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const at = y * (stride + 1) + 1 + x;
      const left = x >= 4 ? rgba[row + x - 4] : 0;
      const up = y > 0 ? rgba[row - stride + x] : 0;
      const ul = x >= 4 && y > 0 ? rgba[row - stride + x - 4] : 0;
      let v = raw[at];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, ul);
      rgba[row + x] = v & 0xff;
    }
  }
  return { w, h, rgba };
}

// --- PNG encode (same shape as extension/build.mjs) ---
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
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
    rows[y * (w * 4 + 1)] = 0;
    rgba.copy(rows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * (w * 4 + 1));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const { w, h, rgba } = decodePNG(readFileSync(SRC));

// Glyph bbox from alpha, then a chip slightly larger than the glyph.
let x0 = w, x1 = 0, y0 = h, y1 = 0;
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++)
    if (rgba[(y * w + x) * 4 + 3] > 8) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
const pad = Math.round(Math.min(w, h) * 0.06);
const cx0 = Math.max(0, x0 - pad), cx1 = Math.min(w - 1, x1 + pad);
const cy0 = Math.max(0, y0 - pad), cy1 = Math.min(h - 1, y1 + pad);
const corner = Math.round((cx1 - cx0) * 0.14);

const out = Buffer.alloc(w * h * 4);
const set = (xf, yf, c, a = 255) => {
  // Fractional indices silently no-op on Buffer — round first.
  const x = Math.round(xf), y = Math.round(yf);
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const i = (y * w + x) * 4;
  out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = a;
};
for (let y = cy0; y <= cy1; y++)
  for (let x = cx0; x <= cx1; x++) {
    // rounded-corner chip
    const dx = Math.min(x - cx0, cx1 - x), dy = Math.min(y - cy0, cy1 - y);
    if (dx < corner && dy < corner && (corner - dx) ** 2 + (corner - dy) ** 2 > corner ** 2) continue;
    const glyph = rgba[(y * w + x) * 4 + 3] > 8;
    set(x, y, glyph ? [255, 255, 255] : GREY);
  }

// Badge: yellow disc with white ring, bottom-right of the chip.
const br = Math.round(Math.min(w, h) * 0.16);
const bcx = cx1 - br * 0.9, bcy = cy1 - br * 0.9;
for (let y = Math.max(0, bcy - br - 2); y <= Math.min(h - 1, bcy + br + 2); y++)
  for (let x = Math.max(0, bcx - br - 2); x <= Math.min(w - 1, bcx + br + 2); x++) {
    const d = Math.hypot(x - bcx, y - bcy);
    if (d <= br) set(x, y, YELLOW);
    else if (d <= br + 2) set(x, y, [255, 255, 255]);
  }

writeFileSync(OUT, encodePNG(w, h, out));
console.log(`wrote ${OUT} (${w}x${h}, chip ${cx1 - cx0 + 1}x${cy1 - cy0 + 1}, badge r=${br})`);
