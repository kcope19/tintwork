// Automatic (non-AI) analysis: white balance, auto enhance, horizon / straighten detection and the
// largest crop after a rotation. Everything here is classic image statistics on a small copy of the
// picture (≤ 512 px), so it is fast, deterministic and explainable.
import { wbFromNeutral, pointFns } from './pixels.js';

const lin = new Float32Array(256); for (let i = 0; i < 256; i++) lin[i] = Math.pow(i / 255, 2.2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Gray-world estimate over trustworthy pixels (not clipped, not near-black, not strongly saturated). */
export function autoWhiteBalance(img) {
  const d = img.data; let r = 0, g = 0, b = 0, n = 0;
  for (let pass = 0; pass < 2 && n < 50; pass++) {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const R = d[i], G = d[i + 1], B = d[i + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      if (pass === 0 && (mx > 250 || mx < 20 || (mx - mn) / mx > 0.6)) continue;
      r += lin[R]; g += lin[G]; b += lin[B]; n++;
    }
  }
  if (!n) return { temperature: 0, tint: 0 };
  return wbFromNeutral(r / n, g / n, b / n);
}
/** Temperature / tint that make the average colour around (x, y) neutral grey. */
export function neutralAt(img, x, y, radius = 2) {
  const d = img.data, W = img.width, H = img.height; let r = 0, g = 0, b = 0, n = 0;
  for (let v = Math.max(0, y - radius); v <= Math.min(H - 1, y + radius); v++) for (let u = Math.max(0, x - radius); u <= Math.min(W - 1, x + radius); u++) {
    const i = (v * W + u) * 4; if (d[i + 3] < 8) continue; r += lin[d[i]]; g += lin[d[i + 1]]; b += lin[d[i + 2]]; n++;
  }
  return n ? wbFromNeutral(r / n, g / n, b / n) : null;
}
function applyFns(img, fns) {
  const t = fns.map((f) => { const a = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) a[v] = f(v); return a; });
  const d = new Uint8ClampedArray(img.data);
  for (let i = 0; i < d.length; i += 4) { d[i] = t[0][d[i]]; d[i + 1] = t[1][d[i + 1]]; d[i + 2] = t[2][d[i + 2]]; }
  return { width: img.width, height: img.height, data: d };
}
function lumaStats(img) {
  const d = img.data, h = new Uint32Array(256); let n = 0, sum = 0, sum2 = 0, chroma = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const y = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]); h[y]++; n++; sum += y; sum2 += y * y;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); chroma += (mx - mn) / 255;
  }
  const pct = (p) => { let c = 0; const k = n * p; for (let v = 0; v < 256; v++) { c += h[v]; if (c >= k) return v; } return 255; };
  const mean = n ? sum / n : 128;
  return { n, lo: pct(0.005), hi: pct(0.995), median: pct(0.5), mean, std: n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) / 255 : 0, chroma: n ? chroma / n : 0 };
}
/**
 * Auto enhance: white balance, then a levels stretch (0.5 % clip) with a midtone gamma, a gentle S-curve when
 * the picture is flat and a saturation lift when it is dull. Returns adjustment-layer specs (bottom → top);
 * steps that would change nothing are left out.
 */
/** Options (v0.9): { wb, tone, contrast, color } switch each step; strength (0–150 %) scales every correction. */
export function autoEnhance(img, o = {}) {
  const out = [], S = (o.strength ?? 100) / 100;
  const wb0 = autoWhiteBalance(img), wb = { temperature: Math.round(wb0.temperature * S), tint: Math.round(wb0.tint * S) };
  const wbOn = o.wb !== false && Math.abs(wb.temperature) + Math.abs(wb.tint) >= 4;
  if (wbOn) out.push({ type: 'whiteBalance', name: 'Auto white balance', params: wb });
  let cur = wbOn ? applyFns(img, pointFns('whiteBalance', wb)) : img;
  let s = lumaStats(cur); if (!s.n) return out;
  const inBlack = Math.round(clamp(s.lo, 0, 60) * S), inWhite = Math.round(255 - (255 - clamp(s.hi, 190, 255)) * S);
  const range = Math.max(1, inWhite - inBlack), m = clamp((s.median - inBlack) / range, 0.02, 0.98);
  const gamma = Math.round((1 + (clamp(Math.round((Math.log(m) / Math.log(0.46)) * 100) / 100, 0.7, 1.6) - 1) * S) * 100) / 100;
  if (o.tone !== false && inBlack > 2 || inWhite < 253 || Math.abs(gamma - 1) > 0.03) {
    const p = { inBlack, inWhite, gamma, outBlack: 0, outWhite: 255 };
    out.push({ type: 'levels', name: 'Auto tone', params: p });
    cur = applyFns(cur, pointFns('levels', p)); s = lumaStats(cur);
  }
  const k = Math.round(clamp((0.23 - s.std) * 110, 0, 16) * S);
  if (o.contrast !== false && k >= 2) { const pts = [[0, 0], [64, 64 - k], [192, 192 + k], [255, 255]], id = [[0, 0], [255, 255]]; out.push({ type: 'curves', name: 'Auto contrast', params: { rgb: pts, r: id, g: id, b: id } }); }
  const sat = Math.round(clamp((0.3 - s.chroma) * 90, 0, 22) * S);
  if (o.color !== false && sat >= 3) out.push({ type: 'hueSaturation', name: 'Auto color', params: { hue: 0, saturation: sat, lightness: 0 } });
  return out;
}

