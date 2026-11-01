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
function boxBlurPass(src, dst, w, h, r, horizontal) {
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

/** Gaussian blur approximated with three box blurs (standard technique). */
export function gaussianBlur(img, radius) {
  if (radius <= 0) return img;
  const { width: w, height: h, data } = img;
  const n = 3;
  const wIdeal = Math.sqrt((12 * radius * radius) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * radius * radius - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const sizes = []; for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
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
