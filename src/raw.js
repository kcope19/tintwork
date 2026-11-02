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
  // axial (longitudinal) CA / purple fringing: desaturate purple and green fringes on high-contrast edges, by hue range
  fringePurple: 0, fringePurpleLo: 260, fringePurpleHi: 320, fringeGreen: 0, fringeGreenLo: 80, fringeGreenHi: 150,
  distortion: 0, // manual lens distortion: + straightens barrel (lines bowing out), − straightens pincushion
  local: null, // local adjustments: [{ type: 'linear' | 'radial', exposure, contrast, temp, ...shape }] (see cleanLocal)
});
export const RANGES = {
  temp: [2000, 50000], tint: [-150, 150], exposure: [-5, 5], highlights: [0, 100], shadows: [-100, 100], contrast: [-100, 100],
  vibrance: [-100, 100], saturation: [-100, 100], sharpen: [0, 150], sharpRadius: [0.5, 3], sharpDetail: [0, 100], sharpMask: [0, 100],
  nrLuma: [0, 100], nrColor: [0, 100], vignette: [-100, 100], caRed: [-100, 100], caBlue: [-100, 100],
  fringePurple: [0, 100], fringePurpleLo: [200, 340], fringePurpleHi: [200, 340], fringeGreen: [0, 100], fringeGreenLo: [40, 190], fringeGreenHi: [40, 190],
  distortion: [-100, 100],
};
/**
 * Local adjustment limits: exposure in EV, the rest −100..100 (noise reduction 0..100). Exposure, temperature, tint,
 * highlights and shadows work on the linear values; saturation and contrast on colour / display values; clarity,
 * texture, sharpness and noise run after the develop on the luminance, weighted by the mask.
 */
export const LOCAL_RANGES = {
  exposure: [-4, 4], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100], temp: [-100, 100], tint: [-100, 100],
  saturation: [-100, 100], clarity: [-100, 100], texture: [-100, 100], sharpness: [-100, 100], noise: [0, 100],
};
export const LOCAL_DETAIL = ['clarity', 'texture', 'sharpness', 'noise'];
export const MAX_LOCALS = 8;
/** Brush limits per local adjustment: strokes and points (u, v pairs) kept. */
export const MAX_STROKES = 400, MAX_BRUSH_POINTS = 40000;
/** Brush size = radius as a share of the long side of the image. */
export const BRUSH_SIZE = [0.002, 0.5];
const clampN = (v, lo, hi, d = 0) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
/**
 * Local adjustments, validated. Positions are fractions of the developed (oriented) image: 0..1 across, 0..1 down.
 *   linear (graduated filter): full effect on the (x0, y0) side, fading to none at the (x1, y1) line.
 *   radial: ellipse centre (cx, cy), radii rx (fraction of the width), ry (of the height), feather 0..1 (share of the
 *     radius that fades).
 *   brush: only what is painted.
 * Every type: invert (the shape's other side), strokes (brush strokes that add to the shape, or erase from it with
 * erase: true; { size, feather, flow, auto, erase, pts: [u, v, u, v, …] }), lum ({ lo, hi, soft }: luminance range
 * 0..100) and color ({ hue, range, soft } in degrees): range masks multiply (intersect) the shape. name: a label.
 * Returns null when there are none.
 */
export function cleanLocal(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const a of list) {
    if (out.length >= MAX_LOCALS) break;
    if (!a || typeof a !== 'object' || !['linear', 'radial', 'brush'].includes(a.type)) continue;
    const e = { type: a.type };
    if (typeof a.name === 'string' && a.name.trim()) e.name = a.name.trim().slice(0, 40);
    for (const [k, [lo, hi]] of Object.entries(LOCAL_RANGES)) e[k] = clampN(a[k], lo, hi);
    if (a.type === 'linear') {
      Object.assign(e, { x0: clampN(a.x0, -1, 2, 0.5), y0: clampN(a.y0, -1, 2, 0), x1: clampN(a.x1, -1, 2, 0.5), y1: clampN(a.y1, -1, 2, 0.5) });
      if (Math.hypot(e.x1 - e.x0, e.y1 - e.y0) < 1e-3) e.y1 = e.y0 + 0.01;
    } else if (a.type === 'radial') Object.assign(e, { cx: clampN(a.cx, -1, 2, 0.5), cy: clampN(a.cy, -1, 2, 0.5), rx: clampN(a.rx, 0.01, 2, 0.3), ry: clampN(a.ry, 0.01, 2, 0.3), feather: clampN(a.feather, 0, 1, 0.5) });
    e.invert = !!a.invert;
    if (Array.isArray(a.strokes)) {
      const st = []; let pts = 0;
      for (const k of a.strokes) {
        if (st.length >= MAX_STROKES || !k || !Array.isArray(k.pts) && !ArrayBuffer.isView(k.pts)) continue;
        const n = Math.min(k.pts.length & ~1, MAX_BRUSH_POINTS * 2 - pts); if (n < 2) continue;
        const p = new Array(n); let ok = true;
        for (let i = 0; i < n; i++) { const v = +k.pts[i]; if (!Number.isFinite(v)) { ok = false; break; } p[i] = Math.min(2, Math.max(-1, v)); }
        if (!ok) continue;
        pts += n; st.push({ erase: !!k.erase, auto: !!k.auto, size: clampN(k.size, BRUSH_SIZE[0], BRUSH_SIZE[1], 0.05), feather: clampN(k.feather, 0, 1, 0.5), flow: clampN(k.flow, 0.02, 1, 1), pts: p });
      }
      if (st.length) e.strokes = st;
    }
    if (a.lum && typeof a.lum === 'object') { let lo = clampN(a.lum.lo, 0, 100, 0), hi = clampN(a.lum.hi, 0, 100, 100); if (lo > hi) [lo, hi] = [hi, lo]; e.lum = { lo, hi, soft: clampN(a.lum.soft, 0, 50, 10) }; }
    if (a.color && typeof a.color === 'object') e.color = { hue: ((clampN(a.color.hue, -720, 720, 0) % 360) + 360) % 360, range: clampN(a.color.range, 2, 90, 25), soft: clampN(a.color.soft, 0, 90, 20) };
    out.push(e);
  }
  return out.length ? out : null;
}
/** True when local adjustment `a` changes anything. */
export const localActive = (a) => Object.keys(LOCAL_RANGES).some((k) => a[k]);
/**
 * Shape weight 0..1 of a graduated / radial local adjustment at output position (u, v) (fractions of width / height);
 * aspect = width / height (the graduated filter's fade runs at right angles to its line in image pixels). A brush
 * adjustment's shape is empty (0; 1 when inverted): its strokes are added in the develop.
 */
