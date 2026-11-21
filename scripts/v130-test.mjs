// v1.30: Suggest H-candidate pool keeps same-row lines on a different facade
// and slightly shorter edges (minLenFrac 0.08). Probe/gate scoring is unchanged;
// no acceptMix gate was loosened. Tune: towers (in-sample). Held-outs v130-*
// were measured on v1.29.0 before any change and not used to tune.
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

check(['1.30.0','1.31.0','1.32.0','1.33.0','1.34.0','1.34.1'].includes(await T(() => window.tintwork.APP_VERSION)), `APP_VERSION is 1.30.0 (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check((m?.[1] === '1.30.0' || (m?.[1] === '1.31.0' || (m?.[1] === '1.32.0' || (m?.[1] === '1.33.0' || (m?.[1] === '1.34.0' || m?.[1] === '1.34.1'))))), `SW CACHE is 1.30.0 (${m?.[1]})`);
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
const leftover = (r) => {
  const m = /~([\d.]+)°/.exec(r.status || '');
  return m ? Number(m[1]) : NaN;
};

// In-sample towers: mixed, leftover better than v1.29's 32.2°, vOk
{
  const r = await suggest('v128-towers.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && r.nv >= 2 && r.nh >= 1, `towers Suggest mixed (${r.nv}V+${r.nh}H)`);
  check(Number.isFinite(L) && L <= 27.0, `towers leftover ≤27° (was ~32.2°; status ~${L}°)`);
  check(r.gate?.vOk === true && r.gate?.noOverallHarm === true, `towers mix vOk and noOverallHarm (vOk=${r.gate?.vOk}, mV=${r.gate?.mV?.toFixed?.(2)}, vv=${r.gate?.vv?.toFixed?.(2)})`);
}

// Held-outs (not used to tune): none worse than v1.29.0 baseline; highrise improves
{
  check(existsSync(path.join(HERE, 'test-assets/real', 'v130-angle.jpg')), 'v130-angle.jpg present');
  const r = await suggest('v130-angle.jpg');
  const L = leftover(r);
  check(r.ok && r.nv >= 2 && Number.isFinite(L) && L <= 18.8, `angle leftover ≤18.8° (baseline 18.6°; ~${L}° ${r.nv}V+${r.nh}H)`);
}
{
  check(existsSync(path.join(HERE, 'test-assets/real', 'v130-highrise.jpg')), 'v130-highrise.jpg present');
  const r = await suggest('v130-highrise.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && Number.isFinite(L) && L <= 25.0, `highrise leftover ≤25° (baseline 27.0°; ~${L}°)`);
  check(r.gate?.vOk === true, `highrise mix vOk (mV=${r.gate?.mV?.toFixed?.(2)}, vv=${r.gate?.vv?.toFixed?.(2)})`);
}
{
  check(existsSync(path.join(HERE, 'test-assets/real', 'v130-below.jpg')), 'v130-below.jpg present');
  const r = await suggest('v130-below.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && Number.isFinite(L) && L <= 0.7, `below leftover ≤0.7° (baseline 0.5°; ~${L}° ${r.nv}V+${r.nh}H)`);
}

// Interior may now mix; leftover must improve and VP-V stay within vOk
{
  const r = await suggest('v117-interior.jpg');
  const L = leftover(r);
  check(r.ok && r.nv === 2 && r.mixed && r.gate?.vOk === true && L <= 4.5,
    `interior Suggest vOk mixed ≤4.5° (was 6.6° pure-V; ${r.nv}V+${r.nh}H ~${L}°, mV=${r.gate?.mV?.toFixed?.(2)}, vv=${r.gate?.vv?.toFixed?.(2)})`);
}

// Glass leftover also improves; vOk holds
{
  const r = await suggest('v126-glass.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && r.gate?.vOk === true && L <= 14.0, `glass leftover ≤14° (was 18.8°; ~${L}°, vOk=${r.gate?.vOk})`);
}

// Pure-V validate set unchanged
for (const f of ['v128-masonry.jpg', 'brick.jpg', 'v117-flat.jpg', 'v117-lowangle.jpg', 'geneva.jpg']) {
  const r = await suggest(f);
  check(r.ok && !r.mixed && r.nv >= 2, `${f} Suggest still pure-V (${r.nv}V+${r.nh}H)`);
}
// Mixed validate set still mixed
for (const f of ['v128-balconies.jpg', 'v126-city.jpg', 'v126-resid.jpg', 'v117-cathedral.jpg', 'v117-frame.jpg', 'library.jpg', 'c4.jpg']) {
  const r = await suggest(f);
  check(r.ok && r.mixed, `${f} Suggest still mixed (${r.nv}V+${r.nh}H)`);
}

{
  const audit = readFileSync(path.join(HERE, 'docs/AUDIT.md'), 'utf8');
  check(/v1\.30\.0/.test(audit) && /same-row|facade|minLenFrac 0\.08/i.test(audit), 'AUDIT.md has v1.30 H-pool note');
}
{
  const bench = readFileSync(path.join(HERE, 'docs/WORKFLOW_BENCHMARK.md'), 'utf8');
  check(/v1\.30 scorecard/i.test(bench), 'WORKFLOW_BENCHMARK.md has v1.30 scorecard');
}
{
  const lic = readFileSync(path.join(HERE, 'test-assets/real/LICENSES.md'), 'utf8');
  check(/v130-angle|v1\.30 held-out/i.test(lic), 'LICENSES.md documents v1.30 held-outs');
}

check(errors.length === 0, `no page errors (${errors.slice(0, 2).join('; ')})`);
await browser.close();
if (!process.env.TW_URL) server.close();
console.log(`\n${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
