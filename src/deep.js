// 16-bit-per-channel image operations ("deep" images). A DImage is { width, height, data: Uint16Array RGBA }
// with straight (non-premultiplied) alpha and sRGB-encoded values 0..65535. Every operation mirrors the
// 8-bit version in pixels.js (same formulas, same parameters) so switching depth never changes the look,
// only the precision. Also holds a float compositor with the 16 blend modes for 16-bit export / flatten.
import { pointFns, rgbToHsl, hslToRgb, boxBlurPass, boxSizes, cubeLookup } from './pixels.js';

export const BLEND_NAMES = ['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
export const blendIndex = (name) => Math.max(0, BLEND_NAMES.indexOf(name));

const c16 = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : v);
export const createDeep = (width, height, data = null) => ({ width, height, data: data || new Uint16Array(width * height * 4) });
export const cloneDeep = (d) => createDeep(d.width, d.height, new Uint16Array(d.data));
export const deepBytes = (w, h) => w * h * 8;

export function deepFromImageData(img) {
  const s = img.data, out = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] * 257;
  return createDeep(img.width, img.height, out);
}

// small integer hash -> [0,1) used for dithering (deterministic, so the same image exports identically)
const hash01 = (i, seed) => {
  let x = (i ^ (seed * 0x9e3779b9)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

/**
 * Reduce to 8 bits. With `dither`, each channel is rounded up or down at random in proportion to its
 * fractional part (unbiased random rounding): smooth 16-bit gradients come out without visible bands, and
 * values that are exact in 8 bits stay exact (so 8-bit content round-trips unchanged).
 */
export function deepToImageData(d, { dither = false, seed = 1 } = {}) {
  const s = d.data, out = new ImageData(d.width, d.height), o = out.data;
  // Uint8ClampedArray rounds to nearest, so v / 257 is the nearest 8-bit level (the same rounding reconcileDeep checks)
  if (!dither) { for (let i = 0; i < s.length; i++) o[i] = s[i] / 257; return out; }
  for (let i = 0; i < s.length; i += 4) {
    o[i + 3] = s[i + 3] / 257;
    for (let c = 0; c < 3; c++) { const v = s[i + c] / 257, f = Math.floor(v); o[i + c] = f + (hash01(i + c, seed) < v - f ? 1 : 0); }
  }
  return out;
}

/**
 * Keep the 16-bit data of a layer in step with its 8-bit canvas after an 8-bit edit (brush, transform, …):
 * where the canvas still shows the rounded 16-bit value the deep pixel is kept; elsewhere it is replaced by
 * the 8-bit value (so edited areas become 8-bit precise, untouched areas keep 16 bits).
 * `ox, oy` = position of the old deep data relative to the canvas.
 */
export function reconcileDeep(old, ox, oy, img) {
  const W = img.width, H = img.height, s = img.data, out = new Uint16Array(W * H * 4), od = old ? old.data : null;
  let kept = 0;
  for (let y = 0; y < H; y++) {
    const sy = y - oy, rowOk = od && sy >= 0 && sy < old.height;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, sx = x - ox;
      if (rowOk && sx >= 0 && sx < old.width) {
        const j = (sy * old.width + sx) * 4, a8 = s[i + 3], da = od[j + 3];
        if (Math.round(da / 257) === a8) {
          const tol = a8 === 255 ? 0 : a8 === 0 ? 255 : Math.ceil(255 / a8);
          if (a8 === 0 || (Math.abs(Math.round(od[j] / 257) - s[i]) <= tol && Math.abs(Math.round(od[j + 1] / 257) - s[i + 1]) <= tol && Math.abs(Math.round(od[j + 2] / 257) - s[i + 2]) <= tol)) {
            out[i] = od[j]; out[i + 1] = od[j + 1]; out[i + 2] = od[j + 2]; out[i + 3] = da; kept++; continue;
          }
        }
      }
      out[i] = s[i] * 257; out[i + 1] = s[i + 1] * 257; out[i + 2] = s[i + 2] * 257; out[i + 3] = s[i + 3] * 257;
    }
  }
  const r = createDeep(W, H, out); r.kept = kept; return r;
}

/** Copy `src` into a new w×h deep image at (dx, dy) (transparent elsewhere). */
export function padDeep(src, w, h, dx, dy) {
  const out = createDeep(w, h);
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy; if (ty < 0 || ty >= h) continue;
    const x0 = Math.max(0, -dx), x1 = Math.min(src.width, w - dx); if (x1 <= x0) continue;
    out.data.set(src.data.subarray((y * src.width + x0) * 4, (y * src.width + x1) * 4), (ty * w + x0 + dx) * 4);
  }
  return out;
}

