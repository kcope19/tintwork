// v1.5 test: local adjustments in develop — brush masks (size, feather, flow, Alt to erase, edge-aware auto mask,
// mouse smoothing), luminance and colour range masks intersecting the shapes, the wider set of local controls
// (highlights, shadows, tint, saturation, clarity, texture, sharpness, noise), the mask list (rename, duplicate,
// invert, delete) and the O mask overlay; plus the 24 MP cost per mask. Screenshots: 15x-*.png.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createStaticServer } from './serve.mjs';
import * as R from '../src/raw.js';
import { makeDNG } from './lib/dng-fixture.mjs';

let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const T0 = Date.now();
mkdirSync('screenshots', { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// 1. Node
// ---------------------------------------------------------------------------------------------------------
const meta = { blackLevel: [0, 0, 0, 0], whiteLevel: 1, cameraMultipliers: [1, 1, 1], colorMatrix: null };
const flat = (W, H, f) => { const s = { width: W, height: H, data: new Float32Array(W * H * 3), half: false }; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) s.data.set(f(x, y), (y * W + x) * 3); return s; };
const optsOf = (src, set) => ({ pipe: R.pipeline(meta, R.colorModel(meta), set, null), orientation: 1, settings: set, scale: 1, bits: 16, distortion: set.distortion || 0 });
const dev = (src, set) => R.developRows(src, optsOf(src, set));
const at = (r, x, y) => { const i = (y * r.width + x) * 4; return [r.data[i], r.data[i + 1], r.data[i + 2]]; };
const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
const D = (set) => ({ ...R.DEFAULT_SETTINGS, ...set });
const brushW = (a, src, u, v, W, H) => { const P = R.localPlan(R.prepareLocals([a], src, 1), W, H)[0]; const i = (Math.floor(v * H) * W + Math.floor(u * W)) * 3; const m = [0, 0, 0]; R.rangeMetrics(src.data[i], src.data[i + 1], src.data[i + 2], m); return R.maskWeight(P, u, v, W / H, src.data[i], src.data[i + 1], src.data[i + 2], m, [0, 0]); };
{ // validation
  const c = R.cleanLocal([{ type: 'brush', name: '  Sky  ', highlights: 300, noise: -5, tint: 20, strokes: [{ size: 9, feather: 2, flow: 0, pts: [0.1, 0.2, 0.3, 'x'] }, { erase: 1, pts: [0.5, 0.5, 0.6, 0.6] }, { pts: [] }, null], lum: { lo: 80, hi: 20, soft: 99 }, color: { hue: -30, range: 500 } }]);
  const a = c[0];
  check(a.type === 'brush' && a.name === 'Sky' && a.highlights === 100 && a.noise === 0 && a.tint === 20 && a.strokes.length === 1 && a.strokes[0].erase && a.strokes[0].size === 0.05 && a.lum.lo === 20 && a.lum.hi === 80 && a.lum.soft === 50 && a.color.hue === 330 && a.color.range === 90,
    'brush masks, names, ranges and the new controls are validated (bad strokes dropped, values clamped, lum range ordered, hue wrapped)');
  const many = R.cleanLocal([{ type: 'brush', strokes: Array.from({ length: 600 }, () => ({ pts: [0.5, 0.5] })) }])[0];
  check(many.strokes.length === R.MAX_STROKES && Object.keys(R.LOCAL_RANGES).length === 11, `at most ${R.MAX_STROKES} strokes per mask; 11 local controls (${Object.keys(R.LOCAL_RANGES).join(', ')})`);
}
{ // brush weights: size / feather / flow / erase
  const W = 400, H = 200, src = flat(W, H, () => [0.3, 0.3, 0.3]);
  const st = { size: 0.05, feather: 0, flow: 1, pts: [0.2, 0.5, 0.8, 0.5] }, a = { type: 'brush', exposure: 1, strokes: [st] };
  const w = [brushW(a, src, 0.5, 0.5, W, H), brushW(a, src, 0.5, 0.5 + 0.04 * W / H, W, H), brushW(a, src, 0.5, 0.5 + 0.07 * W / H, W, H), brushW(a, src, 0.05, 0.5, W, H)];
  const soft = { type: 'brush', exposure: 1, strokes: [{ ...st, feather: 1 }] }, ws = brushW(soft, src, 0.5, 0.5 + 0.025 * W / H, W, H);
  const half = { type: 'brush', exposure: 1, strokes: [{ ...st, flow: 0.5 }] }, wh = brushW(half, src, 0.5, 0.5, W, H);
  const twice = { type: 'brush', exposure: 1, strokes: [{ ...st, flow: 0.5 }, { ...st, flow: 0.5 }] }, w2 = brushW(twice, src, 0.5, 0.5, W, H);
  const er = { type: 'brush', exposure: 1, strokes: [st, { size: 0.05, feather: 0, flow: 1, erase: true, pts: [0.5, 0, 0.5, 1] }] }, we = [brushW(er, src, 0.5, 0.5, W, H), brushW(er, src, 0.3, 0.5, W, H)];
  const inv = { ...a, invert: true }, wi = [brushW(inv, src, 0.5, 0.5, W, H), brushW(inv, src, 0.05, 0.5, W, H)];
  check(w[0] > 0.98 && w[1] > 0.9 && w[2] < 0.02 && w[3] === 0, `a hard brush stroke: 1 on the stroke and inside its radius, 0 outside (${w.map((v) => v.toFixed(2)).join(', ')})`);
  check(ws > 0.2 && ws < 0.8 && Math.abs(wh - 0.5) < 0.03 && w2 > 0.7 && w2 < 0.8, `feather softens the edge (half-way out: ${ws.toFixed(2)}); flow 50 % gives ${wh.toFixed(2)}, two overlapping 50 % strokes build up to ${w2.toFixed(2)}`);
  check(we[0] < 0.02 && we[1] > 0.98 && wi[0] < 0.02 && wi[1] > 0.98, `an erase stroke removes the mask where it passes (${we[0].toFixed(2)}) and leaves the rest (${we[1].toFixed(2)}); invert swaps inside and outside`);
}
{ // auto mask stops at an edge
  const W = 400, H = 200, src = flat(W, H, (x) => (x < 200 ? [0.6, 0.25, 0.1] : [0.05, 0.12, 0.3]));
  const st = { size: 0.1, feather: 0, flow: 1, pts: [0.35, 0.5, 0.45, 0.5] };
  const plain = { type: 'brush', exposure: 1, strokes: [st] }, auto = { type: 'brush', exposure: 1, strokes: [{ ...st, auto: true }] };
  const wp = brushW(plain, src, 0.52, 0.5, W, H), wa = brushW(auto, src, 0.52, 0.5, W, H), wIn = brushW(auto, src, 0.47, 0.5, W, H);
  const r0 = dev(src, D({})), r1 = dev(src, D({ local: [auto] }));
  const dIn = lum(at(r1, 190, 100)) - lum(at(r0, 190, 100)), dOut = lum(at(r1, 210, 100)) - lum(at(r0, 210, 100));
  check(wp > 0.98 && wa < 0.05 && wIn > 0.95 && dIn > 3000 && Math.abs(dOut) < 300, `auto mask: a stroke on the orange side spills over the edge without it (${wp.toFixed(2)}) but stops at the edge with it (${wa.toFixed(2)}; same side ${wIn.toFixed(2)}); developed +${dIn.toFixed(0)} left of the edge, ${dOut.toFixed(0)} right of it`);
}
{ // range masks and intersection
  const W = 300, H = 200, src = flat(W, H, (x, y) => { const b = x % 100 < 50; if (y < 100) return b ? [0.7, 0.15, 0.08] : [0.08, 0.3, 0.06]; return b ? [0.02, 0.02, 0.02] : [0.6, 0.6, 0.6]; });
  const r0 = dev(src, D({}));
  const all = { type: 'radial', cx: 0.5, cy: 0.5, rx: 2, ry: 2, feather: 0, exposure: 1 };
  const rl = dev(src, D({ local: [{ ...all, lum: { lo: 50, hi: 100, soft: 5 } }] }));
  const dl = (r, x, y) => lum(at(r, x, y)) - lum(at(r0, x, y));
  check(dl(rl, 75, 150) > 2000 && Math.abs(dl(rl, 25, 150)) < 50, `luminance range 50–100: the light grey brightens (+${dl(rl, 75, 150).toFixed(0)}) and the near-black stays (${dl(rl, 25, 150).toFixed(0)})`);
  const red = { hue: 8, range: 20, soft: 10 }, rc = dev(src, D({ local: [{ ...all, color: red }] }));
  check(dl(rc, 25, 50) > 2000 && Math.abs(dl(rc, 75, 50)) < 50 && Math.abs(dl(rc, 75, 150)) < 50, `colour range (red ± 20°): the red patch brightens (+${dl(rc, 25, 50).toFixed(0)}); green (${dl(rc, 75, 50).toFixed(0)}) and grey (${dl(rc, 75, 150).toFixed(0)}) stay`);
  const lin = { type: 'linear', x0: 0.5, y0: 0, x1: 0.5, y1: 0.01, exposure: 1, color: red }; // full effect only above the line, i.e. none
  const lin2 = { type: 'linear', x0: 0, y0: 0.5, x1: 0.01, y1: 0.5, exposure: 1, color: red }; // left of x = 0
  const left = { type: 'linear', x0: 0.4, y0: 0.5, x1: 0.41, y1: 0.5, exposure: 1, color: red }; // x < 0.4: the first red patch only
  const ri = dev(src, D({ local: [left] }));
  check(dl(ri, 25, 50) > 2000 && Math.abs(dl(ri, 225, 50)) < 50 && Math.abs(dl(ri, 75, 50)) < 50, `ranges intersect with the shape: graduated (left 40 %) × red → the left red patch changes (+${dl(ri, 25, 50).toFixed(0)}), the red patch on the right does not (${dl(ri, 225, 50).toFixed(0)})`);
  const bw = { type: 'brush', exposure: 1, strokes: [{ size: 0.1, feather: 0, flow: 1, pts: [0.05, 0.75, 0.95, 0.75] }], lum: { lo: 50, hi: 100, soft: 5 } }, rb = dev(src, D({ local: [bw] }));
  check(dl(rb, 75, 150) > 2000 && Math.abs(dl(rb, 25, 150)) < 50 && Math.abs(dl(rb, 75, 50)) < 50, `a brush mask intersects with a luminance range too: on the painted row the grey brightens (+${dl(rb, 75, 150).toFixed(0)}), the near-black does not (${dl(rb, 25, 150).toFixed(0)}), nothing changes outside the stroke`);
  void lin; void lin2;
  const g = R.rangeSample(src, R.pipeline(meta, R.colorModel(meta), D({}), null), 1, 25 / 300, 50 / 200), k = R.rangeSample(src, R.pipeline(meta, R.colorModel(meta), D({}), null), 1, 75 / 300, 150 / 200);
  check(g.hue >= 0 && (g.hue < 20 || g.hue > 350) && g.sat > 0.3 && k.hue === -1 && k.lum > 60, `range eyedropper: red patch → hue ${g.hue}°, light grey → no hue, luminance ${k.lum}`);
}
{ // the new local controls
  const W = 240, H = 160, rnd = ((s) => () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296))(7);
  const src = flat(W, H, (x, y) => { if (y < 80) { const v = x < 120 ? 0.04 : 0.7; return [v, v * 0.9, v * 0.8]; } const n = (rnd() - 0.5) * 0.08, e = ((x >> 3) & 1) ? 0.5 : 0.25; return x < 120 ? [0.3 + n, 0.3 + n, 0.3 + n] : [e, e * 0.6, e * 0.3]; });
  const all = (p) => ({ type: 'radial', cx: 0.5, cy: 0.5, rx: 2, ry: 2, feather: 0, ...p });
  const r0 = dev(src, D({})), run = (p) => dev(src, D({ local: [all(p)] }));
  const L0 = (x, y) => lum(at(r0, x, y));
  const hi = run({ highlights: -80 }), sh = run({ shadows: 80 });
  check(lum(at(hi, 180, 40)) < L0(180, 40) - 1500 && Math.abs(lum(at(hi, 60, 40)) - L0(60, 40)) < 400 && lum(at(sh, 60, 40)) > L0(60, 40) + 1500 && Math.abs(lum(at(sh, 180, 40)) - L0(180, 40)) < 800,
    `local highlights −80 pull the bright patch down (${(lum(at(hi, 180, 40)) - L0(180, 40)).toFixed(0)}) and leave the dark one; shadows +80 lift the dark patch (+${(lum(at(sh, 60, 40)) - L0(60, 40)).toFixed(0)})`);
  const sat = run({ saturation: -100 }), tint = run({ tint: 60 }), p0 = at(r0, 200, 120), ps = at(sat, 200, 120), pt = at(tint, 60, 40), pt0 = at(r0, 60, 40);
  check(Math.max(...ps) - Math.min(...ps) < 300 && Math.max(...p0) - Math.min(...p0) > 5000 && pt[1] < pt0[1] && pt[0] > pt0[0], `saturation −100 makes the orange grey (spread ${Math.max(...ps) - Math.min(...ps)}); tint + moves toward magenta (G ${pt0[1]} → ${pt[1]})`);
  const sd = (r, x0, x1, y0, y1) => { let s = 0, s2 = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = lum(at(r, x, y)); s += v; s2 += v * v; n++; } return Math.sqrt(s2 / n - (s / n) ** 2); };
  const nr = run({ noise: 100 }), tx = run({ texture: 100 }), txn = run({ texture: -100 }), sp = run({ sharpness: 100 }), cl = run({ clarity: 100 });
  const n0 = sd(r0, 20, 100, 100, 150), nN = sd(nr, 20, 100, 100, 150), nT = sd(tx, 20, 100, 100, 150), nTn = sd(txn, 20, 100, 100, 150);
  const e0 = sd(r0, 130, 230, 100, 150), eS = sd(sp, 130, 230, 100, 150), eC = sd(cl, 130, 230, 100, 150);
  check(nN < n0 * 0.75 && nT > n0 * 1.1 && nTn < n0 * 0.9 && eS > e0 * 1.03 && eC > e0 * 1.03, `noise reduction 100 calms grain (σ ${n0.toFixed(0)} → ${nN.toFixed(0)}); texture +100 / −100 → σ ${nT.toFixed(0)} / ${nTn.toFixed(0)}; sharpness and clarity raise edge contrast (σ ${e0.toFixed(0)} → ${eS.toFixed(0)} / ${eC.toFixed(0)})`);
  const zero = dev(src, D({ local: [all({ clarity: 0, texture: 0, noise: 0, sharpness: 0, lum: { lo: 0, hi: 50 } })] }));
  let z = 0; for (let i = 0; i < zero.data.length; i++) z = Math.max(z, Math.abs(zero.data[i] - r0.data[i]));
  check(z === 0, 'a mask whose controls are all 0 changes nothing (also with a range set)');
}
{ // bands and overlay
  const W = 640, H = 420, rnd = ((s) => () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296))(3);
  const src = flat(W, H, (x, y) => { const n = (rnd() - 0.5) * 0.05, e = ((x >> 4) + (y >> 4)) & 1; return [0.2 + 0.5 * e + n, 0.25 + 0.3 * (x / W) + n, 0.15 + 0.4 * (y / H) + n]; });
  const set = D({ nr: 30, sharpen: 40, fringePurple: 40, distortion: 20, local: [
    { type: 'brush', exposure: 0.7, clarity: 60, texture: -40, noise: 50, strokes: [{ size: 0.08, feather: 0.6, flow: 0.8, auto: true, pts: [0.1, 0.2, 0.5, 0.5, 0.9, 0.8] }, { erase: true, size: 0.03, feather: 0, flow: 1, pts: [0.5, 0, 0.5, 1] }] },
    { type: 'radial', sharpness: 80, highlights: -50, shadows: 40, saturation: 30, tint: -20, cx: 0.4, cy: 0.6, rx: 0.3, ry: 0.25, lum: { lo: 20, hi: 90, soft: 10 }, color: { hue: 30, range: 40, soft: 20 } },
    { type: 'linear', clarity: -50, temp: 20, x0: 0.5, y0: 0, x1: 0.5, y1: 0.4 }] });
  const o = { ...optsOf(src, set), locals: R.prepareLocals(set.local, src, 1) }, whole = R.developRows(src, o);
  const out = new Uint16Array(whole.data.length);
  for (const b of R.planBands(src, o, 6)) { const r = R.developRows(R.extractRegion(src, b.rect), { ...o, rows: b.rows }); out.set(r.data, b.rows[0] * r.width * 4); }
  let worst = 0; for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - whole.data[i]));
  check(worst <= 1, `band develop (6 bands) equals the whole-image develop with brush + auto mask + ranges + clarity / texture / sharpness / noise + NR + sharpen + defringe + distortion (max difference ${worst})`);
  const ov = R.developRows(src, { ...o, settings: { ...set, maskShow: 1 } }), pr = (r) => { let red = 0; for (let i = 0; i < r.data.length; i += 4) if (r.data[i] - Math.max(r.data[i + 1], r.data[i + 2]) > 20000) red++; return red / (r.data.length / 4); };
  check(pr(ov) > pr(whole) + 0.05 && R.cleanSettings({ ...set, maskShow: 1 }).maskShow === undefined, `the mask overlay tints the selected mask's area red (${(pr(ov) * 100).toFixed(0)} % red vs ${(pr(whole) * 100).toFixed(0)} %) and is never saved with the settings`);
}

