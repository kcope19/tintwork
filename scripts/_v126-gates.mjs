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
const out = {};
for (const f of ['v117-cathedral.jpg','v117-interior.jpg','brick.jpg','v117-frame.jpg','library.jpg','c4.jpg','v117-lowangle.jpg','v117-flat.jpg','geneva.jpg']) {
  await page.setInputFiles('#fileInput', { name: f, mimeType: 'image/jpeg', buffer: REAL(f) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), f);
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await T(() => window.tintwork.run('guidedUpright'));
  out[f] = await T(() => {
    const x = window.tintwork.mxf;
    window.tintwork.applySuggestedGuides(x);
    const g = x.guides || [];
    const isV = (s) => Math.abs(s[1][1]-s[0][1]) >= Math.abs(s[1][0]-s[0][0]);
    const nv = g.filter(isV).length;
    return { n: g.length, nv, nh: g.length-nv, mixed: nv>0 && g.length-nv>0, gate: window.tintwork.lastSuggestGate, status: document.getElementById('status')?.textContent };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  console.log(f, JSON.stringify({ mixed: out[f].mixed, n: out[f].n, nv: out[f].nv, nh: out[f].nh, gate: out[f].gate }));
}
writeFileSync(path.join(HERE, 'docs/audit/workflows-v126-gates.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