// ---- point operations ---------------------------------------------------------------------------
export function lut16(fn) {
  const t = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) t[i] = Math.round(fn(i / 257) * 257);
  return t;
}
function applyLut16(d, fns) {
  const [r, g, b] = fns.map(lut16), s = d.data;
  for (let i = 0; i < s.length; i += 4) { s[i] = r[s[i]]; s[i + 1] = g[s[i + 1]]; s[i + 2] = b[s[i + 2]]; }
  return d;
}
function hueSat(d, { hue = 0, saturation = 0, lightness = 0 }) {
  const s = d.data, hs = hue / 360, ss = saturation / 100, ls = lightness / 100;
  for (let i = 0; i < s.length; i += 4) {
    let [h, sa, l] = rgbToHsl(s[i] / 257, s[i + 1] / 257, s[i + 2] / 257);
    h = (h + hs + 1) % 1;
    sa = ss > 0 ? sa + (1 - sa) * ss : sa * (1 + ss);
    l = ls > 0 ? l + (1 - l) * ls : l * (1 + ls);
    const [r, g, b] = hslToRgb(h, sa, l);
    s[i] = c16(Math.round(r * 257)); s[i + 1] = c16(Math.round(g * 257)); s[i + 2] = c16(Math.round(b * 257));
  }
  return d;
}
function grayscale(d) {
  const s = d.data;
  for (let i = 0; i < s.length; i += 4) s[i] = s[i + 1] = s[i + 2] = Math.round(0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2]);
  return d;
}
function sepia(d, { amount = 100 } = {}) {
  const s = d.data, a = amount / 100;
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i], g = s[i + 1], b = s[i + 2];
    s[i] = c16(Math.round(r + (0.393 * r + 0.769 * g + 0.189 * b - r) * a));
    s[i + 1] = c16(Math.round(g + (0.349 * r + 0.686 * g + 0.168 * b - g) * a));
    s[i + 2] = c16(Math.round(b + (0.272 * r + 0.534 * g + 0.131 * b - b) * a));
  }
  return d;
}

