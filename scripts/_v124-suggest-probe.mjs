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
const open = async (file) => {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};
async function suggest(file) {
  await open(file);
  await T(() => window.tintwork.run('guidedUpright'));
  const r = await T(() => {
    const x = window.tintwork.mxf;
    // replicate applySuggestedGuides decision internals by calling it and reading guides
    const ok = window.tintwork.applySuggestedGuides(x);
    const guides = (x.guides || []).map((g) => {
      const v = Math.abs(g[1][1]-g[0][1]) >= Math.abs(g[1][0]-g[0][0]);
      return { v, len: Math.hypot(g[1][0]-g[0][0], g[1][1]-g[0][1]) };
    });
    const nv = guides.filter((g) => g.v).length, nh = guides.length - nv;
    return { ok, n: guides.length, nv, nh, mixed: nv > 0 && nh > 0, status: document.getElementById('status')?.textContent || '' };
  });
  await T(() => window.tintwork.cancelMeshXf?.({ quiet: true }));
  console.log(file, JSON.stringify(r));
  return r;
}
const out = {};
for (const f of ['v117-cathedral.jpg','v117-frame.jpg','v117-flat.jpg','v117-interior.jpg','v117-lowangle.jpg','library.jpg','c4.jpg','brick.jpg']) {
  out[f] = await suggest(f);
}
writeFileSync(path.join(HERE, 'docs/audit/workflows-v124-suggest-probe.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
