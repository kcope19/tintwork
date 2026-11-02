// Camera RAW develop maths (original code). Pure functions: runs in the codec / develop workers and in Node tests.
import { curveFn } from './pixels.js';
// Input is FlashRaw's demosaiced, as-shot white-balanced linear sRGB (3 channels, sensor orientation),
// either Float32 or half-float bits. Output is RGBA (16-bit and/or 8-bit), oriented, display-encoded sRGB.

export const DEFAULT_SETTINGS = Object.freeze({
  wb: 'as-shot', temp: 5500, tint: 0, // wb: 'as-shot' | 'auto' | 'custom'
  exposure: 0, highlights: 20, shadows: 0, contrast: 0,
  vibrance: 0, saturation: 0, curve: null, // curve: { rgb, r, g, b } point lists in 0..255 (null = straight)
  sharpen: 25, sharpRadius: 1, sharpDetail: 25, sharpMask: 0,
  nrLuma: 0, nrColor: 25, lens: true, vignette: 0,
  caAuto: false, caRed: 0, caBlue: 0, // lateral chromatic aberration: automatic estimate + manual red/cyan, blue/yellow
});
export const RANGES = {
  temp: [2000, 50000], tint: [-150, 150], exposure: [-5, 5], highlights: [0, 100], shadows: [-100, 100], contrast: [-100, 100],
  vibrance: [-100, 100], saturation: [-100, 100], sharpen: [0, 150], sharpRadius: [0.5, 3], sharpDetail: [0, 100], sharpMask: [0, 100],
  nrLuma: [0, 100], nrColor: [0, 100], vignette: [-100, 100], caRed: [-100, 100], caBlue: [-100, 100],
};
/** Lateral CA slider ±100 = ±0.4 % radial scale of the red or blue channel against green. */
export const CA_UNIT = 0.004;
/** Settings with every key valid (unknown keys dropped, numbers clamped): used for presets read from storage. */
export function cleanSettings(s) {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const v = s?.[k]; if (v === undefined) continue;
    if (k === 'wb') { if (['as-shot', 'auto', 'custom'].includes(v)) out.wb = v; }
    else if (k === 'curve') { out.curve = v && typeof v === 'object' ? Object.fromEntries(['rgb', 'r', 'g', 'b'].map((c) => [c, Array.isArray(v[c]) && v[c].length >= 2 ? v[c].map(([x, y]) => [+x || 0, +y || 0]) : [[0, 0], [255, 255]]])) : null; }
    else if (typeof DEFAULT_SETTINGS[k] === 'boolean') out[k] = !!v;
    else if (Number.isFinite(+v)) { const r = RANGES[k]; out[k] = r ? Math.min(r[1], Math.max(r[0], +v)) : +v; }
  }
  return out;
}
const isStraight = (p) => !p || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 255 && p[1][1] === 255);
export const curveIsIdentity = (c) => !c || ['rgb', 'r', 'g', 'b'].every((k) => isStraight(c[k]));

// ---- small linear algebra ---------------------------------------------------------------------------------
const mul3 = (a, b) => { const o = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]; return o; };
const mulv = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
export function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (!det || !isFinite(det)) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
const diag = (v) => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// linear sRGB (D65) → XYZ
const XYZ_FROM_SRGB = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];

// ---- colour temperature ------------------------------------------------------------------------------------
/** CIE xy of a blackbody (Planckian locus, cubic approximation, 1667–25000 K; clamped outside). */
export function planckXY(T) {
  T = Math.min(25000, Math.max(1667, T));
  const t = 1e3 / T, t2 = t * t, t3 = t2 * t;
  const x = T <= 4000 ? -0.2661239 * t3 - 0.234358 * t2 + 0.8776956 * t + 0.17991 : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222 ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000 ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
    : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}
const xyToUV = ([x, y]) => { const d = -2 * x + 12 * y + 3; return [4 * x / d, 6 * y / d]; };
const uvToXY = ([u, v]) => { const d = 2 * u - 8 * v + 4; return [3 * u / d, 2 * v / d]; };
/** xy for a temperature and a tint (tint: offset from the locus, + = the light is greener, so the photo turns magenta). */
export function tempTintXY(T, tint) {
  const uv = xyToUV(planckXY(T)), uv2 = xyToUV(planckXY(T * 1.01));
  let nx = -(uv2[1] - uv[1]), ny = uv2[0] - uv[0]; const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
  if (ny < 0) { nx = -nx; ny = -ny; } // normal pointing towards green (+v)
  const k = tint / 3000;
  return uvToXY([uv[0] + nx * k, uv[1] + ny * k]);
}
const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];

// ---- camera colour model ------------------------------------------------------------------------------------
const ILLUMINANT_K = { 1: 5500, 2: 4150, 3: 2856, 4: 5500, 9: 5500, 10: 6500, 11: 7500, 12: 6400, 13: 5000, 14: 4200, 15: 3450, 17: 2856, 18: 4874, 19: 6774, 20: 5503, 21: 6504, 22: 7504, 23: 5003, 24: 3200 };
/**
 * Colour model of a camera from FlashRaw metadata: converts between white balance multipliers (camera space)
 * and temperature / tint, and builds the white balance change matrix in linear sRGB.
 */
