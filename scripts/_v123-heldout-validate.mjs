/** Apply Distortion→Full; measure held-out check Vs (edgeAngle) for library/brick. */
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
const open = async (file) => {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};
const measure = async (seeds) => page.evaluate(async ({ seeds }) => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
  const angs = [];
  for (const [[x1, y1], [x2, y2]] of seeds) {
    const xs = [], ys = []; const horiz = Math.abs(x2 - x1) > Math.abs(y2 - y1); const win = 5;
    if (horiz) continue; // V only
    for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
      if (y < 0 || y >= H) continue; const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win); if (a < 1 || b >= W - 1) continue;
      let k = -1, best = 10; for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); if (v > best) { best = v; k = x; } }
      if (k < 0) continue; xs.push(k); ys.push(y);
    }
    if (xs.length < 8) { angs.push(null); continue; }
    let s = 0, keep = xs.map(() => true);
    for (let it = 0; it < 5; it++) {
      const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 8) { angs.push(null); s = null; break; }
      const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n;
      let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; }
      s = sxy / (syy || 1); keep = xs.map((x, i) => Math.abs(x - (s * ys[i] + mx - s * my)) < 2);
    }
    if (s == null) continue;
    angs.push(Math.atan(s) * 180 / Math.PI);
  }
  const v = angs.filter((d) => d != null).map(Math.abs);
  v.sort((a, b) => a - b);
  return { worst: v.length ? Math.max(...v) : null, median: v.length ? v[Math.floor(v.length / 2)] : null, n: v.length, detail: angs.map((d) => d == null ? null : Math.abs(d)) };
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

async function getCheck(file, plumb) {
  await open(file);
  await T(() => window.tintwork.run('perspective'));
  const check = await T((plumb) => window.tintwork.splitDetectedPlumbSets(window.tintwork.mxf, plumb).check, plumb);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  // top 5 longest
  return [...check].sort((a, b) => {
    const la = Math.hypot(a[1][0]-a[0][0], a[1][1]-a[0][1]);
    const lb = Math.hypot(b[1][0]-b[0][0], b[1][1]-b[0][1]);
    return lb - la;
  }).slice(0, 5);
}
async function runPath(file, seeds, slider) {
  await open(file);
  await T((slider) => { window.tintwork.run('perspective'); const x = window.tintwork.mxf; x.lensSlider = slider; window.tintwork.previewLensOnMxf(x); }, slider);
  const k = await T(() => window.tintwork.mxf.radialK);
  await T(() => window.tintwork.applyLensFromMxf());
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 });
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 });
  const mapped = await mapChain(seeds, k);
  const m = await measure(mapped);
  return { slider, k, mode: await T(() => window.tintwork.lastUpright?.mode), ...m };
}

const libPlumb = [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]], [[350, 343], [548, 328]]];
const brickA = [[[114, 40], [130, 980]], [[920, 50], [900, 970]]];
const out = {};
const libCheck = await getCheck('library.jpg', libPlumb);
out.libCheck = libCheck;
out.lib = {};
for (const s of [0, -23, 10, -10]) {
  out.lib['s'+s] = await runPath('library.jpg', libCheck, s);
  console.log('lib', s, out.lib['s'+s]);
}
const brickCheck = await getCheck('brick.jpg', brickA);
out.brickCheck = brickCheck;
out.brick = {};
for (const s of [0, 20, -15]) {
  out.brick['s'+s] = await runPath('brick.jpg', brickCheck, s);
  console.log('brick', s, out.brick['s'+s]);
}
// plumb picks
for (const [label, file, g] of [['libPlumb','library.jpg',libPlumb],['brickA','brick.jpg',brickA]]) {
  await open(file); await T(() => window.tintwork.run('perspective'));
  out[label] = await T((g) => { const x = window.tintwork.mxf; x.plumbs = g; window.tintwork.solvePlumbOnMxf(x); return { slider: x.lensSlider, reason: x.plumbMeta?.refined?.reason, status: document.getElementById('status')?.textContent }; }, g);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  console.log('plumb', label, out[label]);
}
writeFileSync(path.join(HERE, 'docs/audit/workflows-v123-heldout-validate.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
