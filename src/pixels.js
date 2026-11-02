// Pixel operations used by adjustments and filters. All functions operate on
// ImageData in place (or return new ImageData) and are pure JS so they behave
// the same in every browser.

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

/** Apply a per-channel lookup table (Uint8 arrays of 256) */
function applyLUT(img, lr, lg = lr, lb = lr) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]];
  }
  return img;
}

function makeLUT(fn) {
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) t[i] = clamp(Math.round(fn(i)));
  return t;
}

/**
 * Per-channel float transfer functions (0..255 in, 0..255 out, already clamped) for the point operations,
 * or null for ops that are not per-channel curves. The 16-bit path builds 65536-entry tables from these and
 * the GPU path builds lookup textures, so all three engines share one definition.
 */
export function pointFns(name, p = {}) {
  const cl = (f) => (v) => clamp(f(v));
  switch (name) {
    case 'brightnessContrast': {
      const b = (p.brightness || 0) * 1.5, c = (p.contrast || 0) * 2.55, f = (259 * (c + 255)) / (255 * (259 - c));
      const fn = cl((v) => f * (v + b - 128) + 128); return [fn, fn, fn];
    }
    case 'exposure': {
      const m = Math.pow(2, p.exposure ?? 0), off = p.offset ?? 0, gm = p.gamma ?? 1;
      const fn = cl((v) => Math.pow(Math.max(0, (v / 255) * m + off), 1 / gm) * 255); return [fn, fn, fn];
    }
    case 'levels': {
      const inB = p.inBlack ?? 0, inW = p.inWhite ?? 255, gm = p.gamma ?? 1, oB = p.outBlack ?? 0, oW = p.outWhite ?? 255, range = Math.max(1, inW - inB);
      const fn = cl((v) => oB + Math.pow(Math.min(1, Math.max(0, (v - inB) / range)), 1 / gm) * (oW - oB)); return [fn, fn, fn];
    }
    case 'invert': { const fn = (v) => 255 - v; return [fn, fn, fn]; }
    case 'curves': {
      const all = cl(curveFn(p.rgb)), ch = [p.r, p.g, p.b].map((pts) => cl(curveFn(pts)));
      return ch.map((f) => (v) => all(f(v)));
    }
    default: return null;
  }
}

export const adjustments = {
  brightnessContrast(img, { brightness = 0, contrast = 0 }) {
    // brightness -100..100, contrast -100..100
    const b = brightness * 1.5;
    const c = (contrast * 2.55);
    const f = (259 * (c + 255)) / (255 * (259 - c));
    return applyLUT(img, makeLUT((v) => f * (v + b - 128) + 128));
  },
  exposure(img, { exposure = 0, offset = 0, gamma = 1 }) {
    // exposure in stops (-3..3), offset -0.5..0.5, gamma 0.1..3
    const m = Math.pow(2, exposure);
    return applyLUT(img, makeLUT((v) => {
      let x = (v / 255) * m + offset;
      x = Math.max(0, x);
      return Math.pow(x, 1 / gamma) * 255;
    }));
  },
  hueSaturation(img, { hue = 0, saturation = 0, lightness = 0 }) {
    const d = img.data;
    const hs = hue / 360, ss = saturation / 100, ls = lightness / 100;
    for (let i = 0; i < d.length; i += 4) {
      let [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      h = (h + hs + 1) % 1;
      s = ss > 0 ? s + (1 - s) * ss : s * (1 + ss);
      l = ls > 0 ? l + (1 - l) * ls : l * (1 + ls);
      const [r, g, b] = hslToRgb(h, s, l);
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    return img;
  },
  levels(img, { inBlack = 0, inWhite = 255, gamma = 1, outBlack = 0, outWhite = 255 }) {
    const range = Math.max(1, inWhite - inBlack);
    return applyLUT(img, makeLUT((v) => {
      let x = Math.min(1, Math.max(0, (v - inBlack) / range));
      x = Math.pow(x, 1 / gamma);
      return outBlack + x * (outWhite - outBlack);
    }));
  },
  invert(img) { return applyLUT(img, makeLUT((v) => 255 - v)); },
  grayscale(img) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    return img;
  },
  sepia(img, { amount = 100 } = {}) {
    const d = img.data, a = amount / 100;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      d[i] = r + (sr - r) * a; d[i + 1] = g + (sg - g) * a; d[i + 2] = b + (sb - b) * a;
    }
    return img;
  },
};

