// Layered PSD / PSB reader and writer (original code, written from the publicly documented file layout).
// Pure functions, no DOM: runs in the codec worker and in Node tests.
//
// readPSD(bytes) → { width, height, depth, colorMode, version, dpi, layers, composite, warnings }
//   layers (bottom → top, like the file): { name, top, left, width, height, opacity 0..1, visible, blendKey,
//   clipping, fillOpacity 0..1, section 0..3 (1/2 = group open/closed, 3 = end-of-group marker), sectionBlend,
//   kind: 'pixel' | 'text' | 'smart' | 'fill' | 'shape' | 'adjust' | 'group' | 'divider', adjKey, adjData,
//   effects, pixels: RGBA Uint8Array (8-bit) or Uint16Array (16/32-bit), mask: { top, left, width, height,
//   data: Uint8Array, defaultColor, disabled } | null }
//   composite: { data } (RGBA, same sample type) or null.
// writePSD(doc) ← { width, height, depth: 8 | 16, dpi, layers (same shape, bottom → top), composite: RGBA }.
import { unzlibSync, zlibSync } from '../vendor/fflate/fflate.js';

// ---- reading ---------------------------------------------------------------------------------------------
class Reader {
  constructor(bytes) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; }
  need(n) { if (this.p + n > this.b.length) throw new Error('The PSD file is truncated or damaged'); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const x = this.v.getUint16(this.p); this.p += 2; return x; }
  i16() { this.need(2); const x = this.v.getInt16(this.p); this.p += 2; return x; }
  u32() { this.need(4); const x = this.v.getUint32(this.p); this.p += 4; return x; }
  i32() { this.need(4); const x = this.v.getInt32(this.p); this.p += 4; return x; }
  u64() { this.need(8); const hi = this.v.getUint32(this.p), lo = this.v.getUint32(this.p + 4); this.p += 8; return hi * 4294967296 + lo; }
  f32() { this.need(4); const x = this.v.getFloat32(this.p); this.p += 4; return x; }
  f64() { this.need(8); const x = this.v.getFloat64(this.p); this.p += 8; return x; }
  str(n) { this.need(n); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p + i]); this.p += n; return s; }
  bytes(n) { this.need(n); const x = this.b.subarray(this.p, this.p + n); this.p += n; return x; }
}
// keys whose length field is 8 bytes in PSB files
const LONG_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD']);
export const ADJ_KEYS = { levl: 'Levels', curv: 'Curves', brit: 'Brightness/contrast', blnc: 'Color balance', hue2: 'Hue/saturation', hue: 'Hue/saturation (old)',
  selc: 'Selective color', thrs: 'Threshold', nvrt: 'Invert', post: 'Posterize', mixr: 'Channel mixer', grdm: 'Gradient map', phfl: 'Photo filter',
  expA: 'Exposure', vibA: 'Vibrance', blwh: 'Black & white', clrL: 'Color lookup', CgEd: 'Brightness/contrast' };
const FILL_KEYS = new Set(['SoCo', 'GdFl', 'PtFl']);
const MODE_NAMES = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };

function unpackBits(src, pos, n, out, at) {
  // PackBits run-length decoding of one row into out[at .. at + n)
  const end = at + n;
  while (at < end && pos < src.length) {
    const h = src[pos++];
    if (h < 128) { const c = Math.min(h + 1, end - at); out.set(src.subarray(pos, pos + c), at); at += c; pos += h + 1; }
    else if (h > 128) { const c = Math.min(257 - h, end - at); out.fill(src[pos++], at, at + c); at += c; }
  }
  return pos;
}
/** Channel bytes (big-endian samples, w*h*bps) from one compressed block. */
function decodePlane(comp, data, w, h, bps, psb, rowCountsAt = null) {
  const rowBytes = w * bps, out = new Uint8Array(rowBytes * h);
  if (!w || !h) return out;
  if (comp === 0) { out.set(data.subarray(0, Math.min(out.length, data.length))); return out; }
  if (comp === 1) {
    const cw = psb ? 4 : 2, counts = rowCountsAt || data, dv = new DataView(counts.buffer, counts.byteOffset, counts.byteLength);
    let pos = rowCountsAt ? 0 : h * cw; const src = rowCountsAt ? data : data;
    for (let y = 0; y < h; y++) {
      const len = cw === 4 ? dv.getUint32(y * 4) : dv.getUint16(y * 2);
      unpackBits(src, pos, rowBytes, out, y * rowBytes); pos += len;
    }
    return out;
  }
  if (comp === 2 || comp === 3) {
    let raw; try { raw = unzlibSync(data); } catch { throw new Error('A ZIP-compressed channel could not be inflated'); }
    out.set(raw.subarray(0, Math.min(out.length, raw.length)));
    if (comp === 3) unpredict(out, w, h, bps);
    return out;
  }
  throw new Error(`Unknown channel compression ${comp}`);
}
function unpredict(b, w, h, bps) {
  if (bps === 1) { for (let y = 0; y < h; y++) { const o = y * w; for (let x = 1; x < w; x++) b[o + x] = (b[o + x] + b[o + x - 1]) & 255; } return; }
  if (bps === 2) {
    for (let y = 0; y < h; y++) {
      let prev = 0;
      for (let x = 0; x < w; x++) { const i = (y * w + x) * 2; const v = (((b[i] << 8) | b[i + 1]) + prev) & 65535; b[i] = v >> 8; b[i + 1] = v & 255; prev = v; }
    }
    return;
  }
  // 32-bit: byte deltas over the row, then the four byte planes are interleaved back
  const row = w * 4, t = new Uint8Array(row);
  for (let y = 0; y < h; y++) {
    const o = y * row; for (let x = 1; x < row; x++) b[o + x] = (b[o + x] + b[o + x - 1]) & 255;
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) t[x * 4 + k] = b[o + k * w + x];
    b.set(t, o);
  }
}
const lin2srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
/** Plane bytes → samples in the output scale (0..255 for 8-bit, 0..65535 for 16 / 32-bit). */
function samplesOf(bytes, n, bps) {
  if (bps === 1) return bytes;
  const out = new Uint16Array(n), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bps === 2) { for (let i = 0; i < n; i++) out[i] = dv.getUint16(i * 2); return out; }
  for (let i = 0; i < n; i++) { const f = dv.getFloat32(i * 4); out[i] = Math.round(Math.min(1, Math.max(0, lin2srgb(f))) * 65535); }
  return out;
}
/** Planes (by channel id) → interleaved RGBA. */
function toRGBA(planes, n, mode, deep, hasAlphaDefault = true) {
  const max = deep ? 65535 : 255, out = deep ? new Uint16Array(n * 4) : new Uint8Array(n * 4);
  const p0 = planes[0], p1 = planes[1], p2 = planes[2], p3 = planes[3], a = planes[-1];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (mode === 1) { const g = p0 ? p0[i] : 0; out[j] = out[j + 1] = out[j + 2] = g; }
    else if (mode === 4) { // CMYK (stored inverted: 0 = full ink); simple conversion without a profile
      const c = 1 - (p0 ? p0[i] : max) / max, m = 1 - (p1 ? p1[i] : max) / max, y = 1 - (p2 ? p2[i] : max) / max, k = 1 - (p3 ? p3[i] : max) / max;
      out[j] = Math.round((1 - c) * (1 - k) * max); out[j + 1] = Math.round((1 - m) * (1 - k) * max); out[j + 2] = Math.round((1 - y) * (1 - k) * max);
    } else { out[j] = p0 ? p0[i] : 0; out[j + 1] = p1 ? p1[i] : 0; out[j + 2] = p2 ? p2[i] : 0; }
    out[j + 3] = a ? a[i] : hasAlphaDefault ? max : 0;
  }
  return out;
}
function readPascal(r, pad) {
  const n = r.u8(), s = r.str(n); const total = n + 1, rem = total % pad; if (rem) r.p += pad - rem;
  return s;
}
function readUnicode(r) { const n = r.u32(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(r.u16()); return s.replace(/\u0000+$/, ''); }

function readLayerInfo(r, end, ctx) {
  const { psb, bps, mode, deep } = ctx;
  let count = r.i16(); const mergedAlpha = count < 0; count = Math.abs(count);
  const recs = [];
  for (let li = 0; li < count; li++) {
    const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
    const nch = r.u16(), chans = [];
    for (let c = 0; c < nch; c++) chans.push({ id: r.i16(), len: psb ? r.u64() : r.u32() });
    if (r.str(4) !== '8BIM') throw new Error('Bad layer record signature');
    const blendKey = r.str(4), opacity = r.u8(), clipping = r.u8(), flags = r.u8(); r.u8();
    const extraLen = r.u32(), extraEnd = r.p + extraLen;
    const L = { name: '', top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top), opacity: opacity / 255, visible: !(flags & 2),
      blendKey, clipping: clipping === 1, fillOpacity: 1, section: 0, sectionBlend: null, kind: 'pixel', adjKey: null, adjData: null, effects: false, mask: null, chans, keys: [] };
    // layer mask / adjustment layer data
    const mlen = r.u32(), mend = r.p + mlen;
    if (mlen >= 18) {
      const mt = r.i32(), ml = r.i32(), mb = r.i32(), mr = r.i32(), def = r.u8(), mf = r.u8();
      L.mask = { top: mt, left: ml, width: Math.max(0, mr - ml), height: Math.max(0, mb - mt), defaultColor: def, disabled: !!(mf & 2), data: null };
      if (mlen >= 36) { // a "real" mask rectangle follows (used by channel -3 when a vector mask exists too)
        let q = r.p; if (mf & 16) { const pf = r.b[q++]; if (pf & 1) q += 1; if (pf & 2) q += 8; if (pf & 4) q += 1; if (pf & 8) q += 8; }
        if (mend - q >= 18) { const dv = r.v, rf = r.b[q], rd = r.b[q + 1]; const t = dv.getInt32(q + 2), l2 = dv.getInt32(q + 6), b2 = dv.getInt32(q + 10), r2 = dv.getInt32(q + 14);
          L.realMask = { top: t, left: l2, width: Math.max(0, r2 - l2), height: Math.max(0, b2 - t), defaultColor: rd, disabled: !!(rf & 2), data: null }; }
      }
    }
    r.p = mend;
    const blen = r.u32(); r.p += blen; // blending ranges
    L.name = readPascal(r, 4);
    while (r.p + 12 <= extraEnd) {
      const sig = r.str(4); if (sig !== '8BIM' && sig !== '8B64') { r.p -= 4; break; }
      const key = r.str(4), len = psb && LONG_KEYS.has(key) ? r.u64() : r.u32(), at = r.p, dend = Math.min(extraEnd, at + len);
      L.keys.push(key);
      try {
        if (key === 'luni') L.name = readUnicode(r) || L.name;
        else if (key === 'lsct' || key === 'lsdk') { L.section = r.u32(); if (len >= 12) { r.str(4); L.sectionBlend = r.str(4); } }
        else if (key === 'iOpa') L.fillOpacity = r.u8() / 255;
        else if (key === 'TySh' || key === 'tySh') L.kind = 'text';
        else if (key === 'SoLd' || key === 'PlLd' || key === 'SoLE') L.kind = 'smart';
        else if (FILL_KEYS.has(key)) { if (L.kind === 'pixel') L.kind = 'fill'; }
        else if (key === 'vmsk' || key === 'vsms') L.vector = true;
        else if (key === 'lfx2' || key === 'lrFX' || key === 'lmfx') L.effects = true;
        else if (ADJ_KEYS[key] && !(key === 'brit' && L.adjKey === 'CgEd')) { L.kind = 'adjust'; L.adjKey = key; L.adjData = r.b.slice(at, dend); }
      } catch { /* a damaged block only loses that property */ }
      r.p = at + len;
      // blocks are padded to an even length (some writers pad to 4): skip padding up to the next signature
      for (let k = 0; k < 4 && r.p < extraEnd; k++) { const s = String.fromCharCode(...r.b.subarray(r.p, r.p + 4)); if (s === '8BIM' || s === '8B64') break; r.p++; }
    }
    r.p = extraEnd;
    if (L.vector && L.kind === 'fill') L.kind = 'shape';
    if (L.section === 1 || L.section === 2) L.kind = 'group'; else if (L.section === 3) L.kind = 'divider';
    recs.push(L);
  }
  // channel image data
  for (const L of recs) {
    const planes = {};
    for (const ch of L.chans) {
      const start = r.p, stop = start + ch.len;
      if (ch.len < 2) { r.p = stop; continue; }
      const comp = r.u16();
      const geo = ch.id === -2 ? L.mask : ch.id === -3 ? L.realMask : L, w = geo ? geo.width : 0, h = geo ? geo.height : 0;
      try {
        if (w && h) {
          const bytes = decodePlane(comp, r.b.subarray(r.p, stop), w, h, bps, psb);
          planes[ch.id] = samplesOf(bytes, w * h, bps);
        }
      } catch (err) { ctx.warnings.push(`Layer “${L.name}”: ${err.message}`); L.broken = true; }
      r.p = stop;
    }
    const n = L.width * L.height;
    if (n && (L.kind !== 'group' && L.kind !== 'divider' && L.kind !== 'adjust')) {
      const hasA = planes[-1] != null;
      L.pixels = toRGBA(planes, n, mode, deep, true);
      if (!hasA) L.opaque = true;
    } else L.pixels = null;
    const mk = planes[-3] && L.realMask ? -3 : -2, M = mk === -3 ? L.realMask : L.mask;
    if (M && planes[mk]) {
      const src = planes[mk], m8 = new Uint8Array(M.width * M.height);
      if (deep) for (let i = 0; i < m8.length; i++) m8[i] = src[i] / 257; else m8.set(src);
      M.data = m8; L.mask = M;
    } else if (L.mask && !(L.mask.width && L.mask.height)) {
      L.mask = L.mask.defaultColor === 255 ? null : { ...L.mask, data: new Uint8Array(0) };
    } else if (L.mask && !planes[mk]) L.mask = null;
    delete L.realMask; delete L.chans;
  }
  r.p = Math.max(r.p, Math.min(end, r.p));
  return { recs, mergedAlpha };
}