// ---- filters ------------------------------------------------------------------------------------
const toLin = (v) => { v /= 65535; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 65535;
let linTable = null;
/** Gaussian blur (σ = radius) on premultiplied floats; `linear` blurs in linear light (physically smoother). */
export function gaussianBlurDeep(d, radius, linear = false) {
  if (radius <= 0) return d;
  const { width: w, height: h, data } = d, n = data.length;
  if (linear && !linTable) { linTable = new Float32Array(65536); for (let i = 0; i < 65536; i++) linTable[i] = toLin(i) * 65535; }
  let a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i += 4) {
    const al = data[i + 3] / 65535;
    if (linear) { a[i] = linTable[data[i]] * al; a[i + 1] = linTable[data[i + 1]] * al; a[i + 2] = linTable[data[i + 2]] * al; }
    else { a[i] = data[i] * al; a[i + 1] = data[i + 1] * al; a[i + 2] = data[i + 2] * al; }
    a[i + 3] = data[i + 3];
  }
  for (const sz of boxSizes(radius)) { const r = (sz - 1) / 2; boxBlurPass(a, b, w, h, r, true); boxBlurPass(b, a, w, h, r, false); }
  for (let i = 0; i < n; i += 4) {
    const al = a[i + 3] / 65535;
    data[i + 3] = c16(Math.round(a[i + 3]));
    if (al > 0) for (let c = 0; c < 3; c++) { const v = a[i + c] / al; data[i + c] = c16(Math.round(linear ? toSrgb(v / 65535) : v)); }
  }
  return d;
}
function sharpenDeep(d, { amount = 80, radius = 1.5, threshold = 0 }, linear) {
  const bl = gaussianBlurDeep(cloneDeep(d), radius, linear), s = d.data, bd = bl.data, k = amount / 100, th = threshold * 257;
  for (let i = 0; i < s.length; i += 4) for (let c = 0; c < 3; c++) {
    const diff = s[i + c] - bd[i + c];
    if (Math.abs(diff) >= th) s[i + c] = c16(Math.round(s[i + c] + diff * k));
  }
  return d;
}
function noiseDeep(d, { amount = 20, monochrome = true, seed = 1 }) {
  let st = seed >>> 0 || 1;
  const rnd = () => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; return ((st >>> 0) / 4294967296) - 0.5; };
  const s = d.data, k = amount * 2.55 * 257;
  for (let i = 0; i < s.length; i += 4) {
    if (s[i + 3] === 0) continue;
    if (monochrome) { const v = rnd() * k; for (let c = 0; c < 3; c++) s[i + c] = c16(Math.round(s[i + c] + v)); }
    else for (let c = 0; c < 3; c++) s[i + c] = c16(Math.round(s[i + c] + rnd() * k));
  }
  return d;
}
function vignetteDeep(d, { amount = 50, size = 60, feather = 50 }, fullW, fullH, offX = 0, offY = 0) {
  const { width: w, height: h, data } = d, W = fullW || w, H = fullH || h;
  const cx = W / 2, cy = H / 2, maxR = Math.sqrt(cx * cx + cy * cy), inner = (size / 100) * maxR, outer = inner + Math.max(1, (feather / 100) * maxR), k = amount / 100;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + offX - cx, dy = y + offY - cy;
    let t = (Math.sqrt(dx * dx + dy * dy) - inner) / (outer - inner); t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) data[i + c] = c16(Math.round(k >= 0 ? data[i + c] * (1 - t * k) : data[i + c] + (65535 - data[i + c]) * (-t * k)));
  }
  return d;
}
function autoLevelsDeep(d) {
  const hist = new Uint32Array(256), s = d.data; let total = 0;
  for (let i = 0; i < s.length; i += 4) { if (s[i + 3] === 0) continue; hist[Math.round((0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2]) / 257)]++; total++; }
  const clip = total * 0.005; let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > clip) break; }
  acc = 0; for (; hi > 0; hi--) { acc += hist[hi]; if (acc > clip) break; }
  if (hi <= lo) return d;
  return applyLut16(d, pointFns('levels', { inBlack: lo, inWhite: hi }));
}

export const DEEP_OPS = ['brightnessContrast', 'exposure', 'levels', 'invert', 'curves', 'hueSaturation', 'grayscale', 'sepia', 'gaussianBlur', 'sharpen', 'noise', 'vignette', 'autoLevels', 'whiteBalance', 'lut3d'];
/** 16-bit counterpart of pixels.runOp (in place). info.linear = blur/sharpen in linear light. */
export function runDeep(name, d, params = {}, info = {}) {
  const fns = pointFns(name, params);
  if (fns) return applyLut16(d, fns);
  switch (name) {
    case 'hueSaturation': return hueSat(d, params);
    case 'grayscale': return grayscale(d);
    case 'sepia': return sepia(d, params);
    case 'gaussianBlur': return gaussianBlurDeep(d, params.radius, !!info.linear);
    case 'sharpen': return sharpenDeep(d, params, !!info.linear);
    case 'noise': return noiseDeep(d, params);
    case 'vignette': return vignetteDeep(d, params, info.docW, info.docH, info.offX, info.offY);
    case 'autoLevels': return autoLevelsDeep(d);
    case 'lut3d': return lut3dDeep(d, params);
    default: throw new Error(`Unknown operation ${name}`);
  }
}
function lut3dDeep(d, p) {
  const L = p.table; if (!L) return d;
  const a = d.data, o = [0, 0, 0], k = (p.amount ?? 100) / 100, cl = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v));
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0) continue;
    const r = a[i], g = a[i + 1], b = a[i + 2]; cubeLookup(L, r / 65535, g / 65535, b / 65535, o);
    a[i] = cl(r + (o[0] * 65535 - r) * k); a[i + 1] = cl(g + (o[1] * 65535 - g) * k); a[i + 2] = cl(b + (o[2] * 65535 - b) * k);
  }
  return d;
}
/** Soft-selection blend (mask 0..255 per pixel) of a processed 16-bit result over the original. */
export function blendMaskedDeep(orig, res, mask) {
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    const m = mask[i]; if (m === 255) continue;
    if (m === 0) { res[j] = orig[j]; res[j + 1] = orig[j + 1]; res[j + 2] = orig[j + 2]; res[j + 3] = orig[j + 3]; continue; }
    const k = m / 255; for (let c = 0; c < 4; c++) res[j + c] = Math.round(orig[j + c] + (res[j + c] - orig[j + c]) * k);
  }
}

