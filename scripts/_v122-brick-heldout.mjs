/** Brick honesty: detect lines, plumb A vs B, measure held-out (not in plumb A). */
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const HERE = '/workspace/photo-editor';
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(HERE, 'scripts/serve.mjs')).href);
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://127.0.0.1:${server.address().port}/?platform=win`);
await page.waitForFunction(() => window.tintwork); await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg);
const open = async () => {
  await page.setInputFiles('#fileInput', { name: 'brick.jpg', mimeType: 'image/jpeg', buffer: REAL('brick.jpg') });
  await page.waitForFunction(() => window.tintwork.doc?.name?.startsWith('brick'), null, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};
const plumbA = [[[114, 40], [130, 980]], [[920, 50], [900, 970]]];

const measure = async (seeds) => page.evaluate(async ({ seeds }) => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
  const angs = seeds.map(([[x1, y1], [x2, y2]]) => {
    const xs = [], ys = []; const horiz = Math.abs(x2 - x1) > Math.abs(y2 - y1); const win = 5;
    if (horiz) {
      for (let x = Math.ceil(Math.min(x1, x2)); x < Math.max(x1, x2); x++) {
        if (x < 0 || x >= W) continue; const yr = y1 + (y2 - y1) * (x - x1) / (x2 - x1), a = Math.round(yr - win), b = Math.round(yr + win); if (a < 1 || b >= H - 1) continue;
        let k = -1, best = 10; for (let y = a; y <= b; y++) { const v = Math.abs(g(x, y + 1) - g(x, y - 1)); if (v > best) { best = v; k = y; } }
        if (k < 0) continue; ys.push(k); xs.push(x);
      }
      if (xs.length < 8) return null; let s = 0, keep = xs.map(() => true);
      for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 8) return null; const mx = idx.reduce((q, i) => q + xs[i], 0) / n, my = idx.reduce((q, i) => q + ys[i], 0) / n; let sxy = 0, sxx = 0; for (const i of idx) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } s = sxy / (sxx || 1); keep = ys.map((y, i) => Math.abs(y - (s * xs[i] + my - s * mx)) < 2); }
      return Math.atan(s) * 180 / Math.PI;
    }
    for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
      if (y < 0 || y >= H) continue; const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win); if (a < 1 || b >= W - 1) continue;
      let k = -1, best = 10; for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); if (v > best) { best = v; k = x; } }
      if (k < 0) continue; xs.push(k); ys.push(y);
    }
    if (xs.length < 8) return null; let s = 0, keep = xs.map(() => true);
    for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 8) return null; const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n; let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; } s = sxy / (syy || 1); keep = xs.map((x, i) => Math.abs(x - (s * ys[i] + mx - s * my)) < 2); }
    return Math.atan(s) * 180 / Math.PI;
  });
  const detail = angs.map((d, i) => ({ i, deg: d, abs: d == null ? null : Math.abs(d) }));
  const v = detail.map((d) => d.abs).filter((d) => d != null);
  return { worst: v.length ? Math.max(...v) : null, n: v.length, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, detail };
}, { seeds });

const mapChain = async (seeds0, kLens) => page.evaluate(({ seeds0, kLens }) => {
  const t = window.tintwork, u = t.lastUpright;
  const W = t.doc?.width || 1000, H = t.doc?.height || 1000;
  const cx = u?.center?.[0] ?? W / 2, cy = u?.center?.[1] ?? H / 2;
  const rNorm2 = u?.rNorm2 ?? (cx * cx + cy * cy);
  const und = (x, y, k) => { if (!k) return [x, y]; const dx = x - cx, dy = y - cy, s = 1 + k * ((dx * dx + dy * dy) / rNorm2); return [cx + dx * s, cy + dy * s]; };
  const Hm = u?.H, c = u?.crop || { x: 0, y: 0 };
  return seeds0.map((seg) => seg.map(([x, y]) => {
    let [a, b] = und(x, y, kLens);
    if (!Hm) return [a - c.x, b - c.y];
    const w = Hm[6] * a + Hm[7] * b + Hm[8];
    return [(Hm[0] * a + Hm[1] * b + Hm[2]) / w - c.x, (Hm[3] * a + Hm[4] * b + Hm[5]) / w - c.y];
  }));
}, { seeds0, kLens });