export function readPSD(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(bytes), warnings = [];
  if (r.str(4) !== '8BPS') throw new Error('Not a PSD file');
  const version = r.u16(); if (version !== 1 && version !== 2) throw new Error(`Unsupported PSD version ${version}`);
  r.p += 6;
  const channels = r.u16(), height = r.u32(), width = r.u32(), depth = r.u16(), colorMode = r.u16();
  const psb = version === 2;
  if (![1, 3, 4].includes(colorMode)) throw new Error(`${MODE_NAMES[colorMode] || 'This'} color mode is not supported (RGB, grayscale and CMYK are)`);
  if (![8, 16, 32].includes(depth)) throw new Error(`${depth}-bit PSD files are not supported`);
  const bps = depth / 8, deep = depth > 8;
  if (colorMode === 4) warnings.push('CMYK document converted to RGB without a color profile: colors are approximate.');
  if (depth === 32) warnings.push('32-bit document converted to 16 bits/channel (linear values encoded as sRGB, highlights above 1.0 clipped).');
  const cmLen = r.u32(); r.p += cmLen;
  // image resources
  const irLen = r.u32(), irEnd = r.p + irLen; let dpi = null;
  while (r.p + 12 <= irEnd) {
    if (r.str(4) !== '8BIM') break;
    const id = r.u16(); readPascal(r, 2); const size = r.u32(), at = r.p;
    if (id === 1005 && size >= 16) { dpi = Math.round(r.v.getUint32(at) / 65536); }
    r.p = at + size + (size & 1);
  }
  r.p = irEnd;
  const ctx = { psb, bps, mode: colorMode, deep, warnings };
  // layer and mask information
  let layers = null, mergedAlpha = false, layerError = null;
  const lmLen = psb ? r.u64() : r.u32(), lmStart = r.p, lmEnd = lmStart + lmLen;
  if (lmLen) {
    try {
      const liLen = psb ? r.u64() : r.u32(), liEnd = r.p + liLen;
      if (liLen) { const res = readLayerInfo(r, liEnd, ctx); layers = res.recs; mergedAlpha = res.mergedAlpha; }
      r.p = liEnd;
      if (r.p + 4 <= lmEnd) { const gl = r.u32(); r.p += gl; }
      while (r.p + 12 <= lmEnd) { // global additional info: 16 / 32-bit documents keep their layers here
        const sig = r.str(4); if (sig !== '8BIM' && sig !== '8B64') break;
        const key = r.str(4), len = psb && LONG_KEYS.has(key) ? r.u64() : r.u32(), at = r.p;
        if ((key === 'Lr16' || key === 'Lr32' || key === 'Layr') && !layers && len) { const res = readLayerInfo(r, at + len, ctx); layers = res.recs; mergedAlpha = res.mergedAlpha; }
        r.p = at + len; while (r.p < lmEnd && (r.p - lmStart) % 2) r.p++;
        for (let k = 0; k < 3 && r.p < lmEnd; k++) { const s = String.fromCharCode(...r.b.subarray(r.p, r.p + 4)); if (s === '8BIM' || s === '8B64') break; r.p++; }
      }
    } catch (err) { layerError = err; layers = null; }
  }
  r.p = lmEnd;
  // merged (composite) image
  let composite = null;
  try {
    const comp = r.u16(), n = width * height, planes = {}, chans = Math.min(channels, colorMode === 1 ? 2 : colorMode === 4 ? 5 : 4);
    const rowBytes = width * bps, cw = psb ? 4 : 2;
    let counts = null, pos = r.p;
    if (comp === 1) { counts = r.b.subarray(r.p, r.p + channels * height * cw); pos = r.p + channels * height * cw; }
    let rest = r.b.subarray(pos);
    if (comp === 2 || comp === 3) { const all = unzlibSync(rest); rest = all; }
    const colors = colorMode === 1 ? 1 : colorMode === 4 ? 4 : 3;
    let off = 0;
    for (let c = 0; c < chans; c++) {
      let bytes;
      if (comp === 1) {
        const cdv = new DataView(counts.buffer, counts.byteOffset + c * height * cw, height * cw); let total = 0;
        for (let y = 0; y < height; y++) total += cw === 4 ? cdv.getUint32(y * 4) : cdv.getUint16(y * 2);
        bytes = decodePlane(1, rest.subarray(off, off + total), width, height, bps, psb, new Uint8Array(counts.buffer, counts.byteOffset + c * height * cw, height * cw)); off += total;
      } else { bytes = rest.subarray(off, off + rowBytes * height).slice(); if (comp === 3) unpredict(bytes, width, height, bps); off += rowBytes * height; }
      planes[c < colors ? c : -1] = samplesOf(bytes, n, bps);
    }
    if (!mergedAlpha) delete planes[-1];
    composite = { data: toRGBA(planes, n, colorMode, deep, true) };
  } catch (err) { warnings.push(`The flattened image in the file could not be read (${err.message}).`); }
  if (layerError) warnings.push(`The layers could not be read (${layerError.message}); opened the flattened image instead.`);
  if (!layers && !composite) throw layerError || new Error('The PSD file has neither readable layers nor a flattened image');
  return { width, height, depth, colorMode, version, dpi, layers, composite, warnings };
}

