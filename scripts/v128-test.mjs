// v1.28: Suggest mixes H with suggested V (not only top-2); picker prefers leftover among accepted mixes.
// Glass: mixed ~18.8° with VP-V not worse than pure-V (~4.89° vs ~5.59°). Gates unchanged.
// Fresh held-outs (v128-*) are baseline only. resid is no longer held-out (tuned in v1.27).
// TW_ROOT / TW_URL supported.
import { chromium, webkit } from 'playwright';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
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

check(await T(() => window.tintwork.APP_VERSION) === '1.28.0', `APP_VERSION is 1.28.0 (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check(m?.[1] === '1.28.0', `SW CACHE is 1.28.0 (${m?.[1]})`);
}

const open = async (file, as = file) => {
  await page.setInputFiles('#fileInput', { name: as, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), as, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};

const suggest = async (file) => {
  await open(file);
  await T(() => window.tintwork.run('guidedUpright'));
  const r = await T(() => {
    const x = window.tintwork.mxf;
    const ok = window.tintwork.applySuggestedGuides(x);
    const g = x.guides || [];
    const isV = (s) => Math.abs(s[1][1] - s[0][1]) >= Math.abs(s[1][0] - s[0][0]);
    const nv = g.filter(isV).length;
    return { ok, n: g.length, nv, nh: g.length - nv, mixed: nv > 0 && g.length - nv > 0, gate: window.tintwork.lastSuggestGate, status: document.getElementById('status')?.textContent };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
};

// Glass: mixed, leftover better than pure-V, VP verticals not worse than ~5.59°
{
  const r = await suggest('v126-glass.jpg');
  const g = r.gate || {};
  check(r.ok && r.mixed && r.nv >= 2 && r.nh >= 1, `glass Suggest mixed (${r.nv}V+${r.nh}H, accept=${g.acceptMix})`);
  const vOk = g.vOk === true;
  const notWorse = Number.isFinite(g.mV) && Number.isFinite(g.vv) && g.mV <= g.vv + 0.05;
  check(vOk && notWorse, `glass VP-V not worse than pure-V (mV=${g.mV?.toFixed?.(2)}, vv=${g.vv?.toFixed?.(2)}, vOk=${g.vOk})`);
  check(Number.isFinite(g.mixedScore) && Number.isFinite(g.v2score) && g.mixedScore <= g.v2score - 2.0,
    `glass leftover beats pure-V by ≥2° (${g.mixedScore?.toFixed?.(2)} vs ${g.v2score?.toFixed?.(2)})`);
}

// Resid stays mixed ~3.4° (no longer held-out)
{
  const r = await suggest('v126-resid.jpg');
  check(r.ok && r.mixed && r.nv >= 2 && r.nh >= 1, `resid Suggest mixed (${r.nv}V+${r.nh}H, accept=${r.gate?.acceptMix})`);
}

// City stays mixed (leftover may improve vs ~5.0°)
{
  const r = await suggest('v126-city.jpg');
  check(r.ok && r.mixed && r.nh >= 1, `city Suggest mixed (${r.nv}V+${r.nh}H)`);
}

// Validate set: interior/brick/flat/lowangle/geneva pure-V; cathedral mixed ~1.2°
{
  const r = await suggest('v117-interior.jpg');
  check(r.ok && !r.mixed && r.nv === 2, `interior Suggest pure-V (n=${r.n}, nh=${r.nh})`);
}
{
  const r = await suggest('brick.jpg');
  check(r.ok && !r.mixed && r.nv === 2, `brick Suggest pure-V (n=${r.n}, nh=${r.nh})`);
}
for (const f of ['v117-flat.jpg', 'v117-lowangle.jpg', 'geneva.jpg']) {
  const r = await suggest(f);
  check(r.ok && !r.mixed && r.nv >= 2, `${f} Suggest pure-V (n=${r.n}, nh=${r.nh})`);
}
{
  const r = await suggest('v117-cathedral.jpg');
  check(r.ok && r.mixed && r.nv >= 2 && r.nh >= 1, `cathedral Suggest mixed (${r.nv}V+${r.nh}H)`);
}
for (const [f, minNh] of [['v117-frame.jpg', 1], ['library.jpg', 1], ['c4.jpg', 1]]) {
  const r = await suggest(f);
  check(r.ok && r.mixed && r.nh >= minNh, `${f} Suggest mixed (${r.nv}V+${r.nh}H)`);
}

// Fresh held-outs exist; Suggest returns ≥2 guides (no quality bar; baseline only)
for (const f of ['v128-towers.jpg', 'v128-masonry.jpg', 'v128-balconies.jpg']) {
  check(existsSync(path.join(HERE, 'test-assets/real', f)), `held-out asset ${f} present`);
  const r = await suggest(f);
  check(r.ok && r.n >= 2, `${f} Suggest ≥2 guides (n=${r.n}, mixed=${r.mixed})`);
}

{
  const lic = readFileSync(path.join(HERE, 'test-assets/real/LICENSES.md'), 'utf8');
  check(/v128-towers|v1\.28 held-out/i.test(lic) && /no longer held-out/i.test(lic),
    'LICENSES.md documents v1.28 held-outs and resid no longer held-out');
}
{
  const audit = readFileSync(path.join(HERE, 'docs/AUDIT.md'), 'utf8');
  check(/v1\.28\.0/.test(audit) && /sugV|suggested V/i.test(audit), 'AUDIT.md has v1.28 sugV-mix note');
}
{
  const bench = readFileSync(path.join(HERE, 'docs/WORKFLOW_BENCHMARK.md'), 'utf8');
  check(/v1\.28 scorecard/i.test(bench), 'WORKFLOW_BENCHMARK.md has v1.28 scorecard');
}

check(errors.length === 0, `no page errors (${errors.slice(0, 2).join('; ')})`);
await browser.close();
if (!process.env.TW_URL) server.close();
console.log(`\n${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