export function colorModel(meta) {
  const list = (meta.colorMatrices?.color || []).filter((c) => c.values?.length === 9)
    .map((c) => ({ T: c.temperature || ILLUMINANT_K[c.illuminant] || 6500, m: c.values }))
    .sort((a, b) => a.T - b.T);
  const known = list.length > 0;
  if (!known) list.push({ T: 6504, m: inv3(XYZ_FROM_SRGB) }); // unknown camera: treat the sensor as linear sRGB
  /** XYZ → camera matrix at a colour temperature (mired interpolation between the calibrated illuminants). */
  const cmAt = (T) => {
    if (list.length === 1 || T <= list[0].T) return list[0].m;
    const last = list[list.length - 1]; if (T >= last.T) return last.m;
    const a = list[0], b = last, f = (1e6 / T - 1e6 / a.T) / (1e6 / b.T - 1e6 / a.T);
    return a.m.map((v, i) => v + (b.m[i] - v) * f);
  };
  // camera → linear sRGB with white preserved (dcraw-style: rows of cam_from_srgb normalised to 1)
  const ref = cmAt(6504), camSrgb = mul3(ref, XYZ_FROM_SRGB);
  for (let r = 0; r < 3; r++) { const s = camSrgb[r * 3] + camSrgb[r * 3 + 1] + camSrgb[r * 3 + 2] || 1; for (let c = 0; c < 3; c++) camSrgb[r * 3 + c] /= s; }
  const M = inv3(camSrgb) || IDENTITY, Minv = inv3(M) || IDENTITY;
  const norm = (v) => [v[0] / v[1], 1, v[2] / v[1]];
  /** White balance multipliers (G = 1) that make light of (T, tint) neutral. */
  const multipliersFor = (T, tint) => {
    // camera response to the illuminant; iterate once so the interpolated matrix matches its own temperature
    const n = norm(mulv(cmAt(T), xyToXYZ(tempTintXY(T, tint))));
    return [1 / n[0], 1, 1 / n[2]];
  };
  /** Temperature / tint whose multipliers match these (coarse-to-fine search). */
  const tempTintFor = (w) => {
    const target = [Math.log(w[0] / w[1]), Math.log(w[2] / w[1])];
    const err = (T, t) => { const m = multipliersFor(T, t); const a = Math.log(m[0]) - target[0], b = Math.log(m[2]) - target[1]; return a * a + b * b; };
    let best = { T: 5500, t: 0, e: Infinity };
    for (let mired = 20; mired <= 500; mired += 10) for (let t = -150; t <= 150; t += 15) { const T = 1e6 / mired, e = err(T, t); if (e < best.e) best = { T, t, e }; }
    let dm = 10, dt = 15;
    for (let it = 0; it < 30; it++) {
      dm /= 1.6; dt /= 1.6; const m0 = 1e6 / best.T;
      for (const [a, b] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
        const T = 1e6 / Math.max(20, Math.min(500, m0 + a * dm)), t = Math.max(-150, Math.min(150, best.t + b * dt)), e = err(T, t);
        if (e < best.e) best = { T, t, e };
      }
    }
    return { temp: Math.round(best.T / 10) * 10, tint: Math.round(best.t) };
  };
  const ws = meta.whiteBalance && meta.whiteBalance[1] ? meta.whiteBalance : null;
  let asShot = ws ? [ws[0] / ws[1], 1, ws[2] / ws[1]] : null;
  if (!asShot && meta.dng?.asShotNeutral?.length >= 3) { const n = meta.dng.asShotNeutral; asShot = [n[1] / n[0], 1, n[1] / n[2]]; }
  if (!asShot) asShot = multipliersFor(5500, 0);
  /** Matrix (linear sRGB → linear sRGB) that changes the as-shot balance to multipliers w. */
  const changeTo = (w) => mul3(mul3(M, diag([w[0] / asShot[0], 1, w[2] / asShot[2]])), Minv);
  return { known, M, Minv, cmAt, multipliersFor, tempTintFor, asShot, changeTo, asShotTT: tempTintFor(asShot) };
}
/** Gray-world auto white balance from a linear (as-shot) RGB preview: multipliers in camera space. */
export function autoMultipliers(model, src) {
  const d = src.data, n = d.length / 3; let r = 0, g = 0, b = 0, c = 0;
  const step = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += step) {
    const R = d[i * 3], G = d[i * 3 + 1], B = d[i * 3 + 2], m = Math.max(R, G, B), lo = Math.min(R, G, B);
    if (m > 0.95 || lo < 0.002) continue; // skip clipped and near-black pixels
    r += R; g += G; b += B; c++;
  }
  if (c < 16 || !g) return model.asShot.slice();
  const cam = mulv(model.Minv, [r / c, g / c, b / c]), k = [cam[1] / cam[0], 1, cam[1] / cam[2]];
  return [model.asShot[0] * k[0], 1, model.asShot[2] * k[2]];
}

// ---- tone pipeline ----------------------------------------------------------------------------------------------
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const srgbEnc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
export const LUT_SIZE = 16384;
/**
 * Everything the per-pixel loop needs: colour matrix (white balance and exposure folded in), highlight shoulder,
 * shadow lift and an output LUT (linear [0, 1] → display 0..65535: sRGB curve and the contrast S-curve).
 */
export function pipeline(meta, model, s, autoW = null) {
  const set = { ...DEFAULT_SETTINGS, ...s };
  let w = model.asShot;
  if (set.wb === 'auto') w = autoW || model.asShot;
  else if (set.wb === 'custom') w = model.multipliersFor(set.temp, set.tint);
  const base = meta.dng?.baselineExposure || 0;
  const gain = Math.pow(2, set.exposure + base);
  const C = model.changeTo(w).map((v) => v * gain);
  // highlight shoulder on the brightest channel: values up to `win` roll off into [knee, 1]
  const h = set.highlights / 100, win = 1 + 3 * h, knee = 0.7 - 0.2 * h;
  const a = win - knee, b = 1 - knee, cK = a > b + 1e-6 ? (a * b) / (a - b) : Infinity;
  // display curve: sRGB encoding, then a contrast S-curve around mid-grey (base contrast is a gentle camera-like curve)
  const p = 1.15 * Math.pow(2, set.contrast / 100), lut = new Float32Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    const x = srgbEnc(i / LUT_SIZE);
    const y = x < 0.5 ? 0.5 * Math.pow(2 * x, p) : 1 - 0.5 * Math.pow(2 * (1 - x), p);
    lut[i] = Math.min(65535, Math.max(0, y * 65535));
  }
  // point curve (display space, like the Curves adjustment: channel curve first, then the RGB curve)
  let luts = [lut, lut, lut];
  if (!curveIsIdentity(set.curve)) {
    const fm = curveFn(set.curve.rgb), k = 255 / 65535;
    luts = ['r', 'g', 'b'].map((c) => {
      const fc = isStraight(set.curve[c]) ? null : curveFn(set.curve[c]), o = new Float32Array(LUT_SIZE + 1);
      for (let i = 0; i <= LUT_SIZE; i++) { let v = lut[i] * k; if (fc) v = fc(v); v = fm(v); o[i] = Math.min(65535, Math.max(0, v / k)); }
      return o;
    });
  }
  return { C, gain, knee, cK, shadows: set.shadows / 100, lut, luts, vib: set.vibrance / 100, sat: 1 + set.saturation / 100, wb: w, settings: set };
}