// ---- adjustment layer data (the subset Tintwork has equivalents for) ------------------------------------
const HUE_RANGES = [[315, 345, 15, 45], [15, 45, 75, 105], [75, 105, 135, 165], [135, 165, 195, 225], [195, 225, 255, 285], [255, 285, 315, 345]];
/** PSD adjustment block → { type, params, approx } for Tintwork, or null when there is no equivalent. */
export function decodeAdjustment(key, data) {
  const r = new Reader(data);
  try {
    if (key === 'nvrt') return { type: 'invert', params: {} };
    if (key === 'CgEd') { // descriptor form of brightness/contrast: pick the Brgh / Cntr integers
      const num = (k) => { for (let i = 0; i + 12 <= data.length; i++) if (String.fromCharCode(...data.subarray(i, i + 8)) === k + 'long') return new DataView(data.buffer, data.byteOffset + i + 8, 4).getInt32(0); return 0; };
      return { type: 'brightnessContrast', params: { brightness: clamp(num('Brgh'), -100, 100), contrast: clamp(num('Cntr'), -100, 100) }, approx: true };
    }
    if (key === 'brit') { const b = r.i16(), c = r.i16(); return { type: 'brightnessContrast', params: { brightness: clamp(b, -100, 100), contrast: clamp(c, -100, 100) }, approx: true }; }
    if (key === 'expA') { r.u16(); const e = r.f32(), o = r.f32(), g = r.f32(); return { type: 'exposure', params: { exposure: clamp(e, -3, 3), offset: clamp(o, -0.5, 0.5), gamma: clamp(g || 1, 0.1, 3) } }; }
    if (key === 'hue2') {
      r.u16(); const colorize = r.u8(); r.u8(); r.i16(); r.i16(); r.i16();
      const hue = r.i16(), sat = r.i16(), light = r.i16();
      let ranged = false; for (let i = 0; i < 6; i++) { r.p += 8; if (r.i16() || r.i16() || r.i16()) ranged = true; }
      if (colorize) return null;
      return { type: 'hueSaturation', params: { hue, saturation: sat, lightness: light }, approx: ranged || undefined };
    }
    if (key === 'levl') {
      r.u16(); const rec = () => ({ inBlack: r.u16(), inWhite: r.u16(), outBlack: r.u16(), outWhite: r.u16(), gamma: r.u16() / 100 });
      const all = rec(), rr = rec(), gg = rec(), bb = rec();
      const id = (q) => q.inBlack === 0 && q.inWhite === 255 && q.outBlack === 0 && q.outWhite === 255 && Math.abs(q.gamma - 1) < 0.005;
      const p = { inBlack: clamp(all.inBlack, 0, 254), inWhite: clamp(all.inWhite, 1, 255), outBlack: clamp(all.outBlack, 0, 255), outWhite: clamp(all.outWhite, 0, 255), gamma: clamp(all.gamma || 1, 0.1, 4) };
      return { type: 'levels', params: p, approx: !(id(rr) && id(gg) && id(bb)) || undefined };
    }
    if (key === 'curv') {
      r.u8(); const ver = r.u16(); if (ver !== 1 && ver !== 4) return null;
      const mask = r.u32(), names = ['rgb', 'r', 'g', 'b'], out = { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] };
      let extra = false;
      for (let i = 0; i < 32; i++) {
        if (!(mask & (1 << i))) continue;
        const n = r.u16(), pts = []; for (let k = 0; k < n; k++) { const o = r.u16(), inp = r.u16(); pts.push([inp, o]); }
        if (i < 4) out[names[i]] = pts.sort((a, b) => a[0] - b[0]); else extra = true;
      }
      return { type: 'curves', params: out, approx: extra || undefined };
    }
  } catch { return null; }
  return null;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
