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
const guides = [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]], [[350, 343], [548, 328]]];
await page.setInputFiles('#fileInput', { name: 'library.jpg', mimeType: 'image/jpeg', buffer: REAL('library.jpg') });
await page.waitForFunction(() => window.tintwork.doc?.name?.startsWith('library'));
await page.evaluate(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
await page.evaluate(() => window.tintwork.run('perspective'));
const r = await page.evaluate((guides) => {
  const x = window.tintwork.mxf;
  const split = window.tintwork.splitDetectedPlumbSets(x, guides);
  const rows = [];
  for (const s of [0, 5, 10, 15, 20, 25, -10, -20]) {
    rows.push({ s, sc: window.tintwork.scoreLensThenFullResidual(x, split.check, window.tintwork.lensSliderToK(s)) });
  }
  const refined = window.tintwork.refineDistortionByPostFull(x, guides, 0.05);
  const per = guides.map((g, i) => {
    x.plumbs = [g];
    // sample via solve path pieces
    return { i, vert: Math.abs(g[1][1]-g[0][1]) >= Math.abs(g[1][0]-g[0][0]) };
  });
  return { fitN: split.fit.length, checkN: split.check.length, rows, refined: { slider: refined.slider, reason: refined.reason, base0: refined.base0, score: refined.score, pickRejected: refined.pickRejected, signAlt: refined.signAlt, foldSigns: refined.foldSigns }, per };
}, guides);
console.log(JSON.stringify(r, null, 2));
await browser.close(); server.close();
