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
async function one(file) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file);
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await T(() => window.tintwork.run('guidedUpright'));
  const r = await T(() => {
    const x = window.tintwork.mxf;
    window.tintwork.applySuggestedGuides(x);
    const g = x.guides || [];
    const isV = (g) => Math.abs(g[1][1]-g[0][1]) >= Math.abs(g[1][0]-g[0][0]);
    return {
      n: g.length, nv: g.filter(isV).length, nh: g.length - g.filter(isV).length,
      gate: window.tintwork.lastSuggestGate,
      status: document.getElementById('status')?.textContent || '',
    };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
}
const out = {};
for (const f of ['v117-cathedral.jpg','v117-interior.jpg','v117-frame.jpg','v117-flat.jpg','library.jpg','c4.jpg','brick.jpg','v117-lowangle.jpg']) {
  out[f] = await one(f);
  console.log(f, JSON.stringify({ n: out[f].n, nv: out[f].nv, nh: out[f].nh, gate: out[f].gate }));
}
writeFileSync(path.join(HERE, 'docs/audit/workflows-v124-gate-trace.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