class Writer {
  constructor(size = 1 << 20) { this.b = new Uint8Array(size); this.v = new DataView(this.b.buffer); this.p = 0; }
  grow(n) { if (this.p + n <= this.b.length) return; let s = this.b.length * 2; while (s < this.p + n) s *= 2; const nb = new Uint8Array(s); nb.set(this.b.subarray(0, this.p)); this.b = nb; this.v = new DataView(nb.buffer); }
  u8(x) { this.grow(1); this.b[this.p++] = x; }
  u16(x) { this.grow(2); this.v.setUint16(this.p, x); this.p += 2; }
  i16(x) { this.grow(2); this.v.setInt16(this.p, x); this.p += 2; }
  u32(x) { this.grow(4); this.v.setUint32(this.p, x >>> 0); this.p += 4; }
  i32(x) { this.grow(4); this.v.setInt32(this.p, x); this.p += 4; }
  f32(x) { this.grow(4); this.v.setFloat32(this.p, x); this.p += 4; }
  str(s) { this.grow(s.length); for (let i = 0; i < s.length; i++) this.b[this.p++] = s.charCodeAt(i) & 255; }
  bytes(a) { this.grow(a.length); this.b.set(a, this.p); this.p += a.length; }
  pad(m) { while (this.p % m) this.u8(0); }
  /** Reserve a u32 length, run fn, write the length (padded to `align`, padding counted in the length). */
  section(fn, align = 1) { const at = this.p; this.u32(0); fn(); while ((this.p - at - 4) % align) this.u8(0); this.v.setUint32(at, this.p - at - 4); }
  out() { return this.b.slice(0, this.p); }
}
/** Tintwork adjustment → [key, bytes] for the PSD block, or null. */
export function encodeAdjustment(type, params = {}) {
  const w = new Writer(512);
  if (type === 'invert') return ['nvrt', new Uint8Array(0)];
  if (type === 'brightnessContrast') { w.i16(Math.round(params.brightness || 0)); w.i16(Math.round(params.contrast || 0)); w.u16(127); w.u8(0); w.u8(0); return ['brit', w.out()]; }
  if (type === 'exposure') { w.u16(1); w.f32(params.exposure || 0); w.f32(params.offset || 0); w.f32(params.gamma || 1); return ['expA', w.out()]; }
  if (type === 'hueSaturation' || type === 'grayscale') {
    const p = type === 'grayscale' ? { hue: 0, saturation: -100, lightness: 0 } : params;
    w.u16(2); w.u8(0); w.u8(0); w.i16(0); w.i16(25); w.i16(0);
    w.i16(Math.round(p.hue || 0)); w.i16(Math.round(p.saturation || 0)); w.i16(Math.round(p.lightness || 0));
    for (const rg of HUE_RANGES) { for (const v of rg) w.i16(v); w.i16(0); w.i16(0); w.i16(0); }
    return ['hue2', w.out()];
  }
  if (type === 'levels') {
    w.u16(2);
    const rec = (q) => { w.u16(q.inBlack); w.u16(q.inWhite); w.u16(q.outBlack); w.u16(q.outWhite); w.u16(Math.round(q.gamma * 100)); };
    rec({ inBlack: Math.round(params.inBlack ?? 0), inWhite: Math.round(params.inWhite ?? 255), outBlack: Math.round(params.outBlack ?? 0), outWhite: Math.round(params.outWhite ?? 255), gamma: params.gamma ?? 1 });
    for (let i = 1; i < 29; i++) rec({ inBlack: 0, inWhite: 255, outBlack: 0, outWhite: 255, gamma: 1 });
    return ['levl', w.out()];
  }
  if (type === 'curves') {
    const names = ['rgb', 'r', 'g', 'b'], isId = (pts) => !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255);
    let mask = 0; names.forEach((k, i) => { if (!isId(params[k]) || i === 0) mask |= 1 << i; });
    w.u8(0); w.u16(1); w.u32(mask);
    names.forEach((k, i) => { if (!(mask & (1 << i))) return; const pts = (params[k] || [[0, 0], [255, 255]]).slice(0, 19); w.u16(pts.length); for (const [x, y] of pts) { w.u16(Math.round(y)); w.u16(Math.round(x)); } });
    return ['curv', w.out()];
  }
  return null;
}

