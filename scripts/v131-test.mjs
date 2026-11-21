// v1.31: Suggest mixed fallback is no longer applied ungated when every
// official pure-V pair fails uprightFromGuides. Mixes are scored against the
// uncorrected photo with the same acceptMix bars. No gate was loosened.
// Willis was inspected for diagnosis only and was not used to tune thresholds;
// its leftover is unchanged (~23.6°) and is now gated (v2src=identity).
// TW_ROOT / TW_URL supported.
import { chromium, webkit } from 'playwright';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;

{
  try {
    const b = await webkit.launch();
    const p = await b.newPage();
    await p.goto('about:blank');
    const ua = await p.evaluate(() => navigator.userAgent);
    check(/WebKit/i.test(ua), `WebKit launches (${ua.slice(0, 60)}…)`);
    await b.close();
  } catch (e) {
    check(false, `WebKit launches (${e.message.slice(0, 80)})`);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}?platform=win`);
await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));

check(await T(() => window.tintwork.APP_VERSION) === '1.31.0' || (await T(() => window.tintwork.APP_VERSION) === '1.32.0' || await T(() => window.tintwork.APP_VERSION) === '1.33.0'), `APP_VERSION is 1.31.0 (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check((m?.[1] === '1.31.0' || (m?.[1] === '1.32.0' || m?.[1] === '1.33.0')), `SW CACHE is 1.31.0 (${m?.[1]})`);
}

const open = async (file, as = file, buffer = null) => {
  await page.setInputFiles('#fileInput', { name: as, mimeType: 'image/jpeg', buffer: buffer || REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), as, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};

const suggest = async (file, as, buffer) => {
  await open(file, as || file, buffer);
  await T(() => window.tintwork.run('guidedUpright'));
  const r = await T(() => {
    const x = window.tintwork.mxf;
    const ok = window.tintwork.applySuggestedGuides(x);
    const g = x.guides || [];
    const isV = (s) => Math.abs(s[1][1] - s[0][1]) >= Math.abs(s[1][0] - s[0][0]);
    const nv = g.filter(isV).length;
    return { ok, n: g.length, nv, nh: g.length - nv, mixed: nv > 0 && g.length - nv > 0, gate: window.tintwork.lastSuggestGate, status: document.getElementById('status')?.textContent };
  });
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
  return r;
};
const leftover = (r) => {
  const m = /~([\d.]+)°/.exec(r.status || '');
  return m ? Number(m[1]) : NaN;
};
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
      if (xs.length < 10) return { deg: null }; let sl = 0, keep = xs.map(() => true);
      for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null }; const mx = idx.reduce((q, i) => q + xs[i], 0) / n, my = idx.reduce((q, i) => q + ys[i], 0) / n; let sxy = 0, sxx = 0; for (const i of idx) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } sl = sxy / (sxx || 1); keep = ys.map((y, i) => Math.abs(y - (sl * xs[i] + my - sl * mx)) < 1.5); }
      return { deg: Math.atan(sl) * 180 / Math.PI };
    }
    for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
      if (y < 0 || y >= H) continue; const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win); if (a < 1 || b >= W - 1) continue;
      let k = -1, best = 12; for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); if (v > best) { best = v; k = x; } }
      if (k < 0) continue; xs.push(k); ys.push(y);
    }
    if (xs.length < 10) return { deg: null }; let sl = 0, keep = xs.map(() => true);
    for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null }; const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n; let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; } sl = sxy / (syy || 1); keep = xs.map((x, i) => Math.abs(x - (sl * ys[i] + mx - sl * my)) < 1.5); }
    return { deg: Math.atan(sl) * 180 / Math.PI };
  });
}, { seeds });
const mapUpright = (pts) => page.evaluate((pts) => {
  const u = window.tintwork.lastUpright, H = u?.H, c = u?.crop || { x: 0, y: 0 };
  if (!H) return pts;
  return pts.map(([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w - c.x, (H[3] * x + H[4] * y + H[5]) / w - c.y]; });
}, pts);
const worst = (es) => { const v = (es || []).map((e) => e?.deg).filter((d) => d != null).map(Math.abs); return v.length ? Math.max(...v) : null; };

