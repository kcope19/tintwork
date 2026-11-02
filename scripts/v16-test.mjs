// v1.6 test: the RAW develop on the GPU — WebGPU compute and the WebGL2 fallback checked against the CPU develop
// (the reference) stage by stage and filter by filter; mask shapes combined with add / subtract / intersect; the
// local whites, blacks, dehaze and hue controls; live previews while dragging sliders and painting (incremental brush
// raster, half-size drafts when the full preview is slow); the develop engine choice; and the RAW develop rows in
// Help › Run performance benchmark. Screenshots: 16x-*.png.
//
// The GPU here is SwiftShader (a software GPU): it proves the GPU code is right, but its timings say nothing about a
// hardware GPU, so the speed numbers printed below are informational only.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createStaticServer } from './serve.mjs';
import { parityInPage } from './lib/gpu-parity.mjs';
import * as R from '../src/raw.js';
import { makeDNG } from './lib/dng-fixture.mjs';

let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const info = (msg) => console.log(`     ${msg}`);
const T0 = Date.now();
mkdirSync('screenshots', { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// 1. Node (the CPU develop is the reference)
// ---------------------------------------------------------------------------------------------------------
const meta = { blackLevel: [0, 0, 0, 0], whiteLevel: 1, cameraMultipliers: [1, 1, 1], colorMatrix: null };
const flat = (W, H, f) => { const s = { width: W, height: H, data: new Float32Array(W * H * 3), half: false }; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) s.data.set(f(x, y), (y * W + x) * 3); return s; };
const D = (set) => ({ ...R.DEFAULT_SETTINGS, ...set });
const optsOf = (src, set) => ({ pipe: R.pipeline(meta, R.colorModel(meta), set, null), orientation: 1, settings: set, scale: 1, bits: 16 });
const dev = (src, set) => R.developRows(src, optsOf(src, set));
const at = (r, x, y) => { const i = (y * r.width + x) * 4; return [r.data[i], r.data[i + 1], r.data[i + 2]]; };
const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
const hueOf = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn || 1; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
const satOf = (p) => (Math.max(...p) - Math.min(...p)) / (Math.max(...p) || 1);
{ // validation of the shapes and the new controls
  const c = R.cleanLocal([{ type: 'radial', cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, whites: 300, blacks: -300, dehaze: 40, hue: 500,
    parts: [{ op: 'subtract', type: 'radial', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1 }, { op: 'weird', type: 'linear', x0: 0, y0: 0, x1: 0, y1: 1, invert: 1 }, { type: 'brush' }, null, ...Array.from({ length: 12 }, () => ({ op: 'intersect', type: 'radial' }))] }])[0];
  check(c.whites === 100 && c.blacks === -100 && c.dehaze === 40 && c.hue === 180 && c.parts.length === R.MAX_PARTS && c.parts[0].op === 'subtract' && c.parts[1].op === 'add' && c.parts[1].invert === true && c.parts.every((p) => ['linear', 'radial'].includes(p.type)),
    `shapes and the new controls are validated (whites / blacks clamped to ±100, hue to ±180°, at most ${R.MAX_PARTS} extra shapes, unknown ops → add, brush / bad shapes dropped)`);
}
{ // add / subtract / intersect
  const W = 300, H = 200, src = flat(W, H, () => [0.3, 0.3, 0.3]), asp = W / H;
  const w = (a, u, v) => { const P = R.localPlan(R.prepareLocals([a], src, 1), W, H)[0], m = [0, 0, 0]; R.rangeMetrics(0.3, 0.3, 0.3, m); return R.maskWeight(P, u, v, asp, 0.3, 0.3, 0.3, m, [0, 0]); };
  const base = { type: 'radial', exposure: 1, cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, feather: 0 };
  const hole = { ...base, parts: [{ op: 'subtract', type: 'radial', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1, feather: 0 }] };
  check(w(base, 0.5, 0.5) > 0.99 && w(hole, 0.5, 0.5) < 0.01 && w(hole, 0.7, 0.5) > 0.99 && w(hole, 0.95, 0.5) < 0.01, `subtract cuts a hole: centre ${w(hole, 0.5, 0.5).toFixed(2)}, ring ${w(hole, 0.7, 0.5).toFixed(2)}, outside ${w(hole, 0.95, 0.5).toFixed(2)}`);
  const plus = { ...base, parts: [{ op: 'add', type: 'linear', x0: 0.5, y0: 1, x1: 0.5, y1: 0.9 }] };
  check(w(plus, 0.05, 0.99) > 0.9 && w(plus, 0.5, 0.5) > 0.99 && w(plus, 0.05, 0.3) < 0.01, `add takes the union with a graduated shape (bottom corner ${w(plus, 0.05, 0.99).toFixed(2)}, centre ${w(plus, 0.5, 0.5).toFixed(2)}, top corner ${w(plus, 0.05, 0.3).toFixed(2)})`);
  const top = { op: 'intersect', type: 'linear', x0: 0.5, y0: 0, x1: 0.5, y1: 0.5 }, inter = { ...base, parts: [top] }, interInv = { ...base, parts: [{ ...top, invert: true }] };
  check(w(inter, 0.5, 0.25) > 0.4 && w(inter, 0.5, 0.75) < 0.01 && w(interInv, 0.5, 0.75) > 0.4 && w(interInv, 0.5, 0.25) < 0.6 && w(inter, 0.05, 0.1) < 0.01,
    `intersect keeps only the overlap (top ${w(inter, 0.5, 0.25).toFixed(2)}, bottom ${w(inter, 0.5, 0.75).toFixed(2)}); a part's Invert uses its outside (bottom ${w(interInv, 0.5, 0.75).toFixed(2)})`);
  const inv = { ...hole, invert: true };
  check(Math.abs(w(inv, 0.5, 0.5) - 1) < 0.01 && w(inv, 0.7, 0.5) < 0.01, 'the mask Invert applies after its shapes are combined (the hole becomes the adjusted area)');
  const pts = []; for (let k = 0; k < 40; k++) { const u = k / 39, v = 0.1 + 0.8 * ((k * 7) % 13) / 12; pts.push([u, v]); }
  const multi = { ...base, feather: 0.4, parts: [{ op: 'subtract', type: 'radial', cx: 0.4, cy: 0.5, rx: 0.1, ry: 0.15, feather: 0.5 }, { op: 'add', type: 'linear', x0: 0.2, y0: 1, x1: 0.3, y1: 0.7 }, { op: 'intersect', type: 'linear', x0: 1, y0: 0.5, x1: 0, y1: 0.5, invert: true }] };
  const worst = Math.max(...pts.map(([u, v]) => Math.abs(w(multi, u, v) - R.maskShapeWeight(multi, u, v, asp))));
  check(worst < 1e-6, `the develop's mask weights equal the overlay's shape weights for 3 combined shapes (max difference ${worst.toExponential(1)})`);
}
{ // whites / blacks / dehaze / hue (local)
  const W = 400, H = 100, cols = [[0.03, 0.03, 0.03], [0.18, 0.18, 0.18], [0.75, 0.75, 0.75], [0.5, 0.08, 0.05], [0.35, 0.37, 0.42]];
  const src = flat(W, H, (x) => cols[Math.floor(x / 80)]), all = { type: 'radial', cx: 0.5, cy: 0.5, rx: 5, ry: 5, feather: 0 };
  const P = (r) => cols.map((_, i) => at(r, i * 80 + 40, 50)), b = P(dev(src, D({}))), go = (k, v) => P(dev(src, D({ local: [{ ...all, [k]: v }] })));
  const wh = go('whites', 70), bl = go('blacks', -70), dz = go('dehaze', 70), dzn = go('dehaze', -70), hu = go('hue', 60), hun = go('hue', -60);
  check(lum(wh[2]) - lum(b[2]) > 3 * Math.max(1, lum(wh[0]) - lum(b[0])) && lum(wh[2]) > lum(b[2]) + 1500, `local Whites lifts the bright end far more than the dark end (+${(lum(wh[2]) - lum(b[2])).toFixed(0)} vs +${(lum(wh[0]) - lum(b[0])).toFixed(0)})`);
  check(lum(bl[0]) < lum(b[0]) - 500 && Math.abs(lum(bl[2]) - lum(b[2])) < (lum(b[0]) - lum(bl[0])) / 3, `local Blacks deepens the dark end and leaves the bright end nearly alone (${(lum(bl[0]) - lum(b[0])).toFixed(0)} vs ${(lum(bl[2]) - lum(b[2])).toFixed(0)})`);
  const ctr = (p) => lum(p[2]) - lum(p[1]);
  check(ctr(dz) > ctr(b) + 500 && lum(dz[4]) < lum(b[4]) && satOf(dz[4]) > satOf(b[4]) && ctr(dzn) < ctr(b) - 500 && lum(dzn[0]) > lum(b[0]),
    `local Dehaze adds contrast and colour to a hazy patch (contrast ${ctr(b).toFixed(0)} → ${ctr(dz).toFixed(0)}, haze saturation ${satOf(b[4]).toFixed(2)} → ${satOf(dz[4]).toFixed(2)}); negative dehaze adds haze`);
  const dh = (p, q) => ((hueOf(p) - hueOf(q) + 540) % 360) - 180;
  check(dh(hu[3], b[3]) > 30 && dh(hu[3], b[3]) < 80 && dh(hun[3], b[3]) < -30 && dh(hun[3], b[3]) > -80 && Math.abs(lum(hu[1]) - lum(b[1])) < 2 && Math.abs(lum(hu[3]) - lum(b[3])) / lum(b[3]) < 0.25,
    `local Hue shift turns the red patch (${hueOf(b[3]).toFixed(0)}° → ${hueOf(hu[3]).toFixed(0)}° at +60, ${hueOf(hun[3]).toFixed(0)}° at −60), keeps greys grey and keeps brightness close`);
}
{ // incremental brush raster while painting
  const strokes = Array.from({ length: 150 }, (_, i) => ({ size: 0.04, feather: 0.5, flow: 0.8, pts: [0.1 + (i % 15) * 0.05, 0.1 + Math.floor(i / 15) * 0.08, 0.15 + (i % 15) * 0.05, 0.12 + Math.floor(i / 15) * 0.08] }));
  const OW = 1400, OH = 933, s0 = { ...R.rasterStats };
  let t = performance.now(); R.cachedRaster(strokes, OW, OH); const tFull = performance.now() - t;
  const live = strokes.slice(0, -1).concat([{ ...strokes.at(-1), pts: strokes.at(-1).pts.slice() }]), times = [];
  for (let k = 0; k < 10; k++) { live.at(-1).pts.push(0.2 + k * 0.01, 0.9); live[live.length - 1] = { ...live.at(-1), pts: live.at(-1).pts.slice() }; t = performance.now(); R.cachedRaster(live, OW, OH); times.push(performance.now() - t); }
  const s1 = { ...R.rasterStats }, med = times.sort((a, b) => a - b)[5];
  const g1 = R.cachedRaster(live, OW, OH), s2 = { ...R.rasterStats };
  for (let k = 0; k < 14; k++) R.cachedRaster([{ size: 0.02, feather: 0, flow: 1, pts: [k / 14, 0.5] }], OW, OH); // evict
  const g2 = R.cachedRaster(live.map((st) => ({ ...st })), OW, OH), same = (a, b) => { if (a === b) return true; if (ArrayBuffer.isView(a)) return a.length === b.length && a.every((v, i) => v === b[i]); if (a && typeof a === 'object') return Object.keys(a).every((k) => same(a[k], b[k])); return a === b; };
  check(s1.full - s0.full === 1 && s1.incremental - s0.incremental === 10 && s2.hits === s1.hits + 1 && same(g1, g2) && med < tFull / 3,
    `painting re-rasterises only the stroke being painted (150 strokes: ${tFull.toFixed(0)} ms from scratch, ${med.toFixed(1)} ms per update; identical to a full raster)`);
}

// ---------------------------------------------------------------------------------------------------------
// 2. GPU develop parity (WebGPU and WebGL2 against the CPU develop), served origin with WebGPU on
// ---------------------------------------------------------------------------------------------------------
const server = createStaticServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const gp = await browser.newPage(); gp.on('pageerror', (e) => errors.push(e.message));
await gp.goto(`${base}?platform=win`); await gp.waitForFunction(() => window.tintwork && document.readyState === 'complete');
const FILTERS = { nr: 'luminance NR', nrc: 'colour NR', sharp: 'sharpen', sharpm: 'sharpen + edge mask', sharp06: 'sharpen 0.6 px', defr: 'defringe', defrm: 'defringe mask view', clar: 'local clarity', tex: 'local texture', lsharp: 'local sharpness', lnoise: 'local noise' };
const sum = (o, k) => o.reduce((s, x) => s + (x[k] || 0), 0);
for (const which of ['webgpu', 'webgl2']) {
  const NM = which === 'webgpu' ? 'WebGPU' : 'WebGL2';
  const d = await gp.evaluate(parityInPage, [`${which}:dev`, '']);
  if (d.error) { check(false, `${NM} develop engine starts (${d.error})`); continue; }
  info(`${NM}: ${d.info.renderer}${d.info.software ? ' (software)' : ''}`);
  const bad = d.out.filter((o) => o.error || o.max > 1);
  check(!bad.length, `${NM} develop stage = CPU within 1 level on all ${d.out.length} cases (16- and 8-bit, lens warp / vignette / CA / distortion, 3 masks with whites / blacks / dehaze / hue / shapes / ranges, overlay, bands, fringe view): max ${Math.max(...d.out.map((o) => o.max ?? 99))}${bad.length ? ` — ${bad.map((o) => `${o.name}: ${o.error || o.max}`).join('; ')}` : ''}`);
  const per = [];
  for (const [f, label] of Object.entries(FILTERS)) {
    const r = await gp.evaluate(parityInPage, [`${which}:post`, f]);
    per.push({ f: label, max: r.error ? 99 : Math.max(...r.out.map((o) => o.error ? 99 : o.max)), err: r.error || r.out.find((o) => o.error)?.error });
  }
  const pbad = per.filter((p) => p.max > 1);
  check(!pbad.length, `${NM} filters given the same input = CPU within 1 level, each alone (${per.map((p) => `${p.f} ${p.max}`).join(', ')})${pbad.length ? ` — off: ${pbad.map((p) => `${p.f}${p.err ? ` (${p.err})` : ''}`).join(', ')}` : ''}`);
  const all = await gp.evaluate(parityInPage, [which, '']);
  const n = sum(all.out, 'of'), over = sum(all.out, 'over1'), mx = Math.max(...all.out.map((o) => o.error ? 99 : o.max));
  check(!all.error && mx <= 8 && over / n < 0.002, `${NM} whole develop with every filter on: ${((1 - over / n) * 100).toFixed(2)} % of values within 1 level, max ${mx} (filters such as NR and sharpening magnify the ±1 rounding of their input on a few edge pixels)`);
  info(`${NM} per case (max / values > 1): ${all.out.map((o) => `${o.name} ${o.max}/${o.over1}`).join('; ')}`);
}
{ // engine choice: Automatic avoids software GPUs (the CPU workers are faster than SwiftShader)
  const r = await gp.evaluate(async () => { const G = await import('/src/gpu-develop.js'); const a = await G.openDevelopEngine('auto'), f = await G.openDevelopEngine('webgpu'), l = await G.openDevelopEngine('webgl2'), c = await G.openDevelopEngine('cpu'); const o = { auto: [a.engine?.kind || 'cpu', a.why], webgpu: f.engine?.kind, webgl2: l.engine?.kind, cpu: c.engine?.kind || 'cpu' }; for (const x of [a, f, l, c]) x.engine?.destroy(); return o; });
  check(r.auto[0] === 'cpu' && /software/i.test(r.auto[1]) && r.webgpu === 'webgpu' && r.webgl2 === 'webgl2' && r.cpu === 'cpu', `Automatic picks the CPU on a software GPU (“${r.auto[1]}”); WebGPU, WebGL2 and CPU can each be forced`);
}
await gp.close();

// ---------------------------------------------------------------------------------------------------------
// 3. The develop dialog with the GPU engine
// ---------------------------------------------------------------------------------------------------------
const tmp = 'test-assets/.v16'; mkdirSync(tmp, { recursive: true });
const sceneFile = `${tmp}/scene.dng`;
writeFileSync(sceneFile, makeDNG({ W: 1200, H: 800, lens: false, scene: (x, y) => (y < 320 ? [0.12, 0.25, 0.55 - 0.2 * y / 320] : y > 640 ? [0.35, 0.35, 0.35] : x < 600 ? [0.6, 0.28, 0.08] : [0.04, 0.1, 0.03 + 0.02 * ((x >> 4) & 1)]) }));
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => { localStorage.setItem('tintwork.engine', 'cpu'); if (!sessionStorage.getItem('v16')) { sessionStorage.setItem('v16', '1'); localStorage.setItem('tintwork.developEngine', 'webgpu'); } });
const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(async () => { await window.tintwork.clearAutosave?.(); for (const k of ['tintwork.rawPresets', 'tintwork.rawLast', 'tintwork.lensProfiles', 'tintwork.rawLink', 'tintwork.rawBrush']) localStorage.removeItem(k); });
const waitPreview = (n) => page.waitForFunction((n) => { const u = window.tintwork.rawUI; return u && u.previews >= n && u.idle; }, n, { timeout: 60000 });
const previews = () => page.evaluate(() => window.tintwork.rawUI.previews);
const prev = (fx, fy) => page.evaluate(([fx, fy]) => { const c = document.querySelector('#rawCanvas'), d = c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data; return [d[0], d[1], d[2]]; }, [fx, fy]);
const canvasPx = () => page.evaluate(() => { const c = document.querySelector('#rawCanvas'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data); });
const L = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
const local = () => page.evaluate(() => JSON.parse(JSON.stringify(window.tintwork.rawUI.settings.local)));
const after = async (fn) => { const n = await previews(); await fn(); await waitPreview(n + 1); };
const rawMs = () => page.evaluate(() => document.querySelector('#rawMs').textContent);
await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'v16in'; i.hidden = true; document.body.append(i); });
await page.setInputFiles('#v16in', sceneFile);
await page.evaluate(() => { window.tintwork.openRAW(document.querySelector('#v16in').files[0], true); }); await waitPreview(1);
const box = () => page.evaluate(() => { const r = window.tintwork.rawUI.overlay().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const drag = async (b, pts, steps = 12) => { await page.mouse.move(b.x + b.w * pts[0][0], b.y + b.h * pts[0][1]); await page.mouse.down(); for (const [u, v] of pts.slice(1)) await page.mouse.move(b.x + b.w * u, b.y + b.h * v, { steps }); await page.mouse.up(); };
{
  check(/· WebGPU$/.test(await rawMs()), `the preview runs on the chosen engine and says so (“${await rawMs()}”)`);
  const sl = await page.evaluate(() => [...document.querySelectorAll('#rawLocalBox [data-l]')].map((e) => e.dataset.l));
  const CU = 0.25, CV = 0.6, RU = 0.39, c0 = await prev(CU, CV), r0 = await prev(RU, CV);
  await page.evaluate(() => window.tintwork.rawUI.addLocal('radial')); await waitPreview(1);
  const sl2 = await page.evaluate(() => [...document.querySelectorAll('#rawLocalBox [data-l]')].map((e) => e.dataset.l));
  check(['whites', 'blacks', 'dehaze', 'hue'].every((k) => sl2.includes(k)), `the mask panel has the new Whites, Blacks, Dehaze and Hue shift sliders (${sl2.length || sl.length} local controls)`);
  // a radial mask on the orange wall (+1 EV), then a subtract shape in its middle
  await after(() => page.evaluate(([cx, cy]) => window.tintwork.rawUI.setLocal(0, { exposure: 1, cx, cy, rx: 0.2, ry: 0.25, feather: 0.1 }), [CU, CV]));
  const c1 = await prev(CU, CV), r1 = await prev(RU, CV);
  await after(() => page.click('#rawPartRadial'));
  const st = await page.evaluate(() => ({ items: document.querySelectorAll('#rawParts [data-pi]').length, op: document.querySelector('#rawParts [data-pop="0"]')?.value, sel: window.tintwork.rawUI.partSel }));
  const c2 = await prev(CU, CV), r2 = await prev(RU, CV);
  check(st.items === 2 && st.op === 'subtract' && st.sel === 0 && L(c1) > L(c0) + 15 && Math.abs(L(c2) - L(c0)) < 4 && Math.abs(L(r2) - L(r1)) < 3,
    `Subtract radial: a second shape in the mask list, selected; the centre is back to normal (${L(c0).toFixed(0)} → ${L(c1).toFixed(0)} → ${L(c2).toFixed(0)}), the ring stays brightened (${L(r2).toFixed(0)})`);
  await page.screenshot({ path: 'screenshots/16a-raw-mask-shapes.png' });
  await after(() => page.selectOption('#rawParts [data-pop="0"]', 'intersect'));
  const c3 = await prev(CU, CV), r3 = await prev(RU, CV);
  check((await local())[0].parts[0].op === 'intersect' && L(c3) > L(c0) + 15 && Math.abs(L(r3) - L(r0)) < 4, `switching it to Intersect keeps only the overlap (centre ${L(c3).toFixed(0)}, ring ${L(r3).toFixed(0)} vs ${L(r0).toFixed(0)} before)`);
  await after(() => page.click('#rawParts [data-pinv="0"]'));
  const c4 = await prev(CU, CV), r4 = await prev(RU, CV);
  check((await local())[0].parts[0].invert && Math.abs(L(c4) - L(c0)) < 4 && L(r4) > L(r0) + 15, `a shape's Invert uses its outside (centre ${L(c4).toFixed(0)}, ring ${L(r4).toFixed(0)})`);
  // drag the selected shape's centre handle
  const b = await box(), p0 = (await local())[0].parts[0];
  await after(() => drag(b, [[p0.cx, p0.cy], [p0.cx + 0.1, p0.cy]]));
  const p1 = (await local())[0].parts[0], m1 = (await local())[0];
  check(Math.abs(p1.cx - p0.cx - 0.1) < 0.02 && Math.abs(m1.cx - CU) < 1e-6, `dragging moves the selected shape, not the mask's own shape (cx ${p0.cx.toFixed(2)} → ${p1.cx.toFixed(2)})`);
  await after(() => page.click('#rawPartLinear'));
  await after(() => page.click('#rawParts [data-pdel="0"]'));
  const l2 = await local();
  check(l2[0].parts.length === 1 && l2[0].parts[0].type === 'linear' && l2[0].parts[0].op === 'subtract', 'Add graduated adds a subtract shape; ✕ removes a shape');
  // GPU preview vs CPU preview of the same settings
  await after(() => page.evaluate(() => window.tintwork.rawUI.setLocal(0, { whites: 40, blacks: -30, dehaze: 30, hue: 25, clarity: 30 })));
  const gpuPx = await canvasPx();
  await page.evaluate(async () => { const C = await import('/src/codecs.js'); await C.setDevelopEngine('cpu'); });
  await after(() => page.evaluate(() => window.tintwork.rawUI.refresh()));
  const cpuPx = await canvasPx(), ms = await rawMs();
  let dmax = 0, n1 = 0; for (let i = 0; i < cpuPx.length; i++) { const dd = Math.abs(cpuPx[i] - gpuPx[i]); if (dd > dmax) dmax = dd; if (dd > 1) n1++; }
  check(cpuPx.length === gpuPx.length && dmax <= 2 && n1 / cpuPx.length < 0.001 && /· CPU$/.test(ms), `the WebGPU preview equals the CPU preview (8-bit: max ${dmax}, ${n1} values off by more than 1) and switching the engine takes effect at once (“${ms}”)`);
  await page.evaluate(async () => { const C = await import('/src/codecs.js'); await C.setDevelopEngine('webgpu'); });
  await after(() => page.evaluate(() => window.tintwork.rawUI.refresh()));
}
{ // live previews while painting and while dragging a slider
  await page.evaluate(() => window.tintwork.rawUI.setBrush({ size: 6, feather: 30, flow: 100, smooth: 0, auto: false }));
  await page.click('#rawAddBrush'); await waitPreview(1);
  const b = await box(), lp0 = await page.evaluate(() => window.tintwork.rawUI.livePaints || 0), n0 = await previews();
  await page.mouse.move(b.x + b.w * 0.1, b.y + b.h * 0.6); await page.mouse.down();
  for (let k = 1; k <= 30; k++) { await page.mouse.move(b.x + b.w * (0.1 + k * 0.01), b.y + b.h * 0.6); await page.waitForTimeout(25); }
  const mid = await page.evaluate(() => ({ previews: window.tintwork.rawUI.previews, paints: window.tintwork.rawUI.livePaints || 0, strokes: window.tintwork.rawUI.settings.local.at(-1).strokes.length }));
  await page.mouse.up(); await waitPreview(mid.previews + 1);
  const w1 = await prev(0.25, 0.6);
  check(mid.paints - lp0 >= 3 && mid.previews - n0 >= 2 && mid.strokes === 1 && L(w1) > 0, `the preview updates while the brush is still down (${mid.paints - lp0} live updates, ${mid.previews - n0} previews drawn before the mouse was released)`);
  // drafts: forced by pretending the full preview is slow is not possible from outside, so measure: on this software GPU
  // the full preview takes longer than the draft threshold, so a slider drag shows drafts and then the full preview
  const full = await page.evaluate(() => window.tintwork.rawUI.lastFullMs), d0 = await page.evaluate(() => window.tintwork.rawUI.drafts || 0);
  const nS = await previews();
  for (let v = 0; v <= 100; v += 10) { await page.evaluate((v) => { const el = document.querySelector('#modal [data-k=exposure]'); el.value = (v - 50) / 100; el.dispatchEvent(new Event('input', { bubbles: true })); }, v); await page.waitForTimeout(30); }
  await page.waitForFunction((n) => { const u = window.tintwork.rawUI; return u.previews > n && u.idle; }, nS, { timeout: 60000 });
  const d1 = await page.evaluate(() => window.tintwork.rawUI.drafts || 0), ms = await rawMs(), finalPx = await canvasPx();
  await after(() => page.evaluate(() => window.tintwork.rawUI.refresh()));
  const againPx = await canvasPx(); let same = finalPx.length === againPx.length; for (let i = 0; same && i < finalPx.length; i++) if (finalPx[i] !== againPx[i]) same = false;
  check(full <= 45 ? d1 === d0 : d1 > d0, `slider drags: ${full > 45 ? `the full preview takes ${full} ms here, so ${d1 - d0} half-size drafts were shown while dragging` : `the full preview takes ${full} ms, no drafts needed`}`);
  check(/^preview /.test(ms) && same, `once the slider rests the full-resolution preview replaces the draft (“${ms}”, identical to a fresh preview)`);
}
{ // Rendering engine dialog: RAW develop engine
  await page.click('#modalCancel').catch(() => {}); await page.waitForFunction(() => !window.tintwork.rawUI, null, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => window.tintwork.openEngineDialog());
  await page.waitForSelector('#engDev'); await page.waitForFunction(() => !/Checking/.test(document.querySelector('#engDevInfo').textContent), null, { timeout: 20000 });
  const dv = await page.evaluate(() => [document.querySelector('#engDev').value, document.querySelector('#engDevInfo').textContent, [...document.querySelectorAll('#engDev option')].map((o) => o.value)]);
  await page.selectOption('#engDev', 'auto'); await page.click('#modalOk');
  await page.waitForFunction(async () => (await import('/src/codecs.js')).getDevelopEnginePref() === 'auto');
  const inf = await page.evaluate(async () => (await import('/src/codecs.js')).developEngineInfo());
  check(dv[0] === 'webgpu' && /WebGPU/.test(dv[1]) && /software/.test(dv[1]) && dv[2].join() === 'auto,webgpu,webgl2,cpu' && inf.kind === 'cpu',
    `View › Rendering engine has the RAW develop engine (shown: “${dv[1]}”); Automatic then picks ${inf.label} here (${inf.note || 'software GPU'})`);
}
{ // Help › Run performance benchmark with the RAW develop rows
  await page.evaluate(() => window.tintwork.openBenchmarkDialog());
  await page.waitForSelector('#benchdev');
  await page.uncheck('#bench12'); await page.uncheck('#bench24'); await page.check('#bench1');
  const t = Date.now(); await page.click('#benchRun');
  await page.waitForFunction(() => /Done in|failed/.test(document.querySelector('#benchProgress').textContent), null, { timeout: 600000 });
  const html = await page.evaluate(() => document.querySelector('#benchOut').innerText);
  const devRows = ['preview update while dragging', 'while painting', 'full resolution, 16-bit'].every((s) => html.includes(s));
  check(devRows && /RAW develop on WebGPU/.test(html) && /RAW develop on WebGL2/.test(html) && /software/.test(html), `the benchmark has the RAW develop rows for CPU, WebGL2 and WebGPU, and flags the software GPU (${((Date.now() - t) / 1000).toFixed(0)} s at 1 MP)`);
  const rows = html.split('\n').filter((l) => /RAW develop:/.test(l));
  for (const r of rows) info(r.replace(/\t+/g, ' | '));
  await page.screenshot({ path: 'screenshots/16b-benchmark-raw-develop.png' });
  await page.click('#modalOk');
}
const ui = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('[title],[aria-label]')].map((e) => `${e.title} ${e.getAttribute('aria-label') || ''}`).join(' '));
const guide = existsSync('USER_GUIDE.md') ? readFileSync('USER_GUIDE.md', 'utf8') : '';
check(!/photoshop|adobe/i.test(ui + guide), 'no product names of other editors in the UI');
check(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close(); server.close();
console.log(fails ? `${fails} of ${count} v1.6 checks FAILED` : `All ${count} v1.6 checks passed (${((Date.now() - T0) / 1000).toFixed(0)} s)`);
process.exit(fails ? 1 : 0);