// ---- lens corrections (DNG opcodes) -------------------------------------------------------------------------------
/**
 * Lens data from the DNG opcodes: { warp, vignette, baked } (null when absent or identity). `warp` / `vignette` are
 * left for the editor to apply; `baked` is a FixVignetteRadial the decoder already applied (undone when the user
 * turns lens corrections off).
 */
export function lensInfo(meta) {
  let warp = null, vignette = null, baked = null;
  for (const o of meta.opcodes || []) {
    if (o.name === 'WarpRectilinear' && o.params?.planes?.length && !o.applied) {
      const id = o.params.planes.every((p) => p.kr[0] === 1 && !p.kr[1] && !p.kr[2] && !p.kr[3] && !p.kt[0] && !p.kt[1]);
      if (!id) warp = { center: o.params.center || [0.5, 0.5], planes: o.params.planes };
    } else if (o.name === 'FixVignetteRadial' && o.params?.k?.some((k) => k)) {
      const v = { center: o.params.center || [0.5, 0.5], k: o.params.k };
      if (o.applied) baked = v; else vignette = v;
    }
  }
  return { warp, vignette, baked };
}

// ---- sources ----------------------------------------------------------------------------------------------------
let HALF = null;
/** Half-float bits → Float32 lookup table. */
export function halfTable() {
  if (HALF) return HALF;
  HALF = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    HALF[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? 0 : s * 65504) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return HALF;
}
/** Box-downscale a 3-channel source so its long side is at most maxSide (Float32 result). */
export function downscale(src, maxSide) {
  const { width: W, height: H, data } = src, half = src.half ? halfTable() : null;
  const f = Math.max(1, Math.ceil(Math.max(W, H) / maxSide)), w = Math.floor(W / f), h = Math.floor(H / f);
  const out = new Float32Array(w * h * 3), acc = new Float64Array(w * 3), k = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let yy = 0; yy < f; yy++) {
      let i = ((y * f + yy) * W) * 3;
      for (let x = 0; x < w; x++) for (let xx = 0; xx < f; xx++, i += 3) {
        if (half) { acc[x * 3] += half[data[i]]; acc[x * 3 + 1] += half[data[i + 1]]; acc[x * 3 + 2] += half[data[i + 2]]; }
        else { acc[x * 3] += data[i]; acc[x * 3 + 1] += data[i + 1]; acc[x * 3 + 2] += data[i + 2]; }
      }
    }
    for (let x = 0; x < w * 3; x++) out[y * w * 3 + x] = acc[x] * k;
  }
  return { width: w, height: h, data: out, half: false, factor: f };
}

// ---- the develop pass ---------------------------------------------------------------------------------------------
/** Output size for an orientation. */
export const orientedSize = (w, h, o) => (o >= 5 && o <= 8 ? [h, w] : [w, h]);
/** Affine map output (ox, oy) → stored (x, y) for EXIF orientation o: x = ax*ox + bx*oy + cx … */
function orientMap(o, W, H) {
  switch (o) {
    case 2: return [-1, 0, W - 1, 0, 1, 0];
    case 3: return [-1, 0, W - 1, 0, -1, H - 1];
    case 4: return [1, 0, 0, 0, -1, H - 1];
    case 5: return [0, 1, 0, 1, 0, 0];
    case 6: return [0, 1, 0, -1, 0, H - 1];
    case 7: return [0, -1, W - 1, -1, 0, H - 1];
    case 8: return [0, -1, W - 1, 1, 0, 0];
    default: return [1, 0, 0, 0, 1, 0];
  }
}
/** Full source size of a (possibly cropped-out) source region. */
const fullOf = (src) => [src.fullW || src.width, src.fullH || src.height];
/**
 * Resampling geometry shared by the develop loop and the band planner: maps a stored-image position (full-resolution
 * pixels of the opcode frame) to where channel c is read from, after the lens warp and the lateral CA scale.
 */
