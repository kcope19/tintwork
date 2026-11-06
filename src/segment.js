// Tintwork v1.8 — non-AI image analysis helpers (pure functions, no DOM, so they run in node tests too):
//  * grabCut(): box-initialised colour-model graph cut (iterated GMM + min-cut, after Rother, Kolmogorov & Blake,
//    "GrabCut", SIGGRAPH 2004) with hard constraints from refine strokes; max-flow is Boykov–Kolmogorov (2004).
//  * guidedFilter(): edge-aware mask refinement (He, Sun & Tang, "Guided Image Filtering", 2010).
//  * detectLines() / estimateUpright(): Hough line detection and a vanishing-point fit for Auto upright.
//  * largestInnerRect(): the biggest axis-aligned (optionally fixed-ratio) rectangle inside the opaque area.
//  * pushPullFill(): smooth fill of transparent pixels from their surroundings (a pyramid "push-pull").
//  * edgeCloneFill(): mirror nearest opaque pixels into gaps (keeps texture; used by Fill empty edges).
// Images are { width, height, data } with RGBA bytes (ImageData-compatible).

// ------------------------------------------------------------------------------------------------ max-flow
// 8-connected grid graph. Arc k of node p goes to p + OFF[k]; the reverse arc is 7 − k.
const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const TERMINAL = -1, ORPHAN = -2, NONE = -3;
/**
 * Min-cut on a W×H grid. cap: Float64Array(N*8) arc capacities (p → neighbour k), tS/tT: terminal capacities.
 * Returns Uint8Array: 1 = source side (foreground).
 */
export function gridMinCut(W, H, cap, tS, tT) {
  const N = W * H, rc = cap, tr = new Float64Array(N), tree = new Uint8Array(N), parent = new Int8Array(N).fill(NONE);
  const ts = new Int32Array(N), dist = new Int32Array(N), off = DX.map((dx, k) => dx + DY[k] * W);
  const valid = (p, k) => { const x = p % W + DX[k], y = ((p / W) | 0) + DY[k]; return x >= 0 && y >= 0 && x < W && y < H; };
  // valid-arc mask per node (edge nodes lack some neighbours)
  const vm = new Uint8Array(N); for (let p = 0; p < N; p++) { let m = 0; for (let k = 0; k < 8; k++) if (valid(p, k)) m |= 1 << k; vm[p] = m; }
  let queue = new Int32Array(Math.max(16, N)), qh = 0, qt = 0, qn = 0; const inQ = new Uint8Array(N);
  const push = (p) => { if (inQ[p]) return; inQ[p] = 1; if (qn === queue.length) { const nq = new Int32Array(queue.length * 2); for (let i = 0; i < qn; i++) nq[i] = queue[(qh + i) % queue.length]; queue = nq; qh = 0; qt = qn; } queue[qt] = p; qt = (qt + 1) % queue.length; qn++; };
  const pop = () => { const p = queue[qh]; qh = (qh + 1) % queue.length; qn--; inQ[p] = 0; return p; };
  for (let p = 0; p < N; p++) {
    const d = tS[p] - tT[p]; tr[p] = d;
    if (d > 0) { tree[p] = 1; parent[p] = TERMINAL; push(p); } else if (d < 0) { tree[p] = 2; parent[p] = TERMINAL; push(p); }
    ts[p] = 0; dist[p] = 1;
  }
  let TIME = 0; const orphans = []; const EPS = 1e-12;
  for (;;) {
    // ---- growth
    let s = -1, t = -1, ak = -1, p = -1;
    while (qn) {
      p = queue[qh]; if (!tree[p]) { pop(); continue; }
      const m = vm[p];
      if (tree[p] === 1) {
        for (let k = 0; k < 8; k++) {
          if (!(m >> k & 1) || rc[p * 8 + k] <= EPS) continue;
          const q = p + off[k];
          if (!tree[q]) { tree[q] = 1; parent[q] = 7 - k; ts[q] = ts[p]; dist[q] = dist[p] + 1; push(q); }
          else if (tree[q] === 2) { s = p; t = q; ak = k; break; }
          else if (ts[q] <= ts[p] && dist[q] > dist[p] && parent[q] >= 0) { parent[q] = 7 - k; ts[q] = ts[p]; dist[q] = dist[p] + 1; }
        }
      } else {
        for (let k = 0; k < 8; k++) {
          if (!(m >> k & 1)) continue; const q = p + off[k];
          if (rc[q * 8 + (7 - k)] <= EPS) continue;
          if (!tree[q]) { tree[q] = 2; parent[q] = 7 - k; ts[q] = ts[p]; dist[q] = dist[p] + 1; push(q); }
          else if (tree[q] === 1) { s = q; t = p; ak = 7 - k; break; }
          else if (ts[q] <= ts[p] && dist[q] > dist[p] && parent[q] >= 0) { parent[q] = 7 - k; ts[q] = ts[p]; dist[q] = dist[p] + 1; }
        }
      }
      if (s >= 0) break;
      pop();
    }
    if (s < 0) break;
    TIME++;
    // ---- augmentation
    let b = rc[s * 8 + ak];
    for (let i = s; ; ) { const pa = parent[i]; if (pa === TERMINAL) { b = Math.min(b, tr[i]); break; } const j = i + off[pa]; b = Math.min(b, rc[j * 8 + (7 - pa)]); i = j; }
    for (let i = t; ; ) { const pa = parent[i]; if (pa === TERMINAL) { b = Math.min(b, -tr[i]); break; } b = Math.min(b, rc[i * 8 + pa]); i = i + off[pa]; }
    rc[s * 8 + ak] -= b; rc[t * 8 + (7 - ak)] += b;
    for (let i = s; ; ) {
      const pa = parent[i];
      if (pa === TERMINAL) { tr[i] -= b; if (tr[i] <= EPS) { tr[i] = 0; parent[i] = ORPHAN; orphans.push(i); } break; }
      const j = i + off[pa]; rc[j * 8 + (7 - pa)] -= b; rc[i * 8 + pa] += b;
      if (rc[j * 8 + (7 - pa)] <= EPS) { parent[i] = ORPHAN; orphans.push(i); }
      i = j;
    }
    for (let i = t; ; ) {
      const pa = parent[i];
      if (pa === TERMINAL) { tr[i] += b; if (tr[i] >= -EPS) { tr[i] = 0; parent[i] = ORPHAN; orphans.push(i); } break; }
      const j = i + off[pa]; rc[i * 8 + pa] -= b; rc[j * 8 + (7 - pa)] += b;
      if (rc[i * 8 + pa] <= EPS) { parent[i] = ORPHAN; orphans.push(i); }
      i = j;
    }
    // ---- adoption
    while (orphans.length) {
      const o = orphans.pop(), tr0 = tree[o], m = vm[o];
      let best = -1, bd = 1e9;
      for (let k = 0; k < 8; k++) {
        if (!(m >> k & 1)) continue; const j = o + off[k]; if (tree[j] !== tr0) continue;
        const r = tr0 === 1 ? rc[j * 8 + (7 - k)] : rc[o * 8 + k]; if (r <= EPS) continue;
        // origin check
        let d = 0, i = j;
        for (;;) {
          if (ts[i] === TIME) { d += dist[i]; break; }
          const pa = parent[i]; d++;
          if (pa === TERMINAL) { ts[i] = TIME; dist[i] = 1; break; }
          if (pa < 0) { d = 1e9; break; }
          i = i + off[pa];
        }
        if (d < 1e9) {
          if (d < bd) { bd = d; best = k; }
          for (let i2 = j; ts[i2] !== TIME; ) { ts[i2] = TIME; dist[i2] = d--; const pa = parent[i2]; if (pa < 0) break; i2 = i2 + off[pa]; }
        }
      }
      if (best >= 0) { parent[o] = best; ts[o] = TIME; dist[o] = bd + 1; continue; }
      // no parent: free the node; its children become orphans, its neighbours become active
      for (let k = 0; k < 8; k++) {
        if (!(m >> k & 1)) continue; const j = o + off[k]; if (tree[j] !== tr0) continue;
        const r = tr0 === 1 ? rc[j * 8 + (7 - k)] : rc[o * 8 + k]; if (r > EPS) push(j);
        const pj = parent[j]; if (pj >= 0 && j + off[pj] === o) { parent[j] = ORPHAN; orphans.push(j); }
      }
      tree[o] = 0; parent[o] = NONE;
    }
  }
  const out = new Uint8Array(N); for (let p = 0; p < N; p++) out[p] = tree[p] === 1 ? 1 : 0;
  return out;
}