// ---- float compositor (W3C compositing & blending, premultiplied) -------------------------------
const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c) {
  const l = lum(c[0], c[1], c[2]), n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / (l - n);
  if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (1 - l)) / (x - l);
  return c;
}
function setLum(c, l) { const d = l - lum(c[0], c[1], c[2]); return clipColor([c[0] + d, c[1] + d, c[2] + d]); }
const sat = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c, s) {
  const o = [0, 0, 0], idx = [0, 1, 2].sort((a, b) => c[a] - c[b]), [mn, md, mx] = idx;
  if (c[mx] > c[mn]) { o[md] = ((c[md] - c[mn]) * s) / (c[mx] - c[mn]); o[mx] = s; }
  return o;
}
function sepBlend(m, b, s) {
  switch (m) {
    case 1: return b * s;
    case 2: return b + s - b * s;
    case 3: return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s); // overlay = hard-light with layers swapped
    case 4: return Math.min(b, s);
    case 5: return Math.max(b, s);
    case 6: return b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 7: return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case 8: return s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1);
    case 9: {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const D = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
      return b + (2 * s - 1) * (D - b);
    }
    case 10: return Math.abs(b - s);
    case 11: return b + s - 2 * b * s;
    default: return s;
  }
}
/** Blend premultiplied source (sr..sa) onto premultiplied destination array `d` at index i. */
export function blendInto(d, i, sr, sg, sb, sa, mode) {
  const dr = d[i], dg = d[i + 1], db = d[i + 2], da = d[i + 3];
  if (mode === 0) { const k = 1 - sa; d[i] = sr + dr * k; d[i + 1] = sg + dg * k; d[i + 2] = sb + db * k; d[i + 3] = sa + da * k; return; }
  if (sa <= 0) return;
  const cb = da > 0 ? [Math.min(1, dr / da), Math.min(1, dg / da), Math.min(1, db / da)] : [0, 0, 0];
  const cs = [Math.min(1, sr / sa), Math.min(1, sg / sa), Math.min(1, sb / sa)];
  let B;
  if (mode >= 12) {
    B = mode === 12 ? setLum(setSat(cs, sat(cb)), lum(...cb)) : mode === 13 ? setLum(setSat(cb, sat(cs)), lum(...cb)) : mode === 14 ? setLum(cs, lum(...cb)) : setLum(cb, lum(...cs));
  } else B = [sepBlend(mode, cb[0], cs[0]), sepBlend(mode, cb[1], cs[1]), sepBlend(mode, cb[2], cs[2])];
  const ks = 1 - da, kd = 1 - sa, both = sa * da;
  d[i] = sr * ks + dr * kd + both * B[0]; d[i + 1] = sg * ks + dg * kd + both * B[1]; d[i + 2] = sb * ks + db * kd + both * B[2];
  d[i + 3] = sa + da * kd;
}

