// Tintwork GPU RAW develop: the develop pipeline and local masks on the GPU.
//   WebGPU (compute): the per-pixel develop (orientation, lens warp, CA, vignette, white balance, local masks with
//     brush rasters, range masks and parts, tone and colour, LUT) and every neighbourhood filter after it (noise
//     reduction, defringe, sharpening, local clarity / texture / sharpness / noise, mask overlay).
//   WebGL2 (fragment shader): the per-pixel develop only; the neighbourhood filters run on the CPU (raw.js).
// raw.js stays the reference: the GPU reads the same half-float (or float32) source, works in float32 and rounds at
// the same points (16-bit output within 1 level of the CPU; see scripts/v16-test.mjs). Positions that resample the
// source are worked out as displacements so float32 keeps sub-pixel precision on 24 MP images.
import * as R from './raw.js';

const LS = R.LUT_SIZE;
export const PLAN_SIZE = 256, PART_SIZE = 16, HDR = 128, MAX_GPU_PLANS = R.MAX_LOCALS;
const MAPKEYS = ['clarity', 'texture', 'sharpness', 'noise'];

/** Is WebGPU / WebGL2 exposed here (window or worker)? */
export const webgpuExposed = () => typeof navigator !== 'undefined' && !!navigator.gpu;
const SOFT_RE = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|software|lavapipe/i;

// ---- parameters --------------------------------------------------------------------------------------------------
/**
 * Everything the per-pixel kernel needs for output rows [h0, h1) of `src`, as one Float32Array (header + one record
 * per mask), plus the LUTs and the brush grids. Mirrors develop() in raw.js.
 */
export function packDevelop(src, opts, h0, h1, maxv) {
  const { pipe, orientation = 1, factor = 1 } = opts;
  const W = src.width, H = src.height, X0 = src.x0 || 0, Y0 = src.y0 || 0;
  const FW = src.fullW || src.width, FH = src.fullH || src.height, [OW, OH] = R.orientedSize(FW, FH, orientation);
  const [ax, bx, cx, ay, by, cy] = R.orientMap(orientation, FW, FH);
  const G = R.developGeometry(src, opts), K = G.K, fr = G.fr, manV = opts.vignette || 0;
  const slow = !!(G.moves || G.vig || manV);
  const locs = opts.locals !== undefined ? opts.locals : opts.settings?.local ? R.prepareLocals(opts.settings.local, src, orientation) : null;
  const showK = Number.isInteger(opts.settings?.maskShow) ? opts.settings.maskShow : -1;
  const plan = R.localPlan(locs, OW, OH).filter((Q, k) => { Q.k = k; return Q.active || k === showK; }), nl = plan.length;
  const used = (k) => plan.some((Q) => Q.active && Q.a[k]);
  let mapBits = 0; MAPKEYS.forEach((k, i) => { if (used(k)) mapBits |= 1 << i; });
  const ovl = showK >= 0 && showK < (locs?.length || 0);
  const P = new Float32Array(HDR + nl * PLAN_SIZE);
  const C = pipe.C;
  Object.assign(P, [W, H, X0, Y0, FW, FH, OW, OH, h0, h1 - h0, src.half ? 1 : 0, slow ? 1 : 0, ax, bx, cx, ay, by, cy]);
  for (let i = 0; i < 9; i++) P[18 + i] = C[i];
  P[27] = pipe.knee; P[28] = pipe.cK === Infinity ? 0 : pipe.cK; P[29] = pipe.cK === Infinity ? 1 : 0; P[30] = pipe.shadows;
  const vib = pipe.vib || 0, sat = pipe.sat ?? 1; P[31] = vib; P[32] = sat; P[33] = vib !== 0 || sat !== 1 ? 1 : 0;
  P[35] = nl; P[36] = plan.some((Q) => Q.range) ? 1 : 0; P[38] = mapBits; P[39] = ovl ? 1 : 0;
  P[40] = factor; P[41] = fr.offX; P[42] = fr.offY;
  P[43] = K.kd; P[44] = K.dcx; P[45] = K.dcy; P[46] = K.dm; P[47] = K.dn - 1; P[48] = K.dn;
  if (K.wp) { P[49] = 1; P[50] = K.wg.px; P[51] = K.wg.py; P[52] = K.wg.m; for (let c = 0; c < 3; c++) { const p = K.wp[c], b = 53 + c * 6; P[b] = p.kr[0] - 1; P[b + 1] = p.kr[1]; P[b + 2] = p.kr[2]; P[b + 3] = p.kr[3]; P[b + 4] = p.kt[0]; P[b + 5] = p.kt[1]; } }
  if (K.ks) { P[71] = 1; P[72] = K.ks[0] - 1; P[73] = K.ks[2] - 1; P[74] = K.cc.px; P[75] = K.cc.py; }
  if (G.vg) { P[76] = 1; P[77] = G.vg.px; P[78] = G.vg.py; P[79] = G.vg.m; for (let i = 0; i < 5; i++) P[80 + i] = G.vig.k[i] || 0; P[85] = G.inv ? 1 : 0; }
  P[86] = manV; P[87] = (FW * factor) / 2; P[88] = (FH * factor) / 2; P[89] = Math.hypot(FW * factor, FH * factor) / 2;
  P[90] = R.LOCAL_TEMP_EV / 100; P[91] = R.LOCAL_TINT_EV / 100; P[92] = maxv;
  // brush grids, concatenated
  const gl = []; let goff = 0;
  const put = (arr) => { if (!arr) return -1; const o = goff; gl.push(arr); goff += arr.length; return o; };
  const shape = (S, b) => { P[b] = S.kind; P[b + 1] = S.ax; P[b + 2] = S.ay; P[b + 3] = S.dx; P[b + 4] = S.dy; P[b + 5] = S.cx; P[b + 6] = S.cy; P[b + 7] = S.irx; P[b + 8] = S.iry; P[b + 9] = S.f0; P[b + 10] = S.fi; };
  plan.forEach((Q, k) => {
    const b = HDR + k * PLAN_SIZE, a = Q.a;
    shape(Q, b); P[b + 11] = Q.inv ? 1 : 0; P[b + 12] = Q.active ? 1 : 0; P[b + 13] = Q.range ? 1 : 0; P[b + 14] = Q.k === showK ? 1 : 0;
    if (a.lum) { P[b + 16] = 1; P[b + 17] = a.lum.lo; P[b + 18] = a.lum.hi; P[b + 19] = a.lum.soft; }
    if (a.color) { P[b + 20] = 1; P[b + 21] = a.color.hue; P[b + 22] = a.color.range; P[b + 23] = a.color.soft; }
    const B = Q.brush;
    if (B) {
      P[b + 24] = 1; P[b + 25] = B.GW; P[b + 26] = B.GH; P[b + 27] = B.bx0; P[b + 28] = B.by0; P[b + 29] = B.bx1; P[b + 30] = B.by1;
      P[b + 31] = put(B.add); P[b + 32] = put(B.era); P[b + 33] = put(B.addA); P[b + 34] = put(B.eraA); P[b + 35] = put(B.refA); P[b + 36] = put(B.refE);
    }
    for (let j = 0; j < 15; j++) P[b + 40 + j] = Q.c[j];
    const parts = Q.parts || []; P[b + 60] = parts.length;
    parts.forEach((S, i) => { const o = b + 64 + i * PART_SIZE; P[o] = S.op; P[o + 1] = S.inv ? 1 : 0; shape(S, o + 2); });
  });
  if (goff > 2 ** 27) throw new Error('brush masks too large for the GPU');
  const grids = new Float32Array(Math.max(4, goff)); let o = 0; for (const a of gl) { grids.set(a, o); o += a.length; }
  const [lr, lg, lb] = pipe.luts || [pipe.lut, pipe.lut, pipe.lut], lut = new Float32Array(3 * (LS + 1));
  lut.set(lr.subarray(0, LS + 1), 0); lut.set(lg.subarray(0, LS + 1), LS + 1); lut.set(lb.subarray(0, LS + 1), 2 * (LS + 1));
  return { P, grids, gridKey: plan.map((Q) => Q.brush || 0), lut, OW, OH, mapBits, ovl, nl };
}