export function localWeight(a, u, v, aspect = 1) {
  let w = 0;
  if (a.type === 'linear') {
    const ax = a.x0 * aspect, bx = a.x1 * aspect, dx = bx - ax, dy = a.y1 - a.y0, L = dx * dx + dy * dy;
    const t = ((u * aspect - ax) * dx + (v - a.y0) * dy) / (L || 1e-9);
    w = 1 - smooth(0, 1, t);
  } else if (a.type === 'radial') {
    const dx = (u - a.cx) / a.rx, dy = (v - a.cy) / a.ry, d = Math.sqrt(dx * dx + dy * dy), f = Math.max(1e-3, a.feather);
    w = 1 - smooth(1 - f, 1, d);
  }
  return a.invert ? 1 - w : w;
}
/** Luminance (0..100, display-like: √ of linear luma) and hue / saturation (of the √ channels) used by range masks. */
export function rangeMetrics(R, G, B, out = [0, 0, 0]) {
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  out[0] = Y <= 0 ? 0 : Y >= 1 ? 100 : Math.sqrt(Y) * 100;
  const r = R > 0 ? Math.sqrt(R) : 0, g = G > 0 ? Math.sqrt(G) : 0, b = B > 0 ? Math.sqrt(B) : 0, hi = Math.max(r, g, b), lo = Math.min(r, g, b), c = hi - lo;
  if (c <= 1e-6) { out[1] = -1; out[2] = 0; return out; }
  let h = hi === r ? ((g - b) / c) % 6 : hi === g ? (b - r) / c + 2 : (r - g) / c + 4; h *= 60; if (h < 0) h += 360;
  out[1] = h; out[2] = c / hi; return out;
}
/** Range-mask weight 0..1 for metrics m = [lum, hue, sat] (see rangeMetrics). */
export function rangeWeight(a, m) {
  let w = 1;
  if (a.lum) { const L = m[0], { lo, hi, soft } = a.lum; w = L >= lo && L <= hi ? 1 : soft > 0 ? 1 - smooth(0, soft, L < lo ? lo - L : L - hi) : 0; if (w <= 0) return 0; }
  if (a.color) {
    if (m[1] < 0) return 0;
    let dh = Math.abs(m[1] - a.color.hue); if (dh > 180) dh = 360 - dh;
    const c = dh <= a.color.range ? 1 : a.color.soft > 0 ? 1 - smooth(0, a.color.soft, dh - a.color.range) : 0;
    w *= c * smooth(0.03, 0.12, m[2]);
  }
  return w;
}
/**
 * Brush auto mask: similarity 0..1 of a source pixel (linear camera RGB) to a reference [log2 brightness, r share,
 * b share] taken under the brush. Edges between different colours or brightness stop the paint.
 */
export const AUTO_LUM = 0.45, AUTO_CHROMA = 0.035;
export function refOf(r, g, b, out = [0, 0, 0]) { const s = Math.max(1e-5, r + g + b); out[0] = Math.log2(s); out[1] = r / s; out[2] = b / s; return out; }
const simTo = (r, g, b, l0, c0, b0) => {
  const s = Math.max(1e-5, r + g + b), dl = (Math.log2(s) - l0) / AUTO_LUM, dr = (r / s - c0) / AUTO_CHROMA, db = (b / s - b0) / AUTO_CHROMA;
  const d = dl * dl + dr * dr + db * db; return d >= 9 ? 0 : Math.exp(-d);
};
/**
 * Local adjustments ready for the develop: validated, and every auto-mask stroke point gets the colour under it
 * (refs: Float32Array of 3 per point) from `src` (any 3-channel source of the whole image, e.g. the preview copy) so
 * that bands, previews and full-resolution develops all compare against the same colours.
 */
export function prepareLocals(list, src, orientation = 1) {
  const locs = cleanLocal(list); if (!locs || !src) return locs;
  const [FW, FH] = [src.fullW || src.width, src.fullH || src.height], [OW, OH] = orientedSize(FW, FH, orientation), [ax, bx, cx, ay, by, cy] = orientMap(orientation, FW, FH);
  const W = src.width, H = src.height, d = src.data, half = src.half ? halfTable() : null, X0 = src.x0 || 0, Y0 = src.y0 || 0, o = [0, 0, 0];
  const px = (x, y, c) => { const v = d[(y * W + x) * 3 + c]; return half ? half[v] : v; };
  for (const a of locs) for (const k of a.strokes || []) {
    if (!k.auto) continue;
    const n = k.pts.length / 2, refs = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ox = Math.min(OW - 1, Math.max(0, Math.floor(k.pts[2 * i] * OW))), oy = Math.min(OH - 1, Math.max(0, Math.floor(k.pts[2 * i + 1] * OH)));
      const sx = ax * ox + bx * oy + cx - X0, sy = ay * ox + by * oy + cy - Y0;
      let r = 0, g = 0, b = 0, m = 0;
      for (let yy = Math.max(0, sy - 1); yy <= Math.min(H - 1, sy + 1); yy++) for (let xx = Math.max(0, sx - 1); xx <= Math.min(W - 1, sx + 1); xx++) { r += px(xx, yy, 0); g += px(xx, yy, 1); b += px(xx, yy, 2); m++; }
      refOf(r / (m || 1), g / (m || 1), b / (m || 1), o); refs.set(o, i * 3);
    }
    k.refs = refs;
  }
  return locs;
}
/** Long side of the brush raster (cells); masks are rasterised in output-frame fractions, so previews and bands agree. */
export const BRUSH_GRID = 768;
/**
 * Rasterise a local adjustment's strokes: { GW, GH, add, addA, refA, era, eraA, refE } (Float32 grids; the *A grids
 * hold auto-mask strokes and ref* the colour under them). Within a stroke dabs merge by maximum; strokes build up by
 * flow (c = c + (1 − c) · flow · dab).
 */
