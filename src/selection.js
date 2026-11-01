// Pixel-mask selections. A selection is an immutable object:
//   { W, H, mask: Uint8Array(W*H) 0..255, x, y, w, h (bounding box of mask > 0) }
// Every operation returns a new selection (or null when empty), which lets the
// history share selection objects between steps without copying.

export function makeSelection(W, H, mask) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let first = -1, last = -1;
    for (let x = 0; x < W; x++) if (mask[row + x]) { if (first < 0) first = x; last = x; }
    if (first >= 0) {
      if (first < x0) x0 = first; if (last > x1) x1 = last;
      if (y < y0) y0 = y; y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { W, H, mask, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Rasterize a shape (a function drawing a path on a 2D context) to a mask. */
export function shapeMask(W, H, drawPath, antialias = true) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff';
  x.beginPath(); drawPath(x); x.fill('nonzero');
  const d = x.getImageData(0, 0, W, H).data;
  const m = new Uint8Array(W * H);
  for (let i = 0, j = 3; i < m.length; i++, j += 4) m[i] = antialias ? d[j] : (d[j] >= 128 ? 255 : 0);
  return m;
}

export function rectMask(W, H, r) {
  const m = new Uint8Array(W * H);
  const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(W, Math.round(r.x + r.w)), y1 = Math.min(H, Math.round(r.y + r.h));
  for (let y = y0; y < y1; y++) m.fill(255, y * W + x0, y * W + x1);
  return m;
}

/** Combine an existing selection with a new mask. mode: new | add | subtract | intersect */
export function combine(sel, W, H, shape, mode) {
  if (mode === 'new' || (!sel && mode === 'add')) return makeSelection(W, H, shape);
  if (!sel) return mode === 'intersect' || mode === 'subtract' ? null : makeSelection(W, H, shape);
  const a = sel.mask, out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) {
    const p = a[i], q = shape[i];
    out[i] = mode === 'add' ? (p > q ? p : q) : mode === 'subtract' ? Math.min(p, 255 - q) : (p < q ? p : q);
  }
  return makeSelection(W, H, out);
}

export function invertSelection(sel, W, H) {
  const out = new Uint8Array(W * H);
  if (!sel) { out.fill(255); return makeSelection(W, H, out); }
  for (let i = 0; i < out.length; i++) out[i] = 255 - sel.mask[i];
  return makeSelection(W, H, out);
}

/** Alpha canvas (white, alpha = mask) used for clipping with destination-in. */
export function selectionCanvas(sel) {
  if (sel._canvas) return sel._canvas;
  const c = document.createElement('canvas'); c.width = sel.W; c.height = sel.H;
  const x = c.getContext('2d');
  const img = x.createImageData(sel.W, sel.H), d = img.data, m = sel.mask;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = 255; d[j + 3] = m[i]; }
  x.putImageData(img, 0, 0);
  Object.defineProperty(sel, '_canvas', { value: c, enumerable: false });
  return c;
}

/** Outline (marching ants) of mask >= 128, as a Path2D in document pixels. Cached. */
export function selectionOutline(sel) {
  if (sel._path) return sel._path;
  const { W, H, mask } = sel;
  const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] >= 128;
  const p = new Path2D();
  const x0 = Math.max(0, sel.x - 1), x1 = Math.min(W, sel.x + sel.w + 1);
  const y0 = Math.max(0, sel.y - 1), y1 = Math.min(H, sel.y + sel.h + 1);
  // horizontal edges (between row y-1 and y), merged into runs
  for (let y = y0; y <= y1; y++) {
    let start = -1;
    for (let x = x0; x <= x1; x++) {
      const edge = x < x1 && on(x, y) !== on(x, y - 1);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) { p.moveTo(start, y); p.lineTo(x, y); start = -1; }
    }
  }
  // vertical edges (between column x-1 and x), merged into runs
  for (let x = x0; x <= x1; x++) {
    let start = -1;
    for (let y = y0; y <= y1; y++) {
      const edge = y < y1 && on(x, y) !== on(x - 1, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) { p.moveTo(x, start); p.lineTo(x, y); start = -1; }
    }
  }
  Object.defineProperty(sel, '_path', { value: p, enumerable: false });
  return p;
}

/** Extract the mask values for a rectangle (document coords) as a Uint8Array. */
export function maskRegion(sel, rx, ry, rw, rh) {
  const out = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const sy = ry + y; if (sy < 0 || sy >= sel.H) continue;
    for (let x = 0; x < rw; x++) {
      const sx = rx + x; if (sx < 0 || sx >= sel.W) continue;
      out[y * rw + x] = sel.mask[sy * sel.W + sx];
    }
  }
  return out;
}

export const isFull = (sel) => sel && sel.x === 0 && sel.y === 0 && sel.w === sel.W && sel.h === sel.H && sel.mask.every((v) => v === 255);

/** Selection shifted by whole pixels (parts moved outside the document are dropped). */
export function translateSelection(sel, dx, dy) {
  if (!sel) return null;
  const { W, H } = sel, out = new Uint8Array(W * H);
  for (let y = Math.max(0, sel.y); y < sel.y + sel.h; y++) {
    const ty = y + dy; if (ty < 0 || ty >= H) continue;
    for (let x = sel.x; x < sel.x + sel.w; x++) {
      const tx = x + dx; if (tx < 0 || tx >= W) continue;
      out[ty * W + tx] = sel.mask[y * W + x];
    }
  }
  return makeSelection(W, H, out);
}