// ---------------------------------------------------------------------------------------------------------
// 2. Browser
// ---------------------------------------------------------------------------------------------------------
const server = createStaticServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const tmp = 'test-assets/.v15'; mkdirSync(tmp, { recursive: true });
const sceneFile = `${tmp}/scene.dng`;
// sky (blue, top), orange wall (left), dark green (right), grey road (bottom)
writeFileSync(sceneFile, makeDNG({ W: 900, H: 600, lens: false, scene: (x, y) => (y < 240 ? [0.12, 0.25, 0.55 - 0.2 * y / 240] : y > 480 ? [0.35, 0.35, 0.35] : x < 450 ? [0.6, 0.28, 0.08] : [0.04, 0.1, 0.03]) }));
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => localStorage.setItem('tintwork.engine', 'cpu'));
const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(async () => { await window.tintwork.clearAutosave?.(); for (const k of ['tintwork.rawPresets', 'tintwork.rawLast', 'tintwork.lensProfiles', 'tintwork.rawLink', 'tintwork.rawBrush']) localStorage.removeItem(k); });
const waitPreview = (n) => page.waitForFunction((n) => { const u = window.tintwork.rawUI; return u && u.previews >= n && u.idle; }, n, { timeout: 30000 });
const previews = () => page.evaluate(() => window.tintwork.rawUI.previews);
const prev = (fx, fy) => page.evaluate(([fx, fy]) => { const c = document.querySelector('#rawCanvas'), d = c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data; return [d[0], d[1], d[2]]; }, [fx, fy]);
const L = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
const local = () => page.evaluate(() => JSON.parse(JSON.stringify(window.tintwork.rawUI.settings.local)));
const after = async (fn) => { const n = await previews(); await fn(); await waitPreview(n + 1); };
await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'v15in'; i.hidden = true; document.body.append(i); });
const openDialog = async (f) => { await page.evaluate(() => { document.querySelector('#v15in').value = ''; }); await page.setInputFiles('#v15in', f);
  await page.evaluate(() => { window.tintwork.openRAW(document.querySelector('#v15in').files[0], true); }); await waitPreview(1); };