function geometry(src, opts) {
  const { lens = null, factor = 1 } = opts, [FW, FH] = fullOf(src);
  const fr = lens?.frame || { fullW: FW * factor, fullH: FH * factor, offX: 0, offY: 0 };
  const warp = lens?.warp, vig = lens?.vignette;
  const geo = (cen) => { const px = cen[0] * fr.fullW, py = cen[1] * fr.fullH; return { px, py, m: Math.hypot(Math.max(px, fr.fullW - px), Math.max(py, fr.fullH - py)) }; };
  const wg = warp ? geo(warp.center) : null, vg = vig ? geo(vig.center) : null;
  const wp = warp ? [0, 1, 2].map((c) => warp.planes[Math.min(c, warp.planes.length - 1)]) : null;
  const ca = opts.ca || null, ks = ca ? [1 + ca[0], 1, 1 + ca[1]] : null;
  const cc = wg || geo([0.5, 0.5]);
  /** out[0], out[1] = stored position (opcode frame) for output-frame position X, Y and channel c */
  const at = (X, Y, c, out) => {
    let sx = X, sy = Y;
    if (wp) {
      const p = wp[c], dx = (X - wg.px) / wg.m, dy = (Y - wg.py) / wg.m, r2 = dx * dx + dy * dy;
      const f = p.kr[0] + r2 * (p.kr[1] + r2 * (p.kr[2] + r2 * p.kr[3]));
      const tx = p.kt[0] * 2 * dx * dy + p.kt[1] * (r2 + 2 * dx * dx), ty = p.kt[0] * (r2 + 2 * dy * dy) + p.kt[1] * 2 * dx * dy;
      sx = wg.px + wg.m * (dx * f + tx); sy = wg.py + wg.m * (dy * f + ty);
    }
    if (ks && c !== 1) { sx = cc.px + (sx - cc.px) * ks[c]; sy = cc.py + (sy - cc.py) * ks[c]; }
    out[0] = sx; out[1] = sy;
  };
  return { fr, at, vg, vig, inv: !!lens?.invertVignette, factor, moves: !!(wp || ks) };
}
/**
 * Develop a source into RGBA. opts: { pipe, orientation, lens: { warp, vignette, invertVignette, frame } | null, vignette (manual, -1..1),
 *   ca: [red, blue] radial scale offsets | null, factor (source pixels are this many full-resolution pixels), rows: [first, end) output rows,
 *   out16: bool, out8: bool }
 * frame: { fullW, fullH, offX, offY } = the uncropped image the opcode coordinates refer to and where the source sits in it.
 * src may be a region of a larger source: { x0, y0, width, height, fullW, fullH, data, half }.
 */