export function rasterStrokes(strokes, OW, OH) {
  const L = Math.max(OW, OH), G = Math.min(BRUSH_GRID, L), GW = Math.max(1, Math.round(G * OW / L)), GH = Math.max(1, Math.round(G * OH / L)), n = GW * GH;
  const grids = { GW, GH, add: null, addA: null, refA: null, era: null, eraA: null, refE: null, bx0: 0, by0: 0, bx1: 0, by1: 0 };
  const t = new Float32Array(n), ti = new Int32Array(n).fill(-1), refW = { refA: null, refE: null }; // colour weights (kept off `grids` so it keeps a fixed shape)
  let BX0 = GW, BY0 = GH, BX1 = -1, BY1 = -1;
  for (const k of strokes) {
    const auto = !!k.auto && !!k.refs, key = k.erase ? (auto ? 'eraA' : 'era') : (auto ? 'addA' : 'add');
    const tgt = grids[key] ||= new Float32Array(n), rk = k.erase ? 'refE' : 'refA';
    if (auto) { grids[rk] ||= new Float32Array(n * 3); refW[rk] ||= new Float32Array(n); }
    const R = Math.max(0.75, k.size * Math.max(GW, GH)), f = Math.max(0.01, k.feather), step = Math.max(0.35, R * 0.2);
    let x0 = GW, y0 = GH, x1 = -1, y1 = -1;
    const dab = (x, y, pi) => {
      const ax = Math.max(0, Math.floor(x - R)), bx = Math.min(GW - 1, Math.ceil(x + R)), ay = Math.max(0, Math.floor(y - R)), by = Math.min(GH - 1, Math.ceil(y + R));
      if (ax > bx || ay > by) return;
      x0 = Math.min(x0, ax); x1 = Math.max(x1, bx); y0 = Math.min(y0, ay); y1 = Math.max(y1, by);
      for (let yy = ay; yy <= by; yy++) for (let xx = ax; xx <= bx; xx++) {
        const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y) / R; if (d >= 1) continue;
        const w = 1 - smooth(1 - f, 1, d), i = yy * GW + xx; if (w > t[i]) { t[i] = w; ti[i] = pi; }
      }
    };
    const P = k.pts, np = P.length / 2;
    let px = P[0] * GW, py = P[1] * GH; dab(px, py, 0);
    for (let i = 1; i < np; i++) {
      const qx = P[2 * i] * GW, qy = P[2 * i + 1] * GH, dist = Math.hypot(qx - px, qy - py), m = Math.ceil(dist / step);
      for (let j = 1; j <= m; j++) dab(px + (qx - px) * j / m, py + (qy - py) * j / m, j * 2 > m ? i : i - 1);
      px = qx; py = qy;
    }
    const flow = k.flow, ref = auto ? grids[rk] : null, rw = auto ? refW[rk] : null;
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const i = yy * GW + xx, w = t[i]; if (w <= 0) continue;
      tgt[i] += (1 - tgt[i]) * flow * w;
      if (auto) { const r = ti[i] * 3, q = w * flow; ref[i * 3] += k.refs[r] * q; ref[i * 3 + 1] += k.refs[r + 1] * q; ref[i * 3 + 2] += k.refs[r + 2] * q; rw[i] += q; }
      t[i] = 0; ti[i] = -1;
    }
    if (x1 >= 0) { BX0 = Math.min(BX0, x0); BY0 = Math.min(BY0, y0); BX1 = Math.max(BX1, x1); BY1 = Math.max(BY1, y1); }
  }
  // bounding box of every painted cell, one cell wider for the bilinear lookup and the colour spread
  Object.assign(grids, { bx0: Math.max(0, BX0 - 3), by0: Math.max(0, BY0 - 3), bx1: Math.min(GW - 1, BX1 + 3), by1: Math.min(GH - 1, BY1 + 3) });
  for (const rk of ['refA', 'refE']) { // normalise, then spread into empty neighbours (bilinear coverage reaches them)
    const ref = grids[rk], W = refW[rk]; if (!ref) continue;
    for (let i = 0; i < n; i++) if (W[i] > 0) { ref[i * 3] /= W[i]; ref[i * 3 + 1] /= W[i]; ref[i * 3 + 2] /= W[i]; }
    const { bx0, by0, bx1, by1 } = grids, has = new Uint8Array(n), DX = [1, -1, 0, 0, 1, -1, 1, -1], DY = [0, 0, 1, -1, 1, -1, -1, 1];
    for (let pass = 0; pass < 2; pass++) {
      for (let y = by0; y <= by1; y++) for (let x = bx0, i = y * GW + bx0; x <= bx1; x++, i++) has[i] = W[i] > 0 ? 1 : 0;
      for (let y = by0; y <= by1; y++) for (let x = bx0, i = y * GW + bx0; x <= bx1; x++, i++) {
        if (has[i]) continue;
        for (let q = 0; q < 8; q++) {
          const xx = x + DX[q], yy = y + DY[q]; if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue; const j = yy * GW + xx;
          if (has[j]) { ref[i * 3] = ref[j * 3]; ref[i * 3 + 1] = ref[j * 3 + 1]; ref[i * 3 + 2] = ref[j * 3 + 2]; W[i] = 1e-6; break; }
        }
      }
    }
  }
  return grids;
}
/** Bilinear lookup in a GW × GH grid at output fractions (u, v). */
const bil = (g, GW, GH, u, v) => {
  const fx = Math.min(GW - 1, Math.max(0, u * GW - 0.5)), fy = Math.min(GH - 1, Math.max(0, v * GH - 0.5)), x0 = fx | 0, y0 = fy | 0;
  const x1 = x0 + 1 < GW ? x0 + 1 : x0, y1 = y0 + 1 < GH ? y0 + 1 : y0, tx = fx - x0, ty = fy - y0;
  return (g[y0 * GW + x0] * (1 - tx) + g[y0 * GW + x1] * tx) * (1 - ty) + (g[y1 * GW + x0] * (1 - tx) + g[y1 * GW + x1] * tx) * ty;
};
/** Brush coverage [add, erase] at (u, v) for a source pixel r, g, b (auto-mask strokes compare its colour). */
function brushAt(B, u, v, r, g, b, out) {
  const GW = B.GW, GH = B.GH, cx = u * GW, cy = v * GH;
  if (cx < B.bx0 || cx > B.bx1 + 1 || cy < B.by0 || cy > B.by1 + 1) { out[0] = 0; out[1] = 0; return out; }
  let add = B.add ? bil(B.add, GW, GH, u, v) : 0, er = B.era ? bil(B.era, GW, GH, u, v) : 0;
  if (B.addA || B.eraA) {
    const ci = Math.min(GH - 1, Math.max(0, (v * GH) | 0)) * GW + Math.min(GW - 1, Math.max(0, (u * GW) | 0));
    if (B.addA) { const c = bil(B.addA, GW, GH, u, v); if (c > 0.001) { const q = B.refA, s = simTo(r, g, b, q[ci * 3], q[ci * 3 + 1], q[ci * 3 + 2]); add = 1 - (1 - add) * (1 - c * s); } }
    if (B.eraA) { const c = bil(B.eraA, GW, GH, u, v); if (c > 0.001) { const q = B.refE, s = simTo(r, g, b, q[ci * 3], q[ci * 3 + 1], q[ci * 3 + 2]); er = 1 - (1 - er) * (1 - c * s); } }
  }
  out[0] = add > 1 ? 1 : add; out[1] = er > 1 ? 1 : er; return out;
}
/** Local adjustment mask weight at (u, v) for source pixel r, g, b and range metrics m (null: computed by the caller). */
export function maskWeight(P, u, v, aspect, r, g, b, m, tmp = [0, 0]) {
  const a = P.a; let w = 0;
  if (P.kind === 1) { const t = (u * aspect - P.ax) * P.dx + (v - P.ay) * P.dy; w = t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * (3 - 2 * t); }
  else if (P.kind === 2) {
    const dx = (u - P.cx) * P.irx, dy = (v - P.cy) * P.iry, d2 = dx * dx + dy * dy;
    if (d2 < 1) { const d = Math.sqrt(d2); if (d <= P.f0) w = 1; else { const t = (d - P.f0) * P.fi; w = 1 - t * t * (3 - 2 * t); } }
  }
  if (P.inv && !P.brush) w = 1 - w;
  if (P.brush) { // strokes add to the shape and erase strokes remove from it; invert applies to the result
    brushAt(P.brush, u, v, r, g, b, tmp); w = (w > tmp[0] ? w : tmp[0]) * (1 - tmp[1]);
    if (a.invert) w = 1 - w;
  }
  if (w > 0 && P.range) w *= rangeWeight(a, m);
  return w;
}
/**
 * Brush rasters are the same for every band of a develop: a worker keeps the last few, keyed by a hash of the strokes
 * (points, sizes, flags and auto-mask colours) and the output size.
 */