const box = () => page.evaluate(() => { const r = window.tintwork.rawUI.overlay().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const drag = async (b, pts, steps = 12) => { await page.mouse.move(b.x + b.w * pts[0][0], b.y + b.h * pts[0][1]); await page.mouse.down(); for (const [u, v] of pts.slice(1)) await page.mouse.move(b.x + b.w * u, b.y + b.h * v, { steps }); await page.mouse.up(); };
{
  await openDialog(sceneFile);
  const s0 = { wall: await prev(0.25, 0.6), green: await prev(0.75, 0.6), sky: await prev(0.5, 0.2) };
  await page.click('#rawAddBrush');
  const st = await page.evaluate(() => ({ mode: window.tintwork.rawUI.brushMode, list: document.querySelectorAll('#rawMaskList [data-mi]').length, name: document.querySelector('#rawMaskList .raw-mask-name')?.textContent, box: !document.querySelector('#rawBrushBox').classList.contains('hidden') }));
  check(st.mode && st.list === 1 && st.name === 'Brush 1' && st.box, `Add brush: a “${st.name}” mask in the list, brush mode on, brush controls shown`);
  await page.evaluate(() => window.tintwork.rawUI.setBrush({ size: 6, feather: 30, flow: 100, smooth: 50, auto: false }));
  const b = await box();
  await page.mouse.move(b.x + b.w * 0.3, b.y + b.h * 0.6);
  const cur = await page.evaluate(() => { const c = window.tintwork.rawUI.overlay(), g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < g.length; i += 4) if (g[i] > 100) n++; return { n, cur: getComputedStyle(c).cursor }; });
  check(cur.n > 50 && cur.cur === 'none', `the brush shows its size as a circle under the mouse (${cur.n} outline pixels; the system cursor is hidden)`);
  await after(() => drag(b, [[0.1, 0.6], [0.4, 0.6]]));
  let l1 = await local();
  const s1 = { wall: await prev(0.25, 0.6), green: await prev(0.75, 0.6), sky: await prev(0.5, 0.2) };
  const pts = l1[0].strokes[0].pts;
  check(l1[0].strokes.length === 1 && pts.length >= 8 && L(s1.wall) > L(s0.wall) + 10 && Math.abs(L(s1.green) - L(s0.green)) < 2 && Math.abs(L(s1.sky) - L(s0.sky)) < 2,
    `painting with the mouse adds a stroke (${pts.length / 2} points) and brightens only where it was painted (wall ${L(s0.wall).toFixed(0)} → ${L(s1.wall).toFixed(0)}, green and sky unchanged)`);
  const endU = pts[pts.length - 2], dy = Math.max(...pts.filter((_, i) => i % 2).map((v) => Math.abs(v - 0.6)));
  check(Math.abs(endU - 0.4) < 0.01 && dy < 0.01, `stroke smoothing keeps the line straight and still ends where the mouse was released (end u = ${endU.toFixed(3)})`);
  // Alt erases
  await page.keyboard.down('Alt'); await after(() => drag(b, [[0.25, 0.45], [0.25, 0.75]])); await page.keyboard.up('Alt');
  l1 = await local(); const s2 = await prev(0.25, 0.6), s2b = await prev(0.15, 0.6);
  check(l1[0].strokes.length === 2 && l1[0].strokes[1].erase && Math.abs(L(s2) - L(s0.wall)) < 4 && L(s2b) > L(s0.wall) + 10, `holding Alt while dragging erases: the crossed part is back to normal (${L(s2).toFixed(0)}) and the rest stays painted (${L(s2b).toFixed(0)})`);
  // [ and ] size
  const z0 = (await page.evaluate(() => window.tintwork.rawUI.brush())).size; await page.keyboard.press(']'); await page.keyboard.press(']'); const z1 = (await page.evaluate(() => window.tintwork.rawUI.brush())).size; await page.keyboard.press('['); const z2 = (await page.evaluate(() => window.tintwork.rawUI.brush())).size;
  check(z1 > z0 && z2 < z1 && (await page.evaluate(() => document.querySelector('[data-bo=size]').textContent)) === `${z2}%`, `] and [ change the brush size (${z0} → ${z1} → ${z2} %)`);
  // auto mask: a stroke on the wall near the green edge stays on the wall
  await page.evaluate(() => window.tintwork.rawUI.setBrush({ size: 8, auto: true }));
  await page.click('#rawAddBrush');
  const g0 = await prev(0.53, 0.65);
  await after(() => drag(b, [[0.44, 0.55], [0.44, 0.75]]));
  const l2 = await local(), g1 = await prev(0.53, 0.65), w1 = await prev(0.4, 0.65);
  check(l2[1].strokes[0].auto && Math.abs(L(g1) - L(g0)) < 3 && L(w1) > L(s0.wall) + 10, `auto mask: a brush stroke on the wall stops at the green edge (green ${L(g0).toFixed(0)} → ${L(g1).toFixed(0)}, wall ${L(s0.wall).toFixed(0)} → ${L(w1).toFixed(0)})`);
  // O overlay
  await page.evaluate(() => window.tintwork.rawUI.selectLocal(0));
  await after(() => page.keyboard.press('o'));
  const ov = await prev(0.15, 0.6), ovNo = await prev(0.75, 0.3), on1 = await page.evaluate(() => [window.tintwork.rawUI.maskOn, document.querySelector('#rawMaskOv').checked]);
  check(on1[0] && on1[1] && ov[0] > ov[1] + 60 && ov[0] > ov[2] + 60 && ovNo[2] > ovNo[0], `O shows the selected mask as a red overlay (painted ${ov.join(',')}; unpainted sky stays ${ovNo.join(',')})`);
  await page.screenshot({ path: 'screenshots/15a-raw-brush-mask-overlay.png' });
  await after(() => page.keyboard.press('o'));
  const ovOff = await prev(0.15, 0.6);
  check(Math.abs(L(ovOff) - L(s2b)) < 3 && !(await page.evaluate(() => window.tintwork.rawUI.maskOn)), 'O again hides the overlay (the preview is back to the edit)');
  // mask list: rename, duplicate, invert, delete
  await page.dblclick('#rawMaskList [data-mi="0"]');
  await page.fill('#rawMaskList .raw-mask-rename', 'Wall light'); await page.keyboard.press('Enter');
  const nm = await page.evaluate(() => [window.tintwork.rawUI.settings.local[0].name, document.querySelector('#rawMaskList [data-mi="0"] .raw-mask-name').textContent]);
  check(nm[0] === 'Wall light' && nm[1] === 'Wall light', `double-click a mask to rename it (“${nm[0]}”)`);
  await page.click('#rawMaskList [data-mi="0"]');
  await after(() => page.click('#rawMaskDup'));
  let l3 = await local();
  check(l3.length === 3 && l3[1].name === 'Wall light copy' && JSON.stringify(l3[1].strokes) === JSON.stringify(l3[0].strokes) && (await page.evaluate(() => window.tintwork.rawUI.localSel)) === 1, `Duplicate copies the mask with its strokes (“${l3[1].name}”, selected)`);
  const d0 = await prev(0.15, 0.6);
  await after(() => page.click('#rawMaskInv'));
  l3 = await local(); const d1 = await prev(0.15, 0.6), d1s = await prev(0.5, 0.2);
  check(l3[1].invert && L(d1) < L(d0) - 5 && L(d1s) > L(s0.sky) + 5 && (await page.evaluate(() => document.querySelector('#rawMaskInv').getAttribute('aria-pressed'))) === 'true', `Invert applies the copy everywhere except the painted area (sky ${L(s0.sky).toFixed(0)} → ${L(d1s).toFixed(0)})`);
  await after(() => page.click('#rawLocalDel'));
  l3 = await local();
  check(l3.length === 2 && l3[0].name === 'Wall light' && Math.abs(L(await prev(0.5, 0.2)) - L(s0.sky)) < 2, 'Delete removes the selected mask');
  // ranges: colour eyedropper and luminance
  await page.evaluate(() => window.tintwork.rawUI.selectLocal(1));
  await after(() => page.evaluate(() => window.tintwork.rawUI.setLocal(1, { strokes: [], type: 'brush', invert: true, exposure: 1 })));
  await page.click('#rawColPick');
  const pk = await page.evaluate(() => [window.tintwork.rawUI.rangePick, getComputedStyle(window.tintwork.rawUI.overlay()).cursor]);
  await after(async () => { await page.mouse.click(b.x + b.w * 0.2, b.y + b.h * 0.6); await page.waitForFunction(() => window.tintwork.rawUI.lastRange, null, { timeout: 10000 }); });
  const l4 = await local(), c1 = { wall: await prev(0.25, 0.65), green: await prev(0.75, 0.6), sky: await prev(0.5, 0.2), road: await prev(0.5, 0.9) };
  check(pk[0] === 'color' && pk[1] === 'crosshair' && l4[1].color && Math.abs(l4[1].color.hue - 25) < 25 && L(c1.wall) > L(s0.wall) + 10 && Math.abs(L(c1.sky) - L(s0.sky)) < 3 && Math.abs(L(c1.green) - L(s0.green)) < 3,
    `color range eyedropper: clicking the orange wall sets hue ${l4[1].color?.hue}°; an inverted (whole-image) mask then brightens only the wall (${L(s0.wall).toFixed(0)} → ${L(c1.wall).toFixed(0)}; sky ${L(s0.sky).toFixed(0)} → ${L(c1.sky).toFixed(0)}, green ${L(s0.green).toFixed(0)} → ${L(c1.green).toFixed(0)}) [${pk}]`);
  await after(() => page.evaluate(() => { document.querySelector('#rawColOn').click(); }));
  await page.click('#rawLumPick');
  await after(async () => { await page.evaluate(() => { window.tintwork.rawUI.lastRange = null; }); await page.mouse.click(b.x + b.w * 0.5, b.y + b.h * 0.9); await page.waitForFunction(() => window.tintwork.rawUI.lastRange, null, { timeout: 10000 }); });
  const l5 = await local(), c2 = { road: await prev(0.5, 0.9), green: await prev(0.75, 0.6) };
  check(!l5[1].color && l5[1].lum && l5[1].lum.lo < l5[1].lum.hi && L(c2.road) > L(s0.wall) - 200 && Math.abs(L(c2.green) - L(s0.green)) < 3, `luminance eyedropper on the grey road sets ${l5[1].lum.lo}–${l5[1].lum.hi}: the road brightens, the dark green does not`);
  // the new sliders
  await page.evaluate(() => window.tintwork.rawUI.selectLocal(0));
  const sat0 = await prev(0.15, 0.6);
  await after(() => page.evaluate(() => { const el = document.querySelector('#modal [data-l=saturation]'); el.value = -100; el.dispatchEvent(new Event('input', { bubbles: true })); }));
  const sat1 = await prev(0.15, 0.6), spread = (p) => Math.max(...p) - Math.min(...p);
  const sliders = await page.evaluate(() => [...document.querySelectorAll('#rawLocalBox [data-l]')].map((e) => e.dataset.l));
  check(spread(sat1) < spread(sat0) / 3 && ['highlights', 'shadows', 'saturation', 'tint', 'clarity', 'texture', 'sharpness', 'noise'].every((k) => sliders.includes(k)), `local sliders: ${sliders.filter((k) => k !== 'feather').join(', ')}; saturation −100 turns the painted wall grey (spread ${spread(sat0)} → ${spread(sat1)})`);
  await page.screenshot({ path: 'screenshots/15b-raw-mask-list-ranges.png' });
  // apply → the layer keeps the masks; re-develop shows them again
  const n0 = await page.evaluate(() => window.tintwork.history.index); await page.click('#modalOk');
  await page.waitForFunction((n) => window.tintwork.history.index > n && !window.tintwork.rawUI && !document.querySelector('.dev-overlay'), n0, { timeout: 60000 });
  const kept = await page.evaluate(() => window.tintwork.activeLayer().raw.settings);
  check(kept.local?.length === 2 && kept.local[0].name === 'Wall light' && kept.local[0].strokes.length === 2 && kept.local[0].saturation === -100 && kept.local[1].lum && kept.maskShow === undefined, 'Develop keeps the masks (names, strokes, ranges, controls) in the layer; the overlay setting is not saved');
  await page.evaluate(() => { window.tintwork.redevelopRaw(); }); await page.waitForFunction(() => window.tintwork.rawUI?.redevelop && window.tintwork.rawUI.previews >= 1 && window.tintwork.rawUI.idle, null, { timeout: 30000 });
  const re = await page.evaluate(() => [...document.querySelectorAll('#rawMaskList .raw-mask-name')].map((e) => e.textContent));
  check(re.length === 2 && re[0] === 'Wall light' && re[1] === 'Brush 2', `Layer ▸ Re-develop lists the masks again (${re.join(', ')})`);
  await page.click('#modalCancel'); await page.waitForTimeout(150);
  const pj = await page.evaluate(async () => (await window.tintwork.projectData()).layers[0].raw.settings.local);
  check(pj?.[0]?.strokes?.[0]?.pts?.length > 4, 'brush strokes are saved in the project file');
}
// ---------------------------------------------------------------------------------------------------------
// 3. Cost per mask: single-thread develop of a 6 MP frame in Node (stable), and the 24 MP sample in the app (workers)
// ---------------------------------------------------------------------------------------------------------
const strokeOf = (auto) => ({ type: 'brush', exposure: 0.5, strokes: [{ size: 0.06, feather: 0.5, flow: 1, auto, pts: Array.from({ length: 60 }, (_, i) => [0.1 + 0.8 * i / 59, 0.5 + 0.2 * Math.sin(i / 6)]).flat() }] });
const radOf = (p) => ({ type: 'radial', cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, feather: 0.5, ...p });
const all8 = Array.from({ length: 8 }, (_, i) => ({ ...(i % 2 ? radOf({ cx: 0.2 + i * 0.08, rx: 0.2, ry: 0.2 }) : strokeOf(i === 0)), exposure: 0.2, highlights: -20, shadows: 20, saturation: 10, tint: 5, clarity: 20, texture: 10, sharpness: 20, noise: 10, ...(i === 2 ? { lum: { lo: 30, hi: 100 } } : {}) }));
const costCases = [
  ['graduated (exposure)', [{ type: 'linear', exposure: -0.7, x0: 0.5, y0: 0, x1: 0.5, y1: 0.45 }]], ['radial (exposure)', [radOf({ exposure: 0.5 })]],
  ['brush (60-point stroke)', [strokeOf(false)]], ['brush with auto mask', [strokeOf(true)]],
  ['radial + luminance range', [radOf({ exposure: 0.5, lum: { lo: 40, hi: 100, soft: 10 } })]], ['radial + colour range', [radOf({ exposure: 0.5, color: { hue: 210, range: 30, soft: 20 } })]],
  ['radial: highlights + shadows', [radOf({ highlights: -40, shadows: 40 })]], ['radial: clarity', [radOf({ clarity: 50 })]], ['radial: texture', [radOf({ texture: 50 })]],
  ['radial: sharpness', [radOf({ sharpness: 50 })]], ['radial: noise', [radOf({ noise: 50 })]], ['8 masks, every control', all8],
];
{
  const W = 3000, H = 2000, src = { width: W, height: H, data: new Float32Array(W * H * 3), half: false };
  for (let i = 0; i < src.data.length; i++) src.data[i] = (((i * 2654435761) >>> 0) / 4294967296) * 0.8;
  const time = (loc) => { const set = D({ local: loc }), o = optsOf(src, set); let best = 1e9; for (let r = 0; r < 2; r++) { const t = performance.now(); R.developRows(src, { ...o, locals: R.prepareLocals(loc, src, 1) }); best = Math.min(best, performance.now() - t); } return best; };
  const b0 = time(null), rows = costCases.map(([name, loc]) => ({ name, ms: time(loc) - b0 }));
  console.log(`     Node, one thread, 6 MP: baseline ${b0.toFixed(0)} ms (develop + NR + sharpen); cost per mask (ms per 6 MP, ×4 for 24 MP on one core):`);
  for (const r of rows) console.log(`       ${r.name.padEnd(30)} +${Math.max(0, r.ms).toFixed(0)} ms  (${(Math.max(0, r.ms) / 6).toFixed(0)} ns/pixel)`);
  console.log(`TIMING_MASKS_NODE ${JSON.stringify({ baseline: Math.round(b0), cost: Object.fromEntries(rows.map((r) => [r.name, Math.round(r.ms)])) })}`);
  const one = Math.max(...rows.slice(0, -1).map((r) => r.ms)), eight = rows[rows.length - 1].ms;
  check(one < b0 && eight < 6 * b0, `cost per mask (single thread, 6 MP): at most +${one.toFixed(0)} ms for one mask (baseline ${b0.toFixed(0)} ms); 8 masks with every control +${eight.toFixed(0)} ms`);
}
const big = 'test-assets/raw-samples/sony-ilce-6000.arw';
if (existsSync(big) && !process.env.SKIP_BIG) {
  await page.setInputFiles('#v15in', big);
  const cases = [['baseline (no masks)', null], ...costCases.filter(([n]) => /^(radial \(exposure\)|brush with auto mask|radial: clarity|8 masks)/.test(n))];
  const res = [];
  for (const [name, loc] of cases) {
    const runs = [];
    for (let k = 0; k < 3; k++) runs.push(await page.evaluate(async (set) => { const t = window.tintwork; await t.openRAW(document.querySelector('#v15in').files[0], false, { ...t.RAW_DEFAULTS, ...set }); const x = { ...t.lastImport }; await t.closeTab(undefined, { force: true }); return { develop: x.develop, total: x.total, mp: x.mp, bands: x.bands, workers: x.workers }; }, { local: loc }));
    res.push({ name, ...runs.sort((a, b) => a.develop - b.develop)[0] });
  }
  const b0 = res[0].develop;
  console.log(`TIMING_MASKS_24MP ${JSON.stringify(res.map((r) => ({ name: r.name, develop: r.develop, total: r.total, cost: r.develop - b0, bands: r.bands, workers: r.workers })))}`);
  for (const r of res) console.log(`     24 MP in the app (best of 3): ${r.name.padEnd(26)} develop ${r.develop} ms${r === res[0] ? '' : ` (${r.develop - b0 >= 0 ? '+' : ''}${r.develop - b0} ms)`}`);
  const one = Math.max(...res.slice(1, -1).map((r) => r.develop - b0)), e8 = res[res.length - 1].develop - b0;
  check(res[0].mp > 20 && one < 800 && e8 < 5000, `24 MP full-resolution develop (${res[0].workers} workers): baseline ${b0} ms; one mask adds at most ${one} ms; 8 masks with every control add ${e8} ms`);
} else console.log(`skip: 24 MP timing (${existsSync(big) ? 'SKIP_BIG set' : 'sample not present: npm run samples'})`);
const ui = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('[title]')].map((e) => e.title).join(' '));
check(!/photoshop|adobe/i.test(ui), 'no product names of other editors in the UI');
check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close(); server.close();
console.log(fails ? `${fails} of ${count} v1.5 check(s) FAILED (${((Date.now() - T0) / 1000).toFixed(0)} s)` : `All ${count} v1.5 checks passed (${((Date.now() - T0) / 1000).toFixed(0)} s)`);
process.exit(fails ? 1 : 0);