// ---- writing ---------------------------------------------------------------------------------------------
function packBits(src, out) {
  // PackBits run-length encoding of one row; returns bytes written into out (at out.p)
  const n = src.length; let i = 0; const start = out.p;
  while (i < n) {
    let run = 1; while (i + run < n && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 2) { out.u8(257 - run); out.u8(src[i]); i += run; continue; }
    let lit = 1; while (i + lit < n && lit < 128 && !(i + lit + 1 < n && src[i + lit] === src[i + lit + 1])) lit++;
    out.u8(lit - 1); out.grow(lit); out.b.set(src.subarray(i, i + lit), out.p); out.p += lit; i += lit;
  }
  return out.p - start;
}
/** One channel → compressed block bytes (compression field included). */
function encodePlane(samples, w, h, deep) {
  const bps = deep ? 2 : 1, rowBytes = w * bps;
  if (!w || !h) return new Uint8Array([0, 0]);
  if (deep) { // ZIP with prediction (16-bit)
    const b = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) { let prev = 0; for (let x = 0; x < w; x++) { const v = samples[y * w + x], d = (v - prev) & 65535; prev = v; const i = (y * w + x) * 2; b[i] = d >> 8; b[i + 1] = d & 255; } }
    const z = zlibSync(b, { level: 6 }), out = new Uint8Array(z.length + 2); out[1] = 3; out.set(z, 2); return out;
  }
  const wr = new Writer(rowBytes * h / 2 + h * 2 + 64); wr.u16(1);
  const countsAt = wr.p; for (let y = 0; y < h; y++) wr.u16(0);
  for (let y = 0; y < h; y++) { const len = packBits(samples.subarray(y * w, (y + 1) * w), wr); wr.v.setUint16(countsAt + y * 2, len); }
  return wr.out();
}
function plane(rgba, n, c) { const T = rgba.constructor, out = new T(n); for (let i = 0; i < n; i++) out[i] = rgba[i * 4 + c]; return out; }
const BLEND_OK = /^[ -~]{4}$/;
/**
 * doc.layers: bottom → top, each { name, top, left, width, height, opacity, visible, blendKey, clipping,
 *   section (0 / 1 / 2 / 3), sectionBlend, pixels (RGBA, Uint8 or Uint16 by depth), mask { top, left, width,
 *   height, data Uint8, defaultColor, disabled }, adjKey, adjData }.
 */
