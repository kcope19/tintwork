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
await page.setInputFiles('#fileInput', { name: 'v117-cathedral.jpg', mimeType: 'image/jpeg', buffer: REAL('v117-cathedral.jpg') });
await page.waitForFunction(() => window.tintwork.doc?.name?.startsWith('v117-cathedral'));
await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
await T(() => window.tintwork.run('guidedUpright'));
const dig = await T(() => {
  const t = window.tintwork, x = t.mxf;
  x.guideMode = true;
  if (!x.pts0) x.pts0 = x.pts.map((p) => [...p]);
  x.pts = x.pts0.map((p) => [...p]);
  const full = t.suggestUprightGuides(x, { max: 4 });
  const base = x.pts0.map((p) => [...p]);
  const isV = (g) => Math.abs(g[1][1] - g[0][1]) >= Math.abs(g[1][0] - g[0][0]);
  let probe = full.slice();
  const det = t.uprightDetectImage?.(x);
  // uprightDetectImage may not be exported — use segment via suggest path
  const cands = [];
  const consider = (g, source) => {
    if (g.length < 2) return;
    const next = t.uprightFromGuides(base, g, x.w, x.h);
    if (!next) return;
    const score = t.scoreSegmentsAfter(base, probe.length >= 2 ? probe : g, next);
    const nv = g.filter(isV).length, nh = g.length - nv;
    cands.push({ source, n: g.length, nv, nh, mixed: nv > 0 && nh > 0, score });
  };
  for (const n of [full.length, Math.min(3, full.length), 2]) consider(full.slice(0, n), 'sug'+n);
  const onlyV = full.filter(isV);
  if (onlyV.length >= 2) consider(onlyV.slice(0, 2), 'sugV');
  const top2 = t.diversifyTop2Verticals?.(x);
  if (top2?.length >= 2) consider(top2, 'top2');
  // Force mixed: 2V+1H from full
  const H = full.filter((g) => !isV(g));
  if (onlyV.length >= 2 && H.length >= 1) consider([...onlyV.slice(0, 2), H[0]], 'forceMix');
  if (onlyV.length >= 2 && H.length >= 2) consider([...onlyV.slice(0, 2), ...H.slice(0, 2)], 'forceMix4');
  // V/H probe scores for forceMix vs top2/sugV
  const v2 = cands.find((c) => c.source === 'top2') || cands.find((c) => c.source === 'sugV');
  const mix = cands.find((c) => c.source === 'forceMix') || cands.find((c) => c.source === 'forceMix4');
  let detail = null;
  if (v2 && mix) {
    const vGuides = (top2?.length >= 2 ? top2 : onlyV.slice(0, 2));
    const mixGuides = mix.source === 'forceMix4' ? [...onlyV.slice(0, 2), ...H.slice(0, 2)] : [...onlyV.slice(0, 2), H[0]];
    const vNext = t.uprightFromGuides(base, vGuides, x.w, x.h);
    const mNext = t.uprightFromGuides(base, mixGuides, x.w, x.h);
    const vProbe = probe.filter(isV);
    const hProbe = probe.filter((g) => !isV(g));
    detail = {
      vv: t.scoreSegmentsAfter(base, vProbe, vNext),
      mV: t.scoreSegmentsAfter(base, vProbe, mNext),
      vH: hProbe.length ? t.scoreSegmentsAfter(base, hProbe, vNext) : null,
      mH: hProbe.length ? t.scoreSegmentsAfter(base, hProbe, mNext) : null,
      v2score: v2.score,
      mixScore: mix.score,
      onTop2Mix: t.scoreSegmentsAfter(base, vGuides, mNext),
      onTop2V: t.scoreSegmentsAfter(base, vGuides, vNext),
    };
  }
  return { fullN: full.length, fullV: full.filter(isV).length, fullH: full.filter((g) => !isV(g)).length, cands, detail };
});
console.log(JSON.stringify(dig, null, 2));
writeFileSync(path.join(HERE, 'docs/audit/workflows-v124-cathedral-dig.json'), JSON.stringify(dig, null, 2));
await browser.close(); server.close();