// ---- Filters ---------------------------------------------------------------

/** Single horizontal+vertical box blur pass with premultiplied alpha. */
export function boxBlurPass(src, dst, w, h, r, horizontal) {
  const iarr = 1 / (r + r + 1);
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const stride = horizontal ? 4 : w * 4;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w * 4 : line * 4;
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let k = -r; k <= r; k++) {
      const idx = base + Math.min(len - 1, Math.max(0, k)) * stride;
      sr += src[idx]; sg += src[idx + 1]; sb += src[idx + 2]; sa += src[idx + 3];
    }
    for (let x = 0; x < len; x++) {
      const o = base + x * stride;
      dst[o] = sr * iarr; dst[o + 1] = sg * iarr; dst[o + 2] = sb * iarr; dst[o + 3] = sa * iarr;
      const addI = base + Math.min(len - 1, x + r + 1) * stride;
      const remI = base + Math.max(0, x - r) * stride;
      sr += src[addI] - src[remI]; sg += src[addI + 1] - src[remI + 1];
      sb += src[addI + 2] - src[remI + 2]; sa += src[addI + 3] - src[remI + 3];
    }
  }
}

/** Box widths for three box passes approximating a Gaussian of standard deviation `radius`. */
export function boxSizes(radius, n = 3) {
  const wIdeal = Math.sqrt((12 * radius * radius) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * radius * radius - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const sizes = []; for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}
/** Gaussian blur approximated with three box blurs (standard technique). */
export function gaussianBlur(img, radius) {
  if (radius <= 0) return img;
  const { width: w, height: h, data } = img;
  const sizes = boxSizes(radius);
  // premultiply alpha to avoid dark fringes
  let a = new Float32Array(data.length), b = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const al = data[i + 3] / 255;
    a[i] = data[i] * al; a[i + 1] = data[i + 1] * al; a[i + 2] = data[i + 2] * al; a[i + 3] = data[i + 3];
  }
  for (const s of sizes) {
    const r = (s - 1) / 2;
    boxBlurPass(a, b, w, h, r, true);
    boxBlurPass(b, a, w, h, r, false);
  }
  for (let i = 0; i < data.length; i += 4) {
    const al = a[i + 3] / 255;
    data[i + 3] = a[i + 3];
    if (al > 0) { data[i] = a[i] / al; data[i + 1] = a[i + 1] / al; data[i + 2] = a[i + 2] / al; }
  }
  return img;
}

/** Unsharp mask: out = src + amount * (src - blurred), with threshold. */
export function sharpen(img, { amount = 80, radius = 1.5, threshold = 0 }) {
  const blurred = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  gaussianBlur(blurred, radius);
  const d = img.data, bd = blurred.data, k = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = d[i + c] - bd[i + c];
      if (Math.abs(diff) >= threshold) d[i + c] = clamp(d[i + c] + diff * k);
    }
  }
  return img;
}

export function noise(img, { amount = 20, monochrome = true, seed = 1 }) {
  // small deterministic PRNG so previews are stable while dragging sliders
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) - 0.5; };
  const d = img.data, k = amount * 2.55;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (monochrome) {
      const n = rnd() * k;
      d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n);
    } else {
      d[i] = clamp(d[i] + rnd() * k); d[i + 1] = clamp(d[i + 1] + rnd() * k); d[i + 2] = clamp(d[i + 2] + rnd() * k);
    }
  }
  return img;
}

