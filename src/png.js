// Minimal PNG codec for high bit depth images (the browser's decoder flattens everything to 8 bits).
// Decodes every standard PNG (grey, RGB, palette, grey+alpha, RGBA; 1–16 bits; Adam7 interlace; tRNS)
// to 16-bit RGBA, and encodes 8- or 16-bit RGBA/RGB. zlib comes from the bundled fflate (MIT).
import { zlibSync, unzlibSync } from '../vendor/fflate/fflate.js';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

let crcTable = null;
function crc32(bytes, start, end) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Read the header only: { width, height, bitDepth, colorType, interlace } or null if not a PNG. */
export function pngInfo(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20), bitDepth: b[24], colorType: b[25], interlace: b[28] };
}

function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }

/** Undo the per-row filters of one (sub)image in place; returns the offset after it. */
function unfilter(data, off, rowBytes, rows, bpp, out) {
  let prev = null;
  for (let y = 0; y < rows; y++) {
    const ft = data[off++], row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    row.set(data.subarray(off, off + rowBytes)); off += rowBytes;
    switch (ft) {
      case 0: break;
      case 1: for (let i = bpp; i < rowBytes; i++) row[i] = (row[i] + row[i - bpp]) & 255; break;
      case 2: if (prev) for (let i = 0; i < rowBytes; i++) row[i] = (row[i] + prev[i]) & 255; break;
      case 3: for (let i = 0; i < rowBytes; i++) row[i] = (row[i] + (((i >= bpp ? row[i - bpp] : 0) + (prev ? prev[i] : 0)) >> 1)) & 255; break;
      case 4: for (let i = 0; i < rowBytes; i++) row[i] = (row[i] + paeth(i >= bpp ? row[i - bpp] : 0, prev ? prev[i] : 0, i >= bpp && prev ? prev[i - bpp] : 0)) & 255; break;
      default: throw new Error(`Bad PNG filter type ${ft}`);
    }
    prev = row;
  }
  return off;
}

/**
 * Decode a PNG to { width, height, bitDepth, colorType, hasAlpha, data: Uint16Array RGBA (0..65535, straight alpha) }.
 * Gamma / ICC chunks are ignored (values are taken as sRGB).
 */
