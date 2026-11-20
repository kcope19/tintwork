// v1.29: Suggest overall do-no-harm. A mix that leaves >1° more leftover tilt than pure-V is refused
// even if a directional gate passes. v128-towers (was mixed ~43.9°) now stays pure-V ~32.2°.
// towers is no longer held-out (this change was motivated by it).
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

check(['1.29.0','1.30.0','1.31.0','1.32.0'].includes(await T(() => window.tintwork.APP_VERSION)), `APP_VERSION is 1.29.0 (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check((m?.[1] === '1.29.0' || (m?.[1] === '1.30.0' || (m?.[1] === '1.31.0' || m?.[1] === '1.32.0'))), `SW CACHE is 1.29.0 (${m?.[1]})`);
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

// Towers: leftover must stay ≤33° (v1.29 was pure-V ~32.2°; v1.30 may mix if vOk).
{
  const r = await suggest('v128-towers.jpg');
  const m = /~([\d.]+)°/.exec(r.status || '');
  check(r.ok && r.nv >= 2, `towers Suggest ≥2V (${r.nv}V+${r.nh}H)`);
  check(m && Number(m[1]) <= 33.0, `towers leftover ≤33° (status ~${m?.[1]}°)`);
  check(!r.mixed || r.gate?.vOk === true, `towers mix only if vOk (${r.mixed}, vOk=${r.gate?.vOk})`);
}
// Gate exposes noOverallHarm on an accepted mix
{
  const r = await suggest('v126-glass.jpg');
  check(r.mixed && r.gate?.noOverallHarm === true, `glass still mixed with noOverallHarm (${r.nv}V+${r.nh}H)`);
}
// Every other row unchanged from v1.28
for (const [f, mixed] of [['v128-balconies.jpg', true], ['v126-city.jpg', true], ['v126-resid.jpg', true],
  ['v117-cathedral.jpg', true], ['v117-frame.jpg', true], ['library.jpg', true], ['c4.jpg', true],
  ['v128-masonry.jpg', false], ['brick.jpg', false], ['v117-flat.jpg', false],
  ['v117-lowangle.jpg', false], ['geneva.jpg', false]]) {
  const r = await suggest(f);
  check(r.ok && r.mixed === mixed, `${f} Suggest ${mixed ? 'mixed' : 'pure-V'} as in v1.28 (${r.nv}V+${r.nh}H)`);
}

// Interior: v1.29 was pure-V; v1.30 may mix when leftover improves and vOk holds.
{
  const r = await suggest('v117-interior.jpg');
  const m = /~([\d.]+)°/.exec(r.status || '');
  const left = m ? Number(m[1]) : Infinity;
  const ok = r.ok && r.nv === 2 && (!r.mixed || (r.gate?.vOk === true && left <= 4.5));
  check(ok, `interior Suggest pure-V or vOk mixed ≤4.5° (${r.nv}V+${r.nh}H, leftover=${m?.[1]})`);
}
{
  const audit = readFileSync(path.join(HERE, 'docs/AUDIT.md'), 'utf8');
  check(/v1\.29\.0/.test(audit) && /noOverallHarm|overall do-no-harm/i.test(audit), 'AUDIT.md has v1.29 do-no-harm note');
}
{
  const bench = readFileSync(path.join(HERE, 'docs/WORKFLOW_BENCHMARK.md'), 'utf8');
  check(/v1\.29 scorecard/i.test(bench), 'WORKFLOW_BENCHMARK.md has v1.29 scorecard');
}

check(errors.length === 0, `no page errors (${errors.slice(0, 2).join('; ')})`);
await browser.close();
if (!process.env.TW_URL) server.close();
console.log(`\n${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
