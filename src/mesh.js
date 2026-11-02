// Tintwork mesh geometry: perspective (homography), warp (control grid → dense mesh) and liquify
// (displacement field). Every deformation becomes one textured triangle mesh:
//   pos: Float32Array [x, y, q] per vertex (output coords; q = homogeneous weight, 1 for affine meshes)
//   uv:  Float32Array [u, v] per vertex (source pixel coords)
//   idx: Uint32Array triangle indices
// The GPU engines rasterise it with perspective-correct interpolation (clip w = q); renderMeshCPU below is the
// exact CPU reference (pixel-centre coverage, perspective-correct barycentrics, bilinear clamp-to-edge sampling
// in premultiplied space), so GPU and CPU results agree to rounding.

/** Solve the 8×8 system for the homography mapping 4 src points to 4 dst points. Returns [h0..h8] (row-major) or null. */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  for (let c = 0; c < 8; c++) { // Gaussian elimination with partial pivoting
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c]; if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]); h.push(1);
  return h;
}
export const applyH = (h, x, y) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w, w]; };

/**
 * Perspective mesh: source rectangle w×h (uv) onto the quad `pts` (4 output points, clockwise from top-left).
 * Returns null when the quad is not convex (no projective map exists).
 */
export function perspectiveMesh(w, h, pts) {
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], pts); if (!H) return null;
  const qs = [[0, 0], [w, 0], [w, h], [0, h]].map(([u, v]) => H[6] * u + H[7] * v + H[8]);
  const s = qs[0] < 0 ? -1 : 1; if (qs.some((q) => q * s <= 1e-6)) return null;
  const pos = new Float32Array(12), uv = new Float32Array([0, 0, w, 0, w, h, 0, h]);
  for (let i = 0; i < 4; i++) { pos[i * 3] = pts[i][0]; pos[i * 3 + 1] = pts[i][1]; pos[i * 3 + 2] = qs[i] * s; }
  // normalise q so the largest weight is 1 (keeps float precision on the GPU)
  const m = Math.max(pos[2], pos[5], pos[8], pos[11]); for (let i = 0; i < 4; i++) pos[i * 3 + 2] /= m;
  return { pos, uv, idx: new Uint32Array([0, 1, 2, 0, 2, 3]), H };
}

/** Default n×n control grid over a w×h rectangle placed at (ox, oy). */
export function gridPoints(n, w, h, ox = 0, oy = 0) {
  const p = []; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) p.push([ox + (w * i) / (n - 1), oy + (h * j) / (n - 1)]);
  return p;
}
// uniform Catmull-Rom through p1..p2 (t in [0,1]); end segments use mirrored phantom points
const cr = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};
/** Smooth surface through an n×n control grid at (s, t) in [0,1]². */
export function warpEval(ctrl, n, s, t) {
  const at = (i, j) => {
    const ci = Math.max(0, Math.min(n - 1, i)), cj = Math.max(0, Math.min(n - 1, j));
    let p = ctrl[cj * n + ci];
    if (i !== ci || j !== cj) { // phantom: reflect across the edge point
      const q = ctrl[(2 * cj - j < 0 || 2 * cj - j > n - 1 ? cj : 2 * cj - j) * n + (2 * ci - i < 0 || 2 * ci - i > n - 1 ? ci : 2 * ci - i)];
      p = [2 * p[0] - q[0], 2 * p[1] - q[1]];
    }
    return p;
  };
  const fs = s * (n - 1), ft = t * (n - 1);
  const i = Math.min(n - 2, Math.floor(fs)), j = Math.min(n - 2, Math.floor(ft)), u = fs - i, v = ft - j;
  const out = [0, 0];
  for (let k = 0; k < 2; k++) {
    const rows = [];
    for (let r = -1; r <= 2; r++) rows.push(cr(at(i - 1, j + r)[k], at(i, j + r)[k], at(i + 1, j + r)[k], at(i + 2, j + r)[k], u));
    out[k] = cr(rows[0], rows[1], rows[2], rows[3], v);
  }
  return out;
}
/** Regular (m+1)×(m+1) vertex mesh with given positions function; uv covers the w×h source. */
function gridMesh(m, w, h, posAt) {
  const nv = (m + 1) * (m + 1), pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(m * m * 6);
  for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) {
    const k = j * (m + 1) + i, [x, y] = posAt(i / m, j / m, i, j);
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = 1; uv[k * 2] = (w * i) / m; uv[k * 2 + 1] = (h * j) / m;
  }
  let t = 0;
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const a = j * (m + 1) + i, b = a + 1, c = a + m + 1, d = c + 1;
    idx[t++] = a; idx[t++] = b; idx[t++] = c; idx[t++] = b; idx[t++] = d; idx[t++] = c;
  }
  return { pos, uv, idx };
}
/** Warp mesh: dense m×m mesh through the n×n control grid (source w×h). */
export function warpMesh(ctrl, n, w, h, m = 32) { return gridMesh(m, w, h, (s, t) => warpEval(ctrl, n, s, t)); }

