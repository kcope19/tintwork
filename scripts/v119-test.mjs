// v1.19 test: Suggest pure-V ranking (match diversify top-2; never worse on held-out) + brick/c4 V/H split.
// TW_ROOT / TW_URL supported.
import { chromium } from 'playwright';
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
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}?platform=win`);
await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));

check(await T(() => window.tintwork.APP_VERSION) === '1.19.0' || await T(() => window.tintwork.APP_VERSION) === '1.21.0' || await T(() => window.tintwork.APP_VERSION) === '1.22.0' || await T(() => window.tintwork.APP_VERSION) === '1.23.0' || await T(() => window.tintwork.APP_VERSION) === '1.24.0' || await T(() => window.tintwork.APP_VERSION) === '1.25.0' || await T(() => window.tintwork.APP_VERSION) === '1.26.0' || await T(() => window.tintwork.APP_VERSION) === '1.27.0' || await T(() => window.tintwork.APP_VERSION) === '1.28.0' || await T(() => window.tintwork.APP_VERSION) === '1.20.0', `APP_VERSION is 1.19+ (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check(m?.[1] === '1.19.0' || m?.[1] === '1.21.0' || m?.[1] === '1.22.0' || m?.[1] === '1.23.0' || await T(() => window.tintwork.APP_VERSION) === '1.24.0' || m?.[1] === '1.24.0' || (m?.[1] === '1.25.0' || m?.[1] === '1.26.0' || m?.[1] === '1.27.0' || m?.[1] === '1.28.0') || m?.[1] === '1.20.0', `SW CACHE is 1.19+ (${m?.[1]})`);
}