// ---- shared WGSL / GLSL develop body ------------------------------------------------------------------------------
// The kernel is written once in a small C-like subset and turned into WGSL or GLSL by `dialect()`: `float`, `int`,
// `uint`, `vec2`, `let x: float = …` → declarations; helper calls P(i), SRC(i), LUT(i), GR(i) are defined per backend.
// The kernel is written once in WGSL with every declaration typed; toGLSL() turns it into GLSL ES 3.00 for the WebGL2
// path (purely syntactic). Each backend defines P(i), LUT(i), GR(i), srcpx(x, y, c) and roundEven_().
const DEV_BODY = String.raw`
fn smoothf(a: f32, b: f32, x: f32) -> f32 { let t: f32 = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
fn fmodT(a: f32, b: f32) -> f32 { return a - b * trunc(a / b); }
// accurate sin/cos (built-ins only promise ~2^-11 absolute error): reduce to [-pi, pi], then Taylor to x^17 / x^18 (< 1e-6)
fn redPi(t: f32) -> f32 { return t - 6.283185307179586 * floor((t + 3.141592653589793) / 6.283185307179586); }
fn sinA(t: f32) -> f32 { let x: f32 = redPi(t); let z: f32 = x * x;
  return x * (1.0 + z * (-1.6666667e-1 + z * (8.3333333e-3 + z * (-1.9841270e-4 + z * (2.7557319e-6 + z * (-2.5052108e-8 + z * (1.6059044e-10 + z * (-7.6471637e-13 + z * 2.8114573e-15)))))))); }
fn cosA(t: f32) -> f32 { let x: f32 = redPi(t); let z: f32 = x * x;
  return 1.0 + z * (-0.5 + z * (4.1666667e-2 + z * (-1.3888889e-3 + z * (2.4801587e-5 + z * (-2.7557319e-7 + z * (2.0876757e-9 + z * (-1.1470746e-11 + z * (4.7794773e-14 + z * -1.5619207e-16)))))))); }
fn halfv(h: u32) -> f32 {
  let e: u32 = (h >> 10u) & 31u; let f: u32 = h & 1023u; let s: f32 = select(1.0, -1.0, (h & 0x8000u) != 0u);
  if (e == 0u) { return s * f32(f) * 5.9604644775390625e-8; }
  if (e == 31u) { return select(s * 65504.0, 0.0, f != 0u); }
  return bitcast<f32>(((h & 0x8000u) << 16u) | ((e + 112u) << 23u) | (f << 13u));
}
fn samp(xi: i32, xf: f32, yi: i32, yf: f32, c: u32) -> f32 {
  let W: i32 = i32(P(0u)); let H: i32 = i32(P(1u));
  var x0: i32 = xi; var fx: f32 = xf; var y0: i32 = yi; var fy: f32 = yf;
  if (x0 < 0) { x0 = 0; fx = 0.0; } else if (x0 >= W - 1) { x0 = W - 1; fx = 0.0; }
  if (y0 < 0) { y0 = 0; fy = 0.0; } else if (y0 >= H - 1) { y0 = H - 1; fy = 0.0; }
  let x1: i32 = min(W - 1, x0 + 1); let y1: i32 = min(H - 1, y0 + 1);
  let g00: f32 = srcpx(x0, y0, c); let g10: f32 = srcpx(x1, y0, c); let g01: f32 = srcpx(x0, y1, c); let g11: f32 = srcpx(x1, y1, c);
  return (g00 * (1.0 - fx) + g10 * fx) * (1.0 - fy) + (g01 * (1.0 - fx) + g11 * fx) * fy;
}
fn dispAt(X: f32, Y: f32, c: u32) -> vec2f {
  var D: vec2f = vec2f(0.0, 0.0); var Xp: f32 = X; var Yp: f32 = Y;
  if (P(43u) != 0.0) {
    let dx: f32 = (X - P(44u)) / P(46u); let dy: f32 = (Y - P(45u)) / P(46u);
    let fm1: f32 = (P(43u) * (dx * dx + dy * dy) - P(47u)) / P(48u);
    D = vec2f((X - P(44u)) * fm1, (Y - P(45u)) * fm1); Xp = X + D.x; Yp = Y + D.y;
  }
  if (P(49u) > 0.5) {
    let b: u32 = 53u + c * 6u; let m: f32 = P(52u); let dx: f32 = (Xp - P(50u)) / m; let dy: f32 = (Yp - P(51u)) / m; let r2: f32 = dx * dx + dy * dy;
    let fm1: f32 = P(b) + r2 * (P(b + 1u) + r2 * (P(b + 2u) + r2 * P(b + 3u)));
    let tx: f32 = P(b + 4u) * 2.0 * dx * dy + P(b + 5u) * (r2 + 2.0 * dx * dx); let ty: f32 = P(b + 4u) * (r2 + 2.0 * dy * dy) + P(b + 5u) * 2.0 * dx * dy;
    D = D + vec2f(m * (dx * fm1 + tx), m * (dy * fm1 + ty));
  }
  if (P(71u) > 0.5 && c != 1u) {
    let k: f32 = select(P(73u), P(72u), c == 0u);
    D = D + vec2f((X + D.x - P(74u)) * k, (Y + D.y - P(75u)) * k);
  }
  return D;
}
fn shapeAt(b: u32, u: f32, v: f32, aspect: f32) -> f32 {
  let kind: f32 = P(b);
  if (kind == 1.0) { let t: f32 = (u * aspect - P(b + 1u)) * P(b + 3u) + (v - P(b + 2u)) * P(b + 4u); if (t <= 0.0) { return 1.0; } if (t >= 1.0) { return 0.0; } return 1.0 - t * t * (3.0 - 2.0 * t); }
  if (kind == 2.0) {
    let dx: f32 = (u - P(b + 5u)) * P(b + 7u); let dy: f32 = (v - P(b + 6u)) * P(b + 8u); let d2: f32 = dx * dx + dy * dy;
    if (d2 < 1.0) { let d: f32 = sqrt(d2); if (d <= P(b + 9u)) { return 1.0; } let t: f32 = (d - P(b + 9u)) * P(b + 10u); return 1.0 - t * t * (3.0 - 2.0 * t); }
  }
  return 0.0;
}
fn bil(off: u32, GW: u32, GH: u32, u: f32, v: f32) -> f32 {
  let fx: f32 = min(f32(GW) - 1.0, max(0.0, u * f32(GW) - 0.5)); let fy: f32 = min(f32(GH) - 1.0, max(0.0, v * f32(GH) - 0.5));
  let x0: u32 = u32(fx); let y0: u32 = u32(fy); let x1: u32 = select(x0, x0 + 1u, x0 + 1u < GW); let y1: u32 = select(y0, y0 + 1u, y0 + 1u < GH);
  let tx: f32 = fx - f32(x0); let ty: f32 = fy - f32(y0);
  return (GR(off + y0 * GW + x0) * (1.0 - tx) + GR(off + y0 * GW + x1) * tx) * (1.0 - ty) + (GR(off + y1 * GW + x0) * (1.0 - tx) + GR(off + y1 * GW + x1) * tx) * ty;
}
fn simTo(r: f32, g: f32, b: f32, o: u32) -> f32 {
  let s: f32 = max(1e-5, r + g + b); let dl: f32 = (log2(s) - GR(o)) / 0.45; let dr: f32 = (r / s - GR(o + 1u)) / 0.035; let db: f32 = (b / s - GR(o + 2u)) / 0.035;
  let d: f32 = dl * dl + dr * dr + db * db; if (d >= 9.0) { return 0.0; } return exp(-d);
}
fn brushW(b: u32, u: f32, v: f32, r: f32, g: f32, bb: f32, w0: f32) -> f32 {
  let GW: u32 = u32(P(b + 25u)); let GH: u32 = u32(P(b + 26u)); let cx: f32 = u * f32(GW); let cy: f32 = v * f32(GH);
  var add: f32 = 0.0; var er: f32 = 0.0;
  if (!(cx < P(b + 27u) || cx > P(b + 29u) + 1.0 || cy < P(b + 28u) || cy > P(b + 30u) + 1.0)) {
    if (P(b + 31u) >= 0.0) { add = bil(u32(P(b + 31u)), GW, GH, u, v); }
    if (P(b + 32u) >= 0.0) { er = bil(u32(P(b + 32u)), GW, GH, u, v); }
    if (P(b + 33u) >= 0.0 || P(b + 34u) >= 0.0) {
      let ci: u32 = u32(min(i32(GH) - 1, max(0, i32(v * f32(GH))))) * GW + u32(min(i32(GW) - 1, max(0, i32(u * f32(GW)))));
      if (P(b + 33u) >= 0.0) { let c: f32 = bil(u32(P(b + 33u)), GW, GH, u, v); if (c > 0.001) { let s: f32 = simTo(r, g, bb, u32(P(b + 35u)) + ci * 3u); add = 1.0 - (1.0 - add) * (1.0 - c * s); } }
      if (P(b + 34u) >= 0.0) { let c: f32 = bil(u32(P(b + 34u)), GW, GH, u, v); if (c > 0.001) { let s: f32 = simTo(r, g, bb, u32(P(b + 36u)) + ci * 3u); er = 1.0 - (1.0 - er) * (1.0 - c * s); } }
    }
  }
  add = min(add, 1.0); er = min(er, 1.0);
  return max(w0, add) * (1.0 - er);
}
fn rangeW(b: u32, L: f32, hue: f32, sat: f32) -> f32 {
  var w: f32 = 1.0;
  if (P(b + 16u) > 0.5) {
    let lo: f32 = P(b + 17u); let hi: f32 = P(b + 18u); let soft: f32 = P(b + 19u);
    if (L >= lo && L <= hi) { w = 1.0; } else if (soft > 0.0) { w = 1.0 - smoothf(0.0, soft, select(L - hi, lo - L, L < lo)); } else { w = 0.0; }
    if (w <= 0.0) { return 0.0; }
  }
  if (P(b + 20u) > 0.5) {
    if (hue < 0.0) { return 0.0; }
    var dh: f32 = abs(hue - P(b + 21u)); if (dh > 180.0) { dh = 360.0 - dh; }
    var c: f32 = 0.0; let rg: f32 = P(b + 22u); let soft: f32 = P(b + 23u);
    if (dh <= rg) { c = 1.0; } else if (soft > 0.0) { c = 1.0 - smoothf(0.0, soft, dh - rg); }
    w = w * c * smoothf(0.03, 0.12, sat);
  }
  return w;
}
fn maskW(b: u32, u: f32, v: f32, aspect: f32, r: f32, g: f32, bb: f32, L: f32, hue: f32, sat: f32) -> f32 {
  var w: f32 = shapeAt(b, u, v, aspect);
  if (P(b + 24u) > 0.5) { w = brushW(b, u, v, r, g, bb, w); }
  let np: u32 = u32(P(b + 60u));
  for (var i: u32 = 0u; i < np; i = i + 1u) {
    let o: u32 = b + 64u + i * 16u; var q: f32 = shapeAt(o + 2u, u, v, aspect); if (P(o + 1u) > 0.5) { q = 1.0 - q; }
    let op: f32 = P(o);
    if (op == 1.0) { w = max(w, q); } else if (op == 2.0) { w = w * (1.0 - q); } else { w = w * q; }
  }
  if (P(b + 11u) > 0.5) { w = 1.0 - w; }
  if (w > 0.0 && P(b + 13u) > 0.5) { w = w * rangeW(b, L, hue, sat); }
  return w;
}
fn lutv(c: u32, X: f32) -> f32 {
  var x: f32 = X;
  if (x <= 0.0) { x = 0.0; } else if (x >= 1.0) { x = @LS@.0; } else { x = x * @LS@.0; }
  let i: u32 = u32(x); let o: u32 = c * @LS1@u; let j: u32 = min(i + 1u, @LS@u);
  return LUT(o + i) + (LUT(o + j) - LUT(o + i)) * (x - f32(i));
}
fn conC(v: f32, k: f32) -> f32 { let x: f32 = 32767.5 + (v - 32767.5) * k; return clamp(x, 0.0, 65535.0); }
fn q8(v: f32) -> u32 { let x: f32 = floor(clamp(v, -100.0, 100.0) + 0.5); return u32(i32(x)) & 255u; }
fn outv(v: f32) -> u32 {
  if (P(92u) > 256.0) { return u32(clamp(floor(v + 0.5), 0.0, 65535.0)); }
  return u32(roundEven_(clamp(v / 257.0, 0.0, 255.0)));
}
fn developPx(ox: u32, oy: u32) -> vec4u {
  let OW: f32 = P(6u); let OH: f32 = P(7u);
  let x: i32 = i32(P(12u)) * i32(ox) + i32(P(13u)) * i32(oy) + i32(P(14u));
  let y: i32 = i32(P(15u)) * i32(ox) + i32(P(16u)) * i32(oy) + i32(P(17u));
  let xl: i32 = x - i32(P(2u)); let yl: i32 = y - i32(P(3u));
  var r: f32 = 0.0; var g: f32 = 0.0; var b: f32 = 0.0;
  if (P(11u) < 0.5) {
    r = srcpx(xl, yl, 0u); g = srcpx(xl, yl, 1u); b = srcpx(xl, yl, 2u);
  } else {
    let fac: f32 = P(40u); let X: f32 = (f32(x) + 0.5) * fac - 0.5 + P(41u); let Y: f32 = (f32(y) + 0.5) * fac - 0.5 + P(42u);
    var ch: vec3f = vec3f(0.0, 0.0, 0.0);
    for (var c: u32 = 0u; c < 3u; c = c + 1u) {
      let D: vec2f = dispAt(X, Y, c); let dq: vec2f = D / fac; let fl: vec2f = floor(dq);
      var v: f32 = samp(xl + i32(fl.x), dq.x - fl.x, yl + i32(fl.y), dq.y - fl.y, c);
      let sx: f32 = X + D.x; let sy: f32 = Y + D.y;
      if (P(76u) > 0.5) {
        let dx: f32 = (sx - P(77u)) / P(79u); let dy: f32 = (sy - P(78u)) / P(79u); let r2: f32 = dx * dx + dy * dy;
        let gain: f32 = 1.0 + r2 * (P(80u) + r2 * (P(81u) + r2 * (P(82u) + r2 * (P(83u) + r2 * P(84u)))));
        if (P(85u) > 0.5) { v = v / gain; } else { v = v * gain; }
      }
      if (P(86u) != 0.0) { let dx: f32 = (sx - P(41u) - P(87u)) / P(89u); let dy: f32 = (sy - P(42u) - P(88u)) / P(89u); v = v * (1.0 + P(86u) * (dx * dx + dy * dy)); }
      ch[c] = v;
    }
    r = ch.x; g = ch.y; b = ch.z;
  }
  var RR: f32 = P(18u) * r + P(19u) * g + P(20u) * b; var GG: f32 = P(21u) * r + P(22u) * g + P(23u) * b; var BB: f32 = P(24u) * r + P(25u) * g + P(26u) * b;
  @ACC@
  for (var j: u32 = 0u; j < 15u; j = j + 1u) { acc[j] = 0.0; }
  var ov: u32 = 0u; var mp: u32 = 0u;
  let nl: u32 = u32(P(35u));
  if (nl > 0u) {
    var L: f32 = 0.0; var hue: f32 = -1.0; var sat: f32 = 0.0;
    if (P(36u) > 0.5) {
      let Yl: f32 = 0.2126 * RR + 0.7152 * GG + 0.0722 * BB;
      if (Yl <= 0.0) { L = 0.0; } else if (Yl >= 1.0) { L = 100.0; } else { L = sqrt(Yl) * 100.0; }
      let sr: f32 = select(0.0, sqrt(max(RR, 0.0)), RR > 0.0); let sg: f32 = select(0.0, sqrt(max(GG, 0.0)), GG > 0.0); let sb: f32 = select(0.0, sqrt(max(BB, 0.0)), BB > 0.0);
      let hi: f32 = max(sr, max(sg, sb)); let lo: f32 = min(sr, min(sg, sb)); let cc: f32 = hi - lo;
      if (cc > 1e-6) {
        var h: f32 = 0.0;
        if (hi == sr) { h = fmodT((sg - sb) / cc, 6.0); } else if (hi == sg) { h = (sb - sr) / cc + 2.0; } else { h = (sr - sg) / cc + 4.0; }
        h = h * 60.0; if (h < 0.0) { h = h + 360.0; }
        hue = h; sat = cc / hi;
      }
    }
    let u: f32 = (f32(ox) + 0.5) / OW; let v: f32 = (f32(oy) + 0.5) / OH; let aspect: f32 = OW / OH;
    var hit: bool = false;
    for (var k: u32 = 0u; k < nl; k = k + 1u) {
      let pb: u32 = @HDR@u + k * @PLAN@u;
      let w: f32 = maskW(pb, u, v, aspect, r, g, b, L, hue, sat);
      if (!(w > 0.0)) { continue; }
      if (P(39u) > 0.5 && P(pb + 14u) > 0.5) { ov = u32(w * 255.0 + 0.5); }
      if (P(pb + 12u) < 0.5) { continue; }
      hit = true;
      for (var j: u32 = 0u; j < 15u; j = j + 1u) { acc[j] = acc[j] + P(pb + 40u + j) * w; }
    }
    if (hit) {
      let lev: f32 = acc[0]; let lt: f32 = acc[1]; let lti: f32 = acc[2];
      if (lev != 0.0 || lt != 0.0 || lti != 0.0) {
        let t: f32 = lt * P(90u); let uu: f32 = lti * P(91u);
        RR = RR * exp2(lev + t + uu * 0.5); GG = GG * exp2(lev - uu); BB = BB * exp2(lev + uu * 0.5 - t);
      }
      if (P(38u) > 0.0) { mp = q8(acc[7]) | (q8(acc[8]) << 8u) | (q8(acc[9]) << 16u) | (q8(acc[10]) << 24u); }
    }
  }
  let lo3: f32 = min(r, min(g, b));
  if (lo3 > 0.75) { let t: f32 = smoothf(0.75, 1.0, lo3); let m: f32 = max(RR, max(GG, BB)); RR = RR + (m - RR) * t; GG = GG + (m - GG) * t; BB = BB + (m - BB) * t; }
  let sh: f32 = P(30u);
  if (sh != 0.0) { let Yl: f32 = 0.2126 * RR + 0.7152 * GG + 0.0722 * BB; let k: f32 = exp2(sh * 1.3 * (1.0 - smoothf(0.0, 0.25, Yl))); RR = RR * k; GG = GG * k; BB = BB * k; }
  let lhi: f32 = acc[4]; let lsh: f32 = acc[5]; let lwh: f32 = acc[11]; let lbk: f32 = acc[12]; let ldh: f32 = acc[13]; let lhue: f32 = acc[14];
  if (ldh != 0.0) {
    let dc: f32 = min(RR, min(GG, BB)); let a: f32 = ldh / 100.0;
    if (a > 0.0) { let t: f32 = a * @DEHAZE_K@ * clamp(dc, 0.0, 1.0); let q: f32 = 1.0 / (1.0 - t); RR = (RR - t) * q; GG = (GG - t) * q; BB = (BB - t) * q; }
    else { let t: f32 = -a * @HAZE_ADD@; RR = RR + (@HAZE_AIR@ - RR) * t; GG = GG + (@HAZE_AIR@ - GG) * t; BB = BB + (@HAZE_AIR@ - BB) * t; }
  }
  if (lsh != 0.0 || lhi != 0.0 || lwh != 0.0 || lbk != 0.0) {
    let Yl: f32 = 0.2126 * RR + 0.7152 * GG + 0.0722 * BB;
    if (lsh != 0.0 || lhi != 0.0 || lwh != 0.0) { let k: f32 = exp2((lsh / 100.0) * 1.3 * (1.0 - smoothf(0.0, 0.25, Yl)) + (lhi / 100.0) * 1.2 * smoothf(0.12, 0.8, Yl) + (lwh / 100.0) * @WHITES_EV@ * smoothf(0.3, 1.0, Yl)); RR = RR * k; GG = GG * k; BB = BB * k; }
    if (lbk != 0.0) { let q: f32 = (lbk / 100.0) * @BLACKS_OFF@ * (1.0 - smoothf(0.0, 0.1, Yl)); RR = max(0.0, RR + q); GG = max(0.0, GG + q); BB = max(0.0, BB + q); }
  }
  let m: f32 = max(RR, max(GG, BB)); let knee: f32 = P(27u);
  if (m > knee) { let e: f32 = m - knee; var f: f32 = 0.0; if (P(29u) > 0.5) { f = min(1.0, m) / m; } else { f = (knee + e / (1.0 + e / P(28u))) / m; } RR = RR * f; GG = GG * f; BB = BB * f; }
  let lsat: f32 = acc[6];
  if (P(33u) > 0.5 || lsat != 0.0) {
    let mx: f32 = max(RR, max(GG, BB)); let mn: f32 = min(RR, min(GG, BB)); var cs: f32 = 0.0; if (mx > 1e-6) { cs = (mx - mn) / mx; }
    let Yl: f32 = 0.2126 * RR + 0.7152 * GG + 0.0722 * BB; let vib: f32 = P(31u);
    let k: f32 = P(32u) * (1.0 + vib * select(cs, 1.0 - cs, vib > 0.0)) * max(0.0, 1.0 + lsat / 100.0);
    RR = Yl + (RR - Yl) * k; GG = Yl + (GG - Yl) * k; BB = Yl + (BB - Yl) * k;
  }
  if (lhue != 0.0) {
    let t: f32 = lhue * 0.017453292519943295; let co: f32 = cosA(t); let si: f32 = sinA(t); let r2: f32 = RR; let g2: f32 = GG; let b2: f32 = BB;
    RR = (0.2126 + co * 0.7874 - si * 0.2126) * r2 + (0.7152 - co * 0.7152 - si * 0.7152) * g2 + (0.0722 - co * 0.0722 + si * 0.9278) * b2;
    GG = (0.2126 - co * 0.2126 + si * 0.143) * r2 + (0.7152 + co * 0.2848 + si * 0.14) * g2 + (0.0722 - co * 0.0722 - si * 0.283) * b2;
    BB = (0.2126 - co * 0.2126 - si * 0.7874) * r2 + (0.7152 - co * 0.7152 + si * 0.7152) * g2 + (0.0722 + co * 0.9278 + si * 0.0722) * b2;
  }
  var vr: f32 = lutv(0u, RR); var vg: f32 = lutv(1u, GG); var vb: f32 = lutv(2u, BB);
  let lcon: f32 = acc[3];
  if (lcon != 0.0) { let k: f32 = 1.0 + lcon / 100.0; vr = conC(vr, k); vg = conC(vg, k); vb = conC(vb, k); }
  var A: u32 = u32(P(92u)); if (P(39u) > 0.5) { A = ov; }
  return vec4u(outv(vr) | (outv(vg) << 16u), outv(vb) | (A << 16u), mp, 0u);
}
`.replace(/@LS@/g, String(LS)).replace(/@LS1@/g, String(LS + 1)).replace(/@HDR@/g, String(HDR)).replace(/@PLAN@/g, String(PLAN_SIZE))
  .replace(/@DEHAZE_K@/g, fl(R.DEHAZE_K)).replace(/@HAZE_ADD@/g, fl(R.HAZE_ADD)).replace(/@HAZE_AIR@/g, fl(R.HAZE_AIR)).replace(/@WHITES_EV@/g, fl(R.WHITES_EV)).replace(/@BLACKS_OFF@/g, fl(R.BLACKS_OFF));
