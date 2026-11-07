// v1.27: Suggest mix when thin H-probe + large overall win (held-out resid); validate set unchanged.
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

check(await T(() => window.tintwork.APP_VERSION) === '1.27.0', `APP_VERSION is 1.27.0 (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check(m?.[1] === '1.27.0', `SW CACHE is 1.27.0 (${m?.[1]})`);
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
    return { ok, n: g.length, nv, nh: g.length - nv, mixed: nv > 0 && g.length - nv > 0, gate: window.tintwork.lastSuggestGate };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
};

// Held-out resid: thin H probe + big overall → mixed
{
  const r = await suggest('v126-resid.jpg');
  check(r.ok && r.mixed && r.nv >= 2 && r.nh >= 1, `resid Suggest mixed (${r.nv}V+${r.nh}H, accept=${r.gate?.acceptMix})`);
  check(r.gate?.thinH === true && r.gate?.bigOverall === true && r.gate?.vOk === true,
    `resid gate thinH+bigOverall+vOk (mS=${r.gate?.mixedScore?.toFixed?.(1)}, v2=${r.gate?.v2score?.toFixed?.(1)})`);
}

// glass still pure-V (vOk false)
{
  const r = await suggest('v126-glass.jpg');
  check(r.ok && !r.mixed && r.nv >= 2, `glass Suggest pure-V (n=${r.n}, nh=${r.nh}, vOk=${r.gate?.vOk})`);
}

// city still mixed
{
  const r = await suggest('v126-city.jpg');
  check(r.ok && r.mixed && r.nh >= 1, `city Suggest mixed (${r.nv}V+${r.nh}H)`);
}

// Validate set: interior/brick/flat/lowangle/geneva pure-V; cathedral/frame/library/c4 mixed
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

{
  const audit = readFileSync(path.join(HERE, 'docs/AUDIT.md'), 'utf8');
  check(/v1\.27\.0/.test(audit) && /thinH|thin H|resid/i.test(audit), 'AUDIT.md has v1.27 thinH/resid note');
}
{
  const bench = readFileSync(path.join(HERE, 'docs/WORKFLOW_BENCHMARK.md'), 'utf8');
  check(/v1\.27 scorecard/i.test(bench), 'WORKFLOW_BENCHMARK.md has v1.27 scorecard');
}

check(errors.length === 0, `no page errors (${errors.slice(0, 2).join('; ')})`);
await browser.close();
if (!process.env.TW_URL) server.close();
console.log(`\n${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