export function vignette(img, { amount = 50, size = 60, feather = 50 }, fullW, fullH, offX = 0, offY = 0) {
  // amount: -100..100 (negative brightens edges), size: 0..100 radius of clear centre
  const { width: w, height: h, data } = img;
  const W = fullW || w, H = fullH || h;
  const cx = W / 2, cy = H / 2, maxR = Math.sqrt(cx * cx + cy * cy);
  const inner = (size / 100) * maxR;
  const outer = inner + Math.max(1, (feather / 100) * maxR);
  const k = amount / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + offX - cx, dy = y + offY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let t = (dist - inner) / (outer - inner);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = t * t * (3 - 2 * t); // smoothstep
      const i = (y * w + x) * 4;
      if (k >= 0) {
        const f = 1 - t * k;
        data[i] *= f; data[i + 1] *= f; data[i + 2] *= f;
      } else {
        const f = -t * k;
        data[i] += (255 - data[i]) * f; data[i + 1] += (255 - data[i + 1]) * f; data[i + 2] += (255 - data[i + 2]) * f;
      }
    }
  }
  return img;
}

/** Contiguous flood fill. Returns a Uint8Array mask (1 = fill). */
export function floodMask(img, sx, sy, tolerance, bounds) {
  const { width: w, height: h, data } = img;
  const mask = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const si = (sy * w + sx) * 4;
  const tr = data[si], tg = data[si + 1], tb = data[si + 2], ta = data[si + 3];
  const tol = tolerance * 4; // compare sum of abs diffs
  const bx0 = bounds ? bounds.x : 0, by0 = bounds ? bounds.y : 0;
  const bx1 = bounds ? bounds.x + bounds.w : w, by1 = bounds ? bounds.y + bounds.h : h;
  const match = (p) => {
    const i = p * 4;
    return Math.abs(data[i] - tr) + Math.abs(data[i + 1] - tg) + Math.abs(data[i + 2] - tb) + Math.abs(data[i + 3] - ta) <= tol;
  };
  const stack = [sy * w + sx];
  while (stack.length) {
    const p = stack.pop();
    if (mask[p]) continue;
    const x = p % w, y = (p / w) | 0;
    if (x < bx0 || x >= bx1 || y < by0 || y >= by1) continue;
    if (!match(p)) continue;
    mask[p] = 1;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  return mask;
}

export function histogram(img) {
  const hist = new Uint32Array(256), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    hist[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
  }
  return hist;
}

export function autoLevels(img) {
  const h = histogram(img); let total = 0; for (const v of h) total += v;
  const clip = total * 0.005; let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += h[lo]; if (acc > clip) break; }
  acc = 0; for (; hi > 0; hi--) { acc += h[hi]; if (acc > clip) break; }
  if (hi <= lo) return img;
  return adjustments.levels(img, { inBlack: lo, inWhite: hi });
}

/** Gaussian-blur a single-channel 0..255 mask (used for feathering selections). */
export function blurMask(mask, W, H, radius) {
  const img = new ImageData(W, H), d = img.data;
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = 255; d[j + 3] = mask[i]; }
  gaussianBlur(img, radius);
  const out = new Uint8Array(mask.length);
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

/** Blend a processed result back over the original using a 0..255 mask (soft selections). */
export function blendMasked(orig, res, mask) {
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    const m = mask[i];
    if (m === 255) continue;
    if (m === 0) { res[j] = orig[j]; res[j + 1] = orig[j + 1]; res[j + 2] = orig[j + 2]; res[j + 3] = orig[j + 3]; continue; }
    const k = m / 255;
    for (let c = 0; c < 4; c++) res[j + c] = orig[j + c] + (res[j + c] - orig[j + c]) * k;
  }
}

/** Single entry point for every pixel operation (used by the worker and the inline fallback). */
export function runOp(name, img, params = {}, info = {}) {
  switch (name) {
    case 'gaussianBlur': return gaussianBlur(img, params.radius);
    case 'sharpen': return sharpen(img, params);
    case 'noise': return noise(img, params);
    case 'vignette': return vignette(img, params, info.docW, info.docH, info.offX, info.offY);
    case 'autoLevels': return autoLevels(img);
    default:
      if (adjustments[name]) return adjustments[name](img, params);
      throw new Error(`Unknown operation ${name}`);
  }
}

