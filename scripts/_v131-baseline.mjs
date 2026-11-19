// v1.31: record Suggest baseline on current v1.30.0 BEFORE any code change
// (fresh CC0 looking-up held-outs v131-*). Includes the regression set.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(HERE, 'scripts/serve.mjs')).href);
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const BASE = `http://127.0.0.1:${server.address().port}/`;

const FILES = [
  // new held-outs (measure first; never tune on these)
  'v131-canyon.jpg', 'v131-willis.jpg', 'v131-white.jpg',
  // v1.30 looking-up set (angle is the v1.31 diagnosis target)
  'v130-angle.jpg', 'v130-highrise.jpg', 'v130-below.jpg',
  // v128 set
  'v128-towers.jpg', 'v128-masonry.jpg', 'v128-balconies.jpg',
  // v126 set
  'v126-glass.jpg', 'v126-city.jpg', 'v126-resid.jpg',
  // regression / validate
  'v117-interior.jpg', 'brick.jpg', 'v117-flat.jpg', 'v117-lowangle.jpg', 'geneva.jpg',
  'v117-cathedral.jpg', 'v117-frame.jpg', 'library.jpg', 'c4.jpg',
];

const out = {
  note: 'Suggest baseline on v1.30.0 BEFORE any v1.31 code change. New v131 held-outs measured first. Fresh page per photo so lastSuggestGate cannot leak. 2026-11-19 America/New_York.',
  app: null,
  rows: {},
};

for (const f of FILES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${BASE}?platform=win`);
  await page.waitForFunction(() => window.tintwork);
  await page.evaluate(() => window.tintwork.engineReady);
  const T = (fn, arg) => page.evaluate(fn, arg);
  if (!out.app) out.app = await T(() => window.tintwork.APP_VERSION);
  await page.setInputFiles('#fileInput', { name: f, mimeType: 'image/jpeg', buffer: REAL(f) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), f, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await T(() => window.tintwork.run('guidedUpright'));
  const r = await T(() => {
    const x = window.tintwork.mxf;
    const ok = window.tintwork.applySuggestedGuides(x);
    const g = x.guides || [];
    const isV = (s) => Math.abs(s[1][1] - s[0][1]) >= Math.abs(s[1][0] - s[0][0]);
    const nv = g.filter(isV).length;
    const status = document.getElementById('status')?.textContent;
    const m = /~([\d.]+)°/.exec(status || '');
    return { ok, n: g.length, nv, nh: g.length - nv, mixed: nv > 0 && g.length - nv > 0, leftover: m ? Number(m[1]) : null, gate: window.tintwork.lastSuggestGate, status };
  });
  await page.close();
  out.rows[f] = r;
  const g = r.gate || {};
  const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—');
  console.log(
    f.padEnd(22),
    r.mixed ? `mixed ${r.nv}V+${r.nh}H` : `pure ${r.nv}V+${r.nh}H`,
    `score=${fmt(g.mixedScore)} v2=${fmt(g.v2score)} mV=${fmt(g.mV)} vv=${fmt(g.vv)} mH=${fmt(g.mH)} vH=${fmt(g.vH)}`,
    `accept=${g.acceptMix} vOk=${g.vOk} thinH=${g.thinH} src=${g.source} v2src=${g.v2src}`,
    `status=${r.status}`,
  );
}

mkdirSync(path.join(HERE, 'docs/audit'), { recursive: true });
const dest = path.join(HERE, 'docs/audit/workflows-v131-holdout-baseline.json');
writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('\nWrote', dest, 'app', out.app);
if (out.app !== '1.30.0') {
  console.error('REFUSING to treat this as a v1.30.0 baseline; app is', out.app);
  process.exit(1);
}
await browser.close(); server.close();