function fl(x) { const s = String(x); return /[.e]/.test(s) ? s : `${s}.0`; }

// ---- WebGPU -----------------------------------------------------------------------------------------------------
const WGSL_DEV = `
@group(0) @binding(0) var<storage, read> SRC_: array<u32>;
@group(0) @binding(1) var<storage, read> P_: array<f32>;
@group(0) @binding(2) var<storage, read> LUT_: array<f32>;
@group(0) @binding(3) var<storage, read> GR_: array<f32>;
@group(0) @binding(4) var<storage, read_write> OUT: array<u32>;
@group(0) @binding(5) var<storage, read_write> MAPS: array<u32>;
fn P(i: u32) -> f32 { return P_[i]; }
fn LUT(i: u32) -> f32 { return LUT_[i]; }
fn GR(i: u32) -> f32 { return GR_[i]; }
fn roundEven_(x: f32) -> f32 { return round(x); }
fn halfAt(i: u32) -> f32 { let w: u32 = SRC_[i >> 1u]; return halfv((w >> ((i & 1u) * 16u)) & 0xffffu); }
fn srcpx(x: i32, y: i32, c: u32) -> f32 {
  let i: u32 = (u32(y) * u32(P(0u)) + u32(x)) * 3u + c;
  if (P(10u) > 0.5) { return halfAt(i); }
  return bitcast<f32>(SRC_[i]);
}
${DEV_BODY.replace('@ACC@', 'var acc: array<f32, 15>;')}
@compute @workgroup_size(16, 16)
fn dev(@builtin(global_invocation_id) gid: vec3u) {
  let OW = u32(P(6u)); if (gid.x >= OW || gid.y >= u32(P(9u))) { return; }
  let o = developPx(gid.x, u32(P(8u)) + gid.y); let i = gid.y * OW + gid.x;
  OUT[2u * i] = o.x; OUT[2u * i + 1u] = o.y;
  if (P(38u) > 0.0) { MAPS[i] = o.z; }
}`;

