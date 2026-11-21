// v1.34: Vibrance, Shadows / highlights and Color balance. Plain per-pixel arithmetic (Shadows / highlights also
// uses a blurred luminance map); no learned models. Each function works in place on straight-alpha RGBA data
// with channel maximum `max` (255 for Uint8ClampedArray, 65535 for Uint16Array), so the 8-bit and 16-bit
// paths share one definition and differ only in precision.

const Y = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b; // Rec. 709 luma weights (sRGB-encoded values)
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const put = (d, i, v, max, round) => { d[i] = v < 0 ? 0 : v > max ? max : round ? Math.round(v) : v; };

/** How much a colour looks like skin, 0..1: hue about 5–45° (orange-red), red > green > blue, moderate saturation.
 * A simple hue window, not a detector; it only scales down how hard Vibrance pushes those colours. */
function skinWeight(r, g, b) {
  if (!(r > g && g >= b)) return 0;
  const mx = r, mn = b, c = mx - mn; if (c <= 0) return 0;
  const hue = 60 * ((g - b) / c); // 0..60 for r ≥ g ≥ b
  const s = c / mx;
  const wh = 1 - Math.min(1, Math.abs(hue - 25) / 22); // peak at 25°
  const ws = s < 0.1 ? s / 0.1 : s > 0.75 ? Math.max(0, 1 - (s - 0.75) / 0.2) : 1;
  return wh * ws;
}
/**
 * Vibrance: raises (or lowers) saturation more for muted colours than for strong ones, holds back on skin tones,
 * and never pushes a colour out of gamut (its chroma is scaled about its own luma, limited so no channel clips,
 * which keeps the hue). Saturation: the same scaling applied evenly. Both −100..100.
 */
export function vibranceData(d, max, { vibrance = 0, saturation = 0 } = {}) {
  const v = vibrance / 100, sv = saturation / 100, round = max > 255;
  if (!v && !sv) return;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b, mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const s = mx > 0 ? (mx - mn) / mx : 0;
    let k = 1;
    if (v) {
      const protect = 1 - 0.75 * skinWeight(r, g, b);
      k = v > 0 ? 1 + v * (1 - s) * (1 - s) * protect * 1.6 : 1 + v * (1 - 0.5 * s) * protect;
    }
    k *= 1 + sv;
    if (k === 1) continue;
    const y = Y(r, g, b);
    if (k > 1) { // gamut limit: the largest k that keeps every channel in 0..max
      let lim = Infinity;
      const dmx = mx - y, dmn = mn - y; // the extreme channels set the limit
      if (dmx > 1e-9) lim = (max - y) / dmx;
      if (dmn < -1e-9) lim = Math.min(lim, -y / dmn);
      if (k > lim) k = Math.max(1, lim);
    }
    if (k < 0) k = 0;
    put(d, i, y + (r - y) * k, max, round); put(d, i + 1, y + (g - y) * k, max, round); put(d, i + 2, y + (b - y) * k, max, round);
  }
}

/** Separable box blur of one float channel (3 passes ≈ Gaussian of σ = radius). */
function blurPlane(src, w, h, radius) {
  if (radius < 0.5) return src;
  const wIdeal = Math.sqrt(12 * radius * radius / 3 + 1); let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * radius * radius - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let p = 0; p < 3; p++) {
    const r = ((p < m ? wl : wl + 2) - 1) / 2, inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) { // horizontal a -> b
      const o = y * w; let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[o + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) { b[o + x] = acc * inv; acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) { // vertical b -> a
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += b[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) { a[y * w + x] = acc * inv; acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]; }
    }
  }
  return a;
}
export const SH_DEFAULTS = { shAmount: 35, shTone: 50, shRadius: 30, hlAmount: 0, hlTone: 50, hlRadius: 30 };
/**
 * Shadows / highlights for ordinary layers. A blurred luminance map (radius = how far "local" reaches) decides
 * which areas count as shadow or highlight; tone range sets how far up (shadows) or down (highlights) that
 * reaches. Shadows are lifted and highlights pulled down with a gamma-style curve on the pixel's own luma, and
 * RGB is scaled by the luma ratio so hues stay put. `scale` shrinks the radii for reduced-size previews.
 */
