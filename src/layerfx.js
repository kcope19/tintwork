// Layer styles (non-destructive effects drawn around / on top of a layer's pixels).
// Each effect is a plain object { type, enabled, ...params }; a layer keeps an array of them in l.styles.
// Rendering works on Canvas 2D: blurs use the shadow-offset trick (fast and available everywhere, incl.
// Safari), strokes and glow spread use an exact Euclidean distance transform for clean anti-aliased edges.

export const FX_TYPES = {
  dropShadow: { title: 'Drop shadow', params: [
    { key: 'color', type: 'color', label: 'Color', value: '#000000' },
    { key: 'opacity', label: 'Opacity %', min: 0, max: 100, value: 75 },
    { key: 'angle', label: 'Angle °', min: -180, max: 180, value: 120 },
    { key: 'distance', label: 'Distance', min: 0, max: 200, value: 8 },
    { key: 'size', label: 'Size', min: 0, max: 150, value: 10 },
    { key: 'blend', type: 'blend', label: 'Blend', value: 'multiply' }] },
  innerShadow: { title: 'Inner shadow', params: [
    { key: 'color', type: 'color', label: 'Color', value: '#000000' },
    { key: 'opacity', label: 'Opacity %', min: 0, max: 100, value: 75 },
    { key: 'angle', label: 'Angle °', min: -180, max: 180, value: 120 },
    { key: 'distance', label: 'Distance', min: 0, max: 200, value: 5 },
    { key: 'size', label: 'Size', min: 0, max: 150, value: 6 },
    { key: 'blend', type: 'blend', label: 'Blend', value: 'multiply' }] },
  outerGlow: { title: 'Outer glow', params: [
    { key: 'color', type: 'color', label: 'Color', value: '#ffffbe' },
    { key: 'opacity', label: 'Opacity %', min: 0, max: 100, value: 75 },
    { key: 'spread', label: 'Spread', min: 0, max: 100, value: 0 },
    { key: 'size', label: 'Size', min: 0, max: 150, value: 14 },
    { key: 'blend', type: 'blend', label: 'Blend', value: 'screen' }] },
  innerGlow: { title: 'Inner glow', params: [
    { key: 'color', type: 'color', label: 'Color', value: '#ffffbe' },
    { key: 'opacity', label: 'Opacity %', min: 0, max: 100, value: 75 },
    { key: 'size', label: 'Size', min: 0, max: 150, value: 12 },
    { key: 'blend', type: 'blend', label: 'Blend', value: 'screen' }] },
  stroke: { title: 'Stroke', params: [
    { key: 'color', type: 'color', label: 'Color', value: '#000000' },
    { key: 'opacity', label: 'Opacity %', min: 0, max: 100, value: 100 },
    { key: 'size', label: 'Size', min: 1, max: 100, value: 3 },
    { key: 'position', type: 'select', label: 'Position', value: 'outside', options: [['outside', 'Outside'], ['inside', 'Inside'], ['center', 'Center']] }] },
  colorOverlay: { title: 'Color overlay', params: [
    { key: 'color', type: 'color', label: 'Color', value: '#e0402a' },
    { key: 'opacity', label: 'Opacity %', min: 0, max: 100, value: 100 },
    { key: 'blend', type: 'blend', label: 'Blend', value: 'source-over' }] },
};
export const FX_ORDER = ['dropShadow', 'outerGlow', 'stroke', 'innerShadow', 'innerGlow', 'colorOverlay'];

export function defaultEffect(type) {
  const def = FX_TYPES[type]; if (!def) throw new Error(`Unknown layer style ${type}`);
  return { type, enabled: true, ...Object.fromEntries(def.params.map((p) => [p.key, p.value])) };
}
export const hasActiveStyles = (styles) => !!styles && styles.some((s) => s.enabled && FX_TYPES[s.type]);
/** Sanitise effects read from a project / autosave (unknown types dropped, missing params defaulted). */
export function normalizeStyles(list) {
  if (!Array.isArray(list)) return null;
  const out = list.filter((s) => s && FX_TYPES[s.type]).map((s) => ({ ...defaultEffect(s.type), ...s, enabled: s.enabled !== false }));
  return out.length ? out : null;
}

