/** Apply Distortion(slider) → Full; measure worst edge angle. Also probe plumb refine + gates + v117. */
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
const libSeeds = [[[1144, 301], [1149, 693]], [[554, 90], [553, 529]], [[575, 325], [1101, 287]], [[582, 641], [1133, 685]], [[350, 343], [548, 328]]];
const brickSeeds = [[[114, 40], [130, 980]], [[920, 50], [900, 970]], [[200, 180], [880, 160]], [[210, 820], [870, 840]]];
const c4Seeds = [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]];

const measure = async (seeds) => page.evaluate(async ({ seeds }) => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
  const angs = seeds.map(([[x1, y1], [x2, y2]]) => {
    const xs = [], ys = []; const horiz = Math.abs(x2 - x1) > Math.abs(y2 - y1); const win = 4;
    if (horiz) {
      for (let x = Math.ceil(Math.min(x1, x2)); x < Math.max(x1, x2); x++) {
        if (x < 0 || x >= W) continue; const yr = y1 + (y2 - y1) * (x - x1) / (x2 - x1), a = Math.round(yr - win), b = Math.round(yr + win); if (a < 1 || b >= H - 1) continue;
        let k = -1, best = 12; for (let y = a; y <= b; y++) { const v = Math.abs(g(x, y + 1) - g(x, y - 1)); if (v > best) { best = v; k = y; } }
        if (k < 0) continue; ys.push(k); xs.push(x);
      }
      if (xs.length < 10) return null; let s = 0, keep = xs.map(() => true);
      for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return null; const mx = idx.reduce((q, i) => q + xs[i], 0) / n, my = idx.reduce((q, i) => q + ys[i], 0) / n; let sxy = 0, sxx = 0; for (const i of idx) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } s = sxy / (sxx || 1); keep = ys.map((y, i) => Math.abs(y - (s * xs[i] + my - s * mx)) < 1.5); }
      return Math.atan(s) * 180 / Math.PI;
    }
    for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
      if (y < 0 || y >= H) continue; const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win); if (a < 1 || b >= W - 1) continue;
      let k = -1, best = 12; for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); if (v > best) { best = v; k = x; } }
      if (k < 0) continue; xs.push(k); ys.push(y);
    }
    if (xs.length < 10) return null; let s = 0, keep = xs.map(() => true);
    for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return null; const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n; let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; } s = sxy / (syy || 1); keep = xs.map((x, i) => Math.abs(x - (s * ys[i] + mx - s * my)) < 1.5); }
    return Math.atan(s) * 180 / Math.PI;
  });
  const v = angs.filter((d) => d != null).map(Math.abs); return v.length ? Math.max(...v) : null;
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
const mapUpright = (pts) => page.evaluate((pts) => {
  const u = window.tintwork.lastUpright, H = u?.H, c = u?.crop || { x: 0, y: 0 };
  if (!H) return pts;
  return pts.map(([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w - c.x, (H[3] * x + H[4] * y + H[5]) / w - c.y]; });
}, pts);

async function runSlider(file, seeds, slider) {
  await open(file);
  await T((slider) => { window.tintwork.run('perspective'); const x = window.tintwork.mxf; x.lensSlider = slider; window.tintwork.previewLensOnMxf(x); }, slider);
  const k = await T(() => window.tintwork.mxf.radialK);
  await T(() => window.tintwork.applyLensFromMxf());
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 });
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 });
  const mapped = await mapChain(seeds, k);
  const w = await measure(mapped);
  const mode = await T(() => window.tintwork.lastUpright?.mode);
  return { slider, k, w, mode };
}

async function runRefuse(file) {
  await open(file);
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 5000 }).catch(() => {});
  return T(() => ({ mxf: !!window.tintwork.mxf, mode: window.tintwork.lastUpright?.mode, H: !!window.tintwork.lastUpright?.H }));
}

async function runPlumb(file, guides) {
  await open(file);
  await T(() => window.tintwork.run('perspective'));
  const r = await T((guides) => {
    const x = window.tintwork.mxf;
    x.plumbs = guides;
    const k = window.tintwork.solvePlumbOnMxf(x);
    return { k, slider: x.lensSlider, meta: x.plumbMeta };
  }, guides);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
}

const out = {};
const libPlumb = [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]], [[350, 343], [548, 328]]];
const brickPlumb = [[[114, 40], [130, 980]], [[920, 50], [900, 970]]];

out.plumbLib = await runPlumb('library.jpg', libPlumb);
console.log('plumbLib', JSON.stringify({ slider: out.plumbLib.slider, usedFull: out.plumbLib.meta?.usedFull, refined: out.plumbLib.meta?.refined?.slider }));
out.plumbBrick = await runPlumb('brick.jpg', brickPlumb);
console.log('plumbBrick', JSON.stringify({ slider: out.plumbBrick.slider, usedFull: out.plumbBrick.meta?.usedFull, refined: out.plumbBrick.meta?.refined?.slider }));

out.lib0 = await runSlider('library.jpg', libSeeds, 0);
out.libAuto = await runSlider('library.jpg', libSeeds, out.plumbLib.slider);
console.log('lib', out.lib0.w?.toFixed?.(3), '→', out.libAuto.w?.toFixed?.(3), 's=', out.libAuto.slider);

out.brick0 = await runSlider('brick.jpg', brickSeeds, 0);
out.brickAuto = await runSlider('brick.jpg', brickSeeds, out.plumbBrick.slider);
out.brick20 = await runSlider('brick.jpg', brickSeeds, 20);
console.log('brick', out.brick0.w?.toFixed?.(3), '→ auto', out.brickAuto.w?.toFixed?.(3), 's=', out.brickAuto.slider, 's20', out.brick20.w?.toFixed?.(3));

// c4 Full only (no lens)
await open('c4.jpg');
await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
const c4m = []; for (const sd of c4Seeds) c4m.push(await mapUpright(sd));
out.c4 = { w: await measure(c4m), mode: await T(() => window.tintwork.lastUpright?.mode) };
console.log('c4', out.c4);

out.geneva = await runRefuse('geneva.jpg');
out.hongkong = await runRefuse('hongkong.jpg');
console.log('refuse', out.geneva, out.hongkong);

out.v117 = {};
for (const f of ['v117-cathedral.jpg','v117-curvy.jpg','v117-flat.jpg','v117-frame.jpg','v117-geo.jpg','v117-interior.jpg','v117-lookup.jpg','v117-lowangle.jpg','v117-station.jpg']) {
  out.v117[f] = await runRefuse(f);
  console.log('v117', f, out.v117[f]);
}

writeFileSync(path.join(HERE, 'docs/audit/workflows-v122-apply-measure.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
console.log('done');