// Post filters: one bind layout for all (px, maps, five f32 inputs, one f32 output, uniforms at a dynamic offset).
const WGSL_POST = `
struct U { a: vec4f, b: vec4f, c: vec4f, d: vec4f }
@group(0) @binding(0) var<storage, read_write> PX: array<u32>;
@group(0) @binding(1) var<storage, read> MP: array<u32>;
@group(0) @binding(2) var<storage, read> FA: array<f32>;
@group(0) @binding(3) var<storage, read> FB: array<f32>;
@group(0) @binding(4) var<storage, read> FC: array<f32>;
@group(0) @binding(5) var<storage, read> FD: array<f32>;
@group(0) @binding(6) var<storage, read> FE: array<f32>;
@group(0) @binding(7) var<storage, read_write> FO: array<f32>;
@group(0) @binding(8) var<uniform> u: U;
fn smoothf(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
fn rd(i: u32) -> vec3f { let a = PX[2u * i]; let b = PX[2u * i + 1u]; return vec3f(f32(a & 0xffffu), f32(a >> 16u), f32(b & 0xffffu)); }
fn wr(i: u32, r: u32, g: u32, b: u32) { PX[2u * i] = r | (g << 16u); PX[2u * i + 1u] = (PX[2u * i + 1u] & 0xffff0000u) | b; }
// 16-bit: r < 0 ? 0 : r > max ? max : r + 0.5 stored as Uint16 (truncates); 8-bit: r stored as Uint8Clamped (round half to even)
fn sto(v: f32) -> u32 { let mx = u.a.z; if (v < 0.0) { return 0u; } if (v > mx) { return u32(mx); } if (mx > 256.0) { return u32(floor(v + 0.5)); } return u32(round(min(v, 255.0))); }
// Math.round, then the store
fn mr(v: f32) -> u32 { return u32(clamp(floor(v + 0.5), 0.0, u.a.z)); }
fn luma(c: vec3f) -> f32 { return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z; }
@compute @workgroup_size(16, 16) fn k_luma(@builtin(global_invocation_id) g: vec3u) {
  let w = u32(u.a.x); if (g.x >= w || g.y >= u32(u.a.y)) { return; } let i = g.y * w + g.x;
  if (u.b.x > 0.0) { FO[i] = luma(rd(i)) * u.b.x; } else { FO[i] = luma(rd(i)); }
}
@compute @workgroup_size(16, 16) fn k_boxH(@builtin(global_invocation_id) g: vec3u) {
  let w = i32(u.a.x); if (g.x >= u32(w) || g.y >= u32(u.a.y)) { return; } let r = i32(u.a.w); let o = i32(g.y) * w; var s = 0.0;
  for (var k = -r; k <= r; k = k + 1) { s = s + FA[o + clamp(i32(g.x) + k, 0, w - 1)]; }
  FO[o + i32(g.x)] = s * (1.0 / f32(2 * r + 1));
}
@compute @workgroup_size(16, 16) fn k_boxV(@builtin(global_invocation_id) g: vec3u) {
  let w = i32(u.a.x); let h = i32(u.a.y); if (g.x >= u32(w) || g.y >= u32(h)) { return; } let r = i32(u.a.w); var s = 0.0;
  for (var k = -r; k <= r; k = k + 1) { s = s + FA[clamp(i32(g.y) + k, 0, h - 1) * w + i32(g.x)]; }
  FO[i32(g.y) * w + i32(g.x)] = s * (1.0 / f32(2 * r + 1));
}
@compute @workgroup_size(16, 16) fn k_b121H(@builtin(global_invocation_id) g: vec3u) {
  let w = i32(u.a.x); if (g.x >= u32(w) || g.y >= u32(u.a.y)) { return; } let o = i32(g.y) * w; let x = i32(g.x);
  FO[o + x] = (FA[o + max(0, x - 1)] + 2.0 * FA[o + x] + FA[o + min(w - 1, x + 1)]) * 0.25;
}
@compute @workgroup_size(16, 16) fn k_b121V(@builtin(global_invocation_id) g: vec3u) {
  let w = i32(u.a.x); let h = i32(u.a.y); if (g.x >= u32(w) || g.y >= u32(h)) { return; } let y = i32(g.y); let x = i32(g.x);
  FO[y * w + x] = (FA[max(0, y - 1) * w + x] + 2.0 * FA[y * w + x] + FA[min(h - 1, y + 1) * w + x]) * 0.25;
}
@compute @workgroup_size(16, 16) fn k_extH(@builtin(global_invocation_id) g: vec3u) {
  let w = i32(u.a.x); if (g.x >= u32(w) || g.y >= u32(u.a.y)) { return; } let r = i32(u.a.w); let o = i32(g.y) * w; let x = i32(g.x);
  var a = -1.0; var b = 2.0;
  for (var k = max(0, x - r); k <= min(w - 1, x + r); k = k + 1) { let v = FA[o + k]; a = max(a, v); b = min(b, v); }
  FO[o + x] = select(a, b, u.b.x > 0.5);
}
@compute @workgroup_size(16, 16) fn k_extV(@builtin(global_invocation_id) g: vec3u) {
  let w = i32(u.a.x); let h = i32(u.a.y); if (g.x >= u32(w) || g.y >= u32(h)) { return; } let r = i32(u.a.w); let y = i32(g.y); let x = i32(g.x);
  var a = -1.0; var b = 2.0;
  for (var k = max(0, y - r); k <= min(h - 1, y + r); k = k + 1) { let v = FA[k * w + x]; a = max(a, v); b = min(b, v); }
  FO[y * w + x] = select(a, b, u.b.x > 0.5);
}
fn hueWeight(h: f32, lo: f32, hi: f32) -> f32 { if (h >= lo && h <= hi) { return 1.0; } if (h < lo) { return max(0.0, 1.0 - (lo - h) / 15.0); } return max(0.0, 1.0 - (h - hi) / 15.0); }
@compute @workgroup_size(16, 16) fn k_defrW(@builtin(global_invocation_id) g: vec3u) {
  let w = u32(u.a.x); if (g.x >= w || g.y >= u32(u.a.y)) { return; } let i = g.y * w + g.x;
  FO[i] = 0.0;
  let edge = smoothf(0.08, 0.3, FA[i] - FB[i]); if (edge <= 0.0) { return; }
  let c3 = rd(i); let hi = max(c3.x, max(c3.y, c3.z)); let lo = min(c3.x, min(c3.y, c3.z)); let c = hi - lo;
  if (c <= u.a.z * 0.01) { return; }
  var hue = 0.0;
  if (hi == c3.x) { hue = ((c3.y - c3.z) / c) % 6.0; } else if (hi == c3.y) { hue = (c3.z - c3.x) / c + 2.0; } else { hue = (c3.x - c3.y) / c + 4.0; }
  hue = hue * 60.0; if (hue < 0.0) { hue = hue + 360.0; }
  FO[i] = min(1.0, u.b.x * hueWeight(hue, u.b.z, u.b.w) + u.b.y * hueWeight(hue, u.c.x, u.c.y)) * edge;
}
@compute @workgroup_size(16, 16) fn k_defrApply(@builtin(global_invocation_id) g: vec3u) {
  let w = u32(u.a.x); if (g.x >= w || g.y >= u32(u.a.y)) { return; } let i = g.y * w + g.x; let mx = u.a.z;
  if (u.c.z > 0.5) { // mask view
    var wt = 0.0; if (u.c.w > 0.5) { wt = FA[i]; }
    let v = mr(mx * (1.0 - wt * 0.9)); var gg = v; if (wt > 0.001953125) { gg = mr(f32(v) * 0.75); }
    wr(i, v, gg, v); return;
  }
  let k = 1.0 - FA[i]; if (k >= 1.0) { return; }
  let c = rd(i); let l = luma(c) * (1.0 / mx) * mx;
  wr(i, mr(l + (c.x - l) * k), mr(l + (c.y - l) * k), mr(l + (c.z - l) * k));
}
@compute @workgroup_size(16, 16) fn k_chroma(@builtin(global_invocation_id) g: vec3u) {
  let cw = u32(u.a.x); if (g.x >= cw || g.y >= u32(u.a.y)) { return; }
  let q = u32(u.a.w); let w = u32(u.b.y); let h = u32(u.b.z); var s = 0.0; var n = 0.0;
  for (var yy = g.y * q; yy < min(h, g.y * q + q); yy = yy + 1u) { for (var xx = g.x * q; xx < min(w, g.x * q + q); xx = xx + 1u) {
    let c = rd(yy * w + xx); let Y = luma(c); s = s + select(c.z - Y, c.x - Y, u.b.x > 0.5); n = n + 1.0;
  } }
  FO[g.y * cw + g.x] = s / n;
}
@compute @workgroup_size(16, 16) fn k_nr(@builtin(global_invocation_id) g: vec3u) {
  let w = u32(u.a.x); if (g.x >= w || g.y >= u32(u.a.y)) { return; } let i = g.y * w + g.x;
  let c = rd(i); let y0v = luma(c); var yv = y0v; var ca = c.z - y0v; var cb = c.x - y0v;
  if (u.b.x > 0.0) { let dd = FA[i] - FB[i]; let a = abs(dd); let T = u.b.w; yv = FB[i] + dd * (a * a / (a * a + T * T)); }
  if (u.b.y > 0.5) {
    let q = u.c.x; let cw = u.c.y; let chh = u.c.z;
    let fy = min(chh - 1.0, max(0.0, (f32(g.y) + 0.5) / q - 0.5)); let y0 = floor(fy); let y1 = min(chh - 1.0, y0 + 1.0); let ty = fy - y0;
    let fx = min(cw - 1.0, max(0.0, (f32(g.x) + 0.5) / q - 0.5)); let x0 = floor(fx); let x1 = min(cw - 1.0, x0 + 1.0); let tx = fx - x0;
    let k00 = u32(y0 * cw + x0); let k10 = u32(y0 * cw + x1); let k01 = u32(y1 * cw + x0); let k11 = u32(y1 * cw + x1);
    let sa = (FC[k00] * (1.0 - tx) + FC[k10] * tx) * (1.0 - ty) + (FC[k01] * (1.0 - tx) + FC[k11] * tx) * ty;
    let sb = (FD[k00] * (1.0 - tx) + FD[k10] * tx) * (1.0 - ty) + (FD[k01] * (1.0 - tx) + FD[k11] * tx) * ty;
    let keep = u.b.z; ca = sa + (ca - sa) * keep; cb = sb + (cb - sb) * keep;
  }
  let b = ca + yv; let r = cb + yv; let gg = (yv - 0.2126 * r - 0.0722 * b) / 0.7152;
  wr(i, sto(r), sto(gg), sto(b));
}
@compute @workgroup_size(16, 16) fn k_sharp(@builtin(global_invocation_id) g: vec3u) {
  let w = u32(u.a.x); let h = u32(u.a.y); if (g.x >= w || g.y >= h) { return; } let i = g.y * w + g.x;
  let L = u.b.y; let D = u.b.z; let T = u.b.w;
  var dd = FA[i] - FB[i]; dd = dd * L / (L + abs(dd)) * (1.0 + D);
  var k = u.b.x;
  if (T > 0.0) {
    let xl = select(i, i - 1u, g.x > 0u); let xr = select(i, i + 1u, g.x < w - 1u); let yu = select(i, i - w, g.y > 0u); let yd = select(i, i + w, g.y < h - 1u);
    let gx = FB[xr] - FB[xl]; let gy = FB[yd] - FB[yu]; k = k * smoothf(T * 0.5, T * 1.5, sqrt(gx * gx + gy * gy));
  }
  if (k == 0.0) { return; }
  let add = dd * k; let c = rd(i);
  wr(i, sto(c.x + add), sto(c.y + add), sto(c.z + add));
}
fn m8(v: u32, s: u32) -> f32 { return f32(i32(v << (24u - s)) >> 24u); }
@compute @workgroup_size(16, 16) fn k_local(@builtin(global_invocation_id) g: vec3u) {
  let w = u32(u.a.x); if (g.x >= w || g.y >= u32(u.a.y)) { return; } let i = g.y * w + g.x;
  let m = MP[i]; let bits = u32(u.b.x); let mx = u.a.z; let lim = 0.12 * mx; let T = 0.05 * mx; let inv = 1.0 / mx;
  let y0 = FA[i]; var d = 0.0;
  let mC = m8(m, 0u); let mT = m8(m, 8u); let mS = m8(m, 16u); let mN = m8(m, 24u);
  if ((bits & 1u) != 0u && mC != 0.0) { let a = mC / 100.0; let e = y0 - FD[i]; let t = y0 * inv; let mid = 1.0 - (2.0 * t - 1.0) * (2.0 * t - 1.0); d = d + a * 0.9 * (0.35 + 0.65 * mid) * (e * lim / (lim + abs(e))); }
  if ((bits & 2u) != 0u && mT != 0.0) { let a = mT / 100.0; d = d + a * select(0.9, 1.2, a > 0.0) * (FB[i] - FC[i]); }
  if ((bits & 4u) != 0u && mS != 0.0) { let a = mS / 100.0; d = d + select(a, a * 1.5, a > 0.0) * (y0 - FB[i]); }
  if ((bits & 8u) != 0u && mN != 0.0) { let a = mN / 100.0; let e = y0 - FE[i]; let ae = abs(e); let TT = T * a; let keep = ae * ae / (ae * ae + TT * TT + 1e-9); d = d + (FE[i] + e * keep - y0); }
  if (d == 0.0) { return; }
  let c = rd(i); wr(i, sto(c.x + d), sto(c.y + d), sto(c.z + d));
}
@compute @workgroup_size(16, 16) fn k_overlay(@builtin(global_invocation_id) g: vec3u) {
  let w = u32(u.a.x); if (g.x >= w || g.y >= u32(u.a.y)) { return; } let i = g.y * w + g.x; let mx = u.a.z;
  let ov = PX[2u * i + 1u] >> 16u; let a = (f32(ov) / 255.0) * 0.6;
  if (a != 0.0) { let c = rd(i); wr(i, mr(c.x + (mx - c.x) * a), mr(c.y * (1.0 - a) + mx * 0.12 * a), mr(c.z * (1.0 - a) + mx * 0.12 * a)); }
  PX[2u * i + 1u] = (PX[2u * i + 1u] & 0xffffu) | (u32(mx) << 16u);
}`;