// ------------------------------------------------------------------------------------------------ GMM
function kmeans(pts, n, K, iters = 6) {
  // pts: Float64Array(n*3). Deterministic farthest-point seeding.
  const C = new Float64Array(K * 3), lab = new Int32Array(n); if (!n) return { C, lab };
  C.set(pts.subarray(0, 3), 0);
  const dmin = new Float64Array(n).fill(Infinity);
  for (let k = 1; k < K; k++) {
    let bi = 0, bv = -1;
    for (let i = 0; i < n; i++) { const dx = pts[i * 3] - C[(k - 1) * 3], dy = pts[i * 3 + 1] - C[(k - 1) * 3 + 1], dz = pts[i * 3 + 2] - C[(k - 1) * 3 + 2]; const d = dx * dx + dy * dy + dz * dz; if (d < dmin[i]) dmin[i] = d; if (dmin[i] > bv) { bv = dmin[i]; bi = i; } }
    C.set(pts.subarray(bi * 3, bi * 3 + 3), k * 3);
  }
  for (let it = 0; it < iters; it++) {
    const S = new Float64Array(K * 4);
    for (let i = 0; i < n; i++) {
      let bk = 0, bd = Infinity;
      for (let k = 0; k < K; k++) { const dx = pts[i * 3] - C[k * 3], dy = pts[i * 3 + 1] - C[k * 3 + 1], dz = pts[i * 3 + 2] - C[k * 3 + 2]; const d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; bk = k; } }
      lab[i] = bk; S[bk * 4] += pts[i * 3]; S[bk * 4 + 1] += pts[i * 3 + 1]; S[bk * 4 + 2] += pts[i * 3 + 2]; S[bk * 4 + 3]++;
    }
    for (let k = 0; k < K; k++) if (S[k * 4 + 3]) for (let c = 0; c < 3; c++) C[k * 3 + c] = S[k * 4 + c] / S[k * 4 + 3];
  }
  return { C, lab };
}
/** Fit a K-component full-covariance GMM to points given hard component labels. */
function fitGMM(pts, n, lab, K) {
  const comps = [];
  for (let k = 0; k < K; k++) comps.push({ n: 0, s: [0, 0, 0], ss: [0, 0, 0, 0, 0, 0, 0, 0, 0] });
  for (let i = 0; i < n; i++) {
    const c = comps[lab[i]], r = pts[i * 3], g = pts[i * 3 + 1], b = pts[i * 3 + 2];
    c.n++; c.s[0] += r; c.s[1] += g; c.s[2] += b;
    const v = [r, g, b]; for (let a = 0; a < 3; a++) for (let e = 0; e < 3; e++) c.ss[a * 3 + e] += v[a] * v[e];
  }
  const out = [];
  for (const c of comps) {
    if (c.n < 2) continue;
    const m = c.s.map((v) => v / c.n), S = new Float64Array(9);
    for (let a = 0; a < 3; a++) for (let e = 0; e < 3; e++) S[a * 3 + e] = c.ss[a * 3 + e] / c.n - m[a] * m[e];
    for (let a = 0; a < 3; a++) S[a * 4] += 1e-4 + 2e-5; // regularise (values are 0..1)
    const det = S[0] * (S[4] * S[8] - S[5] * S[7]) - S[1] * (S[3] * S[8] - S[5] * S[6]) + S[2] * (S[3] * S[7] - S[4] * S[6]);
    const inv = new Float64Array([
      (S[4] * S[8] - S[5] * S[7]) / det, (S[2] * S[7] - S[1] * S[8]) / det, (S[1] * S[5] - S[2] * S[4]) / det,
      (S[5] * S[6] - S[3] * S[8]) / det, (S[0] * S[8] - S[2] * S[6]) / det, (S[2] * S[3] - S[0] * S[5]) / det,
      (S[3] * S[7] - S[4] * S[6]) / det, (S[1] * S[6] - S[0] * S[7]) / det, (S[0] * S[4] - S[1] * S[3]) / det]);
    out.push({ w: c.n / n, m, inv, lnorm: Math.log(c.n / n) - 0.5 * Math.log(Math.max(det, 1e-300)) });
  }
  return out;
}
const compLL = (c, r, g, b) => { const x = r - c.m[0], y = g - c.m[1], z = b - c.m[2], I = c.inv; return c.lnorm - 0.5 * (x * (I[0] * x + I[1] * y + I[2] * z) + y * (I[3] * x + I[4] * y + I[5] * z) + z * (I[6] * x + I[7] * y + I[8] * z)); };
function gmmNLL(gmm, r, g, b) { // −log Σ_k w_k N(x; μ_k, Σ_k) (up to a constant)
  let mx = -Infinity; const v = new Array(gmm.length);
  for (let k = 0; k < gmm.length; k++) { v[k] = compLL(gmm[k], r, g, b); if (v[k] > mx) mx = v[k]; }
  let s = 0; for (let k = 0; k < gmm.length; k++) s += Math.exp(v[k] - mx);
  return -(mx + Math.log(s));
}
const bestComp = (gmm, r, g, b) => { let bk = 0, bv = -Infinity; for (let k = 0; k < gmm.length; k++) { const v = compLL(gmm[k], r, g, b); if (v > bv) { bv = v; bk = k; } } return bk; };

// ------------------------------------------------------------------------------------------------ GrabCut
/**
 * img: RGBA image (already at working resolution). rect: {x,y,w,h} — outside is background.
 * hard: optional Uint8Array(W*H): 1 = must be foreground, 2 = must be background.
 * init: optional previous labels (Uint8Array, 1 = fg) to start from. Returns { mask: Uint8Array (1 = fg) }.
 */
/**
 * Edge-aware (geodesic) distance from seed pixels: the cheapest 8-connected path where each step costs the colour
 * difference it crosses (0–441 for RGB in 0–255) plus a small length term. Dijkstra with a binary heap.
 * Used to let a refine stroke spread over the region it was painted on and stop at edges (no learning involved).
 */
export function geodesicDistance(img, seeds, { lengthCost = 2 } = {}) {
  const W = img.width, H = img.height, N = W * H, d = img.data, D = new Float32Array(N).fill(Infinity);
  let hp = new Int32Array(1024), hk = new Float32Array(1024), n = 0;
  const push = (p, k) => { if (n === hp.length) { const a = new Int32Array(n * 2), b = new Float32Array(n * 2); a.set(hp); b.set(hk); hp = a; hk = b; } let i = n++; while (i) { const j = (i - 1) >> 1; if (hk[j] <= k) break; hp[i] = hp[j]; hk[i] = hk[j]; i = j; } hp[i] = p; hk[i] = k; };
  const pop = () => { const p = hp[0], last = hp[--n], lk = hk[n]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && hk[c + 1] < hk[c]) c++; if (hk[c] >= lk) break; hp[i] = hp[c]; hk[i] = hk[c]; i = c; } hp[i] = last; hk[i] = lk; return p; };
  for (let p = 0; p < N; p++) if (seeds[p]) { D[p] = 0; push(p, 0); }
  while (n) {
    const k0 = hk[0], p = pop(); if (k0 > D[p]) continue; const x = p % W, y = (p / W) | 0;
    for (let k = 0; k < 8; k++) {
      const qx = x + DX[k], qy = y + DY[k]; if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue; const q = qy * W + qx;
      const dr = d[p * 4] - d[q * 4], dg = d[p * 4 + 1] - d[q * 4 + 1], db = d[p * 4 + 2] - d[q * 4 + 2];
      const nd = D[p] + Math.sqrt(dr * dr + dg * dg + db * db) + (DX[k] && DY[k] ? lengthCost * Math.SQRT2 : lengthCost);
      if (nd < D[q]) { D[q] = nd; push(q, nd); }
    }
  }
  return D;
}

