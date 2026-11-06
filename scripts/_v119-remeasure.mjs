import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const HERE = '/workspace/photo-editor';
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(HERE, 'scripts/serve.mjs')).href);
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/?platform=win`);
await page.waitForFunction(() => window.tintwork); await page.evaluate(() => window.tintwork.engineReady);

await page.setInputFiles('#fileInput', { name: 'flat.jpg', mimeType: 'image/jpeg', buffer: REAL('v117-flat.jpg') });
await page.waitForFunction(() => window.tintwork.doc);
const dbg = await page.evaluate(() => {
  const t = window.tintwork; t.run('guidedUpright'); const x = t.mxf;
  const full = t.suggestUprightGuides(x, { max: 4 });
  const base = x.pts.map((p) => [...p]);
  const next = t.uprightFromGuides(base, full, x.w, x.h);
  const img = x.small, k = x.k || 1;
  const toDoc = (l) => [[x.ox + l.x1 / k, x.oy + l.y1 / k], [x.ox + l.x2 / k, x.oy + l.y2 / k]];
  const vv = t.segment.detectLines(img, { orient: 'v', maxDeg: 22, minLenFrac: 0.1, maxLines: 12, thrFrac: 0.72 });
  const probe = vv.slice(0, 6).map(toDoc);
  return { scoreGuides: t.scoreSegmentsAfter(base, full, next), scoreProbe: t.scoreSegmentsAfter(base, probe, next), full: full.length };
});
console.log('flat scores', dbg);
await page.evaluate(() => window.tintwork.run('mxfCancel'));

const edgeAngle = (seeds) => page.evaluate(async ({ seeds }) => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
  return seeds.map(([[x1, y1], [x2, y2]]) => {
    const xs = [], ys = []; const horiz = Math.abs(x2 - x1) > Math.abs(y2 - y1); const win = 4;
    if (horiz) {
      for (let x = Math.ceil(Math.min(x1, x2)); x < Math.max(x1, x2); x++) {
        if (x < 0 || x >= W) continue; const yr = y1 + (y2 - y1) * (x - x1) / (x2 - x1), a = Math.round(yr - win), b = Math.round(yr + win); if (a < 1 || b >= H - 1) continue;
        let k = -1, best = 12; for (let y = a; y <= b; y++) { const v = Math.abs(g(x, y + 1) - g(x, y - 1)); if (v > best) { best = v; k = y; } }
        if (k < 0) continue; ys.push(k); xs.push(x);
      }
      if (xs.length < 10) return { deg: null }; let s = 0, keep = xs.map(() => true);
      for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null }; const mx = idx.reduce((q, i) => q + xs[i], 0) / n, my = idx.reduce((q, i) => q + ys[i], 0) / n; let sxy = 0, sxx = 0; for (const i of idx) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } s = sxy / (sxx || 1); keep = ys.map((y, i) => Math.abs(y - (s * xs[i] + my - s * mx)) < 1.5); }
      return { deg: Math.atan(s) * 180 / Math.PI };
    }
    for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
      if (y < 0 || y >= H) continue; const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win); if (a < 1 || b >= W - 1) continue;
      let k = -1, best = 12; for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); if (v > best) { best = v; k = x; } }
      if (k < 0) continue; xs.push(k); ys.push(y);
    }
    if (xs.length < 10) return { deg: null }; let s = 0, keep = xs.map(() => true);
    for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null }; const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n; let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; } s = sxy / (syy || 1); keep = xs.map((x, i) => Math.abs(x - (s * ys[i] + mx - s * my)) < 1.5); }
    return { deg: Math.atan(s) * 180 / Math.PI };
  });
}, { seeds });
const mapUpright = (pts) => page.evaluate((pts) => {
  const u = window.tintwork.lastUpright, H = u?.H, c = u?.crop || { x: 0, y: 0 };
  if (!H) return pts;
  return pts.map(([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w - c.x, (H[3] * x + H[4] * y + H[5]) / w - c.y]; });
}, pts);
const worst = (es) => { const v = (es || []).map((e) => e?.deg).filter((d) => d != null).map(Math.abs); return v.length ? Math.max(...v) : null; };
const open = async (f) => {
  await page.setInputFiles('#fileInput', { name: f, mimeType: 'image/jpeg', buffer: REAL(f) });
  await page.waitForFunction((n) => (window.tintwork.doc?.name || '').startsWith(n.replace(/\.[^.]+$/, '')), f, { timeout: 30000 });
  await page.evaluate(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};
const pickSeeds = async () => page.evaluate(async () => {
  const t = window.tintwork; await t.compositeSettled?.();
  const c = t.compositeCanvas(); const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  const v = t.segment.detectLines(img, { orient: 'v', maxDeg: 25, minLenFrac: 0.12, maxLines: 20, thrFrac: 0.7 });
  const h = t.segment.detectLines(img, { orient: 'h', maxDeg: 20, minLenFrac: 0.12, maxLines: 20, thrFrac: 0.7 });
  v.sort((a, b) => b.len - a.len); h.sort((a, b) => b.len - a.len);
  const toSeg = (l) => [[l.x1, l.y1], [l.x2, l.y2]];
  const verts = [], hors = [];
  for (const l of v) { const m = (l.x1 + l.x2) / 2; if (verts.every((s) => Math.abs((s[0][0] + s[1][0]) / 2 - m) > c.width * 0.12)) verts.push(toSeg(l)); if (verts.length >= 3) break; }
  for (const l of h) { const m = (l.y1 + l.y2) / 2; if (hors.every((s) => Math.abs((s[0][1] + s[1][1]) / 2 - m) > c.height * 0.1)) hors.push(toSeg(l)); if (hors.length >= 2) break; }
  return { verts, hors, seeds: [...verts, ...hors] };
});
const runTop2 = async (guides, seeds) => {
  await page.evaluate(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('guidedUpright'); });
  await page.waitForFunction(() => window.tintwork.mxf?.guideMode);
  await page.evaluate((guides) => { const t = window.tintwork, x = t.mxf; x.pts0 = x.pts.map((p) => [...p]); x.pts = x.pts0.map((p) => [...p]); x.guides = guides; t.finishGuidedUpright(x); }, guides);
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const mapped = []; for (const sd of seeds) mapped.push(await mapUpright(sd));
  return edgeAngle(mapped);
};
const runSuggest = async (seeds) => {
  await page.evaluate(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('mxfSuggestGuides'); });
  await page.waitForTimeout(120);
  const info = await page.evaluate(() => {
    const x = window.tintwork.mxf; if (!x?.guides?.length) return { n: 0, st: (document.querySelector('#status')?.textContent || '').slice(0, 80) };
    const nv = x.guides.filter((g) => Math.abs(g[1][1] - g[0][1]) >= Math.abs(g[1][0] - g[0][0])).length;
    return { n: x.guides.length, nv, nh: x.guides.length - nv };
  });
  if (info.n >= 2) {
    await page.evaluate(() => { const t = window.tintwork; if (t.mxf) t.finishGuidedUpright(t.mxf); });
    await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 }).catch(() => {});
  }
  await page.evaluate(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const mapped = []; for (const sd of seeds) mapped.push(await mapUpright(sd));
  return { after: await edgeAngle(mapped), info };
};
const rows = [];
for (const file of ['v117-flat.jpg','v117-interior.jpg','v117-cathedral.jpg','v117-frame.jpg','library.jpg','c4.jpg','brick.jpg','v117-lowangle.jpg','geneva.jpg','hongkong.jpg']) {
  await open(file);
  const { verts, seeds } = await pickSeeds();
  if (seeds.length < 2) continue;
  await open(file); const top2 = await runTop2(verts.length >= 2 ? verts.slice(0, 2) : seeds.slice(0, 2), seeds);
  await open(file); const sug = await runSuggest(seeds);
  const isVertSeed = (s) => Math.abs(s[1][1] - s[0][1]) >= Math.abs(s[1][0] - s[0][0]);
  const vIdx = seeds.map((s, i) => isVertSeed(s) ? i : -1).filter((i) => i >= 0);
  const hIdx = seeds.map((s, i) => !isVertSeed(s) ? i : -1).filter((i) => i >= 0);
  const worstAt = (es, idx) => { const v = idx.map((i) => es[i]?.deg).filter((d) => d != null).map(Math.abs); return v.length ? Math.max(...v) : null; };
  const wt = worst(top2), ws = worst(sug.after);
  const wtV = worstAt(top2, vIdx), wsV = worstAt(sug.after, vIdx);
  const wtH = worstAt(top2, hIdx), wsH = worstAt(sug.after, hIdx);
  console.log(file, 'top2', wt?.toFixed(2), 'sug', ws?.toFixed(2), 'Δ', (ws - wt).toFixed(2),
    'V', wtV?.toFixed(2), '→', wsV?.toFixed(2), 'H', wtH?.toFixed(2), '→', wsH?.toFixed(2), sug.info);
  rows.push({ file, wt2: wt, ws, delta: +(ws - wt).toFixed(2), wtV, wsV, wtH, wsH, info: sug.info });
}
writeFileSync(path.join(HERE, 'docs/audit/workflows-v119-suggest.json'), JSON.stringify({ app: '1.19.0', rows }, null, 2));
await browser.close(); server.close();