export function develop(src, opts) {
  const { pipe, orientation = 1, factor = 1 } = opts;
  const W = src.width, H = src.height, d = src.data, half = src.half ? halfTable() : null, X0 = src.x0 || 0, Y0 = src.y0 || 0;
  const [FW, FH] = fullOf(src), [OW, OH] = orientedSize(FW, FH, orientation);
  const r0 = opts.rows ? opts.rows[0] : 0, r1 = opts.rows ? opts.rows[1] : OH, N = OW * (r1 - r0);
  const o16 = opts.out16 ? new Uint16Array(N * 4) : null, o8 = opts.out8 ? new Uint8ClampedArray(N * 4) : null;
  const [ax, bx, cx, ay, by, cy] = orientMap(orientation, FW, FH);
  const C = pipe.C, c0 = C[0], c1 = C[1], c2 = C[2], c3 = C[3], c4 = C[4], c5 = C[5], c6 = C[6], c7 = C[7], c8 = C[8];
  const knee = pipe.knee, cK = pipe.cK, sh = pipe.shadows, LS = LUT_SIZE;
  const [lr, lg, lb] = pipe.luts || [pipe.lut, pipe.lut, pipe.lut], vib = pipe.vib || 0, sat = pipe.sat ?? 1, color = vib !== 0 || sat !== 1;
  const manV = opts.vignette || 0, G = geometry(src, opts), fr = G.fr, vg = G.vg, vig = G.vig, vInv = G.inv;
  const mg = { px: (FW * factor) / 2, py: (FH * factor) / 2, m: Math.hypot(FW * factor, FH * factor) / 2 };
  const sample = (x, y, c) => { // bilinear, clamped to the region, one channel (x, y in full-source pixels)
    x = Math.min(W - 1, Math.max(0, x - X0)); y = Math.min(H - 1, Math.max(0, y - Y0));
    const x0 = x | 0, y0 = y | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = x - x0, fy = y - y0;
    const g = (xx, yy) => { const v = d[(yy * W + xx) * 3 + c]; return half ? half[v] : v; };
    return (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy) + (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy;
  };
  const slow = !!(G.moves || vig || manV), pos = [0, 0], ch = [0, 0, 0];
  let r, g, b;
  for (let oy = r0; oy < r1; oy++) {
    let x = bx * oy + cx, y = by * oy + cy;
    for (let ox = 0, o = (oy - r0) * OW * 4; ox < OW; ox++, o += 4, x += ax, y += ay) {
      if (!slow) {
        const i = ((y - Y0) * W + (x - X0)) * 3;
        if (half) { r = half[d[i]]; g = half[d[i + 1]]; b = half[d[i + 2]]; } else { r = d[i]; g = d[i + 1]; b = d[i + 2]; }
      } else {
        // full-resolution position in the opcode frame
        const X = (x + 0.5) * factor - 0.5 + fr.offX, Y = (y + 0.5) * factor - 0.5 + fr.offY;
        for (let c = 0; c < 3; c++) {
          G.at(X, Y, c, pos); const sx = pos[0], sy = pos[1];
          let v = sample((sx - fr.offX + 0.5) / factor - 0.5, (sy - fr.offY + 0.5) / factor - 0.5, c);
          if (vg) { const dx = (sx - vg.px) / vg.m, dy = (sy - vg.py) / vg.m, r2 = dx * dx + dy * dy, k = vig.k; const gain = 1 + r2 * (k[0] + r2 * (k[1] + r2 * (k[2] + r2 * (k[3] + r2 * k[4])))); v = vInv ? v / gain : v * gain; }
          if (manV) { const dx = (sx - fr.offX - mg.px) / mg.m, dy = (sy - fr.offY - mg.py) / mg.m; v *= 1 + manV * (dx * dx + dy * dy); }
          ch[c] = v;
        }
        r = ch[0]; g = ch[1]; b = ch[2];
      }
      // white balance + exposure
      let R = c0 * r + c1 * g + c2 * b, Gc = c3 * r + c4 * g + c5 * b, B = c6 * r + c7 * g + c8 * b;
      // clipped highlights: neutralise where every channel was near the sensor limit (avoids pink / cyan casts)
      const lo = Math.min(r, g, b);
      if (lo > 0.75) { const t = smooth(0.75, 1, lo), m = Math.max(R, Gc, B); R += (m - R) * t; Gc += (m - Gc) * t; B += (m - B) * t; }
      // shadows: lift or deepen the darker tones (multiplicative, so black stays black)
      if (sh) { const Y = 0.2126 * R + 0.7152 * Gc + 0.0722 * B, k = Math.pow(2, sh * 1.3 * (1 - smooth(0, 0.25, Y))); R *= k; Gc *= k; B *= k; }
      // highlight shoulder on the brightest channel (keeps hue)
      const m = Math.max(R, Gc, B);
      if (m > knee) { const e = m - knee, f = (cK === Infinity ? Math.min(1, m) : knee + e / (1 + e / cK)) / m; R *= f; Gc *= f; B *= f; }
      // saturation and vibrance (vibrance favours muted colours; negative vibrance mutes the strongest first)
      if (color) {
        const mx = Math.max(R, Gc, B), mn = Math.min(R, Gc, B), cs = mx > 1e-6 ? (mx - mn) / mx : 0, Y = 0.2126 * R + 0.7152 * Gc + 0.0722 * B;
        const k = sat * (1 + vib * (vib > 0 ? 1 - cs : cs));
        R = Y + (R - Y) * k; Gc = Y + (Gc - Y) * k; B = Y + (B - Y) * k;
      }
      // output curve
      R = R <= 0 ? 0 : R >= 1 ? LS : R * LS; Gc = Gc <= 0 ? 0 : Gc >= 1 ? LS : Gc * LS; B = B <= 0 ? 0 : B >= 1 ? LS : B * LS;
      const ri = R | 0, gi = Gc | 0, bi = B | 0;
      const vr = lr[ri] + (lr[ri + 1 > LS ? LS : ri + 1] - lr[ri]) * (R - ri), vg2 = lg[gi] + (lg[gi + 1 > LS ? LS : gi + 1] - lg[gi]) * (Gc - gi), vb = lb[bi] + (lb[bi + 1 > LS ? LS : bi + 1] - lb[bi]) * (B - bi);
      if (o16) { o16[o] = vr + 0.5; o16[o + 1] = vg2 + 0.5; o16[o + 2] = vb + 0.5; o16[o + 3] = 65535; }
      if (o8) { o8[o] = vr / 257 + 0.5; o8[o + 1] = vg2 / 257 + 0.5; o8[o + 2] = vb / 257 + 0.5; o8[o + 3] = 255; }
    }
  }
  return { width: OW, height: r1 - r0, fullHeight: OH, data16: o16, data8: o8 };
}

// ---- whole pipeline on a band of output rows (develop → noise reduction → sharpening) ---------------------------
/** Rows of context a band needs above and below so NR and sharpening match a whole-image run (multiple of 4). */
export const BAND_HALO = 48;
/**
 * Develop output rows [rows[0], rows[1]) including noise reduction and sharpening. The band is computed with `halo`
 * extra rows on each side (clamped to the image) so the neighbourhood filters see the same pixels as a whole-image run.
 * opts as develop() plus { settings, scale (output pixels per full-resolution pixel, < 1 for previews), bits: 8 | 16,
 *   nrScale (optional: the scale noise reduction works at; the quick half-resolution pass uses 1 for a cheaper chroma blur) }.
 */
export function developRows(src, opts) {
  const [FW, FH] = fullOf(src), [, OH] = orientedSize(FW, FH, opts.orientation || 1);
  const [a, b] = opts.rows || [0, OH], halo = opts.rows ? (opts.halo ?? BAND_HALO) : 0;
  const h0 = Math.max(0, a - halo), h1 = Math.min(OH, b + halo), bits = opts.bits || 16, set = opts.settings || DEFAULT_SETTINGS, scale = opts.scale ?? 1;
  const out = develop(src, { ...opts, rows: [h0, h1], out16: bits === 16, out8: bits === 8 });
  const px = bits === 16 ? out.data16 : out.data8, w = out.width, hh = out.height;
  const t0 = now();
  denoise(px, w, hh, set.nrLuma, set.nrColor, opts.nrScale ?? scale);
  const t1 = now();
  sharpen(px, w, hh, set, scale);
  const t2 = now();
  const cut = (arr) => (h0 === a && h1 === b ? arr : arr.slice((a - h0) * w * 4, (b - h0) * w * 4));
  return { width: w, height: b - a, rows: [a, b], fullHeight: OH, data: cut(px), bits, ms: { nr: t1 - t0, sharpen: t2 - t1 } };
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Split a develop into bands of output rows and work out which part of the source each band reads (its rows plus the
 * halo, through orientation, lens warp and CA). Returns [{ rows, rect: { x0, y0, x1, y1 } }] with even-aligned rects.
 */
export function planBands(src, opts, n) {
  const [FW, FH] = fullOf(src), o = opts.orientation || 1, [OW, OH] = orientedSize(FW, FH, o), factor = opts.factor || 1;
  const halo = opts.halo ?? BAND_HALO, [ax, bx, cx, ay, by, cy] = orientMap(o, FW, FH);
  const G = geometry(src, opts), fr = G.fr, pos = [0, 0];
  n = Math.max(1, Math.min(n, Math.floor(OH / 16) || 1));
  const step = Math.ceil(OH / n / 4) * 4, bands = [];
  for (let a = 0; a < OH; a += step) {
    const b = Math.min(OH, a + step), h0 = Math.max(0, a - halo), h1 = Math.min(OH, b + halo);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const visit = (ox, oy) => {
      const x = ax * ox + bx * oy + cx, y = ay * ox + by * oy + cy;
      if (!G.moves) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); return; }
      const X = (x + 0.5) * factor - 0.5 + fr.offX, Y = (y + 0.5) * factor - 0.5 + fr.offY;
      for (let c = 0; c < 3; c++) {
        G.at(X, Y, c, pos);
        const sx = (pos[0] - fr.offX + 0.5) / factor - 0.5, sy = (pos[1] - fr.offY + 0.5) / factor - 0.5;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
    };
    // the boundary of the band maps onto the boundary of what it reads (the warp is a smooth radial map)
    const sx = Math.max(1, Math.floor(OW / 64)), sy = Math.max(1, Math.floor((h1 - h0) / 16));
    for (let ox = 0; ox < OW; ox += sx) { visit(ox, h0); visit(ox, h1 - 1); }
    for (let oy = h0; oy < h1; oy += sy) { visit(0, oy); visit(OW - 1, oy); }
    visit(OW - 1, h0); visit(OW - 1, h1 - 1);
    const pad = G.moves ? 4 : 1;
    const rx0 = Math.max(0, Math.floor(x0) - pad) & ~1, ry0 = Math.max(0, Math.floor(y0) - pad) & ~1;
    let rx1 = Math.min(FW, Math.ceil(x1) + pad + 1), ry1 = Math.min(FH, Math.ceil(y1) + pad + 1);
    if ((rx1 - rx0) & 1 && rx1 < FW) rx1++; if ((ry1 - ry0) & 1 && ry1 < FH) ry1++;
    bands.push({ rows: [a, b], rect: { x0: rx0, y0: ry0, x1: rx1, y1: ry1 } });
  }
  return bands;
}
/** Copy a rectangle out of a 3-channel source as a region source (keeps the full size for orientation and lens maths). */
export function extractRegion(src, rect) {
  const [FW, FH] = fullOf(src), W = src.width, bx = src.x0 || 0, byy = src.y0 || 0, w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  const data = new src.data.constructor(w * h * 3);
  if (rect.x0 === bx && w === W) data.set(src.data.subarray((rect.y0 - byy) * W * 3, (rect.y1 - byy) * W * 3));
  else for (let y = 0; y < h; y++) { const s = ((rect.y0 - byy + y) * W + (rect.x0 - bx)) * 3; data.set(src.data.subarray(s, s + w * 3), y * w * 3); }
  return { x0: rect.x0, y0: rect.y0, width: w, height: h, fullW: FW, fullH: FH, data, half: !!src.half };
}
/** 2×2 box-downscale of a region source (x0, y0 even), Float32 result: the half-resolution first pass. */
export function halveRegion(src) {
  const [FW, FH] = fullOf(src), W = src.width, x0 = src.x0 || 0, y0 = src.y0 || 0, half = src.half ? halfTable() : null, d = src.data;
  const w = Math.floor(W / 2), h = Math.floor(src.height / 2), out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    const i = ((2 * y) * W + 2 * x) * 3 + c, j = i + W * 3;
    out[(y * w + x) * 3 + c] = half ? (half[d[i]] + half[d[i + 3]] + half[d[j]] + half[d[j + 3]]) * 0.25 : (d[i] + d[i + 3] + d[j] + d[j + 3]) * 0.25;
  }
  return { x0: x0 / 2, y0: y0 / 2, width: w, height: h, fullW: Math.floor(FW / 2), fullH: Math.floor(FH / 2), data: out, half: false };
}