const rasterCache = new Map();
function strokeKey(strokes, OW, OH) {
  let h = 2166136261 >>> 0; const mix = (x) => { h = Math.imul(h ^ (Math.round(x * 1e6) | 0), 16777619) >>> 0; };
  for (const k of strokes) {
    mix(k.size); mix(k.feather); mix(k.flow); mix(k.erase ? 1 : 0); mix(k.auto ? 1 : 0); mix(k.pts.length);
    for (let i = 0; i < k.pts.length; i++) mix(k.pts[i]);
    if (k.refs) for (let i = 0; i < k.refs.length; i++) mix(k.refs[i]);
  }
  return `${OW}x${OH}:${strokes.length}:${h}`;
}
function cachedRaster(strokes, OW, OH) {
  const key = strokeKey(strokes, OW, OH); let g = rasterCache.get(key);
  if (!g) { g = rasterStrokes(strokes, OW, OH); rasterCache.set(key, g); if (rasterCache.size > 12) rasterCache.delete(rasterCache.keys().next().value); }
  return g;
}
/** Order of the per-pixel local accumulators (see localsAt). */
const LOCAL_KEYS = ['exposure', 'temp', 'tint', 'contrast', 'highlights', 'shadows', 'saturation', 'clarity', 'texture', 'sharpness', 'noise'];
/** Prepared locals → per-adjustment develop state { a, brush, active, range, c (amounts in LOCAL_KEYS order) }. */
export function localPlan(locs, OW, OH) {
  const aspect = OW / OH;
  return (locs || []).map((a) => {
    // the same shapes as localWeight(), with the constants worked out once (exactly the same weights)
    const P = { a, brush: a.strokes ? cachedRaster(a.strokes, OW, OH) : null, active: localActive(a), range: !!(a.lum || a.color), c: Float64Array.from(LOCAL_KEYS, (k) => a[k] || 0),
      inv: !!a.invert, kind: 0, ax: 0, ay: 0, dx: 0, dy: 0, cx: 0, cy: 0, irx: 0, iry: 0, f0: 0, fi: 0, k: -1 };
    if (a.type === 'linear') { const ax = a.x0 * aspect, dx = a.x1 * aspect - ax, dy = a.y1 - a.y0, L = dx * dx + dy * dy || 1e-9; Object.assign(P, { kind: 1, ax, ay: a.y0, dx: dx / L, dy: dy / L }); }
    else if (a.type === 'radial') { const f = Math.max(1e-3, a.feather); Object.assign(P, { kind: 2, cx: a.cx, cy: a.cy, irx: 1 / a.rx, iry: 1 / a.ry, f0: 1 - f, fi: 1 / f }); }
    return P;
  });
}
/** Weighted sum of every local adjustment's amounts at one pixel into acc; also the overlay weight. False when none applies. */
function localsAt(plan, nl, u, v, aspect, r, g, b, met, tmp, acc, ovl, oi, showK) {
  let any = false;
  for (let k = 0; k < nl; k++) {
    const P = plan[k], w = maskWeight(P, u, v, aspect, r, g, b, met, tmp); if (!(w > 0)) continue;
    if (ovl !== null && P.k === showK) ovl[oi] = w * 255 + 0.5;
    if (!P.active) continue;
    const c = P.c;
    if (!any) { any = true; for (let j = 0; j < 11; j++) acc[j] = c[j] * w; } else for (let j = 0; j < 11; j++) acc[j] += c[j] * w;
  }
  return any;
}
/** Temperature ±100 of a local adjustment = ±0.5 EV of red against blue; tint ±100 = ±0.4 EV of green against red + blue. */
export const LOCAL_TEMP_EV = 0.5, LOCAL_TINT_EV = 0.4;
const LN2 = Math.LN2;
/** Lateral CA slider ±100 = ±0.4 % radial scale of the red or blue channel against green. */
export const CA_UNIT = 0.004;
/** Settings with every key valid (unknown keys dropped, numbers clamped): used for presets read from storage. */
export function cleanSettings(s) {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const v = s?.[k]; if (v === undefined) continue;
    if (k === 'wb') { if (['as-shot', 'auto', 'custom'].includes(v)) out.wb = v; }
    else if (k === 'local') out.local = cleanLocal(v);
    else if (k === 'curve') { out.curve = v && typeof v === 'object' ? Object.fromEntries(['rgb', 'r', 'g', 'b'].map((c) => [c, Array.isArray(v[c]) && v[c].length >= 2 ? v[c].map(([x, y]) => [+x || 0, +y || 0]) : [[0, 0], [255, 255]]])) : null; }
    else if (typeof DEFAULT_SETTINGS[k] === 'boolean') out[k] = !!v;
    else if (Number.isFinite(+v)) { const r = RANGES[k]; out[k] = r ? Math.min(r[1], Math.max(r[0], +v)) : +v; }
  }
  for (const c of ['Purple', 'Green']) if (out[`fringe${c}Lo`] > out[`fringe${c}Hi`]) [out[`fringe${c}Lo`], out[`fringe${c}Hi`]] = [out[`fringe${c}Hi`], out[`fringe${c}Lo`]];
  return out;
}
/** Develop preset files (.json): { format: 'tintwork-raw-presets', version: 1, presets: [{ name, settings }] }. */
export const PRESET_FILE_FORMAT = 'tintwork-raw-presets';
export const presetFile = (list) => ({ format: PRESET_FILE_FORMAT, version: 1, presets: list.map((p) => ({ name: String(p.name), settings: cleanSettings(p.settings) })) });
/**
 * Presets from a file: the preset-file object above, a bare array of { name, settings }, or one { name, settings }.
 * Names are trimmed (max 60 characters) and settings go through cleanSettings. Throws when nothing valid is found.
 */