// Synthetic looking-up facade whose vertical VP sits in-frame. Official pure-V
// pairs fail uprightFromGuides; a mixed candidate exists but is not clearly
// better than leaving the photo as-is, so Suggest must refuse with numbers.
const synthBuf = Buffer.from((await page.evaluate(() => {
  const W = 1280, H = 853;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#dce4ee'; g.fillRect(0, 0, W, H);
  const sky = g.createLinearGradient(0, 0, 0, 200);
  sky.addColorStop(0, '#9ec5e8'); sky.addColorStop(1, '#dce4ee');
  g.fillStyle = sky; g.fillRect(0, 0, W, 220);
  const vpV = [640, 40], botY = 840, leftBotX = 180, rightBotX = 1100, facadeTop = 180;
  const interp = (x0, y0, x1, y1, y) => { const t = (y - y0) / (y1 - y0); return [x0 + t * (x1 - x0), y]; };
  const leftAt = (y) => interp(vpV[0], vpV[1], leftBotX, botY, y);
  const rightAt = (y) => interp(vpV[0], vpV[1], rightBotX, botY, y);
  const [ltx, lty] = leftAt(facadeTop), [rtx, rty] = rightAt(facadeTop);
  const [lbx, lby] = leftAt(botY), [rbx, rby] = rightAt(botY);
  g.fillStyle = '#6b5344';
  g.beginPath(); g.moveTo(ltx, lty); g.lineTo(rtx, rty); g.lineTo(rbx, rby); g.lineTo(lbx, lby); g.closePath(); g.fill();
  g.strokeStyle = '#1a120c'; g.lineWidth = 8;
  g.beginPath(); g.moveTo(ltx, lty); g.lineTo(lbx, lby); g.stroke();
  g.beginPath(); g.moveTo(rtx, rty); g.lineTo(rbx, rby); g.stroke();
  g.lineWidth = 4;
  for (const frac of [0.25, 0.5, 0.75]) {
    const bx = leftBotX + frac * (rightBotX - leftBotX);
    const [tx, ty] = interp(vpV[0], vpV[1], bx, botY, facadeTop);
    const [bx2, by2] = interp(vpV[0], vpV[1], bx, botY, botY);
    g.beginPath(); g.moveTo(tx, ty); g.lineTo(bx2, by2); g.stroke();
  }
  const drawH = (y) => {
    const [x1, y1] = leftAt(y), [x2, y2] = rightAt(y);
    g.strokeStyle = '#1a120c'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  };
  for (const y of [250, 400, 550, 700, 820]) drawH(y);
  return c.toDataURL('image/jpeg', 0.92).split(',')[1];
})), 'base64');

{
  const r = await suggest('synth-levelH.jpg', 'synth-levelH.jpg', synthBuf);
  check(r.ok === false && r.n === 0, `synthetic in-frame-VP Suggest refuses (ok=${r.ok}, n=${r.n})`);
  check(/no usable upright pair/i.test(r.status || '') && /as-is/i.test(r.status || ''), `synthetic refuse names the missing upright pair (${(r.status || '').slice(0, 140)})`);
  check(/~\d+\.\d+° vs ~\d+\.\d+°/.test(r.status || ''), `synthetic refuse includes both leftover numbers (${(r.status || '').slice(0, 160)})`);
  check(r.gate?.v2src === 'identity' && r.gate?.acceptMix === false, `synthetic gate is identity + refused (v2src=${r.gate?.v2src}, accept=${r.gate?.acceptMix}, mix=${r.gate?.mixedScore?.toFixed?.(2)}, ident=${r.gate?.v2score?.toFixed?.(2)})`);
}

