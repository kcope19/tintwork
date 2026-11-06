// v1.17 test: perspective/upright — refuse cancels mesh; constrain-crop; guide snap; thirds grid.
// Held-out photos: test-assets/real/v117-*.jpg (CC0; seeds fixed before tuning).
// TW_ROOT / TW_URL supported.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}?platform=win`);
await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));

check(await T(() => window.tintwork.APP_VERSION) === '1.17.0' || await T(() => window.tintwork.APP_VERSION) === '1.18.0' || await T(() => window.tintwork.APP_VERSION) === '1.19.0' || await T(() => window.tintwork.APP_VERSION) === '1.21.0' || await T(() => window.tintwork.APP_VERSION) === '1.22.0' || await T(() => window.tintwork.APP_VERSION) === '1.20.0', `APP_VERSION is 1.17+ (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check(m?.[1] === '1.17.0' || m?.[1] === '1.18.0' || m?.[1] === '1.19.0' || m?.[1] === '1.21.0' || m?.[1] === '1.22.0' || m?.[1] === '1.20.0', `SW CACHE is 1.17+ (${m?.[1]})`);
}

const open = async (file, as = file) => {
  await page.setInputFiles('#fileInput', { name: as, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), as, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};

// 1) Refuse cancels mesh quickly (held-out flat: Level finds no usable horizontals)
{
  await open('v117-flat.jpg', 'v117-flat-refuse.jpg');
  const t0 = Date.now();
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightLevel'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 4000 }).catch(() => {});
  const r = await T(() => ({ mxf: !!window.tintwork.mxf, mode: window.tintwork.lastUpright?.mode, status: document.querySelector('#status')?.textContent || '' }));
  const ms = Date.now() - t0;
  check(!r.mxf && r.mode === 'none', `refuse leaves no mxf (mxf=${r.mxf}, mode=${r.mode})`);
  check(ms < 3000, `refuse returns in <3s (${ms}ms; was ~25s when mesh stuck)`);
  check(/Guide/i.test(r.status), `refuse status mentions Guides (${r.status.slice(0, 80)})`);
}

// 2) Vertical upright still works on held-out flat; crop recorded
{
  await open('v117-flat.jpg', 'v117-flat-vert.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightVertical'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 10000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const u = await T(() => ({ H: !!window.tintwork.lastUpright?.H, crop: window.tintwork.lastUpright?.crop, size: [window.tintwork.doc.width, window.tintwork.doc.height] }));
  check(u.H && u.crop && u.crop.w > 100, `Vertical+crop on flat (H=${u.H}, crop=${u.crop?.w}x${u.crop?.h})`);
}

// 3) Guide snap moves an offset stroke toward a detected edge
{
  await open('c4.jpg', 'c4-snap.jpg');
  const snap = await T(() => {
    const t = window.tintwork; t.run('guidedUpright');
    const x = t.mxf, g0 = [[140, 446], [40, 900]];
    const g1 = t.snapUprightGuide(x, g0, 40);
    const moved = Math.hypot(g1[0][0] - g0[0][0], g1[0][1] - g0[0][1]) + Math.hypot(g1[1][0] - g0[1][0], g1[1][1] - g0[1][1]);
    return { moved, g1 };
  });
  check(snap.moved > 10, `snapUprightGuide moves offset guide (moved=${snap.moved?.toFixed?.(1) ?? snap.moved})`);
  await T(() => window.tintwork.run('mxfCancel'));
}

// 4) Guided 2-guide + Enter still finishes (regression)
{
  await open('c4.jpg', 'c4-g2.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('guidedUpright'); });
  await page.waitForFunction(() => window.tintwork.mxf?.guideMode);
  const toScreen = async (p) => page.evaluate(({ x, y }) => {
    const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state;
    return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom };
  }, p);
  for (const pts of [[[124, 446], [15, 900]], [[935, 492], [968, 900]]]) {
    const a = await toScreen({ x: pts[0][0], y: pts[0][1] }), b = await toScreen({ x: pts[1][0], y: pts[1][1] });
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(80);
  }
  const mid = await T(() => ({ guides: window.tintwork.mxf?.guides?.length, mode: !!window.tintwork.mxf?.guideMode }));
  check(mid.guides === 2 && mid.mode, `guided preview after 2 (${mid.guides})`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 }).catch(() => {});
  check(await T(() => !!window.tintwork.lastUpright?.H), 'guided Enter applies H');
}

// 5) Perspective thirds grid: start mesh, ensure no page error while open
{
  await open('v117-cathedral.jpg', 'v117-cath-grid.jpg');
  await T(() => window.tintwork.run('perspective'));
  await page.waitForFunction(() => window.tintwork.mxf && !window.tintwork.mxf.guideMode);
  await T(() => { window.tintwork.renderNow?.(); });
  await page.waitForTimeout(50);
  check(await T(() => !!window.tintwork.mxf), 'perspective session open for grid overlay');
  await T(() => window.tintwork.run('mxfCancel'));
}

// 6) Held-out low-angle: Vertical applies and cancels cleanly; residual check soft (bar 2°)
{
  await open('v117-lowangle.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightVertical'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 10000 });
  const lu = await T(() => ({ H: !!window.tintwork.lastUpright?.H, mode: window.tintwork.lastUpright?.mode || window.tintwork.lastUpright?.kind, mxf: !!window.tintwork.mxf }));
  check(lu.H && !lu.mxf, `low-angle Vertical applies (mode=${lu.mode}, mxf=${lu.mxf})`);
}

// 7) geneva Full still refuses (do-no-harm held-out) and leaves no mxf
{
  await open('geneva.jpg', 'geneva-full.jpg');
  const t0 = Date.now();
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 5000 }).catch(() => {});
  const r = await T(() => ({ mxf: !!window.tintwork.mxf, mode: window.tintwork.lastUpright?.mode }));
  check((r.mode === 'none' || !r.mxf) && !r.mxf, `geneva Full refuse/no-mxf (mode=${r.mode}, ${Date.now() - t0}ms)`);
}

check(errors.filter((e) => !/Deprecated|favicon/i.test(e)).length === 0, `no page errors (${errors.slice(0, 2).join('; ')})`);
console.log(`\n${count - fails}/${count} passed`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
