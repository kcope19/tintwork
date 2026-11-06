// v1.17 perspective measurement (held-out set). Seeds are fixed from line detection
// on the *original* image before any upright command. TW_URL optional.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);

const PHOTOS = [
  { file: 'v117-lowangle.jpg', role: 'low-angle tall' },
  { file: 'v117-lookup.jpg', role: 'looking-up' },
  { file: 'v117-station.jpg', role: 'station interior / wide' },
  { file: 'v117-interior.jpg', role: 'hallway interior' },
  { file: 'v117-flat.jpg', role: 'flat facade' },
  { file: 'v117-geo.jpg', role: 'geometric facade' },
  { file: 'v117-cathedral.jpg', role: 'cathedral facade' },
  { file: 'v117-frame.jpg', role: 'framed art' },
  { file: 'v117-curvy.jpg', role: 'curvy metal' },
  // regression tuning photos (not held-out)
  { file: 'library.jpg', role: 'tuning: library' },
  { file: 'brick.jpg', role: 'tuning: brick' },
  { file: 'geneva.jpg', role: 'held-out prior: geneva' },
  { file: 'hongkong.jpg', role: 'held-out prior: hongkong' },
];

const MODES = ['autoUpright', 'uprightLevel', 'uprightVertical', 'uprightFull'];

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}?platform=win`);
await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg);

const edgeAngle = (seeds, win = 4) => page.evaluate(async ({ seeds, win }) => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
  return seeds.map(([[x1, y1], [x2, y2]]) => {
    const xs = [], ys = [];
    if (Math.abs(x2 - x1) > Math.abs(y2 - y1)) {
      for (let x = Math.ceil(Math.min(x1, x2)); x < Math.max(x1, x2); x++) {
        if (x < 0 || x >= W) continue; const yr = y1 + (y2 - y1) * (x - x1) / (x2 - x1), a = Math.round(yr - win), b = Math.round(yr + win); if (a < 1 || b >= H - 1) continue;
        let k = -1, best = 12; const col = []; for (let y = a; y <= b; y++) { const v = Math.abs(g(x, y + 1) - g(x, y - 1)); col.push(v); if (v > best) { best = v; k = y - a; } }
        if (k < 0) continue; let dy = 0; if (k > 0 && k < col.length - 1) { const l = col[k - 1], cc = col[k], r = col[k + 1], den = l - 2 * cc + r; dy = den ? 0.5 * (l - r) / den : 0; }
        ys.push(a + k + dy); xs.push(x);
      }
      let keep = xs.map(() => true), s = 0, c0 = 0;
      for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null, n, h: true }; const mx = idx.reduce((q, i) => q + xs[i], 0) / n, my = idx.reduce((q, i) => q + ys[i], 0) / n; let sxy = 0, sxx = 0; for (const i of idx) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } s = sxy / sxx; c0 = my - s * mx; keep = ys.map((y, i) => Math.abs(y - (s * xs[i] + c0)) < 1.5); }
      return { deg: Math.atan(s) * 180 / Math.PI, n: keep.filter(Boolean).length, of: xs.length, h: true };
    }
    for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
      if (y < 0 || y >= H) continue; const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win); if (a < 1 || b >= W - 1) continue;
      let k = -1, best = 12; const row = []; for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); row.push(v); if (v > best) { best = v; k = x - a; } }
      if (k < 0) continue; let dx = 0; if (k > 0 && k < row.length - 1) { const l = row[k - 1], cc = row[k], r = row[k + 1], den = l - 2 * cc + r; dx = den ? 0.5 * (l - r) / den : 0; }
      xs.push(a + k + dx); ys.push(y);
    }
    let keep = xs.map(() => true), s = 0, c0 = 0;
    for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null, n }; const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n; let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; } s = sxy / syy; c0 = mx - s * my; keep = xs.map((x, i) => Math.abs(x - (s * ys[i] + c0)) < 1.5); }
    return { deg: Math.atan(s) * 180 / Math.PI, n: keep.filter(Boolean).length, of: xs.length };
  });
}, { seeds, win });

const mapUpright = (pts) => page.evaluate((pts) => {
  const u = window.tintwork.lastUpright, H = u?.H, c = u?.crop || { x: 0, y: 0 };
  if (!H) return pts;
  return pts.map(([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w - c.x, (H[3] * x + H[4] * y + H[5]) / w - c.y]; });
}, pts);

const open = async (file) => {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); window.tintwork.run('zoomFit'); });
};

/** Pick seed edges from detected lines on the original (before upright). */
const pickSeeds = async () => T(async () => {
  const t = window.tintwork;
  await t.compositeSettled?.();
  const c = t.compositeCanvas();
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  // use segment via a temporary mesh small path: expose detect through run? Use internal via evaluate if exported
  // Fall back: sample via window.tintwork if segment exposed
  const seg = t.segment || null;
  if (!seg?.detectLines) {
    // Approximate: invent seeds from image thirds — caller will refine
    const W = c.width, H = c.height;
    return {
      verts: [[[W * 0.25, H * 0.1], [W * 0.25, H * 0.9]], [[W * 0.75, H * 0.1], [W * 0.75, H * 0.9]]],
      hors: [[[W * 0.1, H * 0.3], [W * 0.9, H * 0.3]], [[W * 0.1, H * 0.7], [W * 0.9, H * 0.7]]],
      size: [W, H],
      note: 'fallback thirds (no segment export)',
    };
  }
  const v = seg.detectLines(img, { orient: 'v', maxDeg: 25, minLenFrac: 0.12, maxLines: 20, thrFrac: 0.7 });
  const h = seg.detectLines(img, { orient: 'h', maxDeg: 20, minLenFrac: 0.12, maxLines: 20, thrFrac: 0.7 });
  const toSeg = (l) => [[l.x1, l.y1], [l.x2, l.y2]];
  const score = (l) => l.len || Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  v.sort((a, b) => score(b) - score(a));
  h.sort((a, b) => score(b) - score(a));
  // diversify verticals by x midpoint
  const verts = [];
  for (const l of v) {
    const mid = (l.x1 + l.x2) / 2;
    if (verts.every((s) => Math.abs(((s[0][0] + s[1][0]) / 2) - mid) > c.width * 0.12)) verts.push(toSeg(l));
    if (verts.length >= 3) break;
  }
  const hors = [];
  for (const l of h) {
    const mid = (l.y1 + l.y2) / 2;
    if (hors.every((s) => Math.abs(((s[0][1] + s[1][1]) / 2) - mid) > c.height * 0.1)) hors.push(toSeg(l));
    if (hors.length >= 2) break;
  }
  return { verts, hors, size: [c.width, c.height], nv: v.length, nh: h.length };
});

const runMode = async (cmd, seeds) => {
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; });
  const before = await edgeAngle(seeds);
  const t0 = Date.now();
  await T((c) => window.tintwork.run(c), cmd);
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 25000 }).catch(() => {});
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const ms = Date.now() - t0;
  const lu = await T(() => {
    const u = window.tintwork.lastUpright || {};
    return { mode: u.mode || u.kind, H: !!u.H, crop: u.crop || null, k: u.k || 0, kEst: u.kEst ?? null };
  });
  const size = await T(() => [window.tintwork.doc.width, window.tintwork.doc.height]);
  if (!lu.H) return { before, after: before, lu, ms, size, refused: true, areaKept: 1 };
  const mapped = [];
  for (const sd of seeds) mapped.push(await mapUpright(sd));
  const after = await edgeAngle(mapped);
  const areaKept = lu.crop ? (lu.crop.w * lu.crop.h) / (await T(() => { /* orig before crop stored? */ return null; }) || 1) : 1;
  // area: crop.w*h / original — original was size before; crop has w,h of result which equals current size
  const origArea = await T(() => {
    // lastUpright.crop has x,y,w,h of crop from pre-crop canvas; pre-crop ≈ current if crop applied replaces doc
    return null;
  });
  const area = lu.crop ? +(lu.crop.w * lu.crop.h / (size[0] * size[1])).toFixed(3) : 1; // after crop size IS crop; report crop fraction vs uncropped layer bounds if available
  return { before, after, lu, ms, size, refused: false, crop: lu.crop };
};

const runGuided = async (guides, seeds) => {
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('guidedUpright'); });
  await page.waitForFunction(() => window.tintwork.mxf?.guideMode);
  // inject guides via pointer
  const toScreen = async (p) => page.evaluate(({ x, y }) => {
    const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state;
    return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom };
  }, p);
  for (const g of guides) {
    const a = await toScreen({ x: g[0][0], y: g[0][1] }), b = await toScreen({ x: g[1][0], y: g[1][1] });
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(80);
  }
  const n = await T(() => window.tintwork.mxf?.guides?.length || 0);
  if (n >= 2 && n < 4) await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 25000 }).catch(() => {});
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const lu = await T(() => window.tintwork.lastUpright);
  const mapped = [];
  for (const sd of seeds) mapped.push(await mapUpright(sd));
  return { nGuides: n, after: await edgeAngle(mapped), lu: { mode: lu?.kind || lu?.mode, H: !!lu?.H, crop: lu?.crop } };
};

const fmt = (es) => (es || []).map((e) => (e?.deg == null ? '—' : `${e.deg.toFixed(2)}°`)).join(' / ');
const worst = (es) => Math.max(0, ...((es || []).map((e) => (e?.deg == null ? 0 : Math.abs(e.deg)))));

const results = [];
mkdirSync(path.join(HERE, 'docs/audit'), { recursive: true });

for (const photo of PHOTOS) {
  console.log('\n====', photo.file, `(${photo.role})`);
  await open(photo.file);
  const seedsInfo = await pickSeeds();
  console.log('  seeds', seedsInfo.nv, 'v lines,', seedsInfo.nh, 'h; picked', seedsInfo.verts.length, 'V +', seedsInfo.hors.length, 'H; size', seedsInfo.size);
  if (!seedsInfo.verts.length) { console.log('  SKIP no verticals'); continue; }
  const seeds = [...seedsInfo.verts, ...seedsInfo.hors];
  const row = { file: photo.file, role: photo.role, size: seedsInfo.size, seeds, modes: {} };

  // baseline angles
  const base = await edgeAngle(seeds);
  row.baseline = base;
  console.log('  baseline', fmt(base), 'worst', worst(base).toFixed(2));

  for (const cmd of MODES) {
    await open(photo.file);
    const r = await runMode(cmd, seeds);
    row.modes[cmd] = { before: fmt(r.before), after: fmt(r.after), worst: +worst(r.after).toFixed(3), refused: r.refused, ms: r.ms, mode: r.lu.mode, crop: r.crop, size: r.size };
    console.log(`  ${cmd}: ${r.refused ? 'REFUSE' : r.lu.mode} ${fmt(r.before)} → ${fmt(r.after)} (${r.ms}ms) crop=${r.crop ? `${r.crop.w}x${r.crop.h}` : 'none'}`);
  }

  // Guided 2 / 3 / 4 using detected lines as guides
  const guidePool = [...seedsInfo.verts, ...seedsInfo.hors];
  for (const n of [2, 3, 4]) {
    if (guidePool.length < Math.min(2, n)) break;
    const guides = guidePool.slice(0, n);
    await open(photo.file);
    const before = await edgeAngle(seeds);
    const t0 = Date.now();
    const g = await runGuided(guides, seeds);
    const ms = Date.now() - t0;
    row.modes[`guided${n}`] = { before: fmt(before), after: fmt(g.after), worst: +worst(g.after).toFixed(3), nGuides: g.nGuides, ms, mode: g.lu?.mode, crop: g.lu?.crop };
    console.log(`  guided${n}: ${fmt(before)} → ${fmt(g.after)} (${ms}ms, drew ${g.nGuides})`);
  }
  results.push(row);
}

const out = path.join(HERE, 'docs/audit/workflows-v117-baseline.json');
writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), app: await T(() => window.tintwork.APP_VERSION), results }, null, 2));
console.log('\nWrote', out);
await browser.close(); server.close();