export function parsePresetFile(obj) {
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { throw new Error('This file is not valid JSON'); } }
  let arr;
  if (obj && typeof obj === 'object' && obj.format === PRESET_FILE_FORMAT) { if (!Array.isArray(obj.presets)) throw new Error('The preset file has no preset list'); arr = obj.presets; }
  else if (Array.isArray(obj)) arr = obj;
  else if (obj && typeof obj === 'object' && typeof obj.name === 'string' && obj.settings && typeof obj.settings === 'object') arr = [obj];
  else throw new Error('This file does not contain develop presets');
  const out = [], seen = new Set();
  for (const p of arr) {
    if (!p || typeof p.name !== 'string' || !p.name.trim() || !p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings)) continue;
    const name = p.name.trim().slice(0, 60), key = name.toLowerCase();
    if (seen.has(key)) out.splice(out.findIndex((q) => q.name.toLowerCase() === key), 1);
    seen.add(key); out.push({ name, settings: cleanSettings(p.settings) });
  }
  if (!out.length) throw new Error('The file has no valid develop presets');
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
/** Manual distortion slider ±100 = ∓0.15 radial term (r² at the corners): enough for typical zooms at their ends. */
export const DISTORTION_K = 0.0015;
/** Distortion slider value that a user lens profile gives at a focal length (linear between saved focal lengths). */
export function profileDistortion(entries, focal) {
  const e = (entries || []).filter((p) => Number.isFinite(p.focal) && Number.isFinite(p.k)).sort((a, b) => a.focal - b.focal);
  if (!e.length) return null;
  if (!Number.isFinite(focal) || e.length === 1 || focal <= e[0].focal) return e[0].k;
  if (focal >= e[e.length - 1].focal) return e[e.length - 1].k;
  for (let i = 1; i < e.length; i++) if (focal <= e[i].focal) { const a = e[i - 1], b = e[i], t = (focal - a.focal) / (b.focal - a.focal || 1); return Math.round((a.k + (b.k - a.k) * t) * 10) / 10; }
  return e[e.length - 1].k;
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
  // manual distortion (original model): one radial term around the image centre, r = 1 at the corners,
  // scaled so the image still fills the frame (no empty corners or edges)
  const kd = -(opts.distortion || 0) * DISTORTION_K;
  const dcx = fr.offX + (FW * factor) / 2, dcy = fr.offY + (FH * factor) / 2, dm = Math.hypot(FW * factor, FH * factor) / 2;
  const rmin = Math.min(FW, FH) / Math.hypot(FW, FH), dn = kd < 0 ? 1 + kd * rmin * rmin : 1 + kd;
  /** out[0], out[1] = stored position (opcode frame) for output-frame position X, Y and channel c */
  const at = (X, Y, c, out) => {
    if (kd) { const dx = (X - dcx) / dm, dy = (Y - dcy) / dm, f = (1 + kd * (dx * dx + dy * dy)) / dn; X = dcx + (X - dcx) * f; Y = dcy + (Y - dcy) * f; }
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
  return { fr, at, vg, vig, inv: !!lens?.invertVignette, factor, moves: !!(wp || ks || kd) };
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
  // local adjustments: positions are fractions of the output frame, so bands and previews agree
  const locs = opts.locals !== undefined ? opts.locals : opts.settings?.local ? prepareLocals(opts.settings.local, src, orientation) : null;
  const showK = Number.isInteger(opts.settings?.maskShow) ? opts.settings.maskShow : -1;
  const plan = localPlan(locs, OW, OH).filter((P, k) => { P.k = k; return P.active || k === showK; }), nl = plan.length, aspect = OW / OH;
  const anyRange = plan.some((P) => P.range);
  const used = (k) => plan.some((P) => P.active && P.a[k]);
  const maps = {}; for (const k of LOCAL_DETAIL) if (used(k)) maps[k] = new Int8Array(N);
  const mC = maps.clarity, mT = maps.texture, mS = maps.sharpness, mN = maps.noise, anyMap = !!(mC || mT || mS || mN);
  const ovl = showK >= 0 && showK < (locs?.length || 0) ? new Uint8Array(N) : null;
  const lEV = LOCAL_TEMP_EV / 100, tEV = LOCAL_TINT_EV / 100, conC = (v, k) => { v = 32767.5 + (v - 32767.5) * k; return v < 0 ? 0 : v > 65535 ? 65535 : v; };
  const met = [0, 0, 0], btmp = [0, 0];
  const q8 = (v) => (v > 100 ? 100 : v < -100 ? -100 : Math.round(v));
  const acc = new Float64Array(LOCAL_KEYS.length);
  let r, g, b, lev = 0, ltemp = 0, lcon = 0, ltint = 0, lhi = 0, lsh = 0, lsat = 0;
  for (let oy = r0; oy < r1; oy++) {
    let x = bx * oy + cx, y = by * oy + cy;
    const lv = (oy + 0.5) / OH;
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
      if (nl) {
        if (anyRange) rangeMetrics(R, Gc, B, met);
        if (localsAt(plan, nl, (ox + 0.5) / OW, lv, aspect, r, g, b, met, btmp, acc, ovl, o >> 2, showK)) {
          lev = acc[0]; ltemp = acc[1]; ltint = acc[2]; lcon = acc[3]; lhi = acc[4]; lsh = acc[5]; lsat = acc[6];
          if (lev || ltemp || ltint) {
            if (ltemp || ltint) { const t = ltemp * lEV, u = ltint * tEV, e = lev * LN2; R *= Math.exp(e + (t + u * 0.5) * LN2); Gc *= Math.exp(e - u * LN2); B *= Math.exp(e + (u * 0.5 - t) * LN2); }
            else { const e = Math.exp(lev * LN2); R *= e; Gc *= e; B *= e; }
          }
          if (anyMap) { const i = o >> 2; if (mC) mC[i] = q8(acc[7]); if (mT) mT[i] = q8(acc[8]); if (mS) mS[i] = q8(acc[9]); if (mN) mN[i] = q8(acc[10]); }
        } else lev = ltemp = ltint = lcon = lhi = lsh = lsat = 0;
      }
      // clipped highlights: neutralise where every channel was near the sensor limit (avoids pink / cyan casts)
      const lo = Math.min(r, g, b);
      if (lo > 0.75) { const t = smooth(0.75, 1, lo), m = Math.max(R, Gc, B); R += (m - R) * t; Gc += (m - Gc) * t; B += (m - B) * t; }
      // shadows: lift or deepen the darker tones (multiplicative, so black stays black)
      if (sh) { const Y = 0.2126 * R + 0.7152 * Gc + 0.0722 * B, k = Math.pow(2, sh * 1.3 * (1 - smooth(0, 0.25, Y))); R *= k; Gc *= k; B *= k; }
      if (lsh || lhi) { // local shadows / highlights (±100): lift or deepen the dark tones, brighten or pull down the bright ones
        const Y = 0.2126 * R + 0.7152 * Gc + 0.0722 * B, k = Math.exp(LN2 * ((lsh / 100) * 1.3 * (1 - smooth(0, 0.25, Y)) + (lhi / 100) * 1.2 * smooth(0.12, 0.8, Y))); R *= k; Gc *= k; B *= k;
      }
      // highlight shoulder on the brightest channel (keeps hue)
      const m = Math.max(R, Gc, B);
      if (m > knee) { const e = m - knee, f = (cK === Infinity ? Math.min(1, m) : knee + e / (1 + e / cK)) / m; R *= f; Gc *= f; B *= f; }
      // saturation and vibrance (vibrance favours muted colours; negative vibrance mutes the strongest first)
      if (color || lsat) {
        const mx = Math.max(R, Gc, B), mn = Math.min(R, Gc, B), cs = mx > 1e-6 ? (mx - mn) / mx : 0, Y = 0.2126 * R + 0.7152 * Gc + 0.0722 * B;
        const k = sat * (1 + vib * (vib > 0 ? 1 - cs : cs)) * Math.max(0, 1 + lsat / 100);
        R = Y + (R - Y) * k; Gc = Y + (Gc - Y) * k; B = Y + (B - Y) * k;
      }
      // output curve
      R = R <= 0 ? 0 : R >= 1 ? LS : R * LS; Gc = Gc <= 0 ? 0 : Gc >= 1 ? LS : Gc * LS; B = B <= 0 ? 0 : B >= 1 ? LS : B * LS;
      const ri = R | 0, gi = Gc | 0, bi = B | 0;
      let vr = lr[ri] + (lr[ri + 1 > LS ? LS : ri + 1] - lr[ri]) * (R - ri), vg2 = lg[gi] + (lg[gi + 1 > LS ? LS : gi + 1] - lg[gi]) * (Gc - gi), vb = lb[bi] + (lb[bi + 1 > LS ? LS : bi + 1] - lb[bi]) * (B - bi);
      if (lcon) { // local contrast: around mid grey on the display values
        const k = 1 + lcon / 100; vr = conC(vr, k); vg2 = conC(vg2, k); vb = conC(vb, k);
      }
      if (o16) { o16[o] = vr + 0.5; o16[o + 1] = vg2 + 0.5; o16[o + 2] = vb + 0.5; o16[o + 3] = 65535; }
      if (o8) { o8[o] = vr / 257 + 0.5; o8[o + 1] = vg2 / 257 + 0.5; o8[o + 2] = vb / 257 + 0.5; o8[o + 3] = 255; }
    }
  }
  return { width: OW, height: r1 - r0, fullHeight: OH, data16: o16, data8: o8, maps: anyMap ? maps : null, overlay: ovl };
}

