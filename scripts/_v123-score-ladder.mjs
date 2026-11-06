import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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
async function dump(file, guides) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await T(() => window.tintwork.run('perspective'));
  const r = await T((guides) => {
    const x = window.tintwork.mxf;
    const { check, fit } = window.tintwork.splitDetectedPlumbSets(x, guides);
    const rows = [];
    for (const s of [0,5,10,15,20,25,-5,-10,-15,-20]) {
      rows.push({ s, sc: window.tintwork.scoreLensThenFullResidual(x, check, window.tintwork.lensSliderToK(s)), n: check.length });
    }
    // also score with only 4 longest check
    const top4 = [...check].sort((a,b) => {
      const la=Math.hypot(a[1][0]-a[0][0],a[1][1]-a[0][1]);
      const lb=Math.hypot(b[1][0]-b[0][0],b[1][1]-b[0][1]);
      return lb-la;
    }).slice(0,4);
    const rows4 = [];
    for (const s of [0,5,10,15,20,-10]) {
      // temporary worst-of-4 by calling score (which medians up to 8)
      rows4.push({ s, sc: window.tintwork.scoreLensThenFullResidual(x, top4, window.tintwork.lensSliderToK(s)) });
    }
    return { checkN: check.length, fitN: fit.length, rows, rows4 };
  }, guides);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  console.log(file, JSON.stringify(r, null, 2));
}
await dump('library.jpg', [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]], [[350, 343], [548, 328]]]);
await dump('brick.jpg', [[[114, 40], [130, 980]], [[920, 50], [900, 970]]]);
await browser.close(); server.close();