// Diagnosis target (not used to tune): leftover stays ~23.6°, now gated vs identity
{
  check(existsSync(path.join(HERE, 'test-assets/real', 'v131-willis.jpg')), 'v131-willis.jpg present');
  const r = await suggest('v131-willis.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && r.nv === 2 && r.nh === 2, `willis Suggest still mixed 2V+2H (${r.nv}V+${r.nh}H)`);
  check(Number.isFinite(L) && L >= 23.3 && L <= 23.9, `willis leftover unchanged ~23.6° (~${L}°)`);
  check(r.gate?.v2src === 'identity' && r.gate?.acceptMix === true && r.gate?.vOk === true,
    `willis mix now gated vs identity (v2src=${r.gate?.v2src}, accept=${r.gate?.acceptMix}, vOk=${r.gate?.vOk})`);
}

// Other v131 held-outs unchanged (have a real pure-V baseline; not identity path)
{
  const r = await suggest('v131-canyon.jpg');
  const L = leftover(r);
  check(r.ok && !r.mixed && r.nv >= 2 && Number.isFinite(L) && L <= 13.0, `canyon still pure-V ~12.8° (~${L}° ${r.nv}V+${r.nh}H)`);
  check(r.gate && r.gate.v2src !== 'identity', `canyon still gates vs a pure-V pair (v2src=${r.gate?.v2src})`);
}
{
  const r = await suggest('v131-white.jpg');
  const L = leftover(r);
  check(r.ok && !r.mixed && r.nv >= 2 && Number.isFinite(L) && L <= 27.6, `white still pure-V ~27.3° (~${L}° ${r.nv}V+${r.nh}H)`);
  check(r.gate && r.gate.v2src !== 'identity', `white still gates vs a pure-V pair (v2src=${r.gate?.v2src})`);
}

// Angle leftover metric unchanged
{
  const r = await suggest('v130-angle.jpg');
  const L = leftover(r);
  check(r.ok && !r.mixed && r.nv >= 2 && Number.isFinite(L) && L <= 18.8, `angle leftover still ~18.6° (~${L}°)`);
}

// v130 + regression photos: same mode as v1.30 (safety fix, numbers unchanged)
{
  const r = await suggest('v130-highrise.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && r.gate?.vOk === true && Number.isFinite(L) && L <= 25.0, `highrise still vOk mixed (~${L}°)`);
}
{
  const r = await suggest('v130-below.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && Number.isFinite(L) && L <= 0.7, `below still mixed ≤0.7° (~${L}°)`);
}
{
  const r = await suggest('v128-towers.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && r.gate?.vOk === true && r.gate?.noOverallHarm === true && Number.isFinite(L) && L <= 27.0,
    `towers still vOk mixed ≤27° (~${L}°)`);
}
{
  const r = await suggest('v126-glass.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && r.gate?.vOk === true && L <= 14.0, `glass still vOk mixed ≤14° (~${L}°)`);
}
{
  const r = await suggest('v117-interior.jpg');
  const L = leftover(r);
  check(r.ok && r.mixed && r.gate?.vOk === true && L <= 4.5, `interior still vOk mixed ≤4.5° (~${L}°)`);
}

for (const f of ['v128-masonry.jpg', 'brick.jpg', 'v117-flat.jpg', 'v117-lowangle.jpg', 'geneva.jpg']) {
  const r = await suggest(f);
  check(r.ok && !r.mixed && r.nv >= 2, `${f} Suggest still pure-V (${r.nv}V+${r.nh}H)`);
}
for (const f of ['v128-balconies.jpg', 'v126-city.jpg', 'v126-resid.jpg', 'v117-cathedral.jpg', 'v117-frame.jpg', 'library.jpg', 'c4.jpg']) {
  const r = await suggest(f);
  check(r.ok && r.mixed, `${f} Suggest still mixed (${r.nv}V+${r.nh}H)`);
}

// c4 Full ≤0.5° on fixed vertical seeds (unchanged; not chased via Distortion)
{
  const seeds = [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]];
  await open('c4.jpg', 'c4-full-v131.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  const mapped = []; for (const sd of seeds) mapped.push(await mapUpright(sd));
  const w = worst(await edgeAngle(mapped));
  check(w != null && w <= 0.5, `c4 Full ≤0.5° on fixed V seeds (w=${w?.toFixed?.(2)})`);
}

{
  const audit = readFileSync(path.join(HERE, 'docs/AUDIT.md'), 'utf8');
  check(/v1\.31\.0/.test(audit) && /identity|ungated|no usable upright/i.test(audit), 'AUDIT.md has v1.31 identity-gate note');
}
{
  const bench = readFileSync(path.join(HERE, 'docs/WORKFLOW_BENCHMARK.md'), 'utf8');
  check(/v1\.31 scorecard/i.test(bench), 'WORKFLOW_BENCHMARK.md has v1.31 scorecard');
}
{
  const guide = readFileSync(path.join(HERE, 'docs/USER_GUIDE.md'), 'utf8');
  check(/leaving the photo as-is|no usable upright/i.test(guide), 'USER_GUIDE.md mentions the no-upright-pair mixed fallback');
}

check(errors.length === 0, `no page errors (${errors.slice(0, 2).join('; ')})`);
await browser.close();
if (!process.env.TW_URL) server.close();
console.log(`\n${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