/** Output-space bounding box of a mesh (integer pixels). */
export function meshBounds(mesh) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const p = mesh.pos;
  for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); y0 = Math.min(y0, p[i + 1]); x1 = Math.max(x1, p[i]); y1 = Math.max(y1, p[i + 1]); }
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.max(1, Math.ceil(x1) - Math.floor(x0)), h: Math.max(1, Math.ceil(y1) - Math.floor(y0)) };
}
/** Scale a mesh's positions and uvs (low-resolution previews). */
export function scaleMesh(mesh, k, kuv = k) {
  const pos = new Float32Array(mesh.pos), uv = new Float32Array(mesh.uv);
  for (let i = 0; i < pos.length; i += 3) { pos[i] *= k; pos[i + 1] *= k; }
  for (let i = 0; i < uv.length; i++) uv[i] *= kuv;
  return { pos, uv, idx: mesh.idx };
}

/**
 * CPU reference rasteriser. src: straight ImageData; output outW×outH whose (0,0) is at mesh coords (ox, oy).
 * If `region` {x,y,w,h} (output coords) is given only that rectangle is written into `out` (an ImageData of outW×outH).
 */
export function renderMeshCPU(src, outW, outH, mesh, ox = 0, oy = 0, out = null, region = null) {
  out ||= new ImageData(outW, outH);
  const sd = src.data, SW = src.width, SH = src.height, od = out.data, { pos, uv, idx } = mesh;
  const rx0 = region ? Math.max(0, region.x) : 0, ry0 = region ? Math.max(0, region.y) : 0;
  const rx1 = region ? Math.min(outW, region.x + region.w) : outW, ry1 = region ? Math.min(outH, region.y + region.h) : outH;
  if (region) for (let y = ry0; y < ry1; y++) od.fill(0, (y * outW + rx0) * 4, (y * outW + rx1) * 4);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = pos[a * 3] - ox, ay = pos[a * 3 + 1] - oy, bx = pos[b * 3] - ox, by = pos[b * 3 + 1] - oy, cx = pos[c * 3] - ox, cy = pos[c * 3 + 1] - oy;
    let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); if (Math.abs(area) < 1e-9) continue;
    const qa = 1 / pos[a * 3 + 2], qb = 1 / pos[b * 3 + 2], qc = 1 / pos[c * 3 + 2];
    const ua = uv[a * 2] * qa, va = uv[a * 2 + 1] * qa, ub = uv[b * 2] * qb, vb = uv[b * 2 + 1] * qb, uc = uv[c * 2] * qc, vc = uv[c * 2 + 1] * qc;
    const x0 = Math.max(rx0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(rx1 - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(ry0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(ry1 - 1, Math.ceil(Math.max(ay, by, cy)));
    if (x1 < x0 || y1 < y0) continue;
    const inv = 1 / area;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv; // weight of a
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv; // weight of b
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue;
        const iq = w0 * qa + w1 * qb + w2 * qc;
        const u = (w0 * ua + w1 * ub + w2 * uc) / iq - 0.5, v = (w0 * va + w1 * vb + w2 * vc) / iq - 0.5;
        // bilinear, clamp to edge, premultiplied
        let ix = Math.floor(u), iy = Math.floor(v); const fx = u - ix, fy = v - iy;
        const xa = ix < 0 ? 0 : ix >= SW ? SW - 1 : ix, xb = ix + 1 < 0 ? 0 : ix + 1 >= SW ? SW - 1 : ix + 1;
        const ya = iy < 0 ? 0 : iy >= SH ? SH - 1 : iy, yb = iy + 1 < 0 ? 0 : iy + 1 >= SH ? SH - 1 : iy + 1;
        const i00 = (ya * SW + xa) * 4, i10 = (ya * SW + xb) * 4, i01 = (yb * SW + xa) * 4, i11 = (yb * SW + xb) * 4;
        const k00 = (1 - fx) * (1 - fy) * sd[i00 + 3], k10 = fx * (1 - fy) * sd[i10 + 3], k01 = (1 - fx) * fy * sd[i01 + 3], k11 = fx * fy * sd[i11 + 3];
        const A = k00 + k10 + k01 + k11, o = (y * outW + x) * 4;
        if (A <= 0.0001) { od[o] = od[o + 1] = od[o + 2] = od[o + 3] = 0; continue; }
        od[o] = (k00 * sd[i00] + k10 * sd[i10] + k01 * sd[i01] + k11 * sd[i11]) / A; // Uint8ClampedArray rounds
        od[o + 1] = (k00 * sd[i00 + 1] + k10 * sd[i10 + 1] + k01 * sd[i01 + 1] + k11 * sd[i11 + 1]) / A; // Uint8ClampedArray rounds
        od[o + 2] = (k00 * sd[i00 + 2] + k10 * sd[i10 + 2] + k01 * sd[i01 + 2] + k11 * sd[i11 + 2]) / A; // Uint8ClampedArray rounds
        od[o + 3] = A;
      }
    }
  }
  return out;
}

