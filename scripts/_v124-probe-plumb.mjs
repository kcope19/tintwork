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
    const t0 = performance.now();
    const k = window.tintwork.solvePlumbOnMxf(x);
    const ms = performance.now() - t0;
    return { k, slider: x.lensSlider, meta: x.plumbMeta, status: document.getElementById('status')?.textContent || '', wallMs: ms };
  }, guides);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  console.log(label, JSON.stringify({ slider: r.slider, reason: r.meta?.refined?.reason, ms: r.meta?.refined?.ms, wallMs: r.wallMs, base0: r.meta?.refined?.base0, score: r.meta?.refined?.score, worst0: r.meta?.refined?.baseStats?.worst, status: r.status }));
  return r;
}
async function ladder(file, guides, label) {
  await open(file);
  await T(() => window.tintwork.run('perspective'));
  const r = await T((guides) => {
    const x = window.tintwork.mxf;
    const { check } = window.tintwork.splitDetectedPlumbSets(x, guides);
    const top = [...check].sort((a, b) => {
      const la = Math.hypot(a[1][0]-a[0][0], a[1][1]-a[0][1]);
      const lb = Math.hypot(b[1][0]-b[0][0], b[1][1]-b[0][1]);
      return lb - la;
    }).slice(0, 5);
    const rows = [];
    for (const s of [0, 5, 10, 15, 20, -5, -10, -15, -20, -23]) {
      const st = window.tintwork.scoreApplyMeasureStats(x, top, window.tintwork.lensSliderToK(s));
      rows.push({ s, median: st.median, worst: st.worst, n: st.n });
    }
    return { checkN: check.length, rows };
  }, guides);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  console.log(label + ' ladder', JSON.stringify(r));
  return r;
}
const libPlumb = [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]], [[350, 343], [548, 328]]];
const brickA = [[[114, 40], [130, 980]], [[920, 50], [900, 970]]];
const out = {
  libLadder: await ladder('library.jpg', libPlumb, 'lib'),
  brickLadder: await ladder('brick.jpg', brickA, 'brick'),
  library: await plumb('library.jpg', libPlumb, 'library'),
  brickA: await plumb('brick.jpg', brickA, 'brickA'),
};
mkdirSync(path.join(HERE, 'docs/audit'), { recursive: true });
writeFileSync(path.join(HERE, 'docs/audit/workflows-v124-plumb-probe.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
