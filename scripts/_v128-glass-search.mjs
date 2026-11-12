// v1.28: enumerate V-pairs × H mixes on glass (and optionally other files)
// looking for leftover tilt better than pure-V WITHOUT VP-inlier V worse than vv.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

async function search(file) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await T(() => window.tintwork.run('guidedUpright'));
  const r = await T(() => {
    const t = window.tintwork, x = t.mxf, seg = t.segment, mesh = t.mesh;
    x.guideMode = true;
    if (!x.pts0) x.pts0 = x.pts.map((p) => [...p]);
    const base = x.pts0.map((p) => [...p]);
    const isV = (g) => Math.abs(g[1][1] - g[0][1]) >= Math.abs(g[1][0] - g[0][0]);
    const midX = (g) => (g[0][0] + g[1][0]) / 2;
    const midY = (g) => (g[0][1] + g[1][1]) / 2;
    const glen = (g) => Math.hypot(g[1][0] - g[0][0], g[1][1] - g[0][1]);

    // Detect on full composite (same as uprightDetectImage)
    const c = t.compositeCanvas();
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const toDoc = (l) => [[l.x1, l.y1], [l.x2, l.y2]];
    const W = c.width, H = c.height;

    let vLines = seg.detectLines(img, { orient: 'v', maxDeg: 25, minLenFrac: 0.12, maxLines: 28, thrFrac: 0.7 });
    let hLines = seg.detectLines(img, { orient: 'h', maxDeg: 20, minLenFrac: 0.12, maxLines: 28, thrFrac: 0.7 });
    vLines.sort((a, b) => b.len - a.len); hLines.sort((a, b) => b.len - a.len);
    const uv = vLines.length >= 2 ? seg.estimateUpright(vLines, W, H) : { mode: 'none', inliers: [] };
    const uh = hLines.length >= 2 ? seg.estimateUpright(hLines.map((l) => ({ ...l, x1: l.y1, y1: l.x1, x2: l.y2, y2: l.x2 })), H, W) : { mode: 'none', inliers: [] };
    const vInl = (uv.mode !== 'none' && (uv.inliers || []).length >= 2)
      ? uv.inliers.map((i) => vLines[i]).filter(Boolean).sort((a, b) => b.len - a.len) : [];
    const hInl = (uh.mode !== 'none' && (uh.inliers || []).length >= 2)
      ? uh.inliers.map((i) => hLines[i]).filter(Boolean).sort((a, b) => b.len - a.len) : [];

    const gateV = (vInl.length >= 2 ? vInl : vLines).slice(0, 6).map(toDoc);
    const gateH = (hInl.length >= 2 ? hInl : hLines).slice(0, 6).map(toDoc);
    const broad = [...vLines.slice(0, 6).map(toDoc), ...hLines.slice(0, 6).map(toDoc)];
    const hProbe = broad.filter((g) => !isV(g));
    const vProbeBroad = broad.filter(isV);

    // Diversified V and H pools (wider than current top-2 / hPool of 6)
    const vPool = [];
    for (const l of (vInl.length >= 2 ? [...vInl, ...vLines] : vLines)) {
      const d = toDoc(l);
      if (vPool.every((o) => Math.abs(midX(o) - midX(d)) >= 0.10 * (x.w || W))) vPool.push(d);
      if (vPool.length >= 8) break;
    }
    const hPool = [];
    for (const l of (hInl.length >= 2 ? [...hInl, ...hLines] : hLines)) {
      const d = toDoc(l);
      if (hPool.every((o) => Math.abs(midY(o) - midY(d)) >= 0.08 * (x.h || H))) hPool.push(d);
      if (hPool.length >= 8) break;
    }

    const top2 = t.diversifyTop2Verticals(x);
    const ranked = t.bestVerticalPairGuides(x, { probe: vProbeBroad, minSepFrac: 0.12, maxLines: 8 });
    const sug = t.suggestUprightGuides(x, { max: 4 });
    const sugV = sug.filter(isV);
    const considerPairs = [];
    const addPair = (name, g) => {
      if (!g || g.length < 2) return;
      const a = g[0], b = g[1];
      const key = [midX(a).toFixed(1), midX(b).toFixed(1)].sort().join('|');
      if (considerPairs.some((p) => p.key === key)) return;
      const next = t.uprightFromGuides(base, [a, b], x.w, x.h);
      if (!next || !mesh.perspectiveMesh(x.w, x.h, next)) return;
      considerPairs.push({ name, guides: [a, b], next, key });
    };
    addPair('top2', top2);
    addPair('ranked', ranked);
    addPair('sugV', sugV);
    // all well-separated V pairs from the pool
    for (let i = 0; i < vPool.length; i++) {
      for (let j = i + 1; j < vPool.length; j++) {
        const a = vPool[i], b = vPool[j];
        if (Math.min(glen(a), glen(b)) < 0.4 * Math.max(glen(a), glen(b))) continue;
        if (Math.abs(midX(a) - midX(b)) < 0.12 * (x.w || W)) continue;
        addPair(`V${i}_${j}`, [a, b]);
      }
    }

    const scoreOf = (guides) => {
      const next = t.uprightFromGuides(base, guides, x.w, x.h);
      if (!next || !mesh.perspectiveMesh(x.w, x.h, next)) return null;
      const nv = guides.filter(isV).length, nh = guides.length - nv;
      return {
        next, nv, nh,
        score: t.scoreSegmentsAfter(base, broad, next),
        mV: gateV.length >= 2 ? t.scoreSegmentsAfter(base, gateV, next) : Infinity,
        mH: hProbe.length >= 2 ? t.scoreSegmentsAfter(base, hProbe, next) : Infinity,
        mVbroad: vProbeBroad.length >= 2 ? t.scoreSegmentsAfter(base, vProbeBroad, next) : Infinity,
        onTop2: top2.length >= 2 ? t.scoreSegmentsAfter(base, top2, next) : Infinity,
      };
    };

    // Pure-V baselines
    const pureV = considerPairs.map((p) => {
      const s = scoreOf(p.guides);
      return s ? { name: p.name, ...s } : null;
    }).filter(Boolean);
    pureV.sort((a, b) => a.score - b.score);
    // Reference: current Suggest v2 — prefer top2 if present else best pure-V by current policy
    const v2ref = pureV.find((p) => p.name === 'top2') || pureV[0];
    const vv = v2ref ? v2ref.mV : Infinity;
    const v2score = v2ref ? v2ref.score : Infinity;
    const vH = v2ref ? v2ref.mH : Infinity;
    const onV2 = v2ref ? v2ref.onTop2 : 0;

    const cands = [];
    const push = (name, guides) => {
      const s = scoreOf(guides);
      if (!s) return;
      const vOk = !(Number.isFinite(s.mV) && Number.isFinite(vv) && s.mV > vv + 0.5);
      const vNotWorse = !(Number.isFinite(s.mV) && Number.isFinite(vv) && s.mV > vv + 0.05);
      const vBetter = Number.isFinite(s.mV) && Number.isFinite(vv) && s.mV <= vv - 0.15;
      const hBetter = Number.isFinite(s.mH) && Number.isFinite(vH) && s.mH <= vH - 2.0;
      const thinH = !(Number.isFinite(s.mH) && Number.isFinite(vH));
      const overallBetter = s.score <= v2score - 0.25;
      const bigOverall = s.score <= v2score - 2.0;
      const slack = vBetter ? 0.75 : 0.25;
      const top2Safe = !(Number.isFinite(s.onTop2) && Number.isFinite(onV2) && s.onTop2 > onV2 + slack);
      const acceptExisting = vOk && top2Safe && (vBetter || hBetter || (overallBetter && thinH && bigOverall));
      const winNoWorseV = overallBetter && vNotWorse;
      cands.push({
        name, n: guides.length, nv: s.nv, nh: s.nh,
        score: s.score, mV: s.mV, mH: s.mH, mVbroad: s.mVbroad, onTop2: s.onTop2,
        vOk, vNotWorse, vBetter, hBetter, thinH, overallBetter, bigOverall, top2Safe,
        acceptExisting, winNoWorseV,
      });
    };

    // mixes: each V pair + each H, + H pairs
    for (const p of considerPairs) {
      push(p.name, p.guides);
      for (let i = 0; i < hPool.length; i++) {
        push(`${p.name}+H${i}`, [...p.guides, hPool[i]]);
        for (let j = i + 1; j < hPool.length; j++) {
          push(`${p.name}+H${i}_${j}`, [...p.guides, hPool[i], hPool[j]]);
        }
      }
    }

    const summary = (arr) => arr.slice(0, 12).map((c) => ({
      name: c.name, n: `${c.nv}V+${c.nh}H`, score: +c.score.toFixed(3),
      mV: +c.mV.toFixed(3), mH: Number.isFinite(c.mH) ? +c.mH.toFixed(3) : null,
      vOk: c.vOk, vNotWorse: c.vNotWorse, vBetter: c.vBetter, hBetter: c.hBetter,
      acceptExisting: c.acceptExisting, top2Safe: c.top2Safe,
    }));

    const wins = cands.filter((c) => c.winNoWorseV).sort((a, b) => a.score - b.score || a.mV - b.mV);
    const accept = cands.filter((c) => c.acceptExisting && c.nh > 0).sort((a, b) => a.score - b.score || a.mV - b.mV);
    const vOkOverall = cands.filter((c) => c.vOk && c.overallBetter && c.nh > 0).sort((a, b) => a.score - b.score || a.mV - b.mV);
    const bestOverall = [...cands].sort((a, b) => a.score - b.score)[0] || null;
    const bestVsafe = [...cands].filter((c) => c.vNotWorse).sort((a, b) => a.score - b.score)[0] || null;

    return {
      detect: { nV: vLines.length, nH: hLines.length, vInl: vInl.length, hInl: hInl.length, uv: uv.mode, uh: uh.mode, vPool: vPool.length, hPool: hPool.length, nPairs: considerPairs.length, nCands: cands.length },
      ref: { v2name: v2ref?.name, v2score, vv, vH, onV2 },
      nWinNoWorseV: wins.length,
      nAcceptExistingMix: accept.length,
      nVOkOverallMix: vOkOverall.length,
      wins: summary(wins),
      acceptExistingMix: summary(accept),
      vOkOverallMix: summary(vOkOverall),
      bestOverall: bestOverall ? summary([bestOverall])[0] : null,
      bestVsafe: bestVsafe ? summary([bestVsafe])[0] : null,
      pureVtop: summary(pureV),
    };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['v126-glass.jpg'];
const out = { note: 'v1.28 glass-style guide enumeration on v1.27.0 (no code change). 2026-11-12 America/New_York.', rows: {} };
for (const f of files) {
  console.log('\n==========', f, '==========');
  const r = await search(f);
  out.rows[f] = r;
  console.log('detect', JSON.stringify(r.detect));
  console.log('ref', r.ref.v2name, 'v2score', r.ref.v2score?.toFixed?.(3), 'vv', r.ref.vv?.toFixed?.(3), 'vH', r.ref.vH?.toFixed?.(3));
  console.log('wins with overall better AND VP-V not worse:', r.nWinNoWorseV);
  for (const w of r.wins.slice(0, 8)) console.log('  WIN', JSON.stringify(w));
  console.log('mixes that pass EXISTING gates:', r.nAcceptExistingMix);
  for (const w of r.acceptExistingMix.slice(0, 8)) console.log('  ACCEPT', JSON.stringify(w));
  console.log('mixes with vOk + overallBetter (may fail other flags):', r.nVOkOverallMix);
  for (const w of r.vOkOverallMix.slice(0, 8)) console.log('  VOK', JSON.stringify(w));
  console.log('bestOverall', JSON.stringify(r.bestOverall));
  console.log('bestVsafe', JSON.stringify(r.bestVsafe));
  console.log('pureV', JSON.stringify(r.pureVtop.slice(0, 5)));
}

mkdirSync(path.join(HERE, 'docs/audit'), { recursive: true });
const dest = path.join(HERE, 'docs/audit/workflows-v128-glass-search.json');
writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('\nWrote', dest);
await browser.close(); server.close();