export function writePSD(doc) {
  const { width, height } = doc, deep = doc.depth === 16, max = deep ? 65535 : 255, n = width * height;
  const comp = doc.composite;
  let alphaUsed = false; for (let i = 3; i < comp.length; i += 4) if (comp[i] !== max) { alphaUsed = true; break; }
  const w = new Writer(Math.max(1 << 20, n * (deep ? 3 : 1)));
  w.str('8BPS'); w.u16(1); w.u32(0); w.u16(0); w.u16(alphaUsed ? 4 : 3); w.u32(height); w.u32(width); w.u16(deep ? 16 : 8); w.u16(3);
  w.u32(0); // color mode data
  w.section(() => { // image resources: resolution
    const dpi = doc.dpi || 72; w.str('8BIM'); w.u16(1005); w.u16(0);
    w.u32(16); w.u32(dpi * 65536); w.u16(1); w.u16(1); w.u32(dpi * 65536); w.u16(1); w.u16(1);
  });
  const layerInfo = () => {
    const L = doc.layers, blocks = [];
    w.i16(alphaUsed ? -L.length : L.length);
    for (const l of L) {
      const nPix = l.pixels ? l.width * l.height : 0, chans = [];
      if (l.section === 1 || l.section === 2 || l.section === 3 || l.adjKey || !nPix) {
        for (const id of [-1, 0, 1, 2]) chans.push({ id, data: new Uint8Array([0, 0]) });
      } else {
        for (const [id, c] of [[-1, 3], [0, 0], [1, 1], [2, 2]]) chans.push({ id, data: encodePlane(plane(l.pixels, nPix, c), l.width, l.height, deep) });
      }
      if (l.mask && l.mask.data) {
        const m = l.mask, md = deep ? Uint16Array.from(m.data, (v) => v * 257) : m.data;
        chans.push({ id: -2, data: encodePlane(md, m.width, m.height, deep) });
      }
      blocks.push(chans);
      const empty = !nPix || l.adjKey || l.section;
      w.i32(empty ? 0 : l.top); w.i32(empty ? 0 : l.left); w.i32(empty ? 0 : l.top + l.height); w.i32(empty ? 0 : l.left + l.width);
      w.u16(chans.length); for (const c of chans) { w.i16(c.id); w.u32(c.data.length); }
      w.str('8BIM'); w.str(BLEND_OK.test(l.blendKey || '') ? l.blendKey : 'norm');
      w.u8(Math.round(clamp(l.opacity ?? 1, 0, 1) * 255)); w.u8(l.clipping ? 1 : 0);
      w.u8((l.visible === false ? 2 : 0) | (l.section ? 8 | 16 : 0)); w.u8(0);
      w.section(() => {
        if (l.mask && l.mask.data) { w.u32(20); w.i32(l.mask.top); w.i32(l.mask.left); w.i32(l.mask.top + l.mask.height); w.i32(l.mask.left + l.mask.width); w.u8(l.mask.defaultColor ?? 0); w.u8(l.mask.disabled ? 2 : 0); w.u16(0); }
        else w.u32(0);
        w.section(() => { for (let k = 0; k < 4; k++) { w.u32(0x0000ffff); w.u32(0x0000ffff); } });
        const nm = (l.section === 3 ? '</Layer group>' : l.name || 'Layer');
        const ascii = nm.replace(/[^\x20-\x7e]/g, '?').slice(0, 255), nameAt = w.p; w.u8(ascii.length); w.str(ascii);
        while ((w.p - nameAt) % 4) w.u8(0);
        const block = (key, fn) => { w.str('8BIM'); w.str(key); w.section(fn, 2); };
        block('luni', () => { w.u32(nm.length); for (let i = 0; i < nm.length; i++) w.u16(nm.charCodeAt(i)); });
        if (l.id != null) block('lyid', () => w.u32(l.id));
        if (l.section) block('lsct', () => { w.u32(l.section); if (l.section !== 3) { w.str('8BIM'); w.str(l.sectionBlend || 'pass'); } });
        if (l.adjKey) block(l.adjKey, () => w.bytes(l.adjData || new Uint8Array(0)));
      });
    }
    for (const chans of blocks) for (const c of chans) w.bytes(c.data);
  };
  w.section(() => { // layer and mask information
    if (deep) { w.u32(0); w.u32(0); w.str('8BIM'); w.str('Lr16'); w.section(layerInfo, 4); }
    else { w.section(layerInfo, 4); w.u32(0); }
  }, 2);
  // composite image (RLE, planar)
  const chans = alphaUsed ? [0, 1, 2, 3] : [0, 1, 2], bps = deep ? 2 : 1, rowBytes = width * bps;
  w.u16(1); const countsAt = w.p; for (let i = 0; i < chans.length * height; i++) w.u16(0);
  const row = new Uint8Array(rowBytes);
  chans.forEach((c, ci) => {
    for (let y = 0; y < height; y++) {
      if (deep) for (let x = 0; x < width; x++) { const v = comp[(y * width + x) * 4 + c]; row[x * 2] = v >> 8; row[x * 2 + 1] = v & 255; }
      else for (let x = 0; x < width; x++) row[x] = comp[(y * width + x) * 4 + c];
      const len = packBits(row, w); w.v.setUint16(countsAt + (ci * height + y) * 2, len);
    }
  });
  return w.out();
}