await open();
await T(() => window.tintwork.run('perspective'));
const detected = await T(() => {
  const x = window.tintwork.mxf, img = x.small, sc = x.k || 1;
  const vl = window.tintwork.segment.detectLines(img, { orient: 'v', maxDeg: 25, minLenFrac: 0.12, maxLines: 16, thrFrac: 0.65 });
  const hl = window.tintwork.segment.detectLines(img, { orient: 'h', maxDeg: 18, minLenFrac: 0.12, maxLines: 16, thrFrac: 0.65 });
  const toDoc = (l) => [[[l.x1 / sc + x.ox, l.y1 / sc + x.oy], [l.x2 / sc + x.ox, l.y2 / sc + x.oy]], l.len];
  return {
    V: vl.map(toDoc).sort((a, b) => b[1] - a[1]).map((r) => r[0]),
    H: hl.map(toDoc).sort((a, b) => b[1] - a[1]).map((r) => r[0]),
  };
});
await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
console.log('detected V', detected.V.length, JSON.stringify(detected.V.slice(0, 6)));
console.log('detected H', detected.H.length, JSON.stringify(detected.H.slice(0, 4)));

// Pick plumb B = 2 longest V that are far from plumbA x-means
function xMean(seg) { return (seg[0][0] + seg[1][0]) / 2; }
const aXs = plumbA.map(xMean);
const farV = detected.V.filter((seg) => aXs.every((ax) => Math.abs(xMean(seg) - ax) > 80));
const plumbB = farV.slice(0, 2);
const heldV = farV.slice(2, 5);
const heldH = detected.H.slice(0, 3);
const heldOut = [...heldV, ...heldH];
console.log('plumbB', JSON.stringify(plumbB));
console.log('heldOut n', heldOut.length, JSON.stringify(heldOut));

async function plumb(guides) {
  await open();
  await T(() => window.tintwork.run('perspective'));
  const r = await T((guides) => {
    const x = window.tintwork.mxf; x.plumbs = guides;
    const k = window.tintwork.solvePlumbOnMxf(x);
    return { k, slider: x.lensSlider, usedFull: x.plumbMeta?.usedFull, refined: x.plumbMeta?.refined?.slider, base0: x.plumbMeta?.refined?.base0, score: x.plumbMeta?.refined?.score };
  }, guides);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
}
async function runPath(slider, sets) {
  await open();
  await T((slider) => { window.tintwork.run('perspective'); const x = window.tintwork.mxf; x.lensSlider = slider; window.tintwork.previewLensOnMxf(x); }, slider);
  const k = await T(() => window.tintwork.mxf.radialK);
  await T(() => window.tintwork.applyLensFromMxf());
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 });
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 });
  const out = {};
  for (const [name, seeds] of Object.entries(sets)) {
    if (!seeds?.length) { out[name] = null; continue; }
    const mapped = await mapChain(seeds, k);
    out[name] = await measure(mapped);
  }
  return { slider, k, mode: await T(() => window.tintwork.lastUpright?.mode), ...out };
}

const pA = await plumb(plumbA);
const pB = plumbB.length >= 2 ? await plumb(plumbB) : { slider: null, err: 'no far V' };
console.log('plumbA', pA);
console.log('plumbB', pB);

const sets = { inSampleA: plumbA, plumbBchords: plumbB, heldOut, heldV, heldH };
const base = await runPath(0, sets);
const afterA = await runPath(pA.slider ?? 20, sets);
const afterB = pB.slider != null ? await runPath(pB.slider, sets) : null;

function brief(r) {
  if (!r) return null;
  const b = {};
  for (const k of ['inSampleA', 'plumbBchords', 'heldOut', 'heldV', 'heldH']) {
    const m = r[k];
    b[k] = m ? { worst: m.worst, mean: m.mean, n: m.n, detail: m.detail } : null;
  }
  return { slider: r.slider, k: r.k, mode: r.mode, ...b };
}
const out = { detected: { V: detected.V.slice(0, 8), H: detected.H.slice(0, 5) }, plumbA: pA, plumbB: pB, plumbBguides: plumbB, heldOut, base: brief(base), afterA: brief(afterA), afterB: brief(afterB) };
console.log('SUMMARY base', JSON.stringify({ heldOut: base.heldOut?.worst, heldV: base.heldV?.worst, heldH: base.heldH?.worst, inA: base.inSampleA?.worst, pB: base.plumbBchords?.worst }));
console.log('SUMMARY afterA', JSON.stringify({ heldOut: afterA.heldOut?.worst, heldV: afterA.heldV?.worst, heldH: afterA.heldH?.worst, inA: afterA.inSampleA?.worst, pB: afterA.plumbBchords?.worst, slider: afterA.slider }));
if (afterB) console.log('SUMMARY afterB', JSON.stringify({ heldOut: afterB.heldOut?.worst, heldV: afterB.heldV?.worst, heldH: afterB.heldH?.worst, inA: afterB.inSampleA?.worst, pB: afterB.plumbBchords?.worst, slider: afterB.slider }));
writeFileSync(path.join(HERE, 'docs/audit/workflows-v122-brick-heldout.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