// ---- whole pipeline on a band of output rows (develop → noise reduction → sharpening) ---------------------------
/** Rows of context a band needs above and below so NR and sharpening match a whole-image run (multiple of 4). */
export const BAND_HALO = 48;

/**
 * Memory-aware parallelism. A band worker holds its source region and its develop buffers (linear float RGB, 16-bit
 * output, noise-reduction and sharpening scratch): about BAND_BYTES_PER_PX bytes per output pixel at peak (measured,
 * see scripts/raw-memory.mjs). Bands are developed `workers` at a time, so the band memory in flight is
 * workers × (pixels / bands) × BAND_BYTES_PER_PX; it is kept under DEV_BUDGET of the device memory by using smaller
 * bands first (cheap: only the halo rows are read twice) and fewer workers only when that is not enough.
 */
export const BAND_BYTES_PER_PX = 32;
export const DEV_BUDGET = 1 / 8; // share of navigator.deviceMemory for band buffers in flight
export const MAX_HALO_OVERHEAD = 0.25;
export const WORKERS_PER_GB = 1.5; // pool size limit from device memory (each idle worker costs a few MB)
/** Develop worker pool size: one per spare core (max 8), fewer on small-memory devices (deviceMemory in GB, 0 = unknown). */
export function poolSize(cores, deviceMemory = 0) {
  const byCores = Math.min(8, Math.max(1, (cores || 2) - 1));
  return deviceMemory > 0 ? Math.max(1, Math.min(byCores, Math.floor(deviceMemory * WORKERS_PER_GB))) : byCores;
}
/** { workers, bands, inFlightMB, budgetMB } for a develop of width × height output pixels. cap: test override (0 = one thread). */
export function planWorkers({ width, height, pool, deviceMemory = 0, cap = null, bits = 16 }) {
  let workers = cap == null ? pool : Math.min(pool, cap);
  if (deviceMemory > 0 && workers > 0) workers = Math.min(workers, Math.max(1, Math.floor(deviceMemory * WORKERS_PER_GB)));
  const perPx = bits === 16 ? BAND_BYTES_PER_PX : BAND_BYTES_PER_PX / 2;
  const budget = (deviceMemory > 0 ? deviceMemory : 8) * 2 ** 30 * DEV_BUDGET, MB = 2 ** 20;
  if (workers < 1) return { workers: 0, bands: 1, inFlightMB: Math.round((width * height * perPx) / MB), budgetMB: Math.round(budget / MB) };
  // more bands = less memory in flight, but every band also develops 2 × halo extra rows: at most +25 % rows
  const maxBands = Math.max(workers, Math.floor((height * MAX_HALO_OVERHEAD) / (BAND_HALO * 2)));
  const inFlight = (w, b) => w * (Math.ceil(height / b) + 2 * BAND_HALO) * width * perPx;
  let bands = workers;
  while (bands < maxBands && inFlight(workers, bands) > budget) bands++;
  while (workers > 1 && inFlight(workers, bands) > budget) workers--;
  return { workers, bands, inFlightMB: Math.round(inFlight(workers, bands) / MB), budgetMB: Math.round(budget / MB) };
}
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
  const t1b = now();
  defringe(px, w, hh, set, scale);
  const t1c = now();
  if (!set.fringeMask) sharpen(px, w, hh, set, scale);
  const t2 = now() - (t1c - t1b);
  if (out.maps) localDetail(px, w, hh, out.maps, scale);
  if (out.overlay) maskOverlay(px, out.overlay);
  const t3 = now();
  const cut = (arr) => (h0 === a && h1 === b ? arr : arr.slice((a - h0) * w * 4, (b - h0) * w * 4));
  return { width: w, height: b - a, rows: [a, b], fullHeight: OH, data: cut(px), bits, ms: { nr: t1 - t0, sharpen: t2 - t1, defringe: t1c - t1b, local: t3 - t2 - (t1c - t1b) } };
}

/**
 * Local clarity, texture, sharpness and noise reduction, weighted per pixel by the masks (maps: Int8 −100..100 per
 * pixel, from develop()). All work on luminance and add the change to R, G and B. Radii are in full-resolution pixels
 * (scaled for previews): clarity ≈ 12 px (two box passes of 12), texture ≈ 3 px, sharpness 1 px, noise 2 px; the
 * widest reach (24 px) stays inside the band halo.
 */
export const CLARITY_RADIUS = 12;
export function localDetail(px, w, h, maps, scale = 1) {
  const n = w * h, max = px instanceof Uint16Array ? 65535 : 255, Y = new Float32Array(n), tmp = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) Y[i] = 0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2];
  const blurred = (r, passes) => { const b = Y.slice(); if (r < 1) blur121(b, w, h, tmp); else for (let k = 0; k < passes; k++) boxBlur(b, w, h, r, tmp); return b; };
  const { clarity: mC, texture: mT, sharpness: mS, noise: mN } = maps;
  const b1 = mT || mS ? blurred(0, 1) : null;
  const bT = mT ? blurred(Math.max(1, Math.round(3 * scale)), 2) : null;
  const bC = mC ? blurred(Math.max(1, Math.round(CLARITY_RADIUS * scale)), 2) : null;
  const bN = mN ? blurred(Math.max(1, Math.round(2 * scale)), 1) : null;
  const lim = 0.12 * max, T = 0.05 * max, inv = 1 / max;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y0 = Y[i]; let d = 0;
    if (mC && mC[i]) { const a = mC[i] / 100, e = y0 - bC[i], t = y0 * inv, mid = 1 - (2 * t - 1) * (2 * t - 1); d += a * 0.9 * (0.35 + 0.65 * mid) * (e * lim / (lim + Math.abs(e))); }
    if (mT && mT[i]) { const a = mT[i] / 100; d += a * (a > 0 ? 1.2 : 0.9) * (b1[i] - bT[i]); }
    if (mS && mS[i]) { const a = mS[i] / 100; d += (a > 0 ? a * 1.5 : a) * (y0 - b1[i]); }
    if (mN && mN[i]) { const a = mN[i] / 100, e = y0 - bN[i], ae = Math.abs(e), TT = T * a, keep = ae * ae / (ae * ae + TT * TT + 1e-9); d += (bN[i] + e * keep - y0); }
    if (!d) continue;
    const r = px[j] + d, g = px[j + 1] + d, b = px[j + 2] + d;
    px[j] = r < 0 ? 0 : r > max ? max : r + 0.5; px[j + 1] = g < 0 ? 0 : g > max ? max : g + 0.5; px[j + 2] = b < 0 ? 0 : b > max ? max : b + 0.5;
  }
}
/** Mask overlay (view only): tints the pixels a local adjustment affects red, by its weight (ov: 0..255 per pixel). */
export function maskOverlay(px, ov) {
  const max = px instanceof Uint16Array ? 65535 : 255;
  for (let i = 0, j = 0; i < ov.length; i++, j += 4) {
    const a = (ov[i] / 255) * 0.6; if (!a) continue;
    px[j] = Math.round(px[j] + (max - px[j]) * a); px[j + 1] = Math.round(px[j + 1] * (1 - a) + max * 0.12 * a); px[j + 2] = Math.round(px[j + 2] * (1 - a) + max * 0.12 * a);
  }
}
/**
 * Range-mask eyedropper: luminance (0..100) and hue / saturation of the source near (u, v) (fractions of the output
 * frame) after white balance and exposure, as the range masks see them. src: any whole-image 3-channel source.
 */