// ---- lateral chromatic aberration estimate ---------------------------------------------------------------------
/**
 * Estimate lateral CA: how much the red and the blue channel are magnified against green (radial scale offsets,
 * e.g. 0.001 = 0.1 %). Looks at strongly textured patches away from the centre and finds, for each channel, the
 * radial scale that best lines its edges up with green (normalised cross-correlation, coarse-to-fine search).
 */
export function estimateCA(src, { cells = 20, patch = 12, range = CA_UNIT * 1.5 } = {}) {
  const W = src.width, H = src.height, d = src.data, half = src.half ? halfTable() : null;
  const val = (x, y, c) => { const v = d[(y * W + x) * 3 + c]; return half ? half[v] : v; };
  const bil = (x, y, c) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    return (val(x0, y0, c) * (1 - fx) + val(x0 + 1, y0, c) * fx) * (1 - fy) + (val(x0, y0 + 1, c) * (1 - fx) + val(x0 + 1, y0 + 1, c) * fx) * fy;
  };
  const cxp = (W - 1) / 2, cyp = (H - 1) / 2, rmax = Math.hypot(cxp, cyp);
  // candidate patches: radial gradient energy of green, outer 65 % of the radius, not clipped
  const cand = [], gx = Math.floor(W / cells), gy = Math.floor(H / cells);
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const px = Math.floor((i + 0.5) * gx), py = Math.floor((j + 0.5) * gy), r = Math.hypot(px - cxp, py - cyp) / rmax;
    if (r < 0.35 || px < patch + 8 || py < patch + 8 || px > W - patch - 8 || py > H - patch - 8) continue;
    const ux = (px - cxp) / (r * rmax), uy = (py - cyp) / (r * rmax);
    let e = 0, clip = false;
    for (let y = -patch; y < patch; y += 2) for (let x = -patch; x < patch; x += 2) {
      const a = val(px + x, py + y, 1); if (a > 0.95) clip = true;
      const g = (val(px + x + 1, py + y, 1) - val(px + x - 1, py + y, 1)) * ux + (val(px + x, py + y + 1, 1) - val(px + x, py + y - 1, 1)) * uy;
      e += g * g;
    }
    if (!clip && e > 0) cand.push({ px, py, e });
  }
  cand.sort((a, b) => b.e - a.e);
  const use = cand.slice(0, 48); if (use.length < 4) return { red: 0, blue: 0, patches: use.length };
  const green = use.map(({ px, py }) => { const g = []; for (let y = -patch; y < patch; y++) for (let x = -patch; x < patch; x++) g.push(val(px + x, py + y, 1)); return norm(g); });
  const score = (c, a) => {
    let s = 0;
    use.forEach(({ px, py }, k) => {
      const v = [], G = green[k];
      for (let y = -patch; y < patch; y++) for (let x = -patch; x < patch; x++) v.push(bil(cxp + (px + x - cxp) * (1 + a), cyp + (py + y - cyp) * (1 + a), c));
      const n = norm(v); let cc = 0; for (let i = 0; i < n.length; i++) cc += n[i] * G[i];
      s += cc * cc * use[k].e; // squared correlation (edges may flip sign between channels), weighted by texture
    });
    return s;
  };
  const best = (c) => {
    let lo = -range, hi = range, a = 0, stepN = 24;
    for (let pass = 0; pass < 3; pass++) {
      let top = -Infinity; const st = (hi - lo) / stepN;
      for (let t = lo; t <= hi + 1e-12; t += st) { const sc = score(c, t); if (sc > top) { top = sc; a = t; } }
      lo = a - st; hi = a + st; stepN = 8;
    }
    return a;
  };
  return { red: best(0), blue: best(2), patches: use.length };
}
function norm(v) {
  let m = 0; for (const x of v) m += x; m /= v.length;
  let s = 0; for (const x of v) s += (x - m) * (x - m); s = Math.sqrt(s) || 1;
  return v.map((x) => (x - m) / s);
}
/** Radial scale offsets [red, blue] for the develop pass from the settings (+ the automatic estimate when enabled). */
export function caScales(set, auto) {
  const r = (set.caRed || 0) / 100 * CA_UNIT + (set.caAuto && auto ? auto.red : 0), b = (set.caBlue || 0) / 100 * CA_UNIT + (set.caAuto && auto ? auto.blue : 0);
  return r || b ? [r, b] : null;
}

