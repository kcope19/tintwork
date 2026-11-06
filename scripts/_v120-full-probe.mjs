// Probe Full upright with fixed seeds; optional TW_RADIAL=1 to force-apply kEst.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const HERE = '/workspace/photo-editor';
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const FORCE = process.env.TW_RADIAL === '1';
const { createStaticServer } = await import(pathToFileURL(path.join(HERE, 'scripts/serve.mjs')).href);
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/?platform=win`);
await page.waitForFunction(() => window.tintwork); await page.evaluate(() => window.tintwork.engineReady);

if (FORCE) {
  await page.addInitScript(() => {});
  // Monkey-patch after load: intercept by rewriting gate in evaluate before each run
}

const edgeAngle = (seeds) => page.evaluate(async ({ seeds }) => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
  return seeds.map(([[x1, y1], [x2, y2]]) => {
    const xs = [], ys = []; const horiz = Math.abs(x2 - x1) > Math.abs(y2 - y1); const win = 4;
    if (horiz) {
      for (let x = Math.ceil(Math.min(x1, x2)); x < Math.max(x1, x2); x++) {
        if (x < 0 || x >= W) continue; const yr = y1 + (y2 - y1) * (x - x1) / (x2 - x1), a = Math.round(yr - win), b = Math.round(yr + win); if (a < 1 || b >= H - 1) continue;
        let k = -1, best = 12; for (let y = a; y <= b; y++) { const v = Math.abs(g(x, y + 1) - g(x, y - 1)); if (v > best) { best = v; k = y; } }
        if (k < 0) continue; ys.push(k); xs.push(x);
      }
      if (xs.length < 10) return { deg: null }; let s = 0, keep = xs.map(() => true);
      for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null }; const mx = idx.reduce((q, i) => q + xs[i], 0) / n, my = idx.reduce((q, i) => q + ys[i], 0) / n; let sxy = 0, sxx = 0; for (const i of idx) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } s = sxy / (sxx || 1); keep = ys.map((y, i) => Math.abs(y - (s * xs[i] + my - s * mx)) < 1.5); }
      return { deg: Math.atan(s) * 180 / Math.PI };
    }
    for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
      if (y < 0 || y >= H) continue; const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win); if (a < 1 || b >= W - 1) continue;
      let k = -1, best = 12; for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); if (v > best) { best = v; k = x; } }
      if (k < 0) continue; xs.push(k); ys.push(y);
    }
    if (xs.length < 10) return { deg: null }; let s = 0, keep = xs.map(() => true);
    for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null }; const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n; let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; } s = sxy / (syy || 1); keep = xs.map((x, i) => Math.abs(x - (s * ys[i] + mx - s * my)) < 1.5); }
    return { deg: Math.atan(s) * 180 / Math.PI };
  });
}, { seeds });

const mapUpright = (pts) => page.evaluate((pts) => {
  const u = window.tintwork.lastUpright, H = u?.H, c = u?.crop || { x: 0, y: 0 };
  if (!H) return pts;
  return pts.map(([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w - c.x, (H[3] * x + H[4] * y + H[5]) / w - c.y]; });
}, pts);

const SEEDS = {
  library: [[[1144, 301], [1149, 693]], [[554, 90], [553, 529]], [[575, 325], [1101, 287]], [[582, 641], [1133, 685]], [[350, 343], [548, 328]]],
  brick: [[[1020, 603], [1020, 799]], [[1067, 625], [1069, 794]], [[1030, 572], [1274, 594]], [[1072, 615], [1189, 623]], [[1035, 817], [1274, 823]]],
  geneva: [[[360, 300], [359, 829]], [[1023, 152], [1028, 783]], [[1131, 38], [1139, 829]], [[1030, 367], [1274, 369]], [[1030, 632], [1274, 634]]],
  hongkong: [[[1163, 68], [1161, 779]], [[875, 64], [880, 779]], [[959, 63], [961, 775]], [[85, 200], [1216, 199]], [[60, 597], [1206, 601]]],
  c4: [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]],
};

async function run(name, file, seeds) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => (window.tintwork.doc?.name || '').startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await page.evaluate(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  if (FORCE) {
    // Patch gate: replace kRad=0 force inside autoUpright by temporarily wrapping segment.estimateRadial result path
    // Easier: set a global that main.js can read if we add a hook. For probe without code change, rewrite source via evaluate of APP?
    // Inject by overriding the function that zeros kRad — patch lastUpright after? Too late.
    // Use page.route to serve patched main.js
  }
  const before = await edgeAngle(seeds);
  await page.evaluate((force) => { window.__TW_RADIAL_FORCE__ = !!force; window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); }, FORCE);
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const lu = await page.evaluate(() => {
    const u = window.tintwork.lastUpright || {};
    return { mode: u.mode, k: u.k, kEst: u.kEst, H: !!u.H, hlines: u.hlines, lines: u.lines };
  });
  let after = before;
  if (lu.H) {
    const mapped = [];
    for (const sd of seeds) mapped.push(await mapUpright(sd));
    after = await edgeAngle(mapped);
  }
  const fmt = (es) => es.map((e) => e.deg == null ? null : +Math.abs(e.deg).toFixed(2));
  const worst = (es) => { const v = es.map((e) => e.deg).filter((d) => d != null).map(Math.abs); return v.length ? Math.max(...v) : null; };
  const row = { name, force: FORCE, lu, before: fmt(before), after: fmt(after), wBefore: worst(before), wAfter: lu.H ? worst(after) : worst(before), refused: !lu.H };
  console.log(JSON.stringify(row));
  return row;
}

const rows = [];
rows.push(await run('library', 'library.jpg', SEEDS.library));
rows.push(await run('brick', 'brick.jpg', SEEDS.brick));
rows.push(await run('c4', 'c4.jpg', SEEDS.c4));
rows.push(await run('geneva', 'geneva.jpg', SEEDS.geneva));
rows.push(await run('hongkong', 'hongkong.jpg', SEEDS.hongkong));
writeFileSync(path.join(HERE, `docs/audit/workflows-v120-full-seeds${FORCE ? '-radial' : ''}.json`), JSON.stringify({ force: FORCE, rows }, null, 2));
await browser.close(); server.close();