/** Float premultiplied accumulator -> straight DImage. */
export function accToDeep(acc, W, H) {
  const out = createDeep(W, H), o = out.data;
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3]; o[i + 3] = c16(Math.round(a * 65535));
    if (a > 0) for (let c = 0; c < 3; c++) o[i + c] = c16(Math.round((acc[i + c] / a) * 65535));
  }
  return out;
}

/**
 * Composite layers at float precision. Layer descriptors:
 *  { kind:'pixels', img: DImage, x, y, opacity, mode, mask?: { alpha: Uint8 per pixel, w, h, x, y } }
 *  { kind:'adjust', op, params, opacity, mode, mask? }
 * Returns a Float32Array of premultiplied RGBA (0..1).
 */
export function compositeDeep(W, H, layers, { background = null, info = {} } = {}) {
  const acc = new Float32Array(W * H * 4);
  if (background) for (let i = 0; i < acc.length; i += 4) { acc[i] = background[0] / 255; acc[i + 1] = background[1] / 255; acc[i + 2] = background[2] / 255; acc[i + 3] = 1; }
  const maskAt = (m, x, y) => { const mx = x - m.x, my = y - m.y; return mx < 0 || my < 0 || mx >= m.w || my >= m.h ? 0 : m.alpha[my * m.w + mx] / 255; };
  let acc2 = acc; const stack = [];
  return composeList(acc2);
  function composeList(acc) {
  for (const L of layers) {
    if (L.kind === 'groupBegin') { stack.push(acc); acc = new Float32Array(W * H * 4); continue; }
    if (L.kind === 'passBegin') { stack.push(acc); acc = acc.slice(); continue; }
    if (L.kind === 'groupEnd' || L.kind === 'passEnd') {
      const inner = acc; acc = stack.pop();
      if (L.opacity <= 0) continue;
      for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
        const k = L.opacity * (L.mask ? maskAt(L.mask, x, y) : 1); if (k <= 0) continue;
        if (L.kind === 'passEnd') { const kk = 1 - k; for (let c = 0; c < 4; c++) acc[i + c] = acc[i + c] * kk + inner[i + c] * k; }
        else if (inner[i + 3] > 0) blendInto(acc, i, inner[i] * k, inner[i + 1] * k, inner[i + 2] * k, inner[i + 3] * k, L.mode);
      }
      continue;
    }
    if (L.opacity <= 0) continue;
    if (L.kind === 'adjust') {
      const below = accToDeep(acc, W, H);
      const adj = runDeep(L.op, below, L.params || {}, { docW: W, docH: H, offX: 0, offY: 0, ...info }).data;
      for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
        const k = L.opacity * (L.mask ? maskAt(L.mask, x, y) : 1); if (k <= 0) continue;
        const a = adj[i + 3] / 65535, f = a / 65535;
        const sr = adj[i] * f, sg = adj[i + 1] * f, sb = adj[i + 2] * f;
        if (L.mode === 0) { const kk = 1 - k; acc[i] = acc[i] * kk + sr * k; acc[i + 1] = acc[i + 1] * kk + sg * k; acc[i + 2] = acc[i + 2] * kk + sb * k; acc[i + 3] = acc[i + 3] * kk + a * k; }
        else blendInto(acc, i, sr * k, sg * k, sb * k, a * k, L.mode);
      }
      continue;
    }
    const s = L.img, sd = s.data, x0 = Math.max(0, L.x), y0 = Math.max(0, L.y), x1 = Math.min(W, L.x + s.width), y1 = Math.min(H, L.y + s.height);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const j = ((y - L.y) * s.width + (x - L.x)) * 4, sa0 = sd[j + 3]; if (sa0 === 0) continue;
      const k = L.opacity * (L.mask ? maskAt(L.mask, x, y) : 1); if (k <= 0) continue;
      const a = (sa0 / 65535) * k, f = a / 65535;
      blendInto(acc, (y * W + x) * 4, sd[j] * f, sd[j + 1] * f, sd[j + 2] * f, a, L.mode);
    }
  }
  while (stack.length) acc = stack.shift(); // unbalanced markers: fall back to the outermost buffer
  return acc;
  }
}
