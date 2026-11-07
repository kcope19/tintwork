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
const out = { note: 'Held-out Suggest AFTER v1.27 thinH gate on these files. 2026-11-06 America/New_York.', rows: {} };
for (const f of ['v126-city.jpg','v126-glass.jpg','v126-resid.jpg','v117-cathedral.jpg']) {
  await page.setInputFiles('#fileInput', { name: f, mimeType: 'image/jpeg', buffer: REAL(f) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), f);
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await T(() => window.tintwork.run('guidedUpright'));
  out.rows[f] = await T(() => {
    const x = window.tintwork.mxf;
    window.tintwork.applySuggestedGuides(x);
    const g = x.guides || [];
    const isV = (s) => Math.abs(s[1][1]-s[0][1]) >= Math.abs(s[1][0]-s[0][0]);
    const nv = g.filter(isV).length;
    return { n:g.length, nv, nh:g.length-nv, mixed: nv>0 && g.length-nv>0, gate: window.tintwork.lastSuggestGate, status: document.getElementById('status')?.textContent };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  console.log(f, JSON.stringify({ mixed: out.rows[f].mixed, n: out.rows[f].n, nv: out.rows[f].nv, nh: out.rows[f].nh, accept: out.rows[f].gate?.acceptMix, mV: out.rows[f].gate?.mV, vv: out.rows[f].gate?.vv }));
}
writeFileSync(path.join(HERE, 'docs/audit/workflows-v127-holdout.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