/** Non-contiguous version of floodMask: every pixel within tolerance of the seed pixel. */
export function similarMask(img, sx, sy, tolerance, bounds) {
  const { width: W, height: H, data: d } = img;
  const b = bounds || { x: 0, y: 0, w: W, h: H };
  const mask = new Uint8Array(W * H), si = (sy * W + sx) * 4, t = tolerance * 4;
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
    const i = (y * W + x) * 4;
    if (Math.abs(d[i] - d[si]) + Math.abs(d[i + 1] - d[si + 1]) + Math.abs(d[i + 2] - d[si + 2]) + Math.abs(d[i + 3] - d[si + 3]) <= t) mask[y * W + x] = 1;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Curves: monotone cubic interpolation through control points (no overshoot).
// ---------------------------------------------------------------------------
/** Float version of a curve: x 0..255 -> y (0..255), shared by the 8-bit LUT and the 16-bit / GPU paths. */
export function curveFn(points) {
  const pts = [...(points || [[0, 0], [255, 255]])].map(([x, y]) => [Math.max(0, Math.min(255, x)), Math.max(0, Math.min(255, y))])
    .sort((a, b) => a[0] - b[0]).filter((p, i, arr) => i === 0 || p[0] > arr[i - 1][0]);
  if (pts.length === 1) { const c = pts[0][1]; return () => c; }
  const n = pts.length, d = [], m = new Array(n);
  for (let k = 0; k < n - 1; k++) d.push((pts[k + 1][1] - pts[k][1]) / (pts[k + 1][0] - pts[k][0]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
    const a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[k] = t * a * d[k]; m[k + 1] = t * b * d[k]; }
  }
  return (x) => {
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    let k = 0; while (x > pts[k + 1][0]) k++;
    const h = pts[k + 1][0] - pts[k][0], t = (x - pts[k][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * pts[k][1] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * pts[k + 1][1] + (t3 - t2) * h * m[k + 1];
  };
}
export function curveLUT(points) {
  const lut = new Uint8Array(256), f = curveFn(points);
  for (let x = 0; x < 256; x++) lut[x] = Math.max(0, Math.min(255, Math.round(f(x))));
  return lut;
}
adjustments.curves = (img, p = {}) => {
  const all = curveLUT(p.rgb), r = curveLUT(p.r), g = curveLUT(p.g), b = curveLUT(p.b), d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = all[r[d[i]]]; d[i + 1] = all[g[d[i + 1]]]; d[i + 2] = all[b[d[i + 2]]]; }
  return img;
};

// ---------------------------------------------------------------------------
// Healing: copy texture from `src`, then correct its color/brightness with a
// smooth "membrane" that matches `dst` along the edge of the brushed area.
// The membrane is filled with a pull-push pyramid and relaxed with Jacobi
// iterations (a cheap approximation of solving Laplace's equation).
// ---------------------------------------------------------------------------
function membrane(known, wt, w, h, interior, iterations) {
  // known: Float32Array(3*w*h) values; wt: Float32Array(w*h) 1 where known.
  const levels = [{ v: known, wt, w, h }];
  while (levels.at(-1).w > 1 || levels.at(-1).h > 1) {
    const L = levels.at(-1), w2 = Math.ceil(L.w / 2), h2 = Math.ceil(L.h / 2);
    const v2 = new Float32Array(w2 * h2 * 3), wt2 = new Float32Array(w2 * h2);
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x, a = L.wt[i]; if (!a) continue;
      const j = (y >> 1) * w2 + (x >> 1);
      wt2[j] += a; v2[j * 3] += L.v[i * 3] * a; v2[j * 3 + 1] += L.v[i * 3 + 1] * a; v2[j * 3 + 2] += L.v[i * 3 + 2] * a;
    }
    for (let j = 0; j < w2 * h2; j++) if (wt2[j]) { v2[j * 3] /= wt2[j]; v2[j * 3 + 1] /= wt2[j]; v2[j * 3 + 2] /= wt2[j]; wt2[j] = Math.min(1, wt2[j]); }
    levels.push({ v: v2, wt: wt2, w: w2, h: h2 });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const F = levels[l], C = levels[l + 1];
    for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) {
      const i = y * F.w + x, a = F.wt[i]; if (a >= 1) continue;
      // bilinear sample of the coarse level
      const cx = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), cy = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(C.w - 1, x0 + 1), y1 = Math.min(C.h - 1, y0 + 1), fx = cx - x0, fy = cy - y0;
      for (let c = 0; c < 3; c++) {
        const top = C.v[(y0 * C.w + x0) * 3 + c] * (1 - fx) + C.v[(y0 * C.w + x1) * 3 + c] * fx;
        const bot = C.v[(y1 * C.w + x0) * 3 + c] * (1 - fx) + C.v[(y1 * C.w + x1) * 3 + c] * fx;
        F.v[i * 3 + c] = a * F.v[i * 3 + c] + (1 - a) * (top * (1 - fy) + bot * fy);
      }
      F.wt[i] = 1;
    }
  }
  const v = levels[0].v;
  for (let it = 0; it < iterations; it++) {
    for (const i of interior) {
      const x = i % w, y = (i / w) | 0;
      const l = x > 0 ? i - 1 : i, r = x < w - 1 ? i + 1 : i, u = y > 0 ? i - w : i, dn = y < h - 1 ? i + w : i;
      for (let c = 0; c < 3; c++) v[i * 3 + c] = (v[l * 3 + c] + v[r * 3 + c] + v[u * 3 + c] + v[dn * 3 + c]) / 4;
    }
  }
  return v;
}
function ringOf(cover, w, h) {
  const ring = [], interior = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (cover[i]) { interior.push(i); continue; }
    if ((x > 0 && cover[i - 1]) || (x < w - 1 && cover[i + 1]) || (y > 0 && cover[i - w]) || (y < h - 1 && cover[i + w])) ring.push(i);
  }
  return { ring, interior };
}
/** Heal: returns a new RGBA array (dst with the brushed area replaced by color-matched src texture). */
export function healRegion(dst, src, cover, w, h, iterations = 60) {
  const { ring, interior } = ringOf(cover, w, h);
  const out = new Uint8ClampedArray(dst);
  if (!interior.length) return out;
  const known = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
  for (const i of ring) { wt[i] = 1; for (let c = 0; c < 3; c++) known[i * 3 + c] = dst[i * 4 + c] - src[i * 4 + c]; }
  if (!ring.length) return out;
  const diff = membrane(known, wt, w, h, interior, iterations);
  for (const i of interior) {
    const k = cover[i] / 255;
    for (let c = 0; c < 3; c++) {
      const healed = src[i * 4 + c] + diff[i * 3 + c];
      out[i * 4 + c] = dst[i * 4 + c] + (healed - dst[i * 4 + c]) * k;
    }
  }
  return out;
}
/**
 * Spot heal: pick a nearby source patch automatically (the candidate whose edge
 * best matches after a smooth color correction), then heal from it.
 */