export function grabCut(img, rect, { hard = null, init = null, iterations = 4, K = 5, gamma = 50, prior = null } = {}) {
  const W = img.width, H = img.height, N = W * H, d = img.data;
  const rx0 = Math.max(0, Math.floor(rect.x)), ry0 = Math.max(0, Math.floor(rect.y)), rx1 = Math.min(W, Math.ceil(rect.x + rect.w)), ry1 = Math.min(H, Math.ceil(rect.y + rect.h));
  const px = new Float64Array(N * 3); for (let p = 0; p < N; p++) { px[p * 3] = d[p * 4] / 255; px[p * 3 + 1] = d[p * 4 + 1] / 255; px[p * 3 + 2] = d[p * 4 + 2] / 255; }
  // label: 0 bg, 1 fg; fixed: 0 free, 1 fixed fg, 2 fixed bg
  const lab = new Uint8Array(N), fixed = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, inside = x >= rx0 && x < rx1 && y >= ry0 && y < ry1;
    if (!inside) fixed[p] = 2; lab[p] = inside ? 1 : 0;
    if (hard && hard[p]) fixed[p] = hard[p];
    if (init && inside && !fixed[p]) lab[p] = init[p] ? 1 : 0;
    if (fixed[p] === 1) lab[p] = 1; else if (fixed[p] === 2) lab[p] = 0;
  }
  // smoothness weights (β from the mean colour contrast)
  let sum = 0, cnt = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    for (const k of [4, 6, 7, 5]) { const qx = x + DX[k], qy = y + DY[k]; if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue; const q = qy * W + qx; const a = px[p * 3] - px[q * 3], b = px[p * 3 + 1] - px[q * 3 + 1], c = px[p * 3 + 2] - px[q * 3 + 2]; sum += a * a + b * b + c * c; cnt++; }
  }
  const beta = cnt && sum > 0 ? 1 / (2 * sum / cnt) : 0;
  const nW = new Float64Array(N * 8);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    for (let k = 0; k < 8; k++) {
      const qx = x + DX[k], qy = y + DY[k]; if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue; const q = qy * W + qx;
      const a = px[p * 3] - px[q * 3], b = px[p * 3 + 1] - px[q * 3 + 1], c = px[p * 3 + 2] - px[q * 3 + 2];
      nW[p * 8 + k] = gamma / (DX[k] && DY[k] ? Math.SQRT2 : 1) * Math.exp(-beta * (a * a + b * b + c * c));
    }
  }
  let maxSum = 0; for (let p = 0; p < N; p++) { let s = 0; for (let k = 0; k < 8; k++) s += nW[p * 8 + k]; if (s > maxSum) maxSum = s; }
  const BIG = 1 + maxSum * 2 + 1e3;
  // initial GMM components from k-means
  const sel = (want) => { const idx = []; for (let p = 0; p < N; p++) if (lab[p] === want) idx.push(p); return idx; };
  const gather = (idx) => { const a = new Float64Array(idx.length * 3); idx.forEach((p, i) => { a[i * 3] = px[p * 3]; a[i * 3 + 1] = px[p * 3 + 1]; a[i * 3 + 2] = px[p * 3 + 2]; }); return a; };
  let fgIdx = sel(1), bgIdx = sel(0);
  if (!fgIdx.length || !bgIdx.length) return { mask: lab };
  const sub = (idx) => { if (idx.length <= 40000) return idx; const st = idx.length / 40000, o = []; for (let i = 0; i < idx.length; i += st) o.push(idx[Math.floor(i)]); return o; };
  let fgP = gather(sub(fgIdx)), bgP = gather(sub(bgIdx));
  let fgG = fitGMM(fgP, fgP.length / 3, kmeans(fgP, fgP.length / 3, K).lab, K), bgG = fitGMM(bgP, bgP.length / 3, kmeans(bgP, bgP.length / 3, K).lab, K);
  const tS = new Float64Array(N), tT = new Float64Array(N);
  for (let it = 0; it < iterations; it++) {
    // learn: assign components, refit
    if (it > 0) {
      fgIdx = sel(1); bgIdx = sel(0); if (!fgIdx.length || !bgIdx.length) break;
      const fs = sub(fgIdx), bs = sub(bgIdx); fgP = gather(fs); bgP = gather(bs);
      const fl = new Int32Array(fs.length), bl = new Int32Array(bs.length);
      for (let i = 0; i < fs.length; i++) fl[i] = bestComp(fgG, fgP[i * 3], fgP[i * 3 + 1], fgP[i * 3 + 2]);
      for (let i = 0; i < bs.length; i++) bl[i] = bestComp(bgG, bgP[i * 3], bgP[i * 3 + 1], bgP[i * 3 + 2]);
      const nf = fitGMM(fgP, fs.length, fl, K), nb = fitGMM(bgP, bs.length, bl, K); if (nf.length) fgG = nf; if (nb.length) bgG = nb;
    }
    for (let p = 0; p < N; p++) {
      if (fixed[p] === 1) { tS[p] = BIG; tT[p] = 0; } else if (fixed[p] === 2) { tS[p] = 0; tT[p] = BIG; }
      else { const r = px[p * 3], g = px[p * 3 + 1], b = px[p * 3 + 2]; tS[p] = gmmNLL(bgG, r, g, b); tT[p] = gmmNLL(fgG, r, g, b); if (prior) { tS[p] += prior.fg[p]; tT[p] += prior.bg[p]; } const m = Math.min(tS[p], tT[p]); tS[p] -= m; tT[p] -= m; }
    }
    const cut = gridMinCut(W, H, new Float64Array(nW), tS, tT);
    let changed = 0; for (let p = 0; p < N; p++) if (cut[p] !== lab[p]) { lab[p] = cut[p]; changed++; }
    if (it > 0 && changed < N * 0.0005) break;
  }
  return { mask: lab };
}

/** Keep only the connected fg components that touch a seed (strokes) or are big; fills small holes. */
export function cleanMask(mask, W, H, { minFrac = 0.02, seeds = null } = {}) {
  const lbl = new Int32Array(W * H).fill(-1), sizes = [], touch = [];
  const st = new Int32Array(W * H);
  const flood = (val, out) => {
    let n = 0;
    for (let p0 = 0; p0 < W * H; p0++) {
      if (mask[p0] !== val || lbl[p0] !== -1) continue;
      const id = sizes.length; let sz = 0, sp = 0, hit = false, edge = false; st[sp++] = p0; lbl[p0] = id;
      while (sp) { const p = st[--sp]; sz++; if (seeds && seeds[p]) hit = true; const x = p % W, y = (p / W) | 0; if (!x || !y || x === W - 1 || y === H - 1) edge = true;
        if (x > 0 && mask[p - 1] === val && lbl[p - 1] === -1) { lbl[p - 1] = id; st[sp++] = p - 1; }
        if (x < W - 1 && mask[p + 1] === val && lbl[p + 1] === -1) { lbl[p + 1] = id; st[sp++] = p + 1; }
        if (y > 0 && mask[p - W] === val && lbl[p - W] === -1) { lbl[p - W] = id; st[sp++] = p - W; }
        if (y < H - 1 && mask[p + W] === val && lbl[p + W] === -1) { lbl[p + W] = id; st[sp++] = p + W; } }
      sizes.push(sz); touch.push(val === 0 ? edge : hit); n++;
    }
    return n;
  };
  flood(1);
  let biggest = 0; for (let i = 0; i < sizes.length; i++) if (sizes[i] > sizes[biggest]) biggest = i;
  const total = mask.reduce((a, v) => a + v, 0), out = new Uint8Array(mask);
  const keep = sizes.map((s, i) => i === biggest || touch[i] || s >= total * minFrac);
  for (let p = 0; p < W * H; p++) if (mask[p] === 1 && !keep[lbl[p]]) out[p] = 0;
  // holes: bg components not touching the border and small → fill
  const fgStart = sizes.length; lbl.fill(-1); sizes.length = 0; touch.length = 0;
  const m2 = out; mask = m2; flood(0);
  for (let p = 0; p < W * H; p++) if (out[p] === 0 && !touch[lbl[p]] && sizes[lbl[p]] < total * 0.01) out[p] = 1;
  return out;
}

// ------------------------------------------------------------------------------------------------ guided filter
function boxSum(src, W, H, r, out) {
  // separable running box mean with edge clamping by count
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { let s = 0; const o = y * W; for (let x = 0; x <= Math.min(r, W - 1); x++) s += src[o + x];
    for (let x = 0; x < W; x++) { tmp[o + x] = s; const a = x + r + 1, b = x - r; if (a < W) s += src[o + a]; if (b >= 0) s -= src[o + b]; } }
  for (let x = 0; x < W; x++) { let s = 0; for (let y = 0; y <= Math.min(r, H - 1); y++) s += tmp[y * W + x];
    for (let y = 0; y < H; y++) { out[y * W + x] = s; const a = y + r + 1, b = y - r; if (a < H) s += tmp[a * W + x]; if (b >= 0) s -= tmp[b * W + x]; } }
  return out;
}
/** Grey-guided filter. I, p: Float32Array (0..1). Returns q (Float32Array). */
export function guidedFilter(I, p, W, H, r, eps) {
  const n = W * H, one = new Float32Array(n).fill(1), N = boxSum(one, W, H, r, new Float32Array(n));
  const mI = boxSum(I, W, H, r, new Float32Array(n)), mP = boxSum(p, W, H, r, new Float32Array(n));
  const t = new Float32Array(n); for (let i = 0; i < n; i++) t[i] = I[i] * p[i];
  const mIp = boxSum(t, W, H, r, new Float32Array(n)); for (let i = 0; i < n; i++) t[i] = I[i] * I[i];
  const mII = boxSum(t, W, H, r, new Float32Array(n));
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const c = N[i], mi = mI[i] / c, mp = mP[i] / c, cov = mIp[i] / c - mi * mp, v = mII[i] / c - mi * mi; a[i] = cov / (v + eps); b[i] = mp - a[i] * mi; }
  const ma = boxSum(a, W, H, r, new Float32Array(n)), mb = boxSum(b, W, H, r, new Float32Array(n));
  const q = new Float32Array(n); for (let i = 0; i < n; i++) q[i] = (ma[i] * I[i] + mb[i]) / N[i];
  return q;
}