// ---- sharpening (on the developed RGBA, display space; luminance only) -------------------------------------------
/**
 * Unsharp mask on luminance. amount 0..150 (%), radius in full-resolution pixels (scaled for previews), detail 0..100
 * (low values hold back halos on strong edges), masking 0..100 (limits sharpening to edges, sparing smooth areas).
 */
export function sharpen(rgba, w, h, set, scale = 1) {
  const amount = (set.sharpen || 0) / 100; if (!(amount > 0)) return;
  const n = w * h, max = rgba instanceof Uint16Array ? 65535 : 255, Y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) Y[i] = 0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2];
  const bl = Y.slice(), tmp = new Float32Array(n), sigma = (set.sharpRadius || 1) * scale;
  if (sigma < 0.8) { blur121(bl, w, h, tmp); } else { const rb = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2)); for (let k = 0; k < 3; k++) boxBlur(bl, w, h, rb, tmp); }
  const D = (set.sharpDetail ?? 25) / 100, L = max * (0.02 + 0.6 * D * D), M = (set.sharpMask || 0) / 100, T = M * M * 0.08 * max;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let dd = Y[i] - bl[i];
    dd = dd * L / (L + Math.abs(dd)) * (1 + D); // soft limit: halos on big edges are held back unless detail is high
    let k = amount;
    if (T > 0) { // edge mask from the blurred luminance gradient
      const xl = x ? i - 1 : i, xr = x < w - 1 ? i + 1 : i, yu = y ? i - w : i, yd = y < h - 1 ? i + w : i;
      const gx = bl[xr] - bl[xl], gy = bl[yd] - bl[yu]; k *= smooth(T * 0.5, T * 1.5, Math.sqrt(gx * gx + gy * gy));
    }
    if (!k) continue;
    const j = i * 4, add = dd * k;
    const r = rgba[j] + add, g = rgba[j + 1] + add, b = rgba[j + 2] + add;
    rgba[j] = r < 0 ? 0 : r > max ? max : r + 0.5; rgba[j + 1] = g < 0 ? 0 : g > max ? max : g + 0.5; rgba[j + 2] = b < 0 ? 0 : b > max ? max : b + 0.5;
  }
}
function blur121(p, w, h, tmp) {
  for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) tmp[o + x] = (p[o + Math.max(0, x - 1)] + 2 * p[o + x] + p[o + Math.min(w - 1, x + 1)]) * 0.25; }
  for (let y = 0; y < h; y++) { const u = Math.max(0, y - 1) * w, c = y * w, dn = Math.min(h - 1, y + 1) * w; for (let x = 0; x < w; x++) p[c + x] = (tmp[u + x] + 2 * tmp[c + x] + tmp[dn + x]) * 0.25; }
}

// ---- noise reduction (on the developed RGBA; 16- or 8-bit) -------------------------------------------------------
function boxBlur(p, w, h, r, tmp) {
  if (r < 1) return;
  const n = 2 * r + 1, inv = 1 / n;
  for (let y = 0; y < h; y++) { // horizontal → tmp (clamped at the ends, unclamped in between)
    const o = y * w, e = o + w - 1; let s = 0;
    for (let x = -r; x <= r; x++) s += p[o + Math.min(w - 1, Math.max(0, x))];
    const a = Math.min(w, r), b = Math.max(a, w - r - 1);
    let x = 0;
    for (; x < a; x++) { tmp[o + x] = s * inv; s += p[Math.min(e, o + x + r + 1)] - p[o + Math.max(0, x - r)]; }
    for (; x < b; x++) { tmp[o + x] = s * inv; s += p[o + x + r + 1] - p[o + x - r]; }
    for (; x < w; x++) { tmp[o + x] = s * inv; s += p[Math.min(e, o + x + r + 1)] - p[o + Math.max(0, x - r)]; }
  }
  // vertical → p, a whole row at a time (column sums kept per x: cache-friendly on wide images)
  const s = new Float64Array(w);
  for (let y = -r; y <= r; y++) { const o = Math.min(h - 1, Math.max(0, y)) * w; for (let x = 0; x < w; x++) s[x] += tmp[o + x]; }
  for (let y = 0; y < h; y++) {
    const o = y * w, a = Math.min(h - 1, y + r + 1) * w, b = Math.max(0, y - r) * w;
    for (let x = 0; x < w; x++) { p[o + x] = s[x] * inv; s[x] += tmp[a + x] - tmp[b + x]; }
  }
}
/**
 * Luminance NR (soft coring of fine detail against a small blur) and colour NR (blurred chroma).
 * `scale` < 1 for previews (radii shrink with the image).
 */