export function shadowsHighlightsData(d, w, h, max, p = {}, scale = 1) {
  const q = { ...SH_DEFAULTS, ...p }, as = q.shAmount / 100, ah = q.hlAmount / 100, round = max > 255;
  if (as <= 0 && ah <= 0) return;
  const n = w * h, lum = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) lum[j] = Y(d[i], d[i + 1], d[i + 2]) / max;
  const rs = Math.max(0, q.shRadius * scale), rh = Math.max(0, q.hlRadius * scale);
  const bs = as > 0 ? blurPlane(lum, w, h, rs) : null;
  const bh = ah > 0 ? (bs && Math.abs(rs - rh) < 0.25 ? bs : blurPlane(lum, w, h, rh)) : null;
  const ts = 0.05 + 0.9 * (q.shTone / 100), th = 0.05 + 0.9 * (q.hlTone / 100);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    if (d[i + 3] === 0) continue;
    const L = lum[j]; let L2 = L;
    if (bs) { const wgt = 1 - smooth(bs[j] / ts); if (wgt > 0) L2 = Math.pow(L2, 1 / (1 + 2.2 * as * wgt)); }
    if (bh) { const wgt = 1 - smooth((1 - bh[j]) / th); if (wgt > 0) L2 = 1 - Math.pow(1 - L2, 1 / (1 + 2.2 * ah * wgt)); }
    if (L2 === L) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (L > 1e-4) {
      let k = L2 / L;
      if (k > 1) { const mx = Math.max(r, g, b); if (mx * k > max) { // keep hue: what does not fit as a ratio is added evenly
        const kk = max / mx, add = (L2 - L * kk) * max;
        put(d, i, r * kk + add, max, round); put(d, i + 1, g * kk + add, max, round); put(d, i + 2, b * kk + add, max, round); continue;
      } }
      put(d, i, r * k, max, round); put(d, i + 1, g * k, max, round); put(d, i + 2, b * k, max, round);
    } else { const add = (L2 - L) * max; put(d, i, r + add, max, round); put(d, i + 1, g + add, max, round); put(d, i + 2, b + add, max, round); }
  }
}

export const CB_KEYS = ['sCR', 'sMG', 'sYB', 'mCR', 'mMG', 'mYB', 'hCR', 'hMG', 'hYB'];
/**
 * Color balance: shifts the colour of the shadows, midtones and highlights separately along cyan–red,
 * magenta–green and yellow–blue (each −100..100). Each range is a smooth band of the pixel's luma; a shift moves
 * one channel up and the other two down by half as much. Preserve luminosity restores each pixel's original luma.
 */
export function colorBalanceData(d, max, p = {}) {
  const v = CB_KEYS.map((k) => (p[k] || 0) / 100), preserve = p.preserve !== false, round = max > 255;
  if (v.every((x) => !x)) return;
  const amt = 0.2 * max; // full slider at full band weight moves a channel by about 20 %
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2], y0 = Y(r, g, b), L = y0 / max;
    const ws = 1 - smooth(L / 0.55), wh = smooth((L - 0.45) / 0.55), wm = Math.max(0, 1 - ws - wh) * (1 - Math.abs(2 * L - 1) * 0.5);
    const cr = (v[0] * ws + v[3] * wm + v[6] * wh) * amt, mg = (v[1] * ws + v[4] * wm + v[7] * wh) * amt, yb = (v[2] * ws + v[5] * wm + v[8] * wh) * amt;
    let R = r + cr - 0.5 * mg - 0.5 * yb, G = g + mg - 0.5 * cr - 0.5 * yb, B = b + yb - 0.5 * cr - 0.5 * mg;
    R = R < 0 ? 0 : R > max ? max : R; G = G < 0 ? 0 : G > max ? max : G; B = B < 0 ? 0 : B > max ? max : B;
    if (preserve) { // put the luma back, without moving the hue: scale toward black or toward white
      const y1 = Y(R, G, B);
      if (y1 > y0 && y1 > 0) { const k = y0 / y1; R *= k; G *= k; B *= k; }
      else if (y1 < y0 && y1 < max) { const k = (max - y0) / (max - y1); R = max - (max - R) * k; G = max - (max - G) * k; B = max - (max - B) * k; }
    }
    put(d, i, R, max, round); put(d, i + 1, G, max, round); put(d, i + 2, B, max, round);
  }
}