// ------------------------------------------------------------------------------------------------ resampling
/** Box/bilinear downscale of RGBA bytes to fit `maxSide`; returns { width, height, data, scale }. */
export function downscaleRGBA(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height)); if (s >= 1) return { ...img, scale: 1 };
  const W = Math.max(1, Math.round(img.width * s)), H = Math.max(1, Math.round(img.height * s)), out = new Uint8ClampedArray(W * H * 4), d = img.data;
  const fx = img.width / W, fy = img.height / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx)); let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * img.width + xx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++; }
      const o = (y * W + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: W, height: H, data: out, scale: W / img.width };
}
/** Bilinear sample of a W×H Float32/Uint8 field at (x, y) in field pixels. */
const bil = (f, W, H, x, y) => { x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y)); const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = x - x0, fy = y - y0; return (f[y0 * W + x0] * (1 - fx) + f[y0 * W + x1] * fx) * (1 - fy) + (f[y1 * W + x0] * (1 - fx) + f[y1 * W + x1] * fx) * fy; };

/**
 * Full object selection: img (full-res RGBA region), rect in img pixels, strokes [{ fg: bool, r, pts: [[x,y]…] }]
 * in img pixels. Returns { alpha: Uint8Array(img.width*img.height) 0..255, work } (work = low-res state).
 */
export function objectSelect(img, rect, { strokes = [], workSide = 420, refineSide = 1400, refine = true, strokeWeight = 6, bgReach = 120 } = {}) {
  // working crop: the box plus a margin (outside the box everything is background)
  const mx = Math.max(6, rect.w * 0.06), my = Math.max(6, rect.h * 0.06);
  const cx0 = Math.max(0, Math.floor(rect.x - mx)), cy0 = Math.max(0, Math.floor(rect.y - my)), cx1 = Math.min(img.width, Math.ceil(rect.x + rect.w + mx)), cy1 = Math.min(img.height, Math.ceil(rect.y + rect.h + my));
  const cw = cx1 - cx0, ch = cy1 - cy0; if (cw < 4 || ch < 4) return { alpha: new Uint8Array(img.width * img.height), work: null };
  const crop = cropRGBA(img, cx0, cy0, cw, ch), small = downscaleRGBA(crop, workSide), s = small.scale, W = small.width, H = small.height;
  const r = { x: (rect.x - cx0) * s, y: (rect.y - cy0) * s, w: rect.w * s, h: rect.h * s };
  let hard = null, seeds = null;
  if (strokes.length) {
    hard = new Uint8Array(W * H); seeds = new Uint8Array(W * H);
    for (const st of strokes) {
      const rad = Math.max(1, st.r * s), v = st.fg ? 1 : 2;
      for (let i = 0; i < st.pts.length; i++) {
        const [ax, ay] = st.pts[i], [bx, by] = st.pts[Math.min(i + 1, st.pts.length - 1)], L = Math.hypot(bx - ax, by - ay) * s, n = Math.max(1, Math.ceil(L / Math.max(1, rad / 2)));
        for (let j = 0; j <= n; j++) {
          const x = ((ax + (bx - ax) * j / n) - cx0) * s, y = ((ay + (by - ay) * j / n) - cy0) * s;
          for (let yy = Math.max(0, Math.floor(y - rad)); yy <= Math.min(H - 1, Math.ceil(y + rad)); yy++) for (let xx = Math.max(0, Math.floor(x - rad)); xx <= Math.min(W - 1, Math.ceil(x + rad)); xx++)
            if ((xx - x) ** 2 + (yy - y) ** 2 <= rad * rad) { hard[yy * W + xx] = v; if (st.fg) seeds[yy * W + xx] = 1; }
        }
      }
    }
  }
  // always re-solved from the box (warm-starting from the previous labels measured worse: IoU 0.76 vs 0.86 on the
  // real-photo test), so each refine stroke costs one full solve (~1 s on a 1.6 MP photo in node)
  // v1.8 edge-aware strokes: a stroke also pulls the region it was painted on (geodesic distance in colour, so the
  // pull stops at edges) towards its label, as an extra data cost in the graph cut
  let prior = null;
  if (hard && strokeWeight > 0) {
    const N = W * H, fgS = new Uint8Array(N), bgS = new Uint8Array(N); let nf = 0, nb = 0;
    for (let p = 0; p < N; p++) { if (hard[p] === 1) { fgS[p] = 1; nf++; } else if (hard[p] === 2) { bgS[p] = 1; nb++; } }
    // background seeds also include everything outside the box
    const rx0 = Math.floor(r.x), ry0 = Math.floor(r.y), rx1 = Math.ceil(r.x + r.w), ry1 = Math.ceil(r.y + r.h);
    const bgAll = new Uint8Array(bgS); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < rx0 || y < ry0 || x >= rx1 || y >= ry1) bgAll[y * W + x] = 1;
    const Df = nf ? geodesicDistance(small, fgS) : null, Db = geodesicDistance(small, bgAll), Dbs = nb ? geodesicDistance(small, bgS) : null;
    prior = { fg: new Float32Array(N), bg: new Float32Array(N) };
    for (let p = 0; p < N; p++) {
      if (Df && Df[p] < Db[p]) prior.fg[p] = strokeWeight * (Db[p] - Df[p]) / (Db[p] + Df[p] + 1e-6);
      // a background stroke only claims what it is geodesically near (it competes with the box edge, not the subject)
      if (Dbs && (!Df || Dbs[p] < Df[p])) prior.bg[p] = strokeWeight * Math.exp(-Dbs[p] / bgReach);
    }
  }
  let { mask } = grabCut(small, r, { hard, iterations: 5, prior });
  mask = cleanMask(mask, W, H, { seeds });
  if (hard) for (let p = 0; p < W * H; p++) { if (hard[p] === 1) mask[p] = 1; else if (hard[p] === 2) mask[p] = 0; }
  // refine at up to refineSide: upsample the hard mask, then a guided filter against the image's luminance
  const rs = Math.min(1, refineSide / Math.max(cw, ch)), RW = Math.max(1, Math.round(cw * rs)), RH = Math.max(1, Math.round(ch * rs));
  const mid = rs < 1 ? downscaleRGBA(crop, refineSide) : crop;
  const P = new Float32Array(RW * RH), I = new Float32Array(RW * RH), mf = new Float32Array(mask);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) { const i = y * RW + x; P[i] = bil(mf, W, H, (x + 0.5) * W / RW - 0.5, (y + 0.5) * H / RH - 0.5); const o = i * 4; I[i] = (0.299 * mid.data[o] + 0.587 * mid.data[o + 1] + 0.114 * mid.data[o + 2]) / 255; }
  let Q = P;
  if (refine) { const rad = Math.max(2, Math.round(1.2 * RW / W)); Q = guidedFilter(I, P, RW, RH, rad, 1e-3); }
  const alpha = new Uint8Array(img.width * img.height);
  const rxa = Math.max(0, Math.floor(rect.x)), rya = Math.max(0, Math.floor(rect.y)), rxb = Math.min(img.width, Math.ceil(rect.x + rect.w)), ryb = Math.min(img.height, Math.ceil(rect.y + rect.h));
  for (let y = rya; y < ryb; y++) for (let x = rxa; x < rxb; x++) {
    const q = bil(Q, RW, RH, (x - cx0 + 0.5) * RW / cw - 0.5, (y - cy0 + 0.5) * RH / ch - 0.5);
    const a = Math.max(0, Math.min(1, (q - 0.5) * 2.2 + 0.5)); alpha[y * img.width + x] = Math.round(a * 255);
  }
  return { alpha, work: { W, H, cx0, cy0, mask } };
}
export function cropRGBA(img, x0, y0, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

// ------------------------------------------------------------------------------------------------ lines / upright
/**
 * Hough detection of near-vertical (|angle| ≤ maxDeg from vertical) or near-horizontal straight segments.
 * Returns [{ x1, y1, x2, y2, len, angle }] in image pixels (angle in degrees from the axis).
 */
export function detectLines(img, { orient = 'v', maxDeg = 25, minLenFrac = 0.12, maxLines = 30, thrFrac = 0.88 } = {}) {
  const W = img.width, H = img.height, d = img.data, L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H), mag = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const a = L[i - W - 1], b = L[i - W], c = L[i - W + 1], e = L[i - 1], f = L[i + 1], g = L[i + W - 1], h = L[i + W], k = L[i + W + 1];
    gx[i] = (c + 2 * f + k) - (a + 2 * e + g); gy[i] = (g + 2 * h + k) - (a + 2 * b + c); mag[i] = Math.hypot(gx[i], gy[i]);
  }
  // threshold: strong edges only (≥ 24 levels·8 Sobel units and the top 12 % of gradient magnitudes)
  const sorted = Float32Array.from(mag).sort(), thr = Math.max(24 * 4, sorted[Math.floor(sorted.length * Math.min(0.95, Math.max(0.5, thrFrac)))]);
  const vert = orient === 'v', step = 0.25, nT = Math.round((2 * maxDeg) / step) + 1, diag = Math.ceil(Math.hypot(W, H)), nR = 2 * diag + 1;
  const acc = new Float32Array(nT * nR), cosT = new Float32Array(nT), sinT = new Float32Array(nT);
  // line direction at angle a from the axis; normal n = (cos φ, sin φ). For verticals the normal is ≈ x-axis.
  for (let t = 0; t < nT; t++) { const a = (-maxDeg + t * step) * Math.PI / 180, phi = vert ? a : Math.PI / 2 + a; cosT[t] = Math.cos(phi); sinT[t] = Math.sin(phi); }
  const edges = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (mag[i] < thr) continue;
    // gradient must be roughly along the normal (the edge runs along the line)
    const ga = Math.atan2(gy[i], gx[i]) * 180 / Math.PI; let dev = vert ? Math.abs(((ga % 180) + 180) % 180) : Math.abs((((ga - 90) % 180) + 180) % 180); if (dev > 90) dev = 180 - dev;
    if (dev > maxDeg + 3) continue;
    edges.push(i);
    for (let t = 0; t < nT; t++) { const r = Math.round(x * cosT[t] + y * sinT[t]) + diag; acc[t * nR + r] += 1; }
  }
  const minLen = minLenFrac * (vert ? H : W), lines = [];
  const used = new Uint8Array(nT * nR);
  // candidate peaks, strongest first
  const cand = []; for (let j = 0; j < acc.length; j++) if (acc[j] >= minLen * 0.5) cand.push(j);
  cand.sort((a, b) => acc[b] - acc[a]);
  const onMask = new Uint8Array(W * H); for (const i of edges) onMask[i] = 1;
  for (const j of cand) {
    if (lines.length >= maxLines) break; if (used[j]) continue;
    const t = (j / nR) | 0, r = (j % nR) - diag, c = cosT[t], s = sinT[t];
    // walk along the line, find the longest run of edge support (gaps ≤ 4 px allowed, ±1 px tolerance)
    let best = null, runStart = -1, last = -1, gap = 0;
    const N = vert ? H : W;
    for (let u = 0; u < N; u++) {
      let x, y; if (vert) { y = u; x = (r - y * s) / c; } else { x = u; y = (r - x * c) / s; }
      const xi = Math.round(x), yi = Math.round(y); let hit = false;
      for (let dd = -1; dd <= 1 && !hit; dd++) { const X = vert ? xi + dd : xi, Y = vert ? yi : yi + dd; if (X >= 0 && Y >= 0 && X < W && Y < H && onMask[Y * W + X]) hit = true; }
      if (hit) { if (runStart < 0) runStart = u; last = u; gap = 0; }
      else if (runStart >= 0 && ++gap > 4) { if (!best || last - runStart > best[1] - best[0]) best = [runStart, last]; runStart = -1; gap = 0; }
    }
    if (runStart >= 0 && (!best || last - runStart > best[1] - best[0])) best = [runStart, last];
    if (!best || best[1] - best[0] < minLen) { used[j] = 1; continue; }
    const pt = (u) => vert ? [(r - u * s) / c, u] : [u, (r - u * c) / s];
    // sub-pixel refinement: least-squares line through the edge pixels within ±2 px of the Hough line, weighted by
    // gradient strength (the Hough grid alone is 0.25° × 1 px, too coarse for a vanishing point on a small preview)
    let sw = 0, su = 0, sv = 0, suu = 0, suv = 0;
    for (let u = best[0]; u <= best[1]; u++) {
      const [px, py] = pt(u);
      for (let dd = -2; dd <= 2; dd++) {
        const X = vert ? Math.round(px) + dd : Math.round(px), Y = vert ? Math.round(py) : Math.round(py) + dd;
        if (X < 0 || Y < 0 || X >= W || Y >= H || !onMask[Y * W + X]) continue;
        const w = mag[Y * W + X], uu = vert ? Y : X, vv = vert ? X : Y; sw += w; su += w * uu; sv += w * vv; suu += w * uu * uu; suv += w * uu * vv;
      }
    }
    let x1, y1, x2, y2; const den = sw * suu - su * su;
    if (sw > 0 && Math.abs(den) > 1e-9) {
      const a = (sw * suv - su * sv) / den, b = (sv - a * su) / sw, at = (u) => (vert ? [a * u + b, u] : [u, a * u + b]);
      [x1, y1] = at(best[0]); [x2, y2] = at(best[1]);
    } else { [x1, y1] = pt(best[0]); [x2, y2] = pt(best[1]); }
    const ang = vert ? Math.atan2(x2 - x1, y2 - y1) * 180 / Math.PI : Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    lines.push({ x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1), angle: ang });
    // consume its edge pixels (progressive Hough): later peaks cannot re-use them as a slightly different line
    for (let u = best[0]; u <= best[1]; u++) {
      const f = (best[1] > best[0]) ? (u - best[0]) / (best[1] - best[0]) : 0, px = x1 + (x2 - x1) * f, py = y1 + (y2 - y1) * f;
      for (let dd = -3; dd <= 3; dd++) { const X = vert ? Math.round(px) + dd : Math.round(px), Y = vert ? Math.round(py) : Math.round(py) + dd; if (X >= 0 && Y >= 0 && X < W && Y < H) onMask[Y * W + X] = 0; }
    }
    // suppress neighbours in (θ, ρ)
    for (let dt = -8; dt <= 8; dt++) for (let dr = -6; dr <= 6; dr++) { const tt = t + dt, rr = r + dr + diag; if (tt >= 0 && tt < nT && rr >= 0 && rr < nR) used[tt * nR + rr] = 1; }
  }
  return lines;
}
/**
 * v1.10: re-fit detected segments on a sharper copy of the image (`img`, `s` × the size the lines were found at).
 * Each row (verticals) or column (horizontals) of the segment gets the sub-pixel position of the strongest gradient
 * across it within ±(1.5·s + 2) px, keeping one edge polarity; a weighted least-squares line through those positions
 * (two passes, dropping points > 1.5 px off) replaces the segment. Returned in the original (small) coordinates, so
 * the vanishing-point fit is the same; only the line positions are better. Segments that cannot be re-fit are kept.
 */
