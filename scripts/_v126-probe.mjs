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
    const glen = (g) => Math.hypot(g[1][0]-g[0][0], g[1][1]-g[0][1]);
    const full = t.suggestUprightGuides(x, { max: 4 });
    const top2 = t.diversifyTop2Verticals(x);
    const onlyV = full.filter(isV);
    const onlyH = full.filter((g) => !isV(g));

    // rebuild detect like uprightDetectImage
    let img, toDoc, W, H;
    try {
      t.freshComp?.();
      const c = t.comp;
      if (c && c.width >= 32) {
        const ctx = t.compCtx;
        img = ctx.getImageData(0, 0, c.width, c.height);
        toDoc = (l) => [[l.x1, l.y1], [l.x2, l.y2]];
        W = c.width; H = c.height;
      }
    } catch {}
    if (!img) {
      img = x.small; const k = x.k || 1;
      toDoc = (l) => [[x.ox + l.x1 / k, x.oy + l.y1 / k], [x.ox + l.x2 / k, x.oy + l.y2 / k]];
      W = img.width; H = img.height;
    }

    const detect = (orient, maxDeg, minLenFrac, thrFrac, maxLines) => {
      let lines = seg.detectLines(img, { orient, maxDeg, minLenFrac, maxLines, thrFrac });
      lines.sort((a, b) => b.len - a.len);
      const uv = lines.length >= 2 ? seg.estimateUpright(
        orient === 'v' ? lines : lines.map((l) => ({ ...l, x1: l.y1, y1: l.x1, x2: l.y2, y2: l.x2 })),
        orient === 'v' ? W : H, orient === 'v' ? H : W
      ) : { mode: 'none', inliers: [] };
      const inl = (uv.mode !== 'none' && (uv.inliers||[]).length >= 2)
        ? uv.inliers.map((i) => lines[i]).filter(Boolean) : [];
      return { lines, inl, uv: uv.mode };
    };

    const vDet = detect('v', 25, 0.12, 0.7, 28);
    const hDet = detect('h', 20, 0.12, 0.7, 28);
    const vLong = detect('v', 22, 0.18, 0.72, 16);
    const hLong = detect('h', 15, 0.18, 0.72, 16);

    const probes = {
      broad: [...vDet.lines.slice(0,6).map(toDoc), ...hDet.lines.slice(0,6).map(toDoc)],
      vInlier: (vDet.inl.length >= 2 ? vDet.inl : vDet.lines).slice(0,6).map(toDoc),
      hInlier: (hDet.inl.length >= 2 ? hDet.inl : hDet.lines).slice(0,6).map(toDoc),
      vLong: vLong.lines.slice(0,6).map(toDoc),
      hLong: hLong.lines.slice(0,6).map(toDoc),
      longBoth: [...vLong.lines.slice(0,4).map(toDoc), ...hLong.lines.slice(0,4).map(toDoc)],
      inlierBoth: [
        ...(vDet.inl.length >= 2 ? vDet.inl : vDet.lines).slice(0,4).map(toDoc),
        ...(hDet.inl.length >= 2 ? hDet.inl : hDet.lines).slice(0,4).map(toDoc),
      ],
    };

    // Build H candidate pool: diversified horizontals from detect
    const hPool = [];
    const hd = (hDet.inl.length >= 2 ? hDet.inl : hDet.lines);
    for (const l of hd) {
      const d = toDoc(l);
      const m = (d[0][1]+d[1][1])/2;
      if (hPool.every((o) => Math.abs(((o[0][1]+o[1][1])/2) - m) >= 0.1 * (x.h||H))) hPool.push(d);
      if (hPool.length >= 6) break;
    }
    const vPair = top2.length >= 2 ? top2 : onlyV.slice(0, 2);
    const mixes = [];
    if (vPair.length >= 2) {
      for (let i = 0; i < hPool.length; i++) {
        mixes.push({ name: `2V+H${i}`, g: [...vPair, hPool[i]] });
        for (let j = i+1; j < hPool.length; j++) {
          mixes.push({ name: `2V+H${i}+H${j}`, g: [...vPair, hPool[i], hPool[j]] });
        }
      }
      if (onlyH.length) mixes.push({ name: 'sugMix', g: [...vPair, ...onlyH.slice(0,2)] });
    }

    const vNext = t.uprightFromGuides(base, vPair, x.w, x.h);
    const scoreMix = (g, probe) => {
      const next = t.uprightFromGuides(base, g, x.w, x.h);
      if (!next) return null;
      const vP = probe.filter(isV), hP = probe.filter((g) => !isV(g));
      return {
        score: t.scoreSegmentsAfter(base, probe, next),
        mV: vP.length>=2 ? t.scoreSegmentsAfter(base, vP, next) : null,
        vv: vP.length>=2 ? t.scoreSegmentsAfter(base, vP, vNext) : null,
        mH: hP.length>=2 ? t.scoreSegmentsAfter(base, hP, next) : null,
        vH: hP.length>=2 ? t.scoreSegmentsAfter(base, hP, vNext) : null,
        onTop2: t.scoreSegmentsAfter(base, vPair, next),
      };
    };

    const results = {};
    for (const [pname, probe] of Object.entries(probes)) {
      const rows = [];
      for (const m of mixes) {
        const s = scoreMix(m.g, probe);
        if (!s) continue;
        const vOk = !(s.mV!=null && s.vv!=null && s.mV > s.vv + 0.5);
        const vBetter = s.mV!=null && s.vv!=null && s.mV <= s.vv - 0.15;
        const hBetter = s.mH!=null && s.vH!=null && s.mH <= s.vH - 2.0;
        const hOk = !(s.mH!=null && s.vH!=null && s.mH > s.vH + 1.0);
        const top2Safe = !(s.onTop2 > 0.25); // onTop2V is ~0
        const overall = s.score != null && Number.isFinite(s.vv) ? s.score <= (t.scoreSegmentsAfter(base, probe, vNext)) - 0.25 : false;
        const accept = vOk && top2Safe && (overall || vBetter || hBetter) && (vBetter || hBetter || (vBetter && hOk));
        rows.push({ name: m.name, n: m.g.length, ...s, vOk, vBetter, hBetter, hOk, top2Safe, overall, accept });
      }
      rows.sort((a,b) => (a.mV??99) - (b.mV??99) || (a.mH??99) - (b.mH??99));
      results[pname] = {
        nV: probe.filter(isV).length, nH: probe.filter((g)=>!isV(g)).length,
        v2score: t.scoreSegmentsAfter(base, probe, vNext),
        bestAccept: rows.find((r) => r.accept) || null,
        top3: rows.slice(0,3).map((r) => ({ name:r.name, mV:r.mV, vv:r.vv, mH:r.mH, vH:r.vH, onTop2:r.onTop2, accept:r.accept, vBetter:r.vBetter, hBetter:r.hBetter, vOk:r.vOk, top2Safe:r.top2Safe })),
      };
    }
    return {
      full: { n: full.length, nv: onlyV.length, nh: onlyH.length },
      vDet: { n: vDet.lines.length, inl: vDet.inl.length, mode: vDet.uv },
      hDet: { n: hDet.lines.length, inl: hDet.inl.length, mode: hDet.uv },
      hPool: hPool.length,
      results,
    };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
}

const out = {};
for (const f of ['v117-cathedral.jpg','v117-interior.jpg','v117-frame.jpg','library.jpg','c4.jpg','v117-flat.jpg','v117-lowangle.jpg']) {
  out[f] = await analyze(f);
  const r = out[f];
  console.log('\n==', f, 'full', r.full, 'hPool', r.hPool, 'V/H inliers', r.vDet.inl, r.hDet.inl);
  for (const [p, v] of Object.entries(r.results)) {
    const b = v.bestAccept;
    console.log(p, 'v2', v.v2score?.toFixed?.(2), 'best', b ? `${b.name} mV=${b.mV?.toFixed?.(2)} mH=${b.mH?.toFixed?.(2)}` : 'NONE',
      'top', v.top3[0]?.name, 'mV', v.top3[0]?.mV?.toFixed?.(2), 'accept', v.top3[0]?.accept);
  }
}
writeFileSync('/tmp/v126-probe.json', JSON.stringify(out, null, 2));
await browser.close(); server.close();
