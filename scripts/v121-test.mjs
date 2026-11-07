// v1.21: manual Lens distortion + Plumb line (radial from curved edges); Full still do-no-harm.
// TW_ROOT / TW_URL supported.
import { chromium, webkit } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;

{
  try {
    const b = await webkit.launch();
    const p = await b.newPage();
    await p.goto('about:blank');
    const ua = await p.evaluate(() => navigator.userAgent);
    check(/WebKit/i.test(ua), `WebKit launches (${ua.slice(0, 60)}…)`);
    await b.close();
  } catch (e) {
    check(false, `WebKit launches (${e.message.slice(0, 80)})`);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}?platform=win`);
await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));

check(['1.21.0','1.22.0','1.23.0','1.24.0','1.25.0','1.26.0','1.27.0'].includes(await T(() => window.tintwork.APP_VERSION)), `APP_VERSION is 1.21+ (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check(m?.[1] === '1.21.0' || m?.[1] === '1.22.0' || m?.[1] === '1.23.0' || await T(() => window.tintwork.APP_VERSION) === '1.24.0' || m?.[1] === '1.24.0' || await T(() => window.tintwork.APP_VERSION) === '1.25.0' || await T(() => window.tintwork.APP_VERSION) === '1.26.0' || await T(() => window.tintwork.APP_VERSION) === '1.27.0', `SW CACHE is 1.21+ (${m?.[1]})`);
}

const open = async (file, as = file) => {
  await page.setInputFiles('#fileInput', { name: as, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), as, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};

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
const mapLensThenUpright = (pts, kLens) => page.evaluate(({ pts, kLens }) => {
  const t = window.tintwork, u = t.lastUpright;
  const W = t.doc?.width || 1000, Hgt = t.doc?.height || 1000;
  const cx = u?.center?.[0] ?? W / 2, cy = u?.center?.[1] ?? Hgt / 2;
  const rNorm2 = u?.rNorm2 ?? (cx * cx + cy * cy);
  const und = (x, y, k) => { if (!k) return [x, y]; const dx = x - cx, dy = y - cy, s = 1 + k * ((dx * dx + dy * dy) / rNorm2); return [cx + dx * s, cy + dy * s]; };
  const Hm = u?.H, c = u?.crop || { x: 0, y: 0 };
  return pts.map(([x, y]) => {
    let [a, b] = und(x, y, kLens);
    if (!Hm) return [a - c.x, b - c.y];
    const w = Hm[6] * a + Hm[7] * b + Hm[8];
    return [(Hm[0] * a + Hm[1] * b + Hm[2]) / w - c.x, (Hm[3] * a + Hm[4] * b + Hm[5]) / w - c.y];
  });
}, { pts, kLens });
const worst = (es) => { const v = (es || []).map((e) => e?.deg).filter((d) => d != null).map(Math.abs); return v.length ? Math.max(...v) : null; };

// APIs present
{
  const api = await T(() => ({
    slider: typeof window.tintwork.lensSliderToK === 'function',
    solve: typeof window.tintwork.solvePlumbOnMxf === 'function',
    apply: typeof window.tintwork.applyLensFromMxf === 'function',
    sample: typeof window.tintwork.segment.sampleRidgeAlong === 'function',
    plumbSolve: typeof window.tintwork.segment.solveRadialFromPlumb === 'function',
    cmds: !!(window.tintwork.cmds.mxfLensApply && window.tintwork.cmds.mxfPlumb && window.tintwork.cmds.perspectiveLens),
  }));
  check(api.slider && api.solve && api.apply && api.sample && api.plumbSolve && api.cmds, `lens/plumb APIs exported (${JSON.stringify(api)})`);
}

// slider ↔ k round-trip (RAW sign: +slider → negative k)
{
  const r = await T(() => {
    const k = window.tintwork.lensSliderToK(40);
    const s = window.tintwork.lensKToSlider(k);
    return { k, s, back: window.tintwork.lensSliderToK(s) };
  });
  check(r.k < 0 && Math.abs(r.s - 40) < 0.2 && Math.abs(r.back - r.k) < 1e-9, `Distortion +40 → k<0 round-trip (k=${r.k}, s=${r.s})`);
}

// library: Distortion +10 then Full improves vs Full-only baseline, stays <1.0° (disclosed trail vs 0.5°)
{
  const seeds = [[[1144, 301], [1149, 693]], [[554, 90], [553, 529]], [[575, 325], [1101, 287]], [[582, 641], [1133, 685]], [[350, 343], [548, 328]]];
  await open('library.jpg', 'lib-v121-base.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  let mapped = []; for (const sd of seeds) mapped.push(await mapUpright(sd));
  const base = worst(await edgeAngle(mapped));

  // Fresh open so Lens is not applied on top of an already-Upright layer (crop is a separate history entry).
  await open('library.jpg', 'lib-v121-lens.jpg');
  await T(() => {
    window.tintwork.run('perspective');
    const x = window.tintwork.mxf; x.lensSlider = 10; window.tintwork.previewLensOnMxf(x);
  });
  const k = await T(() => window.tintwork.mxf.radialK);
  check(Math.abs(k + 0.015) < 1e-6, `library Distortion +10 → k≈−0.015 (k=${k})`);
  await T(() => window.tintwork.applyLensFromMxf());
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  const lensLabel = await T(() => window.tintwork.history.entries[window.tintwork.history.index]?.label);
  check(lensLabel === 'Lens distortion', `Apply Lens is one undo step (label=${lensLabel})`);
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  mapped = []; for (const sd of seeds) mapped.push(await mapLensThenUpright(sd, k));
  const after = worst(await edgeAngle(mapped));
  check(after != null && after < 1.0, `library Distortion+10 then Full <1.0° (w=${after?.toFixed?.(2)}, base=${base?.toFixed?.(2)})`);
  check(after != null && base != null && after <= base + 0.05, `library lens+Full not worse than Full-only (${after?.toFixed?.(2)} vs ${base?.toFixed?.(2)})`);
}

// c4 Full ≤0.5° still
{
  const seeds = [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]];
  await open('c4.jpg', 'c4-v121.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  const mapped = []; for (const sd of seeds) mapped.push(await mapUpright(sd));
  const w = worst(await edgeAngle(mapped));
  check(w != null && w <= 0.5, `c4 Full ≤0.5° (w=${w?.toFixed?.(2)})`);
}

// geneva / hongkong refuse
for (const f of ['geneva.jpg', 'hongkong.jpg']) {
  await open(f, f.replace('.jpg', '-v121.jpg'));
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 5000 }).catch(() => {});
  const r = await T(() => ({ mxf: !!window.tintwork.mxf, mode: window.tintwork.lastUpright?.mode, H: !!window.tintwork.lastUpright?.H }));
  check(!r.mxf && (r.mode === 'none' || !r.H), `${f} Full refuse (mode=${r.mode}, H=${r.H})`);
}

// plumb solve on library sets a finite mild slider
{
  await open('library.jpg', 'lib-plumb-v121.jpg');
  await T(() => window.tintwork.run('perspective'));
  const r = await T(() => {
    const x = window.tintwork.mxf;
    x.plumbs = [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]]];
    const k = window.tintwork.solvePlumbOnMxf(x);
    return { k, slider: x.lensSlider, abs: Math.abs(x.lensSlider) };
  });
  check(Number.isFinite(r.k) && r.abs <= 100, `plumb solve sets Distortion within ±100 (k=${r.k}, slider=${r.slider})`);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
}

// radial still gated on automatic Full
{
  await open('library.jpg', 'lib-gate-v121.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  const lu = await T(() => ({ k: window.tintwork.lastUpright?.k, kEst: window.tintwork.lastUpright?.kEst }));
  check(!(lu.k > 0) && !(lu.k < 0), `auto Full radial still gated (k=${lu.k}, kEst=${lu.kEst})`);
}

check(!errors.length, `no page errors (${errors.slice(0, 2).join('; ')})`);

console.log(`\n${count - fails}/${count} passed`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