// ---- blend modes -----------------------------------------------------------------------------------------
export const PSD_TO_BLEND = { norm: 'source-over', mul: 'multiply', scrn: 'screen', over: 'overlay', dark: 'darken', lite: 'lighten', div: 'color-dodge',
  idiv: 'color-burn', hLit: 'hard-light', sLit: 'soft-light', diff: 'difference', smud: 'exclusion', hue: 'hue', sat: 'saturation', colr: 'color', lum: 'luminosity', pass: 'pass-through' };
// modes without an exact Tintwork equivalent → closest available mode
export const PSD_APPROX = { diss: 'source-over', lbrn: 'multiply', dkCl: 'darken', lddg: 'screen', lgCl: 'lighten', vLit: 'overlay', lLit: 'hard-light', pLit: 'hard-light',
  hMix: 'hard-light', fsub: 'difference', fdiv: 'color-dodge' };
export const BLEND_TO_PSD = Object.fromEntries(Object.entries(PSD_TO_BLEND).map(([k, v]) => [v, k.padEnd(4, ' ')]));
export const PSD_MODE_NAMES = { diss: 'Dissolve', lbrn: 'Linear burn', dkCl: 'Darker color', lddg: 'Linear dodge (add)', lgCl: 'Lighter color', vLit: 'Vivid light', lLit: 'Linear light', pLit: 'Pin light', hMix: 'Hard mix', fsub: 'Subtract', fdiv: 'Divide' };
/** 4-char key → { blend, approx } */
export function blendFromKey(key) {
  const k = (key || 'norm').trim();
  if (PSD_TO_BLEND[k]) return { blend: PSD_TO_BLEND[k], approx: false };
  if (PSD_APPROX[k]) return { blend: PSD_APPROX[k], approx: true, name: PSD_MODE_NAMES[k] };
  return { blend: 'source-over', approx: true, name: k };
}