export function refineLines(lines, img, s, orient = 'v') {
  if (!lines.length || !(s > 1.05)) return lines;
  const W = img.width, H = img.height, d = img.data, vert = orient === 'v';
  const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
  const hw = Math.ceil(1.5 * s) + 2;
  return lines.map((l) => {
    const x1 = l.x1 * s, y1 = l.y1 * s, x2 = l.x2 * s, y2 = l.y2 * s;
    const u0 = Math.ceil(Math.min(vert ? y1 : x1, vert ? y2 : x2)) + 1, u1 = Math.floor(Math.max(vert ? y1 : x1, vert ? y2 : x2)) - 1;
    const N = vert ? H : W, M = vert ? W : H; if (u1 - u0 < 8) return l;
    const at = (u) => { const t = ((vert ? u - y1 : u - x1)) / ((vert ? y2 - y1 : x2 - x1) || 1); return vert ? x1 + (x2 - x1) * t : y1 + (y2 - y1) * t; };
    const pts = [];
    for (let u = u0; u <= u1; u++) {
      if (u < 1 || u >= N - 1) continue;
      const c = Math.round(at(u)); let best = 0, bv = 0, bs = 0;
      const g = (v) => { // gradient across the line at (u, v), averaged over 3 rows along it
        if (v < 1 || v >= M - 1) return 0; let q = 0;
        for (let k = -1; k <= 1; k++) { const uu = Math.min(N - 1, Math.max(0, u + k)); q += vert ? lum(v + 1, uu) - lum(v - 1, uu) : lum(uu, v + 1) - lum(uu, v - 1); }
        return q;
      };
      const gs = []; for (let v = c - hw - 1; v <= c + hw + 1; v++) gs.push(g(v));
      for (let j = 1; j < gs.length - 1; j++) { const a = Math.abs(gs[j]); if (a > best && a >= Math.abs(gs[j - 1]) && a >= Math.abs(gs[j + 1])) { best = a; bv = j; bs = Math.sign(gs[j]); } }
      if (best < 24) continue;
      const am = Math.abs(gs[bv - 1]), a0 = best, ap = Math.abs(gs[bv + 1]), den = am - 2 * a0 + ap, off = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (am - ap) / den)) : 0;
      pts.push([u, c - hw - 1 + bv + off, best, bs]);
    }
    if (pts.length < 0.5 * (u1 - u0 + 1)) return l;
    const pol = Math.sign(pts.reduce((q, p) => q + p[3] * p[2], 0)); let P = pts.filter((p) => p[3] === pol);
    let fit = null;
    for (let pass = 0; pass < 2; pass++) {
      let sw = 0, su = 0, sv = 0, suu = 0, suv = 0; for (const [u, v, w] of P) { sw += w; su += w * u; sv += w * v; suu += w * u * u; suv += w * u * v; }
      const den = sw * suu - su * su; if (!(sw > 0) || Math.abs(den) < 1e-9) return l;
      const a = (sw * suv - su * sv) / den; fit = [a, (sv - a * su) / sw];
      if (pass === 0) { const Q = P.filter(([u, v]) => Math.abs(v - (fit[0] * u + fit[1])) <= 1.5); if (Q.length < 0.4 * (u1 - u0 + 1)) return l; P = Q; }
    }
    const ua = P[0][0], ub = P[P.length - 1][0], pt = (u) => vert ? [(fit[0] * u + fit[1]) / s, u / s] : [u / s, (fit[0] * u + fit[1]) / s];
    const [X1, Y1] = pt(ua), [X2, Y2] = pt(ub);
    // a re-fit that turns the segment by more than 1° found a different edge: keep the original
    const ang = vert ? Math.atan2(X2 - X1, Y2 - Y1) * 180 / Math.PI : Math.atan2(Y2 - Y1, X2 - X1) * 180 / Math.PI;
    if (Math.abs(ang - l.angle) > 1) return l;
    return { ...l, x1: X1, y1: Y1, x2: X2, y2: Y2, len: Math.hypot(X2 - X1, Y2 - Y1), angle: ang, refined: true };
  });
}
/**
 * Radial (barrel/pincushion) model used by Upright: r = 1 at the half-diagonal, output = centre + (p−centre)·(1+k·r²).
 * Negative k pulls mid-edge points inward (straightens barrel); positive k straightens pincushion. Matches the sign of
 * the RAW develop "Distortion" slider after scaling (see raw.DISTORTION_K).
 */
