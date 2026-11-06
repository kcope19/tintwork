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

async function analyze(file) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file);
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await T(() => window.tintwork.run('guidedUpright'));
  const r = await T(() => {
    const t = window.tintwork, x = t.mxf, seg = t.segment;
    x.guideMode = true;
    if (!x.pts0) x.pts0 = x.pts.map((p) => [...p]);
    const base = x.pts0.map((p) => [...p]);
    const isV = (g) => Math.abs(g[1][1] - g[0][1]) >= Math.abs(g[1][0] - g[0][0]);
    const full = t.suggestUprightGuides(x, { max: 4 });
    const top2 = t.diversifyTop2Verticals(x);
    const onlyV = full.filter(isV);
    const onlyH = full.filter((g) => !isV(g));
    let img, toDoc, W, H;
    try {
      const c = t.compositeCanvas || t.comp;
      // use small if needed
    } catch {}
    img = x.small; const k = x.k || 1;
    toDoc = (l) => [[x.ox + l.x1 / k, x.oy + l.y1 / k], [x.ox + l.x2 / k, x.oy + l.y2 / k]];
    W = img.width; H = img.height;
    // Prefer full composite when available via detect path inside suggest — use small for parity with mesh
    // Actually rebuild like uprightDetectImage via running detect on whatever suggest uses:
    // Call apply path pieces: use detect on x.small first; also try document pixels from layer
    const vRaw = seg.detectLines(img, { orient: 'v', maxDeg: 25, minLenFrac: 0.12, maxLines: 28, thrFrac: 0.7 });
    vRaw.sort((a,b)=>b.len-a.len);
    const uv = vRaw.length>=2 ? seg.estimateUpright(vRaw, W, H) : { mode:'none', inliers:[] };
    const vInl = (uv.mode!=='none' && (uv.inliers||[]).length>=2) ? uv.inliers.map(i=>vRaw[i]).filter(Boolean).sort((a,b)=>b.len-a.len) : [];
    const hRaw = seg.detectLines(img, { orient: 'h', maxDeg: 20, minLenFrac: 0.12, maxLines: 28, thrFrac: 0.7 });
    hRaw.sort((a,b)=>b.len-a.len);
    const uh = hRaw.length>=2 ? seg.estimateUpright(hRaw.map(l=>({...l,x1:l.y1,y1:l.x1,x2:l.y2,y2:l.x2})), H, W) : { mode:'none', inliers:[] };
    const hInl = (uh.mode!=='none' && (uh.inliers||[]).length>=2) ? uh.inliers.map(i=>hRaw[i]).filter(Boolean).sort((a,b)=>b.len-a.len) : [];

    const broad = [...vRaw.slice(0,6).map(toDoc), ...hRaw.slice(0,6).map(toDoc)];
    const gateV = (vInl.length>=2 ? vInl : vRaw).slice(0,6).map(toDoc);
    const gateH = (hInl.length>=2 ? hInl : hRaw).slice(0,6).map(toDoc);

    // diversify H pool
    const hPool = [];
    const hSrc = (hInl.length>=2 ? hInl : hRaw);
    for (const l of hSrc) {
      const d = toDoc(l); const m = (d[0][1]+d[1][1])/2;
      if (hPool.every(o => Math.abs(((o[0][1]+o[1][1])/2)-m) >= 0.1*(x.h||H))) hPool.push(d);
      if (hPool.length >= 6) break;
    }
    for (const h of onlyH) {
      const m = (h[0][1]+h[1][1])/2;
      if (hPool.every(o => Math.abs(((o[0][1]+o[1][1])/2)-m) >= 0.08*(x.h||H))) hPool.push(h);
    }
    const vPair = top2.length>=2 ? top2 : onlyV.slice(0,2);
    const vNext = t.uprightFromGuides(base, vPair, x.w, x.h);
    const v2scoreBroad = t.scoreSegmentsAfter(base, broad, vNext);

    const evalMix = (g) => {
      const next = t.uprightFromGuides(base, g, x.w, x.h);
      if (!next) return null;
      const mV = gateV.length>=2 ? t.scoreSegmentsAfter(base, gateV, next) : Infinity;
      const vv = gateV.length>=2 ? t.scoreSegmentsAfter(base, gateV, vNext) : Infinity;
      const mH = gateH.length>=2 ? t.scoreSegmentsAfter(base, gateH, next) : Infinity;
      const vH = gateH.length>=2 ? t.scoreSegmentsAfter(base, gateH, vNext) : Infinity;
      const score = t.scoreSegmentsAfter(base, broad, next);
      const onMix = t.scoreSegmentsAfter(base, vPair, next);
      const onV2 = t.scoreSegmentsAfter(base, vPair, vNext);
      const vOk = !(Number.isFinite(mV) && Number.isFinite(vv) && mV > vv + 0.5);
      const vBetter = Number.isFinite(mV) && Number.isFinite(vv) && mV <= vv - 0.15;
      const hBetter = Number.isFinite(mH) && Number.isFinite(vH) && mH <= vH - 2.0;
      const vOnlyBetter = Number.isFinite(mV) && Number.isFinite(vv) && mV <= vv - 0.15
        && (!(Number.isFinite(mH) && Number.isFinite(vH)) || mH <= vH + 1.0);
      const overallBetter = score <= v2scoreBroad - 0.25;
      const bothImprove = vBetter && hBetter;
      const slack = bothImprove ? 0.75 : 0.25;
      const bigH = Number.isFinite(mH) && Number.isFinite(vH) && mH <= vH - 5.0;
      const top2Safe = bigH || !(Number.isFinite(onMix) && Number.isFinite(onV2) && onMix > onV2 + slack);
      const acceptMix = vOk && top2Safe && (overallBetter || vOnlyBetter || hBetter) && (vBetter || hBetter || vOnlyBetter);
      return { n:g.length, nv:g.filter(isV).length, nh:g.length-g.filter(isV).length, mV, vv, mH, vH, score, onMix, onV2, vOk, vBetter, hBetter, vOnlyBetter, overallBetter, top2Safe, acceptMix };
    };

    const mixes = [];
    if (vPair.length>=2) {
      for (let i=0;i<hPool.length;i++) {
        mixes.push({name:`2V+H${i}`, g:[...vPair, hPool[i]]});
        for (let j=i+1;j<Math.min(hPool.length,i+3);j++) mixes.push({name:`2V+H${i}+H${j}`, g:[...vPair, hPool[i], hPool[j]]});
      }
      if (onlyH.length) mixes.push({name:'sugH', g:[...vPair, ...onlyH.slice(0,2)]});
      if (full.length>=3) mixes.push({name:'full', g:full});
    }
    const scored = mixes.map(m => ({name:m.name, ...evalMix(m.g)})).filter(s => s && s.n);
    const accepted = scored.filter(s => s.acceptMix).sort((a,b)=>(a.mV-b.mV)||(a.score-b.score));
    const current = (() => {
      const ok = t.applySuggestedGuides(x);
      const g = x.guides||[];
      const nv = g.filter(isV).length;
      return { ok, n:g.length, nv, nh:g.length-nv, mixed: nv>0 && g.length-nv>0, gate: t.lastSuggestGate, status: document.getElementById('status')?.textContent };
    })();
    return {
      gateV: gateV.length, gateH: gateH.length, hPool: hPool.length, vInl: vInl.length, hInl: hInl.length,
      accepted: accepted.slice(0,3),
      bestReject: scored.filter(s=>!s.acceptMix).sort((a,b)=>(a.mV??9)-(b.mV??9)).slice(0,2),
      current,
    };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
}

const out = {};
for (const f of ['v117-cathedral.jpg','v117-interior.jpg','v117-frame.jpg','library.jpg','c4.jpg','v117-flat.jpg','v117-lowangle.jpg','brick.jpg','geneva.jpg']) {
  out[f] = await analyze(f);
  const a = out[f];
  console.log(f, 'current', a.current.nv+'V+'+a.current.nh+'H', 'mixed', a.current.mixed,
    '| would-accept', a.accepted[0] ? `${a.accepted[0].name} mV=${a.accepted[0].mV?.toFixed(2)} (vv ${a.accepted[0].vv?.toFixed(2)}) mH=${a.accepted[0].mH?.toFixed?.(2)}` : 'NONE',
    '| gateVH', a.gateV, a.gateH, 'hPool', a.hPool);
}
writeFileSync('/workspace/photo-editor/docs/audit/workflows-v126-probe.json', JSON.stringify(out, null, 2));
await browser.close(); server.close();
