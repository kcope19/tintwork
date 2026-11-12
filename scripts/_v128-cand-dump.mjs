// Dump exact applySuggestedGuides candidates (cloned construction) on one or more photos.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(HERE, 'scripts/serve.mjs')).href);
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://127.0.0.1:${server.address().port}/?platform=win`);
await page.waitForFunction(() => window.tintwork);
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg);

async function dump(file) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await T(() => window.tintwork.run('guidedUpright'));
  const r = await T(() => {
    const t = window.tintwork, x = t.mxf, mesh = t.mesh, seg = t.segment;
    x.guideMode = true;
    if (!x.pts0) x.pts0 = x.pts.map((p) => [...p]);
    x.pts = x.pts0.map((p) => [...p]);
    const full = t.suggestUprightGuides(x, { max: 4 });
    const base = x.pts0.map((p) => [...p]);
    // Rebuild probes the same way as buildSuggestProbes (not exported)
    const isV = (g) => Math.abs(g[1][1] - g[0][1]) >= Math.abs(g[1][0] - g[0][0]);
    const c = t.compositeCanvas();
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const toDoc = (l) => [[l.x1, l.y1], [l.x2, l.y2]];
    const W = c.width, Hgt = c.height;
    let vL = seg.detectLines(img, { orient: 'v', maxDeg: 25, minLenFrac: 0.12, maxLines: 28, thrFrac: 0.7 });
    let hL = seg.detectLines(img, { orient: 'h', maxDeg: 20, minLenFrac: 0.12, maxLines: 28, thrFrac: 0.7 });
    vL.sort((a, b) => b.len - a.len); hL.sort((a, b) => b.len - a.len);
    const uv = vL.length >= 2 ? seg.estimateUpright(vL, W, Hgt) : { mode: 'none', inliers: [] };
    const uh = hL.length >= 2 ? seg.estimateUpright(hL.map((l) => ({ ...l, x1: l.y1, y1: l.x1, x2: l.y2, y2: l.x2 })), Hgt, W) : { mode: 'none', inliers: [] };
    const vInl = (uv.mode !== 'none' && (uv.inliers || []).length >= 2) ? uv.inliers.map((i) => vL[i]).filter(Boolean).sort((a, b) => b.len - a.len) : [];
    const hInl = (uh.mode !== 'none' && (uh.inliers || []).length >= 2) ? uh.inliers.map((i) => hL[i]).filter(Boolean).sort((a, b) => b.len - a.len) : [];
    let probe = [...vL.slice(0, 6).map(toDoc), ...hL.slice(0, 6).map(toDoc)];
    let gateV = (vInl.length >= 2 ? vInl : vL).slice(0, 6).map(toDoc);
    const hSrc = hInl.length >= 2 ? hInl : hL;
    const hPool = [];
    const span = x.h || Hgt;
    for (const l of hSrc) {
      const d = toDoc(l); const m = (d[0][1] + d[1][1]) / 2;
      if (hPool.every((o) => Math.abs(((o[0][1] + o[1][1]) / 2) - m) >= 0.1 * span)) hPool.push(d);
      if (hPool.length >= 6) break;
    }
    if (gateV.length < 2) gateV = probe.filter(isV);

    const cands = [];
    const consider = (g, source) => {
      if (g.length < 2) return;
      const next = t.uprightFromGuides(base, g, x.w, x.h);
      if (!next || !mesh.perspectiveMesh(x.w, x.h, next)) return;
      const score = t.scoreSegmentsAfter(base, probe, next);
      const nv = g.filter(isV).length, nh = g.length - nv;
      cands.push({ source, score, mixed: nv > 0 && nh > 0, nv, nh, next, guides: g });
    };
    for (const n of [full.length, Math.min(3, full.length), 2]) consider(full.slice(0, n), 'sug');
    const onlyV = full.filter(isV);
    if (onlyV.length >= 2) consider(onlyV.slice(0, 2), 'sugV');
    const onlyH = full.filter((g) => !isV(g));
    if (onlyH.length >= 2) consider(onlyH.slice(0, 2), 'sugH');
    const vProbeOnly = probe.filter(isV);
    const ranked = t.bestVerticalPairGuides(x, { probe: vProbeOnly, minSepFrac: 0.12, maxLines: 8 });
    if (ranked.length >= 2) consider(ranked, 'ranked');
    const top2 = t.diversifyTop2Verticals(x);
    if (top2.length >= 2) consider(top2, 'top2');
    const vPair = (top2.length >= 2 ? top2 : onlyV.slice(0, 2));
    const hCands = [];
    for (const h of hPool) hCands.push(h);
    for (const h of onlyH) {
      const m = (h[0][1] + h[1][1]) / 2;
      if (hCands.every((o) => Math.abs(((o[0][1] + o[1][1]) / 2) - m) >= 0.08 * (x.h || 1))) hCands.push(h);
    }
    if (vPair.length >= 2) {
      for (let i = 0; i < hCands.length; i++) {
        consider([...vPair, hCands[i]], `mixH${i}`);
        for (let j = i + 1; j < Math.min(hCands.length, i + 3); j++) consider([...vPair, hCands[i], hCands[j]], `mixH${i}_${j}`);
      }
    }

    // ALSO: mixes of sugV / ranked / v2-like pairs with the same H (proposed v1.28 candidates)
    const extraPairs = [];
    if (onlyV.length >= 2) extraPairs.push({ name: 'sugV', g: onlyV.slice(0, 2) });
    if (ranked.length >= 2) extraPairs.push({ name: 'ranked', g: ranked });
    const extra = [];
    for (const p of extraPairs) {
      for (let i = 0; i < hCands.length; i++) {
        consider([...p.g, hCands[i]], `extra_${p.name}+H${i}`);
        extra.push(`extra_${p.name}+H${i}`);
        for (let j = i + 1; j < Math.min(hCands.length, i + 3); j++) {
          consider([...p.g, hCands[i], hCands[j]], `extra_${p.name}+H${i}_${j}`);
          extra.push(`extra_${p.name}+H${i}_${j}`);
        }
      }
    }

    const finite = cands.filter((c) => Number.isFinite(c.score));
    const vPure = finite.filter((c) => c.nv >= 2 && c.nh === 0);
    const top2Pref = vPure.find((c) => c.source === 'top2') || null;
    const rankedPref = vPure.filter((c) => c.source === 'ranked').sort((a, b) => a.score - b.score)[0] || null;
    let v2 = top2Pref || vPure.sort((a, b) => a.score - b.score)[0];
    if (top2Pref && rankedPref && rankedPref.score <= top2Pref.score - 0.5) {
      const onTop2R = t.scoreSegmentsAfter(base, top2Pref.guides, rankedPref.next);
      const onTop2T = t.scoreSegmentsAfter(base, top2Pref.guides, top2Pref.next);
      if (Number.isFinite(onTop2R) && Number.isFinite(onTop2T) && onTop2R <= onTop2T + 0.15) v2 = rankedPref;
    }

    const vProbe = gateV.length >= 2 ? gateV : probe.filter(isV);
    const hProbe = probe.filter((g) => !isV(g));
    const mid = (g, axis) => axis === 'x' ? (g[0][0]+g[1][0])/2 : (g[0][1]+g[1][1])/2;
    const describe = (g) => g.map((s) => `${isV(s)?'V':'H'}@${(isV(s)?mid(s,'x'):mid(s,'y')).toFixed(0)}`).join(',');

    const scored = finite.map((c) => {
      const mV = vProbe.length >= 2 ? t.scoreSegmentsAfter(base, vProbe, c.next) : Infinity;
      const vv0 = vProbe.length >= 2 ? t.scoreSegmentsAfter(base, vProbe, v2.next) : Infinity;
      const mH = hProbe.length >= 2 ? t.scoreSegmentsAfter(base, hProbe, c.next) : Infinity;
      const vH = hProbe.length >= 2 ? t.scoreSegmentsAfter(base, hProbe, c.next && v2.next) : Infinity;
      const vH2 = hProbe.length >= 2 ? t.scoreSegmentsAfter(base, hProbe, v2.next) : Infinity;
      const vOk = !(Number.isFinite(mV) && Number.isFinite(vv0) && mV > vv0 + 0.5);
      const vBetter = Number.isFinite(mV) && Number.isFinite(vv0) && mV <= vv0 - 0.15;
      const hBetter = Number.isFinite(mH) && Number.isFinite(vH2) && mH <= vH2 - 2.0;
      const overallBetter = c.score <= v2.score - 0.25;
      const thinH = !(Number.isFinite(mH) && Number.isFinite(vH2));
      const bigOverall = c.score <= v2.score - 2.0;
      let top2Safe = true;
      if (v2.source === 'top2') {
        const onMix = t.scoreSegmentsAfter(base, v2.guides, c.next);
        const onV2 = t.scoreSegmentsAfter(base, v2.guides, v2.next);
        const slack = vBetter ? 0.75 : 0.25;
        top2Safe = !(Number.isFinite(onMix) && Number.isFinite(onV2) && onMix > onV2 + slack);
      }
      const acceptMix = vOk && top2Safe && (vBetter || hBetter || (overallBetter && thinH && bigOverall));
      return {
        source: c.source, extra: String(c.source).startsWith('extra_'),
        n: `${c.nv}V+${c.nh}H`, score: +c.score.toFixed(3),
        mV: +mV.toFixed(3), vv: +vv0.toFixed(3), mH: Number.isFinite(mH) ? +mH.toFixed(3) : null, vH: Number.isFinite(vH2) ? +vH2.toFixed(3) : null,
        vOk, vBetter, hBetter, overallBetter, thinH, bigOverall, top2Safe, acceptMix,
        guides: describe(c.guides),
      };
    });
    scored.sort((a, b) => a.score - b.score);

    // What current code would pick (ignore extra_* )
    const current = scored.filter((c) => !c.extra);
    const currentMixAccept = current.filter((c) => c.acceptMix && c.n !== '2V+0H' && c.n !== '0V+2H');
    const extraAccept = scored.filter((c) => c.extra && c.acceptMix);

    const sameV = (a, b) => {
      // rough: compare V midpoints
    };
    return {
      top2n: top2.length, vPairN: vPair.length, hCands: hCands.length, hPool: hPool.length,
      v2src: v2?.source, v2score: v2?.score, v2guides: v2 ? describe(v2.guides) : null,
      top2guides: describe(top2),
      sugVguides: describe(onlyV.slice(0, 2)),
      rankedguides: describe(ranked),
      vPairSameAsV2: describe(vPair) === (v2 ? describe(v2.guides) : ''),
      nCandsCurrent: current.length,
      nCandsAll: scored.length,
      currentPickMix: currentMixAccept[0] || null,
      currentBest: current[0],
      extraAccept: extraAccept.slice(0, 8),
      currentAccept: currentMixAccept.slice(0, 8),
      allAccept: scored.filter((c) => c.acceptMix && !c.n.startsWith('2V+0') && !c.n.startsWith('0V+2')).slice(0, 12),
      top12: scored.slice(0, 12),
    };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['v126-glass.jpg'];
const out = {};
for (const f of files) {
  console.log('\n==========', f, '==========');
  const r = await dump(f);
  out[f] = r;
  console.log('v2', r.v2src, 'score', r.v2score?.toFixed?.(3), 'guides', r.v2guides);
  console.log('top2', r.top2guides, 'sugV', r.sugVguides, 'ranked', r.rankedguides, 'vPairSameAsV2', r.vPairSameAsV2, 'hCands', r.hCands);
  console.log('current accept mix:', JSON.stringify(r.currentPickMix));
  console.log('extra accept:', JSON.stringify(r.extraAccept, null, 2));
  console.log('all accept (incl extra):');
  for (const c of r.allAccept) console.log(' ', JSON.stringify(c));
  console.log('top12 by score:');
  for (const c of r.top12) console.log(' ', JSON.stringify(c));
}
writeFileSync(path.join(HERE, 'docs/audit/workflows-v128-cand-dump.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