export function rangeSample(src, pipe, orientation, u, v) {
  const [FW, FH] = [src.fullW || src.width, src.fullH || src.height], [OW, OH] = orientedSize(FW, FH, orientation), [ax, bx, cx, ay, by, cy] = orientMap(orientation, FW, FH);
  const W = src.width, H = src.height, d = src.data, half = src.half ? halfTable() : null, C = pipe.C;
  const ox = Math.min(OW - 1, Math.max(0, Math.floor(u * OW))), oy = Math.min(OH - 1, Math.max(0, Math.floor(v * OH))), sx = ax * ox + bx * oy + cx, sy = ay * ox + by * oy + cy;
  let r = 0, g = 0, b = 0, m = 0;
  for (let yy = Math.max(0, sy - 1); yy <= Math.min(H - 1, sy + 1); yy++) for (let xx = Math.max(0, sx - 1); xx <= Math.min(W - 1, sx + 1); xx++) { const i = (yy * W + xx) * 3, f = (q) => (half ? half[d[q]] : d[q]); r += f(i); g += f(i + 1); b += f(i + 2); m++; }
  r /= m; g /= m; b /= m;
  const met = rangeMetrics(C[0] * r + C[1] * g + C[2] * b, C[3] * r + C[4] * g + C[5] * b, C[6] * r + C[7] * g + C[8] * b);
  return { lum: Math.round(met[0]), hue: met[1] < 0 ? -1 : Math.round(met[1]), sat: met[2] };
}
/** Soft hue window: 1 inside [lo, hi] degrees, fading to 0 over `f` degrees outside. */
const hueWeight = (h, lo, hi, f) => (h >= lo && h <= hi ? 1 : h < lo ? Math.max(0, 1 - (lo - h) / f) : Math.max(0, 1 - (h - hi) / f));
/**
 * Defringe (axial chromatic aberration): pixels whose hue lies in the purple or green range are pulled toward
 * neutral grey (their own luma), weighted by the amount and by local contrast, so fringes along high-contrast edges
 * go while purple or green subjects in flat areas keep their colour. Works in place on RGBA (8- or 16-bit).
 * Edge strength = luma max − min over a (2r+1)² window, r = 3 px at full resolution (scaled for previews).
 */
export function defringe(px, w, h, set, scale = 1) {
  const ap = (set.fringePurple || 0) / 100, ag = (set.fringeGreen || 0) / 100, mask = !!set.fringeMask;
  if (mask) { // preview of the affected areas: white = untouched, darker = more colour removed
    const max = px instanceof Uint16Array ? 65535 : 255, wgt = (ap > 0 || ag > 0) && w >= 3 && h >= 3 ? defringeWeights(px, w, h, set, scale) : null;
    for (let i = 0, j = 0, n = w * h; i < n; i++, j += 4) { const v = Math.round(max * (1 - (wgt ? wgt[i] : 0) * 0.9)); px[j] = v; px[j + 1] = wgt && wgt[i] > 0 ? Math.round(v * 0.75) : v; px[j + 2] = v; }
    return;
  }
  if (!(ap > 0 || ag > 0) || w < 3 || h < 3) return;
  const wgt = defringeWeights(px, w, h, set, scale), max = px instanceof Uint16Array ? 65535 : 255, inv = 1 / max;
  for (let i = 0, j = 0, n = w * h; i < n; i++, j += 4) {
    const k = 1 - wgt[i]; if (k >= 1) continue;
    const R = px[j], G = px[j + 1], B = px[j + 2], l = (0.2126 * R + 0.7152 * G + 0.0722 * B) * inv * max;
    px[j] = Math.round(l + (R - l) * k); px[j + 1] = Math.round(l + (G - l) * k); px[j + 2] = Math.round(l + (B - l) * k);
  }
}
/** Hue in degrees (0..360) of an RGB triple, or -1 for grey. */
export function hueOf(R, G, B) {
  const hi = Math.max(R, G, B), lo = Math.min(R, G, B), c = hi - lo; if (c <= 0) return -1;
  let h = hi === R ? ((G - B) / c) % 6 : hi === G ? (B - R) / c + 2 : (R - G) / c + 4; h *= 60; return h < 0 ? h + 360 : h;
}
/**
 * Defringe eyedropper: the fringe colour near (x, y) of an RGBA image = its most saturated pixel within `r` pixels.
 * Returns { kind: 'purple' | 'green' | null, hue, sat, lo, hi } (lo / hi: a hue range ±20° around it, inside that
 * colour's slider range) — kind is null for neutral or non-fringe colours (reds, oranges, yellows).
 */