export function undistortPoint(x, y, cx, cy, k, rNorm2) {
  if (!k) return [x, y];
  const dx = x - cx, dy = y - cy, r2 = (dx * dx + dy * dy) / rNorm2;
  const s = 1 + k * r2; return [cx + dx * s, cy + dy * s];
}
/** Map a list of segments through the radial model (endpoints only; good enough for the VP fit). */
export function undistortLines(lines, W, H, k) {
  if (!k || !lines.length) return lines;
  const cx = W / 2, cy = H / 2, rNorm2 = cx * cx + cy * cy;
  return lines.map((l) => {
    const [x1, y1] = undistortPoint(l.x1, l.y1, cx, cy, k, rNorm2);
    const [x2, y2] = undistortPoint(l.x2, l.y2, cx, cy, k, rNorm2);
    const ang = Math.abs(x2 - x1) >= Math.abs(y2 - y1)
      ? Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI
      : Math.atan2(x2 - x1, y2 - y1) * 180 / Math.PI;
    return { ...l, x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1), angle: ang };
  });
}
/**
 * Estimate a single radial term from long near-horizontal edges.
 * A straight world line stays straight under perspective, so a left/right half-angle gap on one edge is
 * lens bend. We sample the ridge, then pick the k ∈ [−0.4, 0.4] that minimises the mean |left−right|
 * half-angle across those edges (and does not raise the mid-line RMS). Returns 0 when nothing clear.
 */
export function estimateRadial(lines, img) {
  const W = img.width, H = img.height, d = img.data;
  const long = (lines || []).filter((l) => l.len >= 0.18 * Math.max(W, H) && Math.abs(l.x2 - l.x1) >= Math.abs(l.y2 - l.y1));
  if (long.length < 1) return 0;
  const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
  const cx = W / 2, cy = H / 2, rNorm2 = cx * cx + cy * cy;
  const samples = [];
  for (const l of long) {
    const pts = [];
    for (let t = 0.04; t <= 0.961; t += 0.04) {
      const x0 = l.x1 + (l.x2 - l.x1) * t, y0 = l.y1 + (l.y2 - l.y1) * t;
      let best = 0, bv = 0; const c = Math.round(y0), u = Math.round(x0);
      if (u < 2 || u >= W - 2) continue;
      for (let v = c - 5; v <= c + 5; v++) {
        if (v < 1 || v >= H - 1) continue;
        const g = Math.abs(lum(u, v + 1) - lum(u, v - 1));
        if (g > best) { best = g; bv = v; }
      }
      if (best < 16) continue;
      pts.push([u, bv]);
    }
    if (pts.length >= 10) samples.push(pts);
  }
  if (!samples.length) return 0;
  const und = (x, y, k) => { const dx = x - cx, dy = y - cy, s = 1 + k * ((dx * dx + dy * dy) / rNorm2); return [cx + dx * s, cy + dy * s]; };
  const halfGap = (pts, k) => {
    const U = pts.map(([x, y]) => und(x, y, k));
    const mid = U.length >> 1;
    const ang = (a, b) => {
      const xs = U.slice(a, b); if (xs.length < 4) return null;
      const mx = xs.reduce((q, p) => q + p[0], 0) / xs.length, my = xs.reduce((q, p) => q + p[1], 0) / xs.length;
      let sxy = 0, sxx = 0; for (const p of xs) { sxy += (p[0] - mx) * (p[1] - my); sxx += (p[0] - mx) * (p[0] - mx); }
      if (sxx < 1) return null; return Math.atan(sxy / sxx) * 180 / Math.PI;
    };
    const L = ang(0, mid), R = ang(mid, U.length); if (L == null || R == null) return null;
    return Math.abs(L - R);
  };
  const score = (k) => {
    let s = 0, n = 0; for (const pts of samples) { const g = halfGap(pts, k); if (g == null) continue; s += g; n++; }
    return n ? s / n : Infinity;
  };
  const base = score(0);
  if (!(base > 0.3)) return 0; // already consistent halves — nothing for radial to fix
  let bestK = 0, best = base;
  for (let ki = -40; ki <= 40; ki++) {
    const k = ki / 100, e = score(k);
    if (e < best - 1e-4) { best = e; bestK = k; }
  }
  if (!(base - best > 0.15) || Math.abs(bestK) < 0.04) return 0;
  return bestK;
}



/**
 * Fit a vanishing point to near-vertical segments (RANSAC over pairs, weighted by length, then least squares).
 * Returns { mode: 'none' | 'rotate' | 'keystone', angle (deg, for 'rotate'), vp: [x, y] (for 'keystone'), inliers, lines }.
 */

/**
 * Sample the edge ridge along a chord (layer-pixel coords). Walks the segment and picks the strongest
 * perpendicular gradient peak within ±win px — same idea as estimateRadial's horizon sampling, but works
 * for verticals too. Returns ≥10 points or [].
 */
export function sampleRidgeAlong(img, x1, y1, x2, y2, { win = 5, step = 0.04, minGrad = 12 } = {}) {
  const W = img.width, H = img.height, d = img.data;
  const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
  const vert = Math.abs(y2 - y1) >= Math.abs(x2 - x1);
  const pts = [];
  for (let t = 0.02; t <= 0.981; t += step) {
    const x0 = x1 + (x2 - x1) * t, y0 = y1 + (y2 - y1) * t;
    let best = 0, bx = Math.round(x0), by = Math.round(y0);
    if (vert) {
      const c = Math.round(x0), v = Math.round(y0);
      if (v < 1 || v >= H - 1) continue;
      for (let u = c - win; u <= c + win; u++) {
        if (u < 1 || u >= W - 1) continue;
        const g = Math.abs(lum(u + 1, v) - lum(u - 1, v));
        if (g > best) { best = g; bx = u; by = v; }
      }
    } else {
      const c = Math.round(y0), u = Math.round(x0);
      if (u < 1 || u >= W - 1) continue;
      for (let v = c - win; v <= c + win; v++) {
        if (v < 1 || v >= H - 1) continue;
        const g = Math.abs(lum(u, v + 1) - lum(u, v - 1));
        if (g > best) { best = g; bx = u; by = v; }
      }
    }
    if (best < minGrad) continue;
    pts.push([bx, by]);
  }
  return pts.length >= 10 ? pts : [];
}

/**
 * Solve a single radial term from 1–3 user plumb polylines (each an array of [x,y] ridge samples in the
 * same pixel space as `W`×`H`). Minimises mean |left−right| half-angle across the plumbs (and does not
 * raise mid-line RMS). Same k convention as undistortPoint / estimateRadial. Returns 0 when unclear.
 */