/**
 * Horizon / vertical detection with a Hough transform on Sobel edges. Lines within ±maxDeg of horizontal or
 * vertical vote; the angle whose accumulator is most concentrated wins. Returns { angle (degrees the picture is
 * rotated clockwise, so rotate by −angle to fix), confidence 0..1, kind: 'horizontal' | 'vertical' } or null.
 */
export function detectTilt(img, { maxDeg = 20, step = 0.1 } = {}) {
  const W = img.width, H = img.height, d = img.data, g = new Float32Array(W * H);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * (d[i + 3] / 255);
  const ex = [], ey = [], ea = [], mags = [];
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H), mg = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const sx = g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - 1] - g[i + W - 1];
    const sy = g[i + W - 1] + 2 * g[i + W] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - W] - g[i - W + 1];
    gx[i] = sx; gy[i] = sy; mg[i] = Math.hypot(sx, sy); mags.push(mg[i]);
  }
  if (!mags.length) return null;
  const sorted = Float32Array.from(mags).sort(), thr = Math.max(40, sorted[Math.floor(sorted.length * 0.9)]);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (mg[i] < thr) continue;
    // thin edges: keep local maxima along the gradient (simple non-maximum suppression)
    const ux = Math.round(gx[i] / mg[i]), uy = Math.round(gy[i] / mg[i]);
    if (mg[i + uy * W + ux] > mg[i] || mg[i - uy * W - ux] > mg[i]) continue;
    ex.push(x); ey.push(y); ea.push(Math.atan2(gy[i], gx[i]));
  }
  if (ex.length < 20) return null;
  const n = Math.round(maxDeg / step), R = Math.ceil(Math.hypot(W, H)), acc = new Float32Array(2 * R + 1);
  let best = null;
  for (const kind of ['horizontal', 'vertical']) {
    for (let k = -n; k <= n; k++) {
      const a = k * step, phi = ((kind === 'horizontal' ? 90 : 0) + a) * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi);
      acc.fill(0);
      for (let e = 0; e < ex.length; e++) {
        let dphi = Math.abs(ea[e] - phi) % Math.PI; if (dphi > Math.PI / 2) dphi = Math.PI - dphi; // gradient ∥ normal (either sign)
        if (dphi > 0.35) continue;
        acc[Math.round(ex[e] * c + ey[e] * s) + R] += 1;
      }
      let score = 0; for (let r = 0; r < acc.length; r++) { const v = acc[r]; if (v > 3) score += v * v; }
      if (kind === 'vertical') score *= 0.8; // prefer horizons when both exist
      if (!best || score > best.score) best = { score, angle: a, kind };
    }
  }
  if (!best || best.score <= 0) return null;
  const conf = clamp(Math.sqrt(best.score) / ex.length * 3, 0, 1);
  return { angle: Math.round(best.angle * 10) / 10, confidence: Math.round(conf * 100) / 100, kind: best.kind, edges: ex.length };
}
/** Largest centred rectangle with the canvas's aspect that fits inside the canvas rotated by `deg`. */
export function cropAfterRotate(W, H, deg) {
  const t = Math.abs(deg) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const k = Math.min(W / (W * c + H * s), H / (W * s + H * c));
  const w = Math.floor(W * k), h = Math.floor(H * k);
  return { x: Math.ceil((W - w) / 2), y: Math.ceil((H - h) / 2), w: w - ((W - w) % 2), h: h - ((H - h) % 2) };
}