export function decodePNG(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const info = pngInfo(b); if (!info) throw new Error('Not a PNG file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8, plte = null, trns = null; const idat = [];
  while (pos + 8 <= b.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]), body = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const { width: W, height: H, bitDepth: depth, colorType: ct, interlace } = info;
  const ch = CHANNELS[ct]; if (!ch) throw new Error(`Unsupported PNG color type ${ct}`);
  if (ct === 3 && !plte) throw new Error('PNG palette missing');
  let total = 0; for (const p of idat) total += p.length;
  const z = new Uint8Array(total); { let o = 0; for (const p of idat) { z.set(p, o); o += p.length; } }
  const raw = unzlibSync(z);
  const bitsPP = ch * depth, bpp = Math.max(1, bitsPP >> 3), maxv = (1 << depth) - 1;
  const out = new Uint16Array(W * H * 4);
  // transparent colour key (grey / RGB), in raw sample units
  const key = trns && (ct === 0 || ct === 2) ? (ct === 0 ? [(trns[0] << 8) | trns[1]] : [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]]) : null;
  const sample = (row, idx) => { // idx = sample index within the row
    if (depth === 16) return (row[idx * 2] << 8) | row[idx * 2 + 1];
    if (depth === 8) return row[idx];
    const bit = idx * depth; return (row[bit >> 3] >> (8 - depth - (bit & 7))) & maxv;
  };
  const scale = (v) => (depth === 16 ? v : Math.round((v * 65535) / maxv));
  const putRow = (row, w, y, x0, dx) => {
    for (let i = 0; i < w; i++) {
      const o = (y * W + x0 + i * dx) * 4;
      if (ct === 3) {
        const p = sample(row, i) * 3;
        out[o] = plte[p] * 257; out[o + 1] = plte[p + 1] * 257; out[o + 2] = plte[p + 2] * 257;
        out[o + 3] = trns && p / 3 < trns.length ? trns[p / 3] * 257 : 65535;
      } else if (ct === 0 || ct === 4) {
        const g = sample(row, i * ch); out[o] = out[o + 1] = out[o + 2] = scale(g);
        out[o + 3] = ct === 4 ? scale(sample(row, i * ch + 1)) : key && g === key[0] ? 0 : 65535;
      } else {
        const r = sample(row, i * ch), g = sample(row, i * ch + 1), bb = sample(row, i * ch + 2);
        out[o] = scale(r); out[o + 1] = scale(g); out[o + 2] = scale(bb);
        out[o + 3] = ct === 6 ? scale(sample(row, i * ch + 3)) : key && r === key[0] && g === key[1] && bb === key[2] ? 0 : 65535;
      }
    }
  };
  let off = 0;
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((W - x0) / dx), ph = Math.ceil((H - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPP) / 8), rows = new Uint8Array(rowBytes * ph);
    off = unfilter(raw, off, rowBytes, ph, bpp, rows);
    for (let r = 0; r < ph; r++) putRow(rows.subarray(r * rowBytes, (r + 1) * rowBytes), pw, y0 + r * dy, x0, dx);
  }
  return { width: W, height: H, bitDepth: depth, colorType: ct, hasAlpha: ct === 4 || ct === 6 || !!trns, data: out };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * Encode RGBA pixels as PNG. `data` is a Uint16Array (0..65535) for depth 16 or a Uint8(Clamped)Array for depth 8.
 * Fully opaque images are written as RGB. Rows use the filter with the smallest sum of absolute values.
 */
export function encodePNG({ width: W, height: H, data, depth = 16, level = 6, alpha = null }) {
  const n = W * H;
  if (alpha === null) { alpha = false; const full = depth === 16 ? 65535 : 255; for (let i = 3; i < data.length; i += 4) if (data[i] !== full) { alpha = true; break; } }
  const ch = alpha ? 4 : 3, bps = depth / 8, bpp = ch * bps, rowBytes = W * bpp;
  const filtered = new Uint8Array((rowBytes + 1) * H);
  let prev = new Uint8Array(rowBytes), cur = new Uint8Array(rowBytes);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowBytes));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4, o = x * bpp;
      for (let c = 0; c < ch; c++) {
        const v = data[s + c];
        if (depth === 16) { cur[o + c * 2] = v >> 8; cur[o + c * 2 + 1] = v & 255; } else cur[o + c] = v;
      }
    }
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const t = cand[f]; let sum = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, up = y ? prev[i] : 0, c = i >= bpp && y ? prev[i - bpp] : 0;
        const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : paeth(a, up, c);
        const v = (cur[i] - p) & 255; t[i] = v; sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    // recompute the winner fully (the loop above may have stopped early)
    const t = cand[best];
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = y ? prev[i] : 0, c = i >= bpp && y ? prev[i - bpp] : 0;
      const p = best === 0 ? 0 : best === 1 ? a : best === 2 ? up : best === 3 ? (a + up) >> 1 : paeth(a, up, c);
      t[i] = (cur[i] - p) & 255;
    }
    filtered[y * (rowBytes + 1)] = best; filtered.set(t, y * (rowBytes + 1) + 1);
    const sw = prev; prev = cur; cur = sw;
  }
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, W); hv.setUint32(4, H); ihdr[8] = depth; ihdr[9] = alpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const srgb = new Uint8Array([0]); // rendering intent: perceptual (values are sRGB)
  const parts = [new Uint8Array(SIG), chunk('IHDR', ihdr), chunk('sRGB', srgb), chunk('IDAT', zlibSync(filtered, { level })), chunk('IEND', new Uint8Array(0))];
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  void n;
  return out;
}