export function pickFringe(px, w, h, x, y, r = 3) {
  const max = px instanceof Uint16Array ? 65535 : 255;
  let best = -1, bi = -1;
  for (let yy = Math.max(0, Math.round(y) - r); yy <= Math.min(h - 1, Math.round(y) + r); yy++) for (let xx = Math.max(0, Math.round(x) - r); xx <= Math.min(w - 1, Math.round(x) + r); xx++) {
    const j = (yy * w + xx) * 4, hi = Math.max(px[j], px[j + 1], px[j + 2]), lo = Math.min(px[j], px[j + 1], px[j + 2]), sat = hi > 0 ? (hi - lo) / hi : 0;
    const sc = sat * Math.min(1, hi / (max * 0.1)); // ignore near-black noise
    if (sc > best) { best = sc; bi = j; }
  }
  if (bi < 0) return { kind: null, hue: -1, sat: 0 };
  const hue = hueOf(px[bi], px[bi + 1], px[bi + 2]), sat = Math.max(0, best);
  if (sat < 0.08 || hue < 0) return { kind: null, hue: Math.round(hue), sat, why: 'neutral' };
  const range = hue >= 200 && hue <= 340 ? [200, 340, 'purple'] : hue >= 40 && hue <= 190 ? [40, 190, 'green'] : null;
  if (!range) return { kind: null, hue: Math.round(hue), sat, why: 'hue' };
  let lo = Math.max(range[0], Math.round(hue - 20)), hi = Math.min(range[1], Math.round(hue + 20));
  if (hi - lo < 10) { if (lo === range[0]) hi = lo + 10; else lo = hi - 10; }
  return { kind: range[2], hue: Math.round(hue), sat, lo, hi };
}
/** Per-pixel defringe strength 0..1 (amount × hue window × edge contrast). */
function defringeWeights(px, w, h, set, scale) {
  const ap = (set.fringePurple || 0) / 100, ag = (set.fringeGreen || 0) / 100;
  const max = px instanceof Uint16Array ? 65535 : 255, inv = 1 / max, n = w * h, r = Math.max(1, Math.round(3 * scale));
  const pLo = set.fringePurpleLo ?? 260, pHi = set.fringePurpleHi ?? 320, gLo = set.fringeGreenLo ?? 80, gHi = set.fringeGreenHi ?? 150;
  const Y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) Y[i] = (0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]) * inv;
  // separable running max / min (horizontal then vertical)
  const mx = new Float32Array(n), mn = new Float32Array(n), tx = new Float32Array(n), tn = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let a = -1, b = 2; const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) { const v = Y[o + k]; if (v > a) a = v; if (v < b) b = v; }
      tx[o + x] = a; tn[o + x] = b;
    }
  }
  for (let y = 0; y < h; y++) { // row-major so the vertical pass stays cache friendly
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r), o = y * w;
    mx.set(tx.subarray(y0 * w, y0 * w + w), o); mn.set(tn.subarray(y0 * w, y0 * w + w), o);
    for (let k = y0 + 1; k <= y1; k++) {
      const q = k * w;
      for (let x = 0; x < w; x++) { const a = tx[q + x], b = tn[q + x]; if (a > mx[o + x]) mx[o + x] = a; if (b < mn[o + x]) mn[o + x] = b; }
    }
  }
  const out = tx; out.fill(0); // reuse a scratch buffer for the weights
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const edge = smooth(0.08, 0.3, mx[i] - mn[i]); if (edge <= 0) continue;
    const R = px[j], G = px[j + 1], B = px[j + 2], hi = Math.max(R, G, B), lo = Math.min(R, G, B), c = hi - lo;
    if (c <= max * 0.01) continue;
    let hue = hi === R ? ((G - B) / c) % 6 : hi === G ? (B - R) / c + 2 : (R - G) / c + 4; hue *= 60; if (hue < 0) hue += 360;
    out[i] = Math.min(1, ap * hueWeight(hue, pLo, pHi, 15) + ag * hueWeight(hue, gLo, gHi, 15)) * edge;
  }
  return out;
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

// ---- re-develop into a transformed layer ------------------------------------------------------------------------
/**
 * Resample a developed RGBA image (16- or 8-bit) through an affine map into a w × h image. m = { a, b, c, d, e, f }
 * maps output positions (continuous pixel coordinates, pixel centres at +0.5) to source positions:
 * X = a·x + c·y + e, Y = b·x + d·y + f. Quarter turns, flips and integer offsets are copied exactly; other maps use
 * bilinear sampling, after an integer box pre-shrink when the map shrinks the image by more than 1.33×. Output
 * pixels whose centre falls outside the source are transparent.
 */
export function resampleAffine(src, W, H, m, w, h) {
  const deep = src instanceof Uint16Array, out = deep ? new Uint16Array(w * h * 4) : new Uint8ClampedArray(w * h * 4), A = deep ? 65535 : 255;
  const ints = [m.a, m.b, m.c, m.d].every((v) => Math.abs(v - Math.round(v)) < 1e-9 && Math.abs(Math.round(v)) <= 1);
  const perm = ints && Math.abs(Math.round(m.a) * Math.round(m.d) - Math.round(m.b) * Math.round(m.c)) === 1 && Math.abs(m.e - Math.round(m.e)) < 1e-6 && Math.abs(m.f - Math.round(m.f)) < 1e-6;
  if (perm) {
    const a = Math.round(m.a), b = Math.round(m.b), c = Math.round(m.c), d = Math.round(m.d), e = Math.round(m.e), f = Math.round(m.f);
    for (let y = 0, o = 0; y < h; y++) for (let x = 0; x < w; x++, o += 4) {
      // pixel (x, y) covers [x, x+1): its centre maps to a source pixel centre, so floor gives the exact source pixel
      const X = Math.floor(a * (x + 0.5) + c * (y + 0.5) + e), Y = Math.floor(b * (x + 0.5) + d * (y + 0.5) + f);
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const i = (Y * W + X) * 4; out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = src[i + 3];
    }
    return out;
  }
  // shrink factor of the map (source pixels per output pixel)
  const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  let S = src, SW = W, SH = H, k = 1;
  if (s > 1.33) { // box pre-shrink by an integer factor so bilinear does not alias
    k = Math.floor(s); SW = Math.max(1, Math.floor(W / k)); SH = Math.max(1, Math.floor(H / k));
    S = deep ? new Uint16Array(SW * SH * 4) : new Uint8ClampedArray(SW * SH * 4);
    const acc = new Float64Array(4);
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      acc.fill(0);
      for (let yy = y * k; yy < y * k + k; yy++) for (let xx = x * k; xx < x * k + k; xx++) { const i = (yy * W + xx) * 4; acc[0] += src[i]; acc[1] += src[i + 1]; acc[2] += src[i + 2]; acc[3] += src[i + 3]; }
      const o = (y * SW + x) * 4, kk = k * k; for (let c = 0; c < 4; c++) S[o + c] = Math.round(acc[c] / kk);
    }
  }
  const sw = SW * k, sh = SH * k; // the part of the source the shrunk copy covers
  for (let y = 0, o = 0; y < h; y++) for (let x = 0; x < w; x++, o += 4) {
    const px = x + 0.5, py = y + 0.5, X = m.a * px + m.c * py + m.e, Y = m.b * px + m.d * py + m.f;
    if (X < 0 || Y < 0 || X > W || Y > H) continue;
    const fx = Math.min(SW - 1, Math.max(0, Math.min(X, sw) / k - 0.5)), fy = Math.min(SH - 1, Math.max(0, Math.min(Y, sh) / k - 0.5));
    const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(SW - 1, x0 + 1), y1 = Math.min(SH - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    const i00 = (y0 * SW + x0) * 4, i10 = (y0 * SW + x1) * 4, i01 = (y1 * SW + x0) * 4, i11 = (y1 * SW + x1) * 4;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round((S[i00 + c] * (1 - tx) + S[i10 + c] * tx) * (1 - ty) + (S[i01 + c] * (1 - tx) + S[i11 + c] * tx) * ty);
    out[o + 3] = A;
  }
  return out;
}
/** Affine helpers ({ a, b, c, d, e, f } as in resampleAffine): compose(m, t) = m after t (first t, then m). */
export const affineCompose = (m, t) => ({ a: m.a * t.a + m.c * t.b, b: m.b * t.a + m.d * t.b, c: m.a * t.c + m.c * t.d, d: m.b * t.c + m.d * t.d, e: m.a * t.e + m.c * t.f + m.e, f: m.b * t.e + m.d * t.f + m.f });
export const affineIdentity = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