export function spotHeal(img, cover, w, h) {
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (cover[y * w + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  if (bx1 < 0) return { data: new Uint8ClampedArray(img), offset: null };
  const { ring } = ringOf(cover, w, h);
  const size = Math.max(bx1 - bx0, by1 - by0) + 4;
  let best = null;
  for (const f of [1.05, 1.4, 1.9, 2.5]) for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2, dx = Math.round(Math.cos(ang) * size * f), dy = Math.round(Math.sin(ang) * size * f);
    if (bx0 - 1 + dx < 0 || by0 - 1 + dy < 0 || bx1 + 1 + dx >= w || by1 + 1 + dy >= h) continue;
    // variance of (dst - src) along the edge: a smooth correction can remove the mean, not the variance
    let s = [0, 0, 0], s2 = 0;
    for (const i of ring) {
      const j = i + dy * w + dx;
      for (let c = 0; c < 3; c++) { const dd = img[i * 4 + c] - img[j * 4 + c]; s[c] += dd; s2 += dd * dd; }
    }
    const n = ring.length || 1;
    const score = s2 / n - (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]) / (n * n) + 0.02 * Math.hypot(dx, dy);
    if (!best || score < best.score) best = { score, dx, dy };
  }
  const src = new Uint8ClampedArray(img.length);
  if (best) {
    const off = (best.dy * w + best.dx) * 4;
    for (let i = 0; i < img.length; i++) { const j = i + off; src[i] = j >= 0 && j < img.length ? img[j] : img[i]; }
  } // otherwise src stays black and the result is a pure smooth fill
  return { data: healRegion(img, src, cover, w, h), offset: best && { dx: best.dx, dy: best.dy } };
}

