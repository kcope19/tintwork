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
async function dig(file) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file);
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await T(() => window.tintwork.run('guidedUpright'));
  const r = await T(() => {
    const t = window.tintwork, x = t.mxf;
    x.guideMode = true;
    if (!x.pts0) x.pts0 = x.pts.map((p) => [...p]);
    const base = x.pts0.map((p) => [...p]);
    const full = t.suggestUprightGuides(x, { max: 4 });
    const isV = (g) => Math.abs(g[1][1] - g[0][1]) >= Math.abs(g[1][0] - g[0][0]);
    const top2 = t.diversifyTop2Verticals(x);
    const vNext = t.uprightFromGuides(base, top2, x.w, x.h);
    const mNext = t.uprightFromGuides(base, full, x.w, x.h);
    let probe = full.slice();
    try {
      // rebuild probe like applySuggestedGuides
      const detImg = x.small; // fallback
    } catch {}
    const vProbe = full.filter(isV);
    // broader V probe from detect
    return {
      fullNV: full.filter(isV).length, fullNH: full.length - full.filter(isV).length,
      v2score: t.scoreSegmentsAfter(base, full, vNext),
      mixScore: t.scoreSegmentsAfter(base, full, mNext),
      vv: t.scoreSegmentsAfter(base, vProbe, vNext),
      mV: t.scoreSegmentsAfter(base, vProbe, mNext),
      onTop2V: t.scoreSegmentsAfter(base, top2, vNext),
      onTop2Mix: t.scoreSegmentsAfter(base, top2, mNext),
      hOnly: (() => {
        const h = full.filter((g) => !isV(g));
        if (h.length < 1) return null;
        return { vH: t.scoreSegmentsAfter(base, h, vNext), mH: t.scoreSegmentsAfter(base, h, mNext) };
      })(),
    };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
}
const out = {};
for (const f of ['v117-cathedral.jpg','v117-interior.jpg','v117-frame.jpg','v117-flat.jpg','library.jpg','brick.jpg','c4.jpg']) {
  out[f] = await dig(f);
  console.log(f, JSON.stringify(out[f]));
}
writeFileSync(path.join(HERE, 'docs/audit/workflows-v124-suggest-metrics.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
