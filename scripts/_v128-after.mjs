// v1.28: record Suggest baseline on current v1.27.0 BEFORE any code change.
// Includes new CC0 held-outs (v128-*) and the regression set.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(HERE, 'scripts/serve.mjs')).href);
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://127.0.0.1:${server.address().port}/?platform=win`);
await page.waitForFunction(() => window.tintwork);
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg);

const FILES = [
  // new held-outs
  'v128-towers.jpg', 'v128-masonry.jpg', 'v128-balconies.jpg',
  // v126 set (glass is the v1.28 target; resid no longer held-out)
  'v126-glass.jpg', 'v126-city.jpg', 'v126-resid.jpg',
  // regression / validate
  'v117-interior.jpg', 'brick.jpg', 'v117-flat.jpg', 'v117-lowangle.jpg', 'geneva.jpg',
  'v117-cathedral.jpg', 'v117-frame.jpg', 'library.jpg', 'c4.jpg',
];

const out = {
  note: 'Suggest AFTER v1.28 mix-V-pairs change (gates unchanged). 2026-11-12 America/New_York.',
  app: await T(() => window.tintwork.APP_VERSION),
  rows: {},
};

for (const f of FILES) {
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
    return { ok, n: g.length, nv, nh: g.length - nv, mixed: nv > 0 && g.length - nv > 0, gate: window.tintwork.lastSuggestGate, status };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  out.rows[f] = r;
  const g = r.gate || {};
  const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—');
  console.log(
    f.padEnd(22),
    r.mixed ? `mixed ${r.nv}V+${r.nh}H` : `pure ${r.nv}V+${r.nh}H`,
    `score=${fmt(g.mixedScore)} v2=${fmt(g.v2score)} mV=${fmt(g.mV)} vv=${fmt(g.vv)} mH=${fmt(g.mH)} vH=${fmt(g.vH)}`,
    `accept=${g.acceptMix} vOk=${g.vOk} thinH=${g.thinH} src=${g.source} v2src=${g.v2src}`,
  );
}

mkdirSync(path.join(HERE, 'docs/audit'), { recursive: true });
const dest = path.join(HERE, 'docs/audit/workflows-v128-after.json');
writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('\nWrote', dest, 'app', out.app);
await browser.close(); server.close();