/** Per-channel histograms (luminance + R, G, B) for the curves editor. */
export function channelHistograms(img) {
  const l = new Uint32Array(256), r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
    l[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
  }
  return { l, r, g, b };
}

// --- Color range & refine edge (v0.4) -------------------------------------------------

/** Hue centres (degrees) of the colour-family presets of the Color Range dialog. */
export const HUE_PRESETS = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };
const smooth01 = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/**
 * Build a 0..255 selection mask from the colours of an image.
 * mode: 'sampled' (distance to `color`, softened by `fuzziness`), a hue family from HUE_PRESETS,
 * or a tonal band: 'highlights' | 'midtones' | 'shadows'. Transparent pixels are never selected.
 */
export function colorRangeMask(img, { mode = 'sampled', color = [255, 255, 255], fuzziness = 40 } = {}) {
  const d = img.data, n = img.width * img.height, m = new Uint8Array(n);
  const f = Math.max(1, +fuzziness || 0), hueC = HUE_PRESETS[mode];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2], a = d[j + 3];
    if (!a) continue;
    let w;
    if (mode === 'sampled') {
      const dr = r - color[0], dg = g - color[1], db = b - color[2];
      const dist = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
      w = dist <= f * 0.5 ? 1 : dist >= f ? 0 : (f - dist) / (f * 0.5);
    } else if (hueC !== undefined) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
      if (c === 0) continue;
      let h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
      h *= 60; if (h < 0) h += 360;
      let dh = Math.abs(h - hueC); if (dh > 180) dh = 360 - dh;
      w = (1 - smooth01(15, 45, dh)) * Math.min(1, (c / 255) * 4);
    } else {
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      if (mode === 'highlights') w = smooth01(150, 200, L);
      else if (mode === 'shadows') w = 1 - smooth01(55, 105, L);
      else w = Math.max(0, Math.min(1, 1 - (Math.abs(L - 128) - 40) / 40));
    }
    m[i] = Math.round(w * a);
  }
  return m;
}

// Felzenszwalb & Huttenlocher 1-D squared distance transform (lower envelope of parabolas).
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let p = v[k], s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
    while (s <= z[k]) { k--; p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
}

/** Exact Euclidean distance (in pixels) from every pixel to the nearest pixel where `inside` is true. */
export function distanceTo(inside, W, H) {
  const INF = 1e12, g = new Float64Array(W * H), n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < g.length; i++) g[i] = inside[i] ? 0 : INF;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) f[x] = g[o + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[o + x] = Math.sqrt(d[x]);
  }
  return g;
}

/** Move a mask edge outwards (shift > 0) or inwards (shift < 0) by `shift` pixels, with a 1px soft edge. */
export function shiftMaskEdge(mask, W, H, shift) {
  const n = W * H, out = new Uint8Array(n);
  if (!shift) { out.set(mask); return out; }
  if (shift > 0) {
    const on = new Uint8Array(n); for (let i = 0; i < n; i++) on[i] = mask[i] >= 128;
    const dist = distanceTo(on, W, H);
    for (let i = 0; i < n; i++) out[i] = on[i] ? Math.max(mask[i], 255) : Math.round(Math.min(1, Math.max(0, shift + 1 - dist[i])) * 255);
  } else {
    const R = -shift, off = new Uint8Array(n); for (let i = 0; i < n; i++) off[i] = mask[i] < 128;
    const dist = distanceTo(off, W, H);
    for (let i = 0; i < n; i++) out[i] = off[i] ? 0 : Math.round(Math.min(1, Math.max(0, dist[i] - R)) * 255);
  }
  return out;
}

/** Refine-edge pipeline: smooth (blur + re-threshold), then shift edge (expand/contract), then feather. */
export function refineMask(mask, W, H, { smooth = 0, shift = 0, feather = 0 } = {}) {
  let m = mask;
  if (smooth > 0) {
    m = blurMask(m, W, H, smooth);
    for (let i = 0; i < m.length; i++) m[i] = Math.max(0, Math.min(255, Math.round((m[i] - 128) * 4 + 128)));
  }
  if (shift) m = shiftMaskEdge(m, W, H, Math.round(shift));
  if (feather > 0) m = blurMask(m, W, H, feather);
  if (m === mask) m = new Uint8Array(mask);
  return m;
}
