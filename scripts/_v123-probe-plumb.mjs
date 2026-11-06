import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
async function plumb(file, guides, label) {
  await open(file);
  await T(() => window.tintwork.run('perspective'));
  const r = await T((guides) => {
    const x = window.tintwork.mxf;
    x.plumbs = guides;
    const k = window.tintwork.solvePlumbOnMxf(x);
    const st = document.getElementById('status')?.textContent || '';
    return { k, slider: x.lensSlider, meta: x.plumbMeta, status: st };
  }, guides);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  console.log(label, JSON.stringify({ slider: r.slider, reason: r.meta?.refined?.reason, checkN: r.meta?.refined?.checkN, base0: r.meta?.refined?.base0, score: r.meta?.refined?.score, status: r.status, k0: r.meta?.k0, k0Alt: r.meta?.refined?.k0Alt }));
  return r;
}
const libPlumb = [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]], [[350, 343], [548, 328]]];
const brickA = [[[114, 40], [130, 980]], [[920, 50], [900, 970]]];
const out = {
  library: await plumb('library.jpg', libPlumb, 'library'),
  brickA: await plumb('brick.jpg', brickA, 'brickA'),
};
// brick B: detected far Vs
await open('brick.jpg');
await T(() => window.tintwork.run('perspective'));
const brickBguides = await T(() => {
  const x = window.tintwork.mxf, img = x.small, sc = x.k || 1;
  const vl = window.tintwork.segment.detectLines(img, { orient: 'v', maxDeg: 25, minLenFrac: 0.1, maxLines: 16, thrFrac: 0.65 });
  const toDoc = (l) => [[l.x1 / sc + x.ox, l.y1 / sc + x.oy], [l.x2 / sc + x.ox, l.y2 / sc + x.oy]];
  const aXs = [122, 910];
  const far = vl.map(toDoc).filter((g) => {
    const mx = (g[0][0] + g[1][0]) / 2;
    return aXs.every((ax) => Math.abs(mx - ax) > 80);
  }).sort((a, b) => Math.hypot(b[1][0]-b[0][0], b[1][1]-b[0][1]) - Math.hypot(a[1][0]-a[0][0], a[1][1]-a[0][1]));
  return far.slice(0, 2);
});
await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
out.brickBguides = brickBguides;
out.brickB = brickBguides.length >= 2 ? await plumb('brick.jpg', brickBguides, 'brickB') : { err: 'no guides' };

mkdirSync(path.join(HERE, 'docs/audit'), { recursive: true });
writeFileSync(path.join(HERE, 'docs/audit/workflows-v123-plumb-probe.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