const POST_KERNELS = ['k_luma', 'k_boxH', 'k_boxV', 'k_b121H', 'k_b121V', 'k_extH', 'k_extV', 'k_defrW', 'k_defrApply', 'k_chroma', 'k_nr', 'k_sharp', 'k_local', 'k_overlay'];
const UNI_SLOT = 256, UNI_SLOTS = 96;

/** Develop engine on WebGPU. Returns null when no adapter. */
export async function createWebGPUDevelop({ powerPreference = 'high-performance' } = {}) {
  if (!webgpuExposed()) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference }); if (!adapter) return null;
  const ai = adapter.info || {};
  const need = 2 ** 28, lim = adapter.limits;
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, 2 ** 30), maxBufferSize: Math.min(lim.maxBufferSize, 2 ** 30), maxStorageBuffersPerShaderStage: Math.min(lim.maxStorageBuffersPerShaderStage, 8) } });
  const maxBind = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize, need * 4);
  let lost = false; device.lost.then(() => { lost = true; });
  const errs = []; device.addEventListener?.('uncapturederror', (e) => errs.push(e.error?.message || String(e.error)));
    device.pushErrorScope('validation');
  const devMod = device.createShaderModule({ code: WGSL_DEV }), postMod = device.createShaderModule({ code: WGSL_POST });
  const ci = await devMod.getCompilationInfo?.(); const ci2 = await postMod.getCompilationInfo?.();
  const msgs = [...(ci?.messages || []), ...(ci2?.messages || [])].filter((m) => m.type === 'error');
  if (msgs.length) { device.destroy(); throw new Error(`GPU develop shader: ${msgs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`); }
  const S = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
  const devPipe = device.createComputePipeline({ layout: 'auto', compute: { module: devMod, entryPoint: 'dev' } });
  const ent = (b, type) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type, ...(type === 'uniform' ? { hasDynamicOffset: true } : {}) } });
  const postLayout = device.createBindGroupLayout({ entries: [ent(0, 'storage'), ent(1, 'read-only-storage'), ...[2, 3, 4, 5, 6].map((b) => ent(b, 'read-only-storage')), ent(7, 'storage'), ent(8, 'uniform')] });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [postLayout] });
  const post = Object.fromEntries(POST_KERNELS.map((k) => [k, device.createComputePipeline({ layout: pl, compute: { module: postMod, entryPoint: k } })]));
  const err = await device.popErrorScope();
  if (err) { device.destroy(); throw new Error(`GPU develop pipeline: ${err.message}`); }
  const mk = (size, usage) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
  const dummyR = mk(16, S), dummyO = mk(16, S), dummyM = mk(16, S);
  const uni = mk(UNI_SLOT * UNI_SLOTS, GPUBufferUsage.UNIFORM | CD);
  // buffers that grow: px, maps, 6 f32 scratch, staging; params / lut / grids
  const pool = {}; const grow = (name, size, usage) => { const b = pool[name]; if (b && b.size >= size) return b; b?.destroy(); return (pool[name] = mk(size * 1.1, usage)); };
  const srcCache = new WeakMap(); let lastGrid = null, lastLut = null, ownSrc = [];
  const uploadSrc = (src, keep) => {
    let e = keep ? srcCache.get(src) : null; if (e && e.data === src.data) return e.buf;
    const d = src.data, bytes = d.byteLength, buf = mk(bytes, S | CD);
    const whole = bytes & ~3; if (whole) device.queue.writeBuffer(buf, 0, d.buffer, d.byteOffset, whole);
    if (bytes > whole) { const t = new Uint8Array(4); t.set(new Uint8Array(d.buffer, d.byteOffset + whole, bytes - whole)); device.queue.writeBuffer(buf, whole, t); }
    if (keep) srcCache.set(src, { buf, data: d }); else ownSrc.push(buf);
    return buf;
  };
  const sameKey = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
  const dims = (w, h) => [Math.ceil(w / 16), Math.ceil(h / 16)];

  /** developRows(src, opts) on the GPU: same result object as raw.js developRows. */
  async function developRows(src, opts) {
    if (lost) throw new Error('GPU device lost');
    const tStart = performance.now();
    const FW = src.fullW || src.width, FH = src.fullH || src.height, [, OH] = R.orientedSize(FW, FH, opts.orientation || 1);
    const [a, b] = opts.rows || [0, OH], halo = opts.rows ? (opts.halo ?? R.BAND_HALO) : 0;
    const h0 = Math.max(0, a - halo), h1 = Math.min(OH, b + halo), bits = opts.bits || 16, set = opts.settings || R.DEFAULT_SETTINGS, scale = opts.scale ?? 1;
    const maxv = bits === 16 ? 65535 : 255;
    const K = packDevelop(src, opts, h0, h1, maxv), w = K.OW, hh = h1 - h0, n = w * hh;
    if (n * 8 > maxBind) throw new Error('band too large for the GPU');
    const srcBuf = uploadSrc(src, !!opts.cacheSource);
    const pbuf = grow('P', K.P.byteLength, S | CD); device.queue.writeBuffer(pbuf, 0, K.P);
    if (!lastLut || lastLut.lut !== opts.pipe) { const lb = grow('lut', K.lut.byteLength, S | CD); device.queue.writeBuffer(lb, 0, K.lut); lastLut = { lut: opts.pipe }; }
    if (!sameKey(lastGrid, K.gridKey)) { const gb = grow('grid', K.grids.byteLength, S | CD); device.queue.writeBuffer(gb, 0, K.grids); lastGrid = K.gridKey; }
    const px = grow('px', n * 8, S | CS), maps = K.mapBits ? grow('maps', n * 4, S) : dummyM;
    const enc = device.createCommandEncoder();
    let pass = enc.beginComputePass();
    pass.setPipeline(devPipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: devPipe.getBindGroupLayout(0), entries: [srcBuf, pbuf, pool.lut, pool.grid, px, maps].map((buffer, i) => ({ binding: i, resource: { buffer } })) }));
    pass.dispatchWorkgroups(...dims(w, hh)); pass.end();
    // post filters
    const F = []; const f = (i) => (F[i] ||= grow(`f${i}`, n * 4, S));
    const uni8 = new Float32Array(UNI_SLOT / 4 * UNI_SLOTS); let slot = 0; const calls = [];
    const run = (k, gw, gh, U, io = {}) => {
      if (slot >= UNI_SLOTS) throw new Error('too many GPU passes');
      uni8.set(U.slice(0, 16), slot * UNI_SLOT / 4);
      calls.push({ k, gw, gh, s: slot++, io });
    };
    const U = (w2, h2, r = 0, b0 = [0, 0, 0, 0], c0 = [0, 0, 0, 0]) => [w2, h2, maxv, r, ...b0, ...c0, 0, 0, 0, 0];
    const box = (inp, tmp, out, r, ww = w, hgt = hh) => { run('k_boxH', ww, hgt, U(ww, hgt, r), { a: inp, o: tmp }); run('k_boxV', ww, hgt, U(ww, hgt, r), { a: tmp, o: out }); };
    const b121 = (inp, tmp, out) => { run('k_b121H', w, hh, U(w, hh), { a: inp, o: tmp }); run('k_b121V', w, hh, U(w, hh), { a: tmp, o: out }); };
    // 1. noise reduction
    const luma = set.nrLuma, color = set.nrColor, nrScale = opts.nrScale ?? scale;
    if (luma > 0 || color > 0) {
      let T = 0;
      if (luma > 0) { run('k_luma', w, hh, U(w, hh), { o: f(0) }); box(f(0), f(2), f(1), Math.max(1, Math.round((1 + luma / 50) * Math.min(1, nrScale * 1.5)))); T = (luma / 100) * 0.05 * maxv; }
      let q = 1, cw = w, chh = hh, keep = 1;
      if (color > 0) {
        q = Math.max(1, Math.min(4, Math.round(2 * nrScale))); cw = Math.ceil(w / q); chh = Math.ceil(hh / q);
        const rad = Math.max(1, Math.round(((1 + (color / 100) * 6) * nrScale) / q)); keep = 1 - Math.min(1, color / 40);
        for (const [mode, dst] of [[0, 3], [1, 4]]) { run('k_chroma', cw, chh, U(cw, chh, q, [mode, w, hh, 0]), { o: f(dst) }); box(f(dst), f(5), f(dst), rad, cw, chh); box(f(dst), f(5), f(dst), rad, cw, chh); }
      }
      run('k_nr', w, hh, U(w, hh, 0, [luma > 0 ? 1 : 0, color > 0 ? 1 : 0, keep, T], [q, cw, chh, 0]), { a: luma > 0 ? f(0) : null, b: luma > 0 ? f(1) : null, c: color > 0 ? f(3) : null, d: color > 0 ? f(4) : null, px: 1 });
    }
    // 2. defringe (or its mask view)
    const ap = (set.fringePurple || 0) / 100, ag = (set.fringeGreen || 0) / 100, fmask = !!set.fringeMask;
    if ((ap > 0 || ag > 0 || fmask) && (fmask || (w >= 3 && hh >= 3))) {
      const hasW = (ap > 0 || ag > 0) && w >= 3 && hh >= 3;
      if (hasW) {
        const r = Math.max(1, Math.round(3 * scale));
        run('k_luma', w, hh, U(w, hh, 0, [1 / maxv, 0, 0, 0]), { o: f(0) });
        run('k_extH', w, hh, U(w, hh, r, [0, 0, 0, 0]), { a: f(0), o: f(1) }); run('k_extH', w, hh, U(w, hh, r, [1, 0, 0, 0]), { a: f(0), o: f(2) });
        run('k_extV', w, hh, U(w, hh, r, [0, 0, 0, 0]), { a: f(1), o: f(3) }); run('k_extV', w, hh, U(w, hh, r, [1, 0, 0, 0]), { a: f(2), o: f(4) });
        run('k_defrW', w, hh, U(w, hh, 0, [ap, ag, set.fringePurpleLo ?? 260, set.fringePurpleHi ?? 320], [set.fringeGreenLo ?? 80, set.fringeGreenHi ?? 150, 0, 0]), { a: f(3), b: f(4), o: f(1), px: 1 });
      }
      run('k_defrApply', w, hh, U(w, hh, 0, [0, 0, 0, 0], [0, 0, fmask ? 1 : 0, hasW ? 1 : 0]), { a: hasW ? f(1) : null, px: 1 });
    }
    // 3. sharpening
    const amount = (set.sharpen || 0) / 100;
    if (!fmask && amount > 0) {
      run('k_luma', w, hh, U(w, hh), { o: f(0) });
      const sigma = (set.sharpRadius || 1) * scale;
      if (sigma < 0.8) b121(f(0), f(2), f(1));
      else { const rb = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2)); box(f(0), f(2), f(1), rb); box(f(1), f(2), f(1), rb); box(f(1), f(2), f(1), rb); }
      const D = (set.sharpDetail ?? 25) / 100, L = maxv * (0.02 + 0.6 * D * D), M = (set.sharpMask || 0) / 100, T = M * M * 0.08 * maxv;
      run('k_sharp', w, hh, U(w, hh, 0, [amount, L, D, T]), { a: f(0), b: f(1), px: 1 });
    }
    // 4. local detail
    if (K.mapBits) {
      const mb = K.mapBits, mC = mb & 1, mT = mb & 2, mS = mb & 4, mN = mb & 8;
      run('k_luma', w, hh, U(w, hh), { o: f(0) });
      if (mT || mS) b121(f(0), f(5), f(1));
      const blurred = (r, passes, out) => { box(f(0), f(5), out, r); for (let k = 1; k < passes; k++) box(out, f(5), out, r); };
      if (mT) blurred(Math.max(1, Math.round(3 * scale)), 2, f(2));
      if (mC) blurred(Math.max(1, Math.round(R.CLARITY_RADIUS * scale)), 2, f(3));
      if (mN) blurred(Math.max(1, Math.round(2 * scale)), 1, f(4));
      run('k_local', w, hh, U(w, hh, 0, [mb, 0, 0, 0]), { a: f(0), b: mT || mS ? f(1) : null, c: mT ? f(2) : null, d: mC ? f(3) : null, e: mN ? f(4) : null, px: 1, maps: 1 });
    }
    if (K.ovl) run('k_overlay', w, hh, U(w, hh), { px: 1 });
    if (calls.length) {
      device.queue.writeBuffer(uni, 0, uni8, 0, slot * UNI_SLOT / 4);
      for (const c of calls) {
        const io = c.io, B = (x) => x || dummyR;
        const bg = device.createBindGroup({ layout: postLayout, entries: [
          { binding: 0, resource: { buffer: px } }, { binding: 1, resource: { buffer: io.maps ? maps : dummyM } },
          { binding: 2, resource: { buffer: B(io.a) } }, { binding: 3, resource: { buffer: B(io.b) } }, { binding: 4, resource: { buffer: B(io.c) } },
          { binding: 5, resource: { buffer: B(io.d) } }, { binding: 6, resource: { buffer: B(io.e) } },
          { binding: 7, resource: { buffer: io.o || dummyO } }, { binding: 8, resource: { buffer: uni, size: 64 } }] });
        pass = enc.beginComputePass(); pass.setPipeline(post[c.k]); pass.setBindGroup(0, bg, [c.s * UNI_SLOT]); pass.dispatchWorkgroups(...dims(c.gw, c.gh)); pass.end();
      }
    }
    // read back the band rows [a, b)
    const off = (a - h0) * w * 8, size = (b - a) * w * 8;
    const stage = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | CD });
    enc.copyBufferToBuffer(px, off, stage, 0, size);
    device.queue.submit([enc.finish()]);
    const tSub = performance.now();
    await stage.mapAsync(GPUMapMode.READ);
    const tDone = performance.now();
    const u16 = new Uint16Array(stage.getMappedRange().slice(0)); stage.unmap(); stage.destroy();
    for (const s of ownSrc) s.destroy(); ownSrc = [];
    if (errs.length) throw new Error(`GPU develop: ${errs.splice(0).join('; ')}`);
    let data = u16;
    if (bits === 8) { data = new Uint8ClampedArray(u16.length); data.set(u16); }
    const t = performance.now();
    return { width: w, height: b - a, rows: [a, b], fullHeight: OH, data, bits, ms: { gpu: tDone - tStart, encode: tSub - tStart, read: t - tDone, passes: calls.length + 1 } };
  }
  const info = { kind: 'webgpu', vendor: ai.vendor || '', architecture: ai.architecture || '', device: ai.device || '', description: ai.description || '', fallback: !!adapter.isFallbackAdapter };
  info.software = info.fallback || SOFT_RE.test(`${info.vendor} ${info.architecture} ${info.description}`);
  info.renderer = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU adapter';
  return {
    kind: 'webgpu', info, get lost() { return lost; }, developRows: serial(developRows), maxPixels: Math.floor(maxBind / 8),
    destroy() { for (const b of Object.values(pool)) b.destroy(); device.destroy(); },
  };
}