export function solveRadialFromPlumb(polylines, W, H) {
  const samples = (polylines || []).filter((p) => p && p.length >= 10);
  if (!samples.length) return 0;
  const cx = W / 2, cy = H / 2, rNorm2 = cx * cx + cy * cy;
  const und = (x, y, k) => { const dx = x - cx, dy = y - cy, s = 1 + k * ((dx * dx + dy * dy) / rNorm2); return [cx + dx * s, cy + dy * s]; };
  const halfGap = (pts, k) => {
    const U = pts.map(([x, y]) => und(x, y, k));
    const mid = U.length >> 1;
    const ang = (a, b) => {
      const xs = U.slice(a, b); if (xs.length < 4) return null;
      const mx = xs.reduce((q, p) => q + p[0], 0) / xs.length, my = xs.reduce((q, p) => q + p[1], 0) / xs.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (const p of xs) { sxy += (p[0] - mx) * (p[1] - my); sxx += (p[0] - mx) ** 2; syy += (p[1] - my) ** 2; }
      // prefer the dominant axis so vertical plumbs work too
      if (sxx >= syy) { if (sxx < 1) return null; return Math.atan(sxy / sxx) * 180 / Math.PI; }
      if (syy < 1) return null; return Math.atan(sxy / syy) * 180 / Math.PI;
    };
    const L = ang(0, mid), R = ang(mid, U.length); if (L == null || R == null) return null;
    return Math.abs(L - R);
  };
  const score = (k) => {
    let s = 0, n = 0; for (const pts of samples) { const g = halfGap(pts, k); if (g == null) continue; s += g; n++; }
    return n ? s / n : Infinity;
  };
  const base = score(0);
  if (!(base > 0.15)) return 0;
  let bestK = 0, best = base;
  const scores = [[0, base]];
  for (let ki = -50; ki <= 50; ki++) {
    if (!ki) continue;
    const k = ki / 100, e = score(k);
    scores.push([k, e]);
    if (e < best - 1e-4) { best = e; bestK = k; }
  }
  if (!(base - best > 0.12) || Math.abs(bestK) < 0.02) return 0;
  // Prefer the mildest |k| within 15% of the best half-gap improvement (avoids over-bend that hurts Full).
  const target = best + (base - best) * 0.15;
  let mild = bestK;
  for (const [k, e] of scores) {
    if (e <= target && Math.abs(k) < Math.abs(mild)) mild = k;
  }
  bestK = mild;
  if (Math.abs(bestK) > 0.15) bestK = Math.sign(bestK) * 0.15;
  if (Math.abs(bestK) < 0.02) return 0;
  return bestK;
}

export function estimateUpright(lines, W, H, { tolDeg = 1.2 } = {}) {
  if (lines.length < 2) return { mode: 'none', inliers: [], lines };
  const hom = (l) => { const a = [l.x1, l.y1, 1], b = [l.x2, l.y2, 1]; return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
  const angErr = (l, v) => { // angle between the segment and the direction from its midpoint to v (homogeneous)
    const mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2; let dx, dy;
    if (Math.abs(v[2]) < 1e-9) { dx = v[0]; dy = v[1]; } else { dx = v[0] / v[2] - mx; dy = v[1] / v[2] - my; }
    const sx = l.x2 - l.x1, sy = l.y2 - l.y1, c = Math.abs(dx * sx + dy * sy) / (Math.hypot(dx, dy) * Math.hypot(sx, sy) || 1);
    return Math.acos(Math.min(1, c)) * 180 / Math.PI;
  };
  // v1.11: a line votes with its length capped at 0.4 of the frame's long side, so the one or two long edges of a single
  // leaning object (a library ladder, a lamp post) cannot outvote many shorter edges of the building. Lines shorter
  // than the cap vote exactly as before (jobs 16/17/22/26 unchanged).
  const cap = 0.4 * Math.max(W, H), wt = (l) => Math.min(l.len, cap);
  let best = null;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = hom(lines[i]), b = hom(lines[j]);
    let v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const n = Math.hypot(...v); if (!n) continue; v = v.map((t) => t / n);
    // a vanishing point between the lines' ends inside the frame is not a vertical
    if (Math.abs(v[2]) > 1e-9) { const y = v[1] / v[2], x = v[0] / v[2]; if (y > -0.05 * H && y < 1.05 * H && x > -0.05 * W && x < 1.05 * W) continue; }
    let score = 0; const inl = [];
    lines.forEach((l, k) => { if (angErr(l, v) <= tolDeg) { score += wt(l); inl.push(k); } });
    if (!best || score > best.score) best = { score, v, inl };
  }
  if (!best || best.inl.length < 2) return { mode: 'none', inliers: [], lines };
  // least-squares refinement: v = smallest eigenvector of Σ w l lᵀ (normalised lines)
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const k of best.inl) { const l = hom(lines[k]), n = Math.hypot(l[0], l[1]), w = wt(lines[k]), u = l.map((t) => t / n); for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a * 3 + b] += w * u[a] * u[b]; }
  let v = smallestEigvec3(M); if (v[1] < 0 || (v[1] === 0 && v[0] < 0)) v = v.map((t) => -t);
  const inl = best.inl.filter((k) => angErr(lines[k], v) <= tolDeg * 1.5);
  // distance of the VP from the image centre, in image heights; very far = parallel lines = just a tilt
  const far = Math.abs(v[2]) < 1e-12 ? Infinity : Math.hypot(v[0] / v[2] - W / 2, v[1] / v[2] - H / 2) / H;
  const meanAng = inl.reduce((s, k) => s + lines[k].angle * lines[k].len, 0) / inl.reduce((s, k) => s + lines[k].len, 0);
  if (far > 40) return { mode: Math.abs(meanAng) < 0.05 ? 'none' : 'rotate', angle: meanAng, vh: v, inliers: inl, lines };
  return { mode: 'keystone', vp: Math.abs(v[2]) < 1e-12 ? null : [v[0] / v[2], v[1] / v[2]], vh: v, far, angle: meanAng, inliers: inl, lines };
}
/**
 * Full upright (v1.9): one homography that sends the vertical vanishing point `vv` to the vertical direction at infinity
 * and the horizontal one `vh` to the horizontal direction at infinity (both homogeneous [x, y, w]; null = leave that
 * family alone). Row 3 is the line through both points (it becomes the line at infinity); rows 1 and 2 are the closest
 * rows to the identity that satisfy r1·vv = 0, r2·vh = 0 and keep the centre (cx, cy) where it is.
 * Returns [h0..h8] row-major (same layout as mesh.homography) or null.
 */
export function uprightHomography(vv, vh, cx, cy) {
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const V = vv || [0, 1, 0], Hh = vh || [1, 0, 0];
  let r3 = cross(V, Hh); const c3 = r3[0] * cx + r3[1] * cy + r3[2];
  if (!Number.isFinite(c3) || Math.abs(c3) < 1e-12 * Math.hypot(...r3)) return null;
  r3 = r3.map((t) => t / c3);
  // keep only a modest projective part: |r3·(x, y)| stays < 1 over the frame (checked by the caller via the corners)
  const row = (v, want, target, cc) => { // closest (a, b) to `want` with a·px + b·py = q, c = cc − a·cx − b·cy
    const px = v[0] - cx * v[2], py = v[1] - cy * v[2], q = -cc * v[2], n = px * px + py * py;
    if (n < 1e-18) return null;
    const t = (q - (px * want[0] + py * want[1])) / n, a = want[0] + t * px, b = want[1] + t * py;
    return [a, b, cc - a * cx - b * cy];
  };
  // H·c must equal (cx, cy, 1): r1·c = cx, r2·c = cy (r3·c = 1)
  const r1 = vv ? row(V, [1, 0], 0, cx) : [1, 0, 0], r2 = vh ? row(Hh, [0, 1], 0, cy) : [0, 1, 0];
  if (!r1 || !r2) return null;
  const H = [...r1, ...r2, ...r3];
  return H.every(Number.isFinite) ? H : null;
}
/** Direction (degrees, from the axis) a family of lines with vanishing point `v` (homogeneous) has at (cx, cy). */
export function directionAt(v, cx, cy, orient = 'v') {
  let dx, dy; if (Math.abs(v[2]) < 1e-12) { dx = v[0]; dy = v[1]; } else { dx = v[0] / v[2] - cx; dy = v[1] / v[2] - cy; }
  let a = orient === 'v' ? Math.atan2(dx, dy) * 180 / Math.PI : Math.atan2(dy, dx) * 180 / Math.PI;
  while (a > 90) a -= 180; while (a <= -90) a += 180; return a;
}
function smallestEigvec3(M) {
  // inverse iteration on a 3×3 symmetric PSD matrix
  let v = [0.3, 0.5, 0.8]; const A = M.slice(); const tr = A[0] + A[4] + A[8]; const mu = -1e-9 * (tr || 1);
  A[0] -= mu; A[4] -= mu; A[8] -= mu;
  for (let it = 0; it < 60; it++) { const x = solve3(A, v); const n = Math.hypot(...x); if (!n || !isFinite(n)) break; v = x.map((t) => t / n); }
  return v;
}
function solve3(A, b) {
  const [a, bb, c, d, e, f, g, h, i] = A, det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (!det) return [0, 0, 1];
  return [((e * i - f * h) * b[0] - (bb * i - c * h) * b[1] + (bb * f - c * e) * b[2]) / det,
    (-(d * i - f * g) * b[0] + (a * i - c * g) * b[1] - (a * f - c * d) * b[2]) / det,
    ((d * h - e * g) * b[0] - (a * h - bb * g) * b[1] + (a * e - bb * d) * b[2]) / det];
}
/** Two guides (image pixels) that encode the vanishing point, for the Guided upright solver. */
export function guidesFromVP(vp, W, H) {
  const ys = [0.85 * H, 0.15 * H];
  const at = (x0) => { // the line from (x0, 0.85H) towards vp, sampled at 0.15H
    const [vx, vy] = vp, t = (ys[1] - ys[0]) / (vy - ys[0]); return [[x0, ys[0]], [x0 + (vx - x0) * t, ys[1]]];
  };
  return [at(0.25 * W), at(0.75 * W)];
}