/** How far effects reach outside the layer pixels. */
export function stylePad(styles) {
  let p = 0;
  for (const s of styles || []) {
    if (!s.enabled) continue;
    if (s.type === 'dropShadow') p = Math.max(p, s.distance + s.size * 1.6);
    else if (s.type === 'outerGlow') p = Math.max(p, s.spread + s.size * 1.6);
    else if (s.type === 'stroke' && s.position !== 'inside') p = Math.max(p, s.position === 'center' ? s.size / 2 : s.size);
  }
  return Math.ceil(p) + 2;
}

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const ctx2 = (c) => c.getContext('2d', { willReadFrequently: true });
const hex = (h) => { const n = parseInt(String(h || '#000').replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const dq = q - v[k]; d[q] = dq * dq + f[v[k]]; }
}
/** Euclidean distance from each pixel to the nearest pixel where inside[i] is true (0 on those pixels). */
export function distanceField(inside, w, h) {
  const INF = 1e20, g = new Float32Array(w * h), n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = inside[y * w + x] ? 0 : INF;
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]);
  }
  return g;
}

/** Blurred copy of src's alpha in `color` (optionally offset): the canvas shadow does the blur. */
function shadowOf(src, w, h, size, color, dx = 0, dy = 0) {
  const out = mk(w, h), x = out.getContext('2d'), OFF = w + h + 4 * size + 64;
  const [r, g, b] = hex(color);
  x.shadowColor = `rgb(${r},${g},${b})`; x.shadowBlur = Math.max(0, size); x.shadowOffsetX = OFF + dx; x.shadowOffsetY = dy;
  x.drawImage(src, -OFF, 0);
  return out;
}
function alphaCanvas(alpha, w, h, color) {
  const c = mk(w, h), x = ctx2(c), img = x.createImageData(w, h), [r, g, b] = hex(color);
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) { const a = alpha[i]; if (a <= 0) continue; img.data[j] = r; img.data[j + 1] = g; img.data[j + 2] = b; img.data[j + 3] = Math.min(255, Math.round(a * 255)); }
  x.putImageData(img, 0, 0); return c;
}
/** Draw `layer` onto `dst` restricted to dst's own alpha (dst stays the shape): blend + opacity. */
function drawAtop(dst, layer, opacity, blend) {
  const x = dst.getContext('2d'), w = dst.width, h = dst.height;
  const t = mk(w, h), tx = t.getContext('2d');
  tx.drawImage(layer, 0, 0); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(dst, 0, 0);
  x.save(); x.globalAlpha = opacity; x.globalCompositeOperation = !blend || blend === 'source-over' ? 'source-atop' : blend; x.drawImage(t, 0, 0); x.restore();
  if (blend && blend !== 'source-over') { // keep the shape's alpha exactly (blend modes can grow it at soft edges)
    const k = mk(w, h), kx = k.getContext('2d'); kx.drawImage(dst, 0, 0);
    x.save(); x.globalCompositeOperation = 'copy'; x.drawImage(k, 0, 0); x.restore();
  }
}
const bboxOfAlpha = (a, w, h) => {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) { const row = y * w * 4; for (let x = 0; x < w; x++) if (a[row + x * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; } }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

/**
 * Render a layer's pixels with its effects. `src` = the layer pixels (mask already applied).
 * Returns { canvas, x, y } where x, y is the canvas offset relative to the layer origin (≤ 0), or null when
 * the layer is empty. Draw order follows the usual stacking: shadow, outer glow, outside stroke, pixels,
 * colour overlay, inner glow, inner shadow, inside / centre stroke.
 */
export function renderStyled(src, styles) {
  const on = (styles || []).filter((s) => s.enabled && FX_TYPES[s.type]);
  const sw = src.width, sh = src.height;
  const all = ctx2(src).getImageData(0, 0, sw, sh).data;
  const bb = bboxOfAlpha(all, sw, sh); if (!bb) return null;
  const pad = stylePad(on), w = bb.w + 2 * pad, h = bb.h + 2 * pad, ox = bb.x - pad, oy = bb.y - pad;
  const content = mk(w, h); content.getContext('2d').drawImage(src, -ox, -oy);
  const img = ctx2(content).getImageData(0, 0, w, h).data, A = new Float32Array(w * h);
  for (let i = 0; i < A.length; i++) A[i] = img[i * 4 + 3] / 255;
  let dOut = null, dIn = null;
  const needOut = on.some((s) => (s.type === 'stroke' && s.position !== 'inside') || (s.type === 'outerGlow' && s.spread > 0));
  const needIn = on.some((s) => s.type === 'stroke' && s.position !== 'outside');
  if (needOut || needIn) {
    const ins = new Uint8Array(w * h); for (let i = 0; i < ins.length; i++) ins[i] = A[i] >= 0.5 ? 1 : 0;
    if (needOut) dOut = distanceField(ins, w, h);
    if (needIn) { const outs = new Uint8Array(w * h); for (let i = 0; i < outs.length; i++) outs[i] = ins[i] ? 0 : 1; dIn = distanceField(outs, w, h); }
  }
  const out = mk(w, h), o = out.getContext('2d');
  const put = (c, s, mode) => { o.save(); o.globalAlpha = (s.opacity ?? 100) / 100; o.globalCompositeOperation = mode || s.blend || 'source-over'; o.drawImage(c, 0, 0); o.restore(); };
  const off = (s) => { const a = (s.angle ?? 120) * Math.PI / 180; return [-Math.cos(a) * s.distance, Math.sin(a) * s.distance]; };
  // 1. below the pixels (drawn into an empty canvas: blend modes against transparency act as normal)
  for (const s of on) {
    if (s.type === 'dropShadow') { const [dx, dy] = off(s); put(shadowOf(content, w, h, s.size, s.color, dx, dy), s, 'source-over'); }
    else if (s.type === 'outerGlow') {
      let shape = content;
      if (s.spread > 0) { const a = new Float32Array(w * h); for (let i = 0; i < a.length; i++) a[i] = Math.max(A[i], Math.min(1, Math.max(0, s.spread + 1 - dOut[i]))); shape = alphaCanvas(a, w, h, '#000'); }
      put(shadowOf(shape, w, h, s.size, s.color), s, 'source-over');
    }
  }
  // 2. outside strokes sit just under the pixels
  for (const s of on) if (s.type === 'stroke' && s.position === 'outside') {
    const a = new Float32Array(w * h); for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, s.size + 1 - dOut[i]));
    put(alphaCanvas(a, w, h, s.color), s, 'source-over');
  }
  // 3. the pixels, with the effects that stay inside them
  const body = mk(w, h), bx = body.getContext('2d'); bx.drawImage(content, 0, 0);
  for (const s of on) {
    if (s.type === 'colorOverlay') { const f = mk(w, h), fx = f.getContext('2d'); fx.fillStyle = s.color; fx.fillRect(0, 0, w, h); drawAtop(body, f, s.opacity / 100, s.blend); }
    else if (s.type === 'innerGlow') {
      const inv = mk(w, h), ix = inv.getContext('2d'); ix.fillStyle = '#000'; ix.fillRect(0, 0, w, h); ix.globalCompositeOperation = 'destination-out'; ix.drawImage(content, 0, 0);
      drawAtop(body, shadowOf(inv, w, h, s.size, s.color), s.opacity / 100, s.blend);
    } else if (s.type === 'innerShadow') {
      const [dx, dy] = off(s), big = Math.ceil(Math.abs(dx) + Math.abs(dy) + s.size * 2 + 4);
      const inv = mk(w + 2 * big, h + 2 * big), ix = inv.getContext('2d'); ix.fillStyle = '#000'; ix.fillRect(0, 0, inv.width, inv.height); ix.globalCompositeOperation = 'destination-out'; ix.drawImage(content, big, big);
      const sh = shadowOf(inv, inv.width, inv.height, s.size, s.color, dx, dy), cut = mk(w, h); cut.getContext('2d').drawImage(sh, -big, -big);
      drawAtop(body, cut, s.opacity / 100, s.blend);
    }
  }
  o.drawImage(body, 0, 0);
  // 4. inside / centre strokes on top
  for (const s of on) if (s.type === 'stroke' && s.position !== 'outside') {
    const a = new Float32Array(w * h);
    if (s.position === 'inside') for (let i = 0; i < a.length; i++) a[i] = A[i] * Math.min(1, Math.max(0, s.size + 1 - dIn[i]));
    else { const hs = s.size / 2; for (let i = 0; i < a.length; i++) { const sd = dIn[i] > 0 ? dIn[i] - 0.5 : dOut[i] - 0.5; a[i] = Math.min(1, Math.max(0, hs + 0.5 - Math.abs(sd))); } }
    put(alphaCanvas(a, w, h, s.color), s, 'source-over');
  }
  return { canvas: out, x: ox, y: oy };
}