const open = async (file, as = file) => {
  await page.setInputFiles('#fileInput', { name: as, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), as, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};

const matchTop2 = () => {
  const mid = (g) => [(g[0][0] + g[1][0]) / 2, (g[0][1] + g[1][1]) / 2];
  const near = (a, b, tol = 40) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
  const t = window.tintwork; t.run('guidedUpright');
  const x = t.mxf;
  const top2 = t.diversifyTop2Verticals(x);
  t.applySuggestedGuides(x);
  const sug = x.guides || [];
  const isV = (g) => Math.abs(g[1][1] - g[0][1]) >= Math.abs(g[1][0] - g[0][0]);
  const midsEqual = sug.length >= 2 && top2.length === 2
    && ((near(mid(sug[0]), mid(top2[0])) && near(mid(sug[1]), mid(top2[1])))
      || (near(mid(sug[0]), mid(top2[1])) && near(mid(sug[1]), mid(top2[0]))));
  return { n: sug.length, nv: sug.filter(isV).length, nh: sug.filter((g) => !isV(g)).length, midsEqual, top2N: top2.length };
};

// 1) Held-out flat: Suggest pure-V matches diversify top-2
{
  await open('v117-flat.jpg', 'flat-v119.jpg');
  const r = await T(matchTop2);
  check(r.n === 2 && r.nv === 2 && r.midsEqual, `flat Suggest ≡ diversify top-2 (n=${r.n}, match=${r.midsEqual})`);
  await T(() => window.tintwork.run('mxfCancel'));
}

// 2) Held-out lowangle: same match
{
  await open('v117-lowangle.jpg', 'low-v119.jpg');
  const r = await T(matchTop2);
  check(r.midsEqual && r.nh === 0, `lowangle Suggest ≡ top-2 pure-V (match=${r.midsEqual}, nh=${r.nh})`);
  await T(() => window.tintwork.run('mxfCancel'));
}

// 3) geneva: Suggest matches top-2 (no harmful ranked/mixed)
{
  await open('geneva.jpg', 'geneva-v119.jpg');
  const r = await T(matchTop2);
  check(r.midsEqual && r.n === 2, `geneva Suggest ≡ top-2 (match=${r.midsEqual}, n=${r.n})`);
  await T(() => window.tintwork.run('mxfCancel'));
}

// 4) library: mixed still wins
{
  await open('library.jpg', 'lib-v119.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('suggestGuides'); });
  await page.waitForFunction(() => (window.tintwork.mxf?.guides?.length || 0) >= 2);
  const mid2 = await T(() => {
    const g = window.tintwork.mxf?.guides || [];
    const isV = (s) => Math.abs(s[1][1] - s[0][1]) >= Math.abs(s[1][0] - s[0][0]);
    return { n: g.length, nv: g.filter(isV).length, nh: g.filter((s) => !isV(s)).length };
  });
  check(mid2.nv >= 1 && mid2.nh >= 1, `library still mixed (nv=${mid2.nv}, nh=${mid2.nh})`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 }).catch(() => {});
  check(await T(() => !!window.tintwork.lastUpright?.H), 'library Suggest+Enter applies');
}

// 5) c4: mixed accepted when H improves a lot (or pure-V OK)
{
  await open('c4.jpg', 'c4-v119.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('suggestGuides'); });
  await page.waitForFunction(() => (window.tintwork.mxf?.guides?.length || 0) >= 2);
  const mid2 = await T(() => {
    const g = window.tintwork.mxf?.guides || [];
    const isV = (s) => Math.abs(s[1][1] - s[0][1]) >= Math.abs(s[1][0] - s[0][0]);
    return { n: g.length, nv: g.filter(isV).length, nh: g.filter((s) => !isV(s)).length };
  });
  check(mid2.nv >= 2, `c4 has ≥2V (n=${mid2.n}, nv=${mid2.nv}, nh=${mid2.nh})`);
  check(mid2.nh >= 1, `c4 mixed H accepted (nh=${mid2.nh})`);
  await T(() => window.tintwork.run('mxfCancel'));
}

// 6) brick: pure-V; V residual low (H ~17° is a non-level seed, not a V failure)
{
  await open('brick.jpg', 'brick-v119.jpg');
  const r = await T(() => {
    const t = window.tintwork; t.run('guidedUpright');
    const x = t.mxf;
    t.applySuggestedGuides(x);
    const g = x.guides || [];
    const isV = (s) => Math.abs(s[1][1] - s[0][1]) >= Math.abs(s[1][0] - s[0][0]);
    const base = x.pts0.map((p) => [...p]);
    const next = t.uprightFromGuides(base, g, x.w, x.h);
    // score only V guides
    const vOnly = g.filter(isV);
    return { n: g.length, nv: vOnly.length, nh: g.length - vOnly.length, vScore: t.scoreSegmentsAfter(base, vOnly, next) };
  });
  check(r.nv >= 2 && r.nh === 0, `brick Suggest pure-V (nv=${r.nv}, nh=${r.nh})`);
  check(Number.isFinite(r.vScore) && r.vScore < 2, `brick V residual low (${r.vScore?.toFixed?.(2)})`);
  await T(() => window.tintwork.run('mxfCancel'));
}

// 7) APIs exported
{
  const apis = await T(() => ({
    rank: typeof window.tintwork.bestVerticalPairGuides === 'function',
    top2: typeof window.tintwork.diversifyTop2Verticals === 'function',
  }));
  check(apis.rank && apis.top2, 'ranking APIs exported');
}

// 8) geneva Full still refuses (lens-aware Full still gated)
{
  await open('geneva.jpg', 'geneva-full-v119.jpg');
  const t0 = Date.now();
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 5000 }).catch(() => {});
  const r = await T(() => ({ mxf: !!window.tintwork.mxf, mode: window.tintwork.lastUpright?.mode, k: window.tintwork.lastUpright?.k, kEst: window.tintwork.lastUpright?.kEst }));
  check(!r.mxf, `geneva Full refuse/no-mxf (mode=${r.mode}, ${Date.now() - t0}ms)`);
  check(!(r.k > 0), `radial still gated on apply (k=${r.k}, kEst=${r.kEst})`);
}

check(errors.filter((e) => !/Deprecated|favicon/i.test(e)).length === 0, `no page errors (${errors.slice(0, 2).join('; ')})`);
console.log(`\n${count - fails}/${count} passed`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