// ------------------------------------------------------------------------------------------------ crop / fill
/**
 * Largest axis-aligned rectangle of opaque pixels. alpha: Uint8Array/Clamped (W*H), opaque = alpha ≥ thr.
 * ratio (w/h) optional. Returns { x, y, w, h } or null.
 */
export function largestInnerRect(alpha, W, H, { ratio = null, thr = 250 } = {}) {
  const ok = new Uint8Array(W * H); let any = 0; for (let i = 0; i < W * H; i++) if (alpha[i] >= thr) { ok[i] = 1; any = 1; }
  if (!any) return null;
  if (!ratio) {
    const hgt = new Int32Array(W); let best = { a: 0 };
    const st = new Int32Array(W + 1);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) hgt[x] = ok[y * W + x] ? hgt[x] + 1 : 0;
      let sp = 0;
      for (let x = 0; x <= W; x++) {
        const h = x < W ? hgt[x] : 0;
        while (sp && hgt[st[sp - 1]] >= h) { const top = st[--sp], hh = hgt[top], left = sp ? st[sp - 1] + 1 : 0, w = x - left; if (hh * w > best.a) best = { a: hh * w, x: left, y: y - hh + 1, w, h: hh }; }
        st[sp++] = x;
      }
    }
    return best.a ? { x: best.x, y: best.y, w: best.w, h: best.h } : null;
  }
  // fixed ratio: binary search on the height using a summed-area table of "not ok"
  const S = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += ok[y * W + x] ? 0 : 1; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
  const bad = (x, y, w, h) => S[(y + h) * (W + 1) + x + w] - S[y * (W + 1) + x + w] - S[(y + h) * (W + 1) + x] + S[y * (W + 1) + x];
  const fits = (h) => { const w = Math.round(h * ratio); if (w < 1 || w > W || h > H) return null;
    // prefer the position closest to the centre
    let bestP = null, bd = Infinity;
    for (let y = 0; y + h <= H; y++) for (let x = 0; x + w <= W; x++) if (!bad(x, y, w, h)) { const dd = (x + w / 2 - W / 2) ** 2 + (y + h / 2 - H / 2) ** 2; if (dd < bd) { bd = dd; bestP = { x, y, w, h }; } }
    return bestP; };
  let lo = 1, hi = Math.min(H, Math.floor(W / ratio)), res = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1, f = fits(mid); if (f) { res = f; lo = mid + 1; } else hi = mid - 1; }
  return res;
}
/** Fill pixels with alpha < 255 from their opaque surroundings (push-pull pyramid). Mutates and returns img. */
/**
 * Fill transparent pixels by mirroring the nearest opaque pixel across the gap boundary (v1.13).
 * Preserves grain/texture far better than a pure push-pull smear on edges after an upright crop-fill.
 * Falls back to leaving a pixel alone when no opaque source exists.
 */
export function edgeCloneFill(img, { max = 255 } = {}) {
  const W = img.width, H = img.height, d = img.data, N = W * H;
  const dist = new Int32Array(N).fill(-1), src = new Int32Array(N).fill(-1), q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (d[i * 4 + 3] >= max * 0.98) { dist[i] = 0; src[i] = i; q[qt++] = i; }
  const step = [1, -1, W, -W];
  while (qh < qt) {
    const p = q[qh++], x = p % W, y = (p / W) | 0;
    for (let s = 0; s < 4; s++) {
      const n = p + step[s];
      if (s < 2) { const nx = x + (s === 0 ? 1 : -1); if (nx < 0 || nx >= W) continue; }
      else { const ny = y + (s === 2 ? 1 : -1); if (ny < 0 || ny >= H) continue; }
      if (dist[n] >= 0) continue;
      dist[n] = dist[p] + 1; src[n] = src[p]; q[qt++] = n;
    }
  }
  for (let i = 0; i < N; i++) {
    if (d[i * 4 + 3] === max) continue;
    const s = src[i]; if (s < 0) continue;
    const sx = s % W, sy = (s / W) | 0, x = i % W, y = (i / W) | 0;
    // mirror across the opaque boundary so structure continues into the gap
    let mx = sx - (x - sx), my = sy - (y - sy);
    if (mx < 0) mx = 0; else if (mx >= W) mx = W - 1;
    if (my < 0) my = 0; else if (my >= H) my = H - 1;
    let take = my * W + mx;
    if (d[take * 4 + 3] < max * 0.98) take = s;
    d[i * 4] = d[take * 4]; d[i * 4 + 1] = d[take * 4 + 1]; d[i * 4 + 2] = d[take * 4 + 2]; d[i * 4 + 3] = max;
  }
  return img;
}
export function pushPullFill(img, { max = 255 } = {}) {
  const W = img.width, H = img.height, d = img.data, M = max, round = max !== 255 || !(d instanceof Uint8ClampedArray);
  const levels = []; let cur = { W, H, c: new Float32Array(W * H * 4) };
  for (let i = 0; i < W * H; i++) { const a = d[i * 4 + 3] / M; cur.c[i * 4] = d[i * 4] * a; cur.c[i * 4 + 1] = d[i * 4 + 1] * a; cur.c[i * 4 + 2] = d[i * 4 + 2] * a; cur.c[i * 4 + 3] = a; }
  levels.push(cur);
  while (cur.W > 1 || cur.H > 1) { // pull: premultiplied 2×2 averages
    const w = Math.max(1, Math.ceil(cur.W / 2)), h = Math.max(1, Math.ceil(cur.H / 2)), c = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = 2 * y; yy < Math.min(cur.H, 2 * y + 2); yy++) for (let xx = 2 * x; xx < Math.min(cur.W, 2 * x + 2); xx++) { const i = (yy * cur.W + xx) * 4; r += cur.c[i]; g += cur.c[i + 1]; b += cur.c[i + 2]; a += cur.c[i + 3]; }
      const k = a > 1 ? 1 / a : 1, o = (y * w + x) * 4; c[o] = r * k; c[o + 1] = g * k; c[o + 2] = b * k; c[o + 3] = Math.min(1, a);
    }
    cur = { W: w, H: h, c }; levels.push(cur);
  }
  for (let l = levels.length - 2; l >= 0; l--) { // push: fill the missing coverage from the coarser level (bilinear)
    const f = levels[l], g = levels[l + 1];
    for (let y = 0; y < f.H; y++) for (let x = 0; x < f.W; x++) {
      const o = (y * f.W + x) * 4, a = f.c[o + 3]; if (a >= 1) continue;
      const gx = (x + 0.5) / 2 - 0.5, gy = (y + 0.5) / 2 - 0.5, x0 = Math.max(0, Math.floor(gx)), y0 = Math.max(0, Math.floor(gy)), x1 = Math.min(g.W - 1, x0 + 1), y1 = Math.min(g.H - 1, y0 + 1), fx = Math.min(1, Math.max(0, gx - x0)), fy = Math.min(1, Math.max(0, gy - y0));
      for (let ch = 0; ch < 4; ch++) {
        const v = (g.c[(y0 * g.W + x0) * 4 + ch] * (1 - fx) + g.c[(y0 * g.W + x1) * 4 + ch] * fx) * (1 - fy) + (g.c[(y1 * g.W + x0) * 4 + ch] * (1 - fx) + g.c[(y1 * g.W + x1) * 4 + ch] * fx) * fy;
        f.c[o + ch] += (1 - a) * v;
      }
    }
  }
  const top = levels[0].c;
  for (let i = 0; i < W * H; i++) {
    if (d[i * 4 + 3] === M) continue; const a = top[i * 4 + 3] || 1;
    if (round) for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = Math.min(M, Math.max(0, Math.round(top[i * 4 + ch] / a)));
    else { d[i * 4] = top[i * 4] / a; d[i * 4 + 1] = top[i * 4 + 1] / a; d[i * 4 + 2] = top[i * 4 + 2] / a; }
    d[i * 4 + 3] = M;
  }
  return img;
}
