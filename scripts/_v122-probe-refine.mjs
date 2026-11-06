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
async function open(file) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
}
const plumbs = {
  library: [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]], [[350, 343], [548, 328]]],
  brick: [[[114, 40], [130, 980]], [[920, 50], [900, 970]]],
};
const out = {};
for (const [name, guides] of Object.entries(plumbs)) {
  await open(name + '.jpg');
  const r = await T((guides) => {
    window.tintwork.run('perspective');
    const x = window.tintwork.mxf;
    x.plumbs = guides;
    const k = window.tintwork.solvePlumbOnMxf(x);
    return { k, slider: x.lensSlider, meta: x.plumbMeta, scores: {
      s0: window.tintwork.scoreLensThenFullResidual(x, guides, 0),
      sk: window.tintwork.scoreLensThenFullResidual(x, guides, k),
    }};
  }, guides);
  out[name] = r;
  console.log(name, JSON.stringify(r));
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
}
writeFileSync(path.join(HERE, 'docs/audit/workflows-v122-refine.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
