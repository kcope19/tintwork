// v1.20 test: WebKit restored; lens-aware Full stays gated (measured); Suggest regressions held.
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

// 0) WebKit launches (restored host deps)
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

check(['1.20.0','1.21.0','1.22.0'].includes(await T(() => window.tintwork.APP_VERSION)), `APP_VERSION is 1.20+ (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check(m?.[1] === '1.20.0' || m?.[1] === '1.21.0' || m?.[1] === '1.22.0', `SW CACHE is 1.20+ (${m?.[1]})`);
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
const worst = (es) => { const v = (es || []).map((e) => e?.deg).filter((d) => d != null).map(Math.abs); return v.length ? Math.max(...v) : null; };

// 1) library Full: ≤1.0° bar (disclosed); radial stays gated (k===0)
{
  const seeds = [[[1144, 301], [1149, 693]], [[554, 90], [553, 529]], [[575, 325], [1101, 287]], [[582, 641], [1133, 685]], [[350, 343], [548, 328]]];
  await open('library.jpg', 'lib-full-v120.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  const lu = await T(() => ({ mode: window.tintwork.lastUpright?.mode, k: window.tintwork.lastUpright?.k, kEst: window.tintwork.lastUpright?.kEst, H: !!window.tintwork.lastUpright?.H }));
  const mapped = []; for (const sd of seeds) mapped.push(await mapUpright(sd));
  const after = await edgeAngle(mapped);
  const w = worst(after);
  check(lu.H && w != null && w < 1.0, `library Full ≤1.0° (w=${w?.toFixed?.(2)}, mode=${lu.mode})`);
  check(!(lu.k > 0) && !(lu.k < 0), `library radial gated on apply (k=${lu.k}, kEst=${lu.kEst})`);
}

// 2) c4 Full ≤0.5° on fixed vertical seeds
{
  const seeds = [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]];
  await open('c4.jpg', 'c4-full-v120.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  const mapped = []; for (const sd of seeds) mapped.push(await mapUpright(sd));
  const w = worst(await edgeAngle(mapped));
  check(w != null && w <= 0.5, `c4 Full ≤0.5° on fixed V seeds (w=${w?.toFixed?.(2)})`);
}

// 3) geneva + hongkong Full refuse
for (const f of ['geneva.jpg', 'hongkong.jpg']) {
  await open(f, f.replace('.jpg', '-full-v120.jpg'));
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 5000 }).catch(() => {});
  const r = await T(() => ({ mxf: !!window.tintwork.mxf, mode: window.tintwork.lastUpright?.mode, H: !!window.tintwork.lastUpright?.H }));
  check(!r.mxf && (r.mode === 'none' || !r.H), `${f} Full refuse (mode=${r.mode}, H=${r.H})`);
}

// 4) Suggest still matches top-2 on flat (v1.19 regression)
{
  await open('v117-flat.jpg', 'flat-v120.jpg');
  const r = await T(() => {
    const mid = (g) => [(g[0][0] + g[1][0]) / 2, (g[0][1] + g[1][1]) / 2];
    const near = (a, b, tol = 40) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
    const t = window.tintwork; t.run('guidedUpright');
    const x = t.mxf; const top2 = t.diversifyTop2Verticals(x);
    t.applySuggestedGuides(x); const sug = x.guides || [];
    const ok = sug.length === 2 && top2.length === 2
      && ((near(mid(sug[0]), mid(top2[0])) && near(mid(sug[1]), mid(top2[1])))
        || (near(mid(sug[0]), mid(top2[1])) && near(mid(sug[1]), mid(top2[0]))));
    return { ok, n: sug.length };
  });
  check(r.ok, `flat Suggest ≡ top-2 (n=${r.n})`);
  await T(() => window.tintwork.run('mxfCancel'));
}

check(errors.filter((e) => !/Deprecated|favicon/i.test(e)).length === 0, `no page errors (${errors.slice(0, 2).join('; ')})`);
console.log(`\n${count - fails}/${count} passed`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
