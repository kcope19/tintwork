import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const HERE = '/workspace/photo-editor';
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const BASE = 'https://kcope19.github.io/tintwork/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}?platform=win`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.tintwork); await page.evaluate(() => window.tintwork.engineReady);
console.log('live', await page.evaluate(() => window.tintwork.APP_VERSION));
const T = (fn, arg) => page.evaluate(fn, arg);
const open = async (file) => {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 60000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};
async function shot(name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(HERE, 'screenshots', name), fullPage: false });
  console.log('wrote', name);
}
await open('library.jpg');
await T(() => window.tintwork.run('perspective'));
await T(() => {
  const x = window.tintwork.mxf;
  x.plumbs = [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]], [[350, 343], [548, 328]]];
  window.tintwork.solvePlumbOnMxf(x);
});
await shot('124-live-library-plumb.png');
await T(() => window.tintwork.cancelMeshXf({ quiet: true }));

await open('brick.jpg');
await T(() => window.tintwork.run('perspective'));
await T(() => {
  const x = window.tintwork.mxf;
  x.plumbs = [[[114, 40], [130, 980]], [[920, 50], [900, 970]]];
  window.tintwork.solvePlumbOnMxf(x);
});
await shot('124-live-brick-plumb.png');
await T(() => window.tintwork.cancelMeshXf({ quiet: true }));

await open('c4.jpg');
await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 30000 });
await shot('124-live-c4-full.png');

await open('geneva.jpg');
await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
await page.waitForTimeout(1500);
await shot('124-live-geneva-refuse.png');

await open('v117-cathedral.jpg');
await T(() => window.tintwork.run('guidedUpright'));
await T(() => window.tintwork.applySuggestedGuides(window.tintwork.mxf));
await page.waitForTimeout(500);
await shot('124-live-cathedral-suggest.png');
await T(() => window.tintwork.cancelMeshXf({ quiet: true }));

await browser.close();