export function denoise(rgba, w, h, luma, color, scale = 1) {
  if (!(luma > 0) && !(color > 0)) return;
  const n = w * h, max = rgba instanceof Uint16Array ? 65535 : 255;
  // luminance: soft coring of fine detail against a small blur (full resolution, only when asked for)
  let Y = null, bl = null;
  if (luma > 0) {
    Y = new Float32Array(n); for (let i = 0, j = 0; i < n; i++, j += 4) Y[i] = 0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2];
    bl = Y.slice(); const rad = Math.max(1, Math.round((1 + luma / 50) * Math.min(1, scale * 1.5)));
    boxBlur(bl, w, h, rad, new Float32Array(n));
  }
  // colour: chroma (B - Y, R - Y) is low-frequency noise, so it is blurred at reduced resolution and upsampled
  let A = null, Bc = null, q = 1, cw = w, chh = h, keep = 1;
  if (color > 0) {
    q = Math.max(1, Math.min(4, Math.round(2 * scale))); cw = Math.ceil(w / q); chh = Math.ceil(h / q);
    A = new Float32Array(cw * chh); Bc = new Float32Array(cw * chh); const cnt = new Float32Array(cw * chh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4, r = rgba[j], g = rgba[j + 1], b = rgba[j + 2], yy = 0.2126 * r + 0.7152 * g + 0.0722 * b, k = ((y / q) | 0) * cw + ((x / q) | 0);
      A[k] += b - yy; Bc[k] += r - yy; cnt[k]++;
    }
    for (let k = 0; k < A.length; k++) { A[k] /= cnt[k]; Bc[k] /= cnt[k]; }
    const rad = Math.max(1, Math.round(((1 + (color / 100) * 6) * scale) / q)), tmp = new Float32Array(cw * chh);
    boxBlur(A, cw, chh, rad, tmp); boxBlur(A, cw, chh, rad, tmp); boxBlur(Bc, cw, chh, rad, tmp); boxBlur(Bc, cw, chh, rad, tmp);
    keep = 1 - Math.min(1, color / 40);
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(chh - 1, Math.max(0, (y + 0.5) / q - 0.5)), y0 = fy | 0, y1 = Math.min(chh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i * 4, r0 = rgba[j], g0 = rgba[j + 1], b0 = rgba[j + 2], y0v = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
      let yv = y0v, ca = b0 - y0v, cb = r0 - y0v;
      if (Y) { const dd = Y[i] - bl[i], a = Math.abs(dd), T = (luma / 100) * 0.05 * max; yv = bl[i] + dd * (a * a / (a * a + T * T)); }
      if (A) {
        const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / q - 0.5)), x0 = fx | 0, x1 = Math.min(cw - 1, x0 + 1), tx = fx - x0;
        const k00 = y0 * cw + x0, k10 = y0 * cw + x1, k01 = y1 * cw + x0, k11 = y1 * cw + x1;
        const sa = (A[k00] * (1 - tx) + A[k10] * tx) * (1 - ty) + (A[k01] * (1 - tx) + A[k11] * tx) * ty;
        const sb = (Bc[k00] * (1 - tx) + Bc[k10] * tx) * (1 - ty) + (Bc[k01] * (1 - tx) + Bc[k11] * tx) * ty;
        ca = sa + (ca - sa) * keep; cb = sb + (cb - sb) * keep;
      }
      const b = ca + yv, r = cb + yv, g = (yv - 0.2126 * r - 0.0722 * b) / 0.7152;
      rgba[j] = r < 0 ? 0 : r > max ? max : r + 0.5; rgba[j + 1] = g < 0 ? 0 : g > max ? max : g + 0.5; rgba[j + 2] = b < 0 ? 0 : b > max ? max : b + 0.5;
    }
  }
}
/** 8-bit copy of a 16-bit RGBA buffer (rounded, like deepToImageData). */
export function to8(d16) { const o = new Uint8ClampedArray(d16.length); for (let i = 0; i < d16.length; i++) o[i] = (d16[i] + 128) / 257; return o; }
/** Short camera description for the dialog. */
export function describe(meta) {
  const c = meta.camera || {}, e = meta.exposure || {};
  const shutter = e.exposureTime ? (e.exposureTime >= 1 ? `${e.exposureTime}s` : `1/${Math.round(1 / e.exposureTime)}s`) : null;
  return [c.canonicalMake && c.canonicalModel ? `${c.canonicalMake} ${c.canonicalModel}` : c.name || meta.format, meta.lens?.model, e.iso ? `ISO ${e.iso}` : null, shutter, e.fNumber ? `f/${e.fNumber}` : null, e.focalLength ? `${e.focalLength} mm` : null].filter(Boolean).join(' · ');
}

/**
 * Last-resort preview finder for files the RAW decoder cannot even open: walks every JPEG start-of-image
 * marker in the container, follows the marker segments to the end of the image, and returns the largest
 * complete baseline/progressive JPEG with its size. Original code; works on TIFF-based and ISO-BMFF RAWs alike.
 */
export function findEmbeddedJpeg(bytes) {
  const b = bytes, n = b.length; let best = null;
  for (let i = 0; i < n - 4; i++) {
    if (b[i] !== 0xff || b[i + 1] !== 0xd8 || b[i + 2] !== 0xff) continue;
    let p = i + 2, w = 0, h = 0, ok = false;
    while (p + 4 <= n && b[p] === 0xff) {
      const m = b[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd9) { ok = true; p += 2; break; }
      const len = (b[p + 2] << 8) | b[p + 3];
      if (len < 2 || p + 2 + len > n) break;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = (b[p + 5] << 8) | b[p + 6]; w = (b[p + 7] << 8) | b[p + 8]; }
      p += 2 + len;
      if (m === 0xda) { // entropy-coded data: skip to the next real marker
        while (p + 1 < n && !(b[p] === 0xff && b[p + 1] !== 0 && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7))) p++;
      }
    }
    if (ok && w && h && (!best || w * h > best.width * best.height)) best = { start: i, end: p, width: w, height: h };
    if (ok) i = p - 1;
  }
  return best ? { data: bytes.subarray(best.start, best.end), width: best.width, height: best.height, mimeType: 'image/jpeg' } : null;
}