// ---- WebGL2 (per-pixel develop only) -------------------------------------------------------------------------------
/** The typed WGSL body → GLSL ES 3.00 (only the constructs DEV_BODY uses). */
function toGLSL(src) {
  let s = src.replace('@ACC@', 'float acc[15];');
  s = s.replace(/fn (\w+)\(([^)]*)\) -> (\w+) \{/g, (m, name, args, ret) => `${ret} ${name}(${args.split(',').map((a) => a.trim()).filter(Boolean).map((a) => { const [n, t] = a.split(':').map((x) => x.trim()); return `${t} ${n}`; }).join(', ')}) {`);
  s = s.replace(/\b(?:let|var) (\w+): (\w+) = /g, '$2 $1 = ');
  s = s.replace(/\bvec2f\b/g, 'vec2').replace(/\bvec3f\b/g, 'vec3').replace(/\bvec4u\b/g, 'uvec4').replace(/\bf32\b/g, 'float').replace(/\bu32\b/g, 'uint').replace(/\bi32\b/g, 'int');
  s = s.replace(/bitcast<float>/g, 'uintBitsToFloat').replace(/\bselect\(/g, 'sel(');
  if (/\b(let|var|fn)\b/.test(s)) throw new Error('GLSL translation left WGSL syntax');
  return s;
}

/** Develop engine on WebGL2: GPU per-pixel develop + CPU neighbourhood filters. Returns null when unavailable. */
export function createWebGL2Develop() {
  let canvas;
  try { canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas'); } catch { return null; }
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info'), renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE), TW = 4096;
  const vs = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
  const body = toGLSL(DEV_BODY);
  const fs = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D; precision highp sampler2D;
uniform sampler2D uP; uniform sampler2D uLUT; uniform sampler2D uGR; uniform highp usampler2D uSrcH; uniform sampler2D uSrcF;
out uvec4 outC;
float P(uint i) { return texelFetch(uP, ivec2(int(i & 1023u), int(i >> 10u)), 0).r; }
float LUT(uint i) { return texelFetch(uLUT, ivec2(int(i % ${TW}u), int(i / ${TW}u)), 0).r; }
float GR(uint i) { return texelFetch(uGR, ivec2(int(i % ${TW}u), int(i / ${TW}u)), 0).r; }
uniform bool uHalf;
float sel(float f, float t, bool c) { return c ? t : f; }
uint sel(uint f, uint t, bool c) { return c ? t : f; }
float roundEven_(float x) { return roundEven(x); }
float halfv(uint h);
float srcpx(int x, int y, uint c) {
  if (uHalf) { return halfv(texelFetch(uSrcH, ivec2(x, y), 0)[c]); }
  return texelFetch(uSrcF, ivec2(x, y), 0)[c];
}
${body}
void main() { uvec2 g = uvec2(gl_FragCoord.xy); outC = developPx(g.x, uint(P(8u)) + g.y); }`;
  const prog = gl.createProgram();
  const sh = (type, code) => { const s = gl.createShader(type); gl.shaderSource(s, code); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`WebGL2 develop shader: ${gl.getShaderInfoLog(s)}`); gl.attachShader(prog, s); return s; };
  sh(gl.VERTEX_SHADER, vs); sh(gl.FRAGMENT_SHADER, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`WebGL2 develop link: ${gl.getProgramInfoLog(prog)}`);
  gl.useProgram(prog);
  ['uP', 'uLUT', 'uGR', 'uSrcH', 'uSrcF'].forEach((n, i) => gl.uniform1i(gl.getUniformLocation(prog, n), i));
  const locHalf = gl.getUniformLocation(prog, 'uHalf');
  const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST); for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE); return t; };
  const T = { P: tex(), LUT: tex(), GR: tex(), H: tex(), F: tex(), out: tex() };
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const flat = (unit, t, data, width) => { // a Float32Array as an R32F texture `width` wide
    const h = Math.max(1, Math.ceil(data.length / width)); if (h > maxTex) throw new Error('data too large for a WebGL2 texture');
    let d = data; if (d.length !== width * h) { d = new Float32Array(width * h); d.set(data); }
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, h, 0, gl.RED, gl.FLOAT, d);
  };
  const fb = gl.createFramebuffer(); let srcOf = null, lastLut = null, lastGrid = null, outW = 0, outH = 0;
  const sameKey = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
  async function developRows(src, opts) {
    if (gl.isContextLost()) throw new Error('WebGL2 context lost');
    const t0 = performance.now();
    const FW = src.fullW || src.width, FH = src.fullH || src.height, [, OH] = R.orientedSize(FW, FH, opts.orientation || 1);
    const [a, b] = opts.rows || [0, OH], halo = opts.rows ? (opts.halo ?? R.BAND_HALO) : 0;
    const h0 = Math.max(0, a - halo), h1 = Math.min(OH, b + halo), bits = opts.bits || 16, set = opts.settings || R.DEFAULT_SETTINGS, scale = opts.scale ?? 1, maxv = bits === 16 ? 65535 : 255;
    const K = packDevelop(src, opts, h0, h1, maxv), w = K.OW, hh = h1 - h0, n = w * hh;
    if (src.width > maxTex || src.height > maxTex || w > maxTex || hh > maxTex) throw new Error('image too large for WebGL2');
    flat(0, T.P, K.P, 1024);
    if (lastLut !== opts.pipe) { flat(1, T.LUT, K.lut, TW); lastLut = opts.pipe; }
    if (!sameKey(lastGrid, K.gridKey)) { flat(2, T.GR, K.grids, TW); lastGrid = K.gridKey; }
    if (srcOf?.src !== src || srcOf.data !== src.data) { // the source as an exact integer (half bits) or float texture
      if (src.half) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, T.H); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, src.width, src.height, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, src.data); }
      else { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, T.F); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, src.width, src.height, 0, gl.RGB, gl.FLOAT, src.data); }
      srcOf = { src, data: src.data }; gl.uniform1i(locHalf, src.half ? 1 : 0);
    }
    for (const [u, t] of [[0, T.P], [1, T.LUT], [2, T.GR], [3, T.H], [4, T.F]]) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, t); }
    if (outW !== w || outH !== hh) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, T.out); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, w, hh, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, null); outW = w; outH = hh; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.out, 0);
    gl.viewport(0, 0, w, hh); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const raw = new Uint32Array(n * 4); gl.readPixels(0, 0, w, hh, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw);
    const t1 = performance.now();
    const px = bits === 16 ? new Uint16Array(n * 4) : new Uint8ClampedArray(n * 4);
    const maps = K.mapBits ? {} : null; if (maps) MAPKEYS.forEach((k, i) => { if (K.mapBits & (1 << i)) maps[k] = new Int8Array(n); });
    const ov = K.ovl ? new Uint8Array(n) : null;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const p0 = raw[j], p1 = raw[j + 1]; px[j] = p0 & 0xffff; px[j + 1] = p0 >>> 16; px[j + 2] = p1 & 0xffff; px[j + 3] = maxv;
      if (ov) ov[i] = p1 >>> 16;
      if (maps) { const m = raw[j + 2]; if (maps.clarity) maps.clarity[i] = m << 24 >> 24; if (maps.texture) maps.texture[i] = m << 16 >> 24; if (maps.sharpness) maps.sharpness[i] = m << 8 >> 24; if (maps.noise) maps.noise[i] = m >> 24; }
    }
    const t2 = performance.now();
    R.denoise(px, w, hh, set.nrLuma, set.nrColor, opts.nrScale ?? scale);
    R.defringe(px, w, hh, set, scale);
    if (!set.fringeMask) R.sharpen(px, w, hh, set, scale);
    if (maps) R.localDetail(px, w, hh, maps, scale);
    if (ov) R.maskOverlay(px, ov);
    const cut = h0 === a && h1 === b ? px : px.slice((a - h0) * w * 4, (b - h0) * w * 4);
    const t3 = performance.now();
    return { width: w, height: b - a, rows: [a, b], fullHeight: OH, data: cut, bits, ms: { gpu: t1 - t0, unpack: t2 - t1, cpuFilters: t3 - t2 } };
  }
  const software = SOFT_RE.test(renderer || '');
  return { kind: 'webgl2', info: { kind: 'webgl2', renderer, software, maxTextureSize: maxTex }, get lost() { return gl.isContextLost(); }, developRows: serial(developRows), maxPixels: maxTex * maxTex,
    destroy() { gl.getExtension('WEBGL_lose_context')?.loseContext(); } };
}

/** One job at a time: the engines reuse their buffers between calls (a preview can arrive while a develop runs). */
function serial(fn) { let q = Promise.resolve(); return (...a) => { const r = q.then(() => fn(...a)); q = r.catch(() => {}); return r; }; }

/** Best develop engine here: { engine, why }. prefer: 'auto' | 'webgpu' | 'webgl2' | 'cpu'. Software adapters lose to the CPU in 'auto'. */
export async function openDevelopEngine(prefer = 'auto') {
  const tried = [];
  if (prefer === 'cpu') return { engine: null, why: 'CPU chosen' };
  if (prefer === 'auto' || prefer === 'webgpu') {
    try {
      const e = await createWebGPUDevelop();
      if (e && (prefer === 'webgpu' || !e.info.software)) return { engine: e, why: '' };
      if (e) { tried.push(`WebGPU is a software adapter (${e.info.renderer})`); e.destroy(); } else tried.push('no WebGPU adapter');
    } catch (err) { tried.push(`WebGPU failed: ${err.message}`); }
  }
  if (prefer === 'auto' || prefer === 'webgl2' || prefer === 'webgpu') {
    try {
      const e = createWebGL2Develop();
      if (e && (prefer !== 'auto' || !e.info.software)) return { engine: e, why: tried.join('; ') };
      if (e) { tried.push(`WebGL2 is a software renderer (${e.info.renderer})`); e.destroy(); } else tried.push('no WebGL2');
    } catch (err) { tried.push(`WebGL2 failed: ${err.message}`); }
  }
  return { engine: null, why: tried.join('; ') };
}