// --- liquify ---------------------------------------------------------------------------------------
/**
 * Displacement field over a w×h image: grid of (gw+1)×(gh+1) vertices with `cell` px spacing. Output pixel p
 * samples the source at p + D(p). Mesh = regular grid at the vertex positions, uv = position + displacement.
 */
export function createField(w, h, cell = 4) {
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  return { w, h, cell, gw, gh, d: new Float32Array((gw + 1) * (gh + 1) * 2) };
}
/**
 * One liquify dab at (cx, cy) (image coords), radius r, strength s (0..1).
 * mode: 'push' (delta = brush movement), 'bloat' (expand from centre), 'pinch' (contract), 'restore' (towards 0).
 * Returns the affected bbox in image pixels.
 */
export function liquifyDab(f, mode, cx, cy, r, s, dx = 0, dy = 0) {
  const { cell, gw, gh, d } = f;
  const i0 = Math.max(0, Math.floor((cx - r) / cell)), i1 = Math.min(gw, Math.ceil((cx + r) / cell));
  const j0 = Math.max(0, Math.floor((cy - r) / cell)), j1 = Math.min(gh, Math.ceil((cy + r) / cell));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const qx = i * cell, qy = j * cell, dist = Math.hypot(qx - cx, qy - cy); if (dist >= r) continue;
    const t = dist / r, w = (1 - t * t) * (1 - t * t) * s, k = (j * (gw + 1) + i) * 2;
    if (mode === 'push') { d[k] -= dx * w; d[k + 1] -= dy * w; }
    else if (mode === 'bloat') { d[k] -= (qx - cx) * w * 0.15; d[k + 1] -= (qy - cy) * w * 0.15; }
    else if (mode === 'pinch') { d[k] += (qx - cx) * w * 0.15; d[k + 1] += (qy - cy) * w * 0.15; }
    else { d[k] *= 1 - w; d[k + 1] *= 1 - w; }
  }
  const pad = cell * 2;
  return { x: Math.max(0, Math.floor(cx - r - pad)), y: Math.max(0, Math.floor(cy - r - pad)), x1: Math.min(f.w, Math.ceil(cx + r + pad)), y1: Math.min(f.h, Math.ceil(cy + r + pad)) };
}
/** Mesh for the field (optionally only the cells covering rect {x,y,x1,y1}). */
export function fieldMesh(f, rect = null) {
  const { cell, gw, gh, d } = f;
  const i0 = rect ? Math.max(0, Math.floor(rect.x / cell) - 1) : 0, i1 = rect ? Math.min(gw, Math.ceil(rect.x1 / cell) + 1) : gw;
  const j0 = rect ? Math.max(0, Math.floor(rect.y / cell) - 1) : 0, j1 = rect ? Math.min(gh, Math.ceil(rect.y1 / cell) + 1) : gh;
  const cw = i1 - i0, ch = j1 - j0, nv = (cw + 1) * (ch + 1);
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(cw * ch * 6);
  for (let j = 0; j <= ch; j++) for (let i = 0; i <= cw; i++) {
    const gi = i0 + i, gj = j0 + j, k = j * (cw + 1) + i, s = (gj * (gw + 1) + gi) * 2;
    const x = Math.min(f.w, gi * cell), y = Math.min(f.h, gj * cell);
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = 1; uv[k * 2] = x + d[s]; uv[k * 2 + 1] = y + d[s + 1];
  }
  let t = 0;
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const a = j * (cw + 1) + i, b = a + 1, c = a + cw + 1, e = c + 1;
    idx[t++] = a; idx[t++] = b; idx[t++] = c; idx[t++] = b; idx[t++] = e; idx[t++] = c;
  }
  return { pos, uv, idx };
}
export const fieldIsIdentity = (f) => f.d.every((v) => v === 0);
