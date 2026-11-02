// v1.2 test: faster RAW develop (bands across workers must equal a whole-image run, half-resolution first pass,
// 24 MP timing), the new develop controls (sharpening, tone curve, vibrance / saturation, chromatic aberration
// auto + manual, before / after), develop presets and batch RAW settings, the pre-cached RAW decoder (offline before
// the first RAW file is opened). Screenshots: 12x-*.png.
import { chromium } from 'playwright';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createStaticServer } from './serve.mjs';
import * as R from '../src/raw.js';
import { makeDNG } from './lib/dng-fixture.mjs';

let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const T0 = Date.now();
mkdirSync('screenshots', { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// 1. Node: develop maths
// ---------------------------------------------------------------------------------------------------------
const rnd = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })();
function source(W, H, f) { const d = new Float32Array(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(f(x, y), (y * W + x) * 3); return { width: W, height: H, data: d, half: false }; }
const meta = { blackLevel: [0, 0, 0, 0], whiteLevel: 1, cameraMultipliers: [2, 1, 1.4], colorMatrix: null };
const model = R.colorModel(meta);
const pipeOf = (set) => R.pipeline(meta, model, { ...R.DEFAULT_SETTINGS, ...set }, null);
const checker = (x, y) => { const v = ((x >> 4) + (y >> 4)) % 2 ? 0.55 : 0.12; return [v * 0.5 + rnd() * 0.01, v + rnd() * 0.01, v * 0.7 + rnd() * 0.01]; };
{ // bands == whole image, for every orientation, with lens warp + vignette, CA, NR and sharpening
  const src = source(611, 397, checker);
  const lens = { warp: { center: [0.48, 0.52], planes: [{ kr: [1, 0.05, -0.01, 0], kt: [0.001, 0] }] }, vignette: { center: [0.5, 0.5], k: [0.4, 0, 0, 0, 0] }, frame: { fullW: 611, fullH: 397, offX: 0, offY: 0 } };
  const set = { ...R.DEFAULT_SETTINGS, nrLuma: 40, nrColor: 80, sharpen: 120, sharpRadius: 2.5, sharpDetail: 60, sharpMask: 30, vibrance: 30, saturation: 10, curve: { rgb: [[0, 0], [128, 150], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [90, 80], [255, 255]], b: [[0, 0], [255, 255]] } };
  const pipe = pipeOf(set); let worst = 0, cases = 0, halfOK = true;
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) for (const [L, ca] of [[null, null], [lens, [0.003, -0.002]]]) {
    const opts = { pipe, orientation: o, lens: L, ca, factor: 1, settings: set, scale: 1, bits: 16 };
    const whole = R.developRows(src, opts), out = new Uint16Array(whole.data.length);
    const bands = R.planBands(src, opts, 6);
    for (const b of bands) { const r = R.developRows(R.extractRegion(src, b.rect), { ...opts, rows: b.rows }); out.set(r.data, b.rows[0] * r.width * 4); }
    for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - whole.data[i]));
    // half-resolution pass: bands of the halved regions tile the half-size frame
    const hh = bands.reduce((s2, b) => { const hr = R.halveRegion(R.extractRegion(src, b.rect)), [, hOH] = R.orientedSize(hr.fullW, hr.fullH, o); const r = R.developRows(hr, { ...opts, factor: 2, scale: 0.5, rows: [Math.min(hOH, b.rows[0] / 2), Math.min(hOH, Math.floor(b.rows[1] / 2))], halo: 24, bits: 8 }); return s2 + r.height; }, 0);
    if (hh !== R.orientedSize(305, 198, o)[1]) halfOK = false;
    cases++;
  }
  check(worst <= 1, `band develop (6 bands + 48-row halo, extracted source regions) equals the whole-image develop in ${cases} cases: 8 orientations × lens warp/vignette/CA on and off, with NR, sharpening, curve, vibrance (max difference ${worst} / 65535)`);
  check(halfOK, 'half-resolution bands tile the half-size frame exactly (every orientation)');
  const big = R.planBands({ width: 6000, height: 4000 }, { orientation: 1, factor: 1 }, 7), read = big.reduce((s2, b) => s2 + (b.rect.y1 - b.rect.y0), 0);
  check(big.length === 7 && big[0].rows[0] === 0 && big.at(-1).rows[1] === 4000 && big.every((b) => b.rows[0] % 4 === 0) && read < 4000 * 1.2, `24 MP plan: 7 bands on 4-row boundaries, each reads only its rows + halo (${read} source rows in total for 4000)`);
}
{ // sharpening
  const W = 64, H = 32, edge = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = x < 32 ? 16000 : 40000; edge.set([v, v, v, 65535], (y * W + x) * 4); }
  const run = (set) => { const a = edge.slice(); R.sharpen(a, W, H, { ...R.DEFAULT_SETTINGS, ...set }); return a; };
  const at = (a, x) => a[(16 * W + x) * 4 + 1];
  const off = run({ sharpen: 0 }), on = run({ sharpen: 100, sharpDetail: 100 }), low = run({ sharpen: 100, sharpDetail: 0 }), wide = run({ sharpen: 100, sharpRadius: 3, sharpDetail: 100 });
  check(off.every((v, i) => v === edge[i]), 'sharpening amount 0 leaves the pixels untouched');
  check(at(on, 31) < 16000 - 1000 && at(on, 32) > 40000 + 1000 && at(on, 10) === 16000, `sharpening adds contrast at an edge only (dark side ${at(on, 31)}, bright side ${at(on, 32)}, flat area ${at(on, 10)})`);
  check(40000 - at(low, 31) < 16000 - at(on, 31) + 24000 && at(low, 32) - 40000 < at(on, 32) - 40000, `low detail holds back the halo on a strong edge (overshoot ${at(low, 32) - 40000} vs ${at(on, 32) - 40000})`);
  check(at(wide, 28) < at(on, 28) || at(wide, 36) > at(on, 36), `a larger radius widens the sharpened band (x=28: ${at(wide, 28)} vs ${at(on, 28)})`);
  // masking: noise in a flat area is left alone, the edge is still sharpened
  const noisy = edge.slice(); for (let i = 0; i < noisy.length; i += 4) { const n = (rnd() - 0.5) * 1200; for (let c = 0; c < 3; c++) noisy[i + c] += n; }
  const flatVar = (a) => { let s2 = 0, m = 0, n = 0; for (let y = 4; y < 28; y++) for (let x = 4; x < 20; x++) { m += a[(y * W + x) * 4 + 1]; n++; } m /= n; for (let y = 4; y < 28; y++) for (let x = 4; x < 20; x++) s2 += (a[(y * W + x) * 4 + 1] - m) ** 2; return Math.sqrt(s2 / n); };
  const nm0 = noisy.slice(), nm1 = noisy.slice(); R.sharpen(nm0, W, H, { ...R.DEFAULT_SETTINGS, sharpen: 120, sharpMask: 0 }); R.sharpen(nm1, W, H, { ...R.DEFAULT_SETTINGS, sharpen: 120, sharpMask: 80 });
  check(flatVar(nm1) < flatVar(nm0) * 0.85 && at(nm1, 32) - at(noisy, 32) > 500, `masking spares flat noisy areas (noise ${flatVar(nm0).toFixed(0)} → ${flatVar(nm1).toFixed(0)} with masking 80) and still sharpens the edge`);
}
{ // vibrance / saturation / curve through the develop pass
  const px = (rgb, set) => { const src = source(1, 1, () => rgb), out = R.develop(src, { pipe: pipeOf(set), out16: true }).data16; return [out[0], out[1], out[2]]; };
  const spread = (p) => Math.max(...p) - Math.min(...p);
  const muted = [0.18, 0.4, 0.2], vivid = [0.05, 0.45, 0.06];
  const g = px(muted, { saturation: -100 });
  check(spread(g) <= 2, `saturation −100 makes a colour grey (${g})`);
  const s2 = px(muted, { saturation: 50 }), s0 = px(muted, {});
  check(spread(s2) > spread(s0) * 1.2, `saturation +50 strengthens colour (spread ${spread(s0)} → ${spread(s2)})`);
  const vm = spread(px(muted, { vibrance: 80 })) / spread(px(muted, {})), vv = spread(px(vivid, { vibrance: 80 })) / spread(px(vivid, {}));
  check(vm > vv && vm > 1.1, `vibrance boosts a muted colour more than a vivid one (×${vm.toFixed(2)} vs ×${vv.toFixed(2)})`);
  const c0 = px([0.12, 0.25, 0.17], {}), c1 = px([0.12, 0.25, 0.17], { curve: { rgb: [[0, 0], [128, 170], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] } });
  check(c1.every((v, i) => v > c0[i] + 2000), `an RGB point curve brightens every channel (${c0} → ${c1})`);
  const c2 = px([0.12, 0.25, 0.17], { curve: { rgb: [[0, 0], [255, 255]], r: [[0, 0], [128, 90], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] } });
  check(c2[0] < c0[0] - 1000 && Math.abs(c2[1] - c0[1]) <= 1 && Math.abs(c2[2] - c0[2]) <= 1, `a red-channel curve changes only red (${c0} → ${c2})`);
  check(R.curveIsIdentity(null) && R.curveIsIdentity({ rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] }) && (() => { const p = pipeOf({}); return p.luts[0] === p.lut && p.luts[2] === p.lut; })(), 'a straight curve adds no work (shares the base tone LUT)');
}
// lateral CA: red magnified by +0.3 %, blue shrunk by −0.2 % (relative to green)
// anti-aliased checker (edges a few pixels wide), so a sub-pixel channel shift is really in the data
const sq = (u) => Math.max(-1, Math.min(1, 3 * Math.sin((2 * Math.PI * u) / 44)));
const caScene = (W, H, aR, aB) => { const cx = (W - 1) / 2, cy = (H - 1) / 2; const base = (x, y) => 0.39 + 0.31 * sq(x) * sq(y); return (x, y) => [base(cx + (x - cx) / (1 + aR), cy + (y - cy) / (1 + aR)), base(x, y), base(cx + (x - cx) / (1 + aB), cy + (y - cy) / (1 + aB))]; };
{
  const W = 1200, H = 800, f = caScene(W, H, 0.003, -0.002), src = source(W, H, (x, y) => f(x, y));
  const t = Date.now(), est = R.estimateCA(src), ms = Date.now() - t;
  check(Math.abs(est.red - 0.003) < 0.0002 && Math.abs(est.blue + 0.002) < 0.0002, `automatic CA estimate: red ${(est.red * 100).toFixed(3)} % (true 0.300), blue ${(est.blue * 100).toFixed(3)} % (true −0.200), ${est.patches} patches, ${ms} ms`);
  const clean = source(W, H, () => [0.4, 0.4, 0.4]); const none = R.estimateCA(clean);
  check(none.red === 0 && none.blue === 0, 'no texture → no CA correction');
  // fringe energy: |R − G| + |B − G| near the corners, before and after correction
  const fringe = (ca) => { const out = R.develop(src, { pipe: pipeOf({ wb: 'custom', temp: 5500, tint: 0 }), ca, out16: true }).data16; let e = 0; for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) { const i = (y * W + x) * 4; e += Math.abs(out[i] - out[i + 1]) + Math.abs(out[i + 2] - out[i + 1]); } return e; };
  const fNo = fringe(null), fAuto = fringe(R.caScales({ caAuto: true }, est)), fMan = fringe(R.caScales({ caRed: 75, caBlue: -50 }, null));
  check(fAuto < fNo * 0.5 && fMan < fNo * 0.5, `CA correction removes colour fringes in the corner (fringe energy ${(fNo / 1e6).toFixed(1)}M → auto ${(fAuto / 1e6).toFixed(1)}M, manual ${(fMan / 1e6).toFixed(1)}M)`);
  check(R.caScales({ caRed: 100, caBlue: -100 })[0] === R.CA_UNIT && R.caScales({}) === null, 'manual CA sliders map ±100 to ±0.4 % radial scale; zero → no resampling');
}
{ // presets: stored settings are validated
  const c = R.cleanSettings({ exposure: 99, sharpen: '40', wb: 'bogus', curve: { rgb: [[0, 0], [100, 140], [255, 255]] }, evil: '<script>', lens: 0 });
  check(c.exposure === 5 && c.sharpen === 40 && c.wb === 'as-shot' && c.curve.rgb.length === 3 && c.curve.r.length === 2 && !('evil' in c) && c.lens === false, 'preset / last-used settings are cleaned on load (clamped ranges, unknown keys dropped, curves completed)');
}

// ---------------------------------------------------------------------------------------------------------
// 2. Browser
// ---------------------------------------------------------------------------------------------------------
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const tmp = 'test-assets/.v12'; mkdirSync(tmp, { recursive: true });
const caFile = `${tmp}/ca-test.dng`, plainFile = `${tmp}/plain.dng`, plain2 = `${tmp}/plain-2.dng`;
writeFileSync(caFile, makeDNG({ W: 1200, H: 800, lens: false, scene: caScene(1200, 800, 0.003, -0.002) }));
const colourScene = (x, y) => [0.45 + 0.2 * Math.sin(x / 40), 0.3, 0.12 + 0.1 * Math.cos(y / 30)];
writeFileSync(plainFile, makeDNG({ W: 480, H: 320, lens: false, scene: colourScene })); writeFileSync(plain2, makeDNG({ W: 320, H: 480, lens: false, scene: colourScene }));

// --- offline: the decoder is cached by the service worker before any RAW file is opened ---------------------
{
  const sw = readFileSync('sw.js', 'utf8');
  check(/tintwork-shell-v1\.2\.0/.test(sw) && ['flashraw_simd.wasm', 'flashraw.wasm', 'flashraw_simd_jxl.wasm', 'develop-worker.js'].every((f) => sw.includes(f)), 'service worker v1.2.0 pre-caches the RAW decoder WebAssembly (SIMD + fallback + JPEG XL build) and the develop worker');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`offline: ${e.message}`));
  await page.goto(base); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(async () => { const ks = await caches.keys(); if (!ks.includes('tintwork-shell-v1.2.0')) return false; const c = await caches.open('tintwork-shell-v1.2.0'); return !!(await c.match('./vendor/flashraw/flashraw_simd.wasm')) && !!(await c.match('./vendor/flashraw/flashraw_simd_jxl.wasm')); }, null, { timeout: 30000, polling: 250 });
  const cached = await page.evaluate(async () => { const c = await caches.open('tintwork-shell-v1.2.0'); const ks = (await c.keys()).map((r) => new URL(r.url).pathname); return ks.filter((k) => /flashraw|develop-worker/.test(k)); });
  check(cached.some((k) => k.endsWith('flashraw_simd.wasm')) && cached.some((k) => k.endsWith('flashraw.wasm')), `decoder WebAssembly is in the cache right after the first visit, with no RAW file opened (${cached.filter((k) => k.endsWith('.wasm')).map((k) => k.split('/').pop()).join(', ')})`);
  await ctx.setOffline(true);
  await page.reload(); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete', null, { timeout: 30000 });
  const off = await page.evaluate(async () => {
    const r = await fetch('./vendor/flashraw/flashraw_simd.wasm').then((x) => x.ok).catch(() => false);
    return { online: navigator.onLine, wasm: r };
  });
  await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'v12in'; i.hidden = true; i.onchange = () => { window.__f = i.files[0]; }; document.body.append(i); });
  await page.setInputFiles('#v12in', plainFile); await page.waitForFunction(() => !!window.__f);
  const r = await page.evaluate(async () => { try { await window.tintwork.openRAW(window.__f, false); const d = window.tintwork.state.doc; return { ok: d?.depth === 16 && /plain/.test(d.name), w: d?.width }; } catch (e) { return { ok: false, err: e.message }; } });
  check(!off.online && off.wasm && r.ok, `offline (network off, page reloaded): the decoder loads from the cache and a DNG opens as a 16-bit document (${r.w} px wide${r.err ? `; ${r.err}` : ''})`);
  await ctx.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem('tintwork.engine', 'cpu'));
const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(async () => { await window.tintwork.clearAutosave?.(); localStorage.removeItem('tintwork.rawPresets'); localStorage.removeItem('tintwork.rawLast'); });
await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'v12in'; i.hidden = true; i.onchange = () => { window.__files = [...i.files]; }; document.body.append(i); });
const toPage = async (files) => { await page.evaluate(() => { window.__files = null; }); await page.setInputFiles('#v12in', files); await page.waitForFunction((n) => window.__files?.length === n, files.length); };
const settle = () => page.evaluate(async () => { await window.tintwork.idle(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
const waitPreview = (n) => page.waitForFunction((n) => { const u = window.tintwork.rawUI; return u && u.previews >= n && u.idle; }, n, { timeout: 30000 });
const previewStats = () => page.evaluate(() => {
  const c = document.querySelector('#rawCanvas'), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data; let s = 0, sp = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) { s += d[i] + d[i + 1] + d[i + 2]; sp += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); n++; }
  // corner fringe: |R−G| + |B−G| in the top-left 15 %
  let f = 0; const cw = Math.floor(c.width * 0.15), ch = Math.floor(c.height * 0.15), q = x.getImageData(0, 0, cw, ch).data; for (let i = 0; i < q.length; i += 4) f += Math.abs(q[i] - q[i + 1]) + Math.abs(q[i + 2] - q[i + 1]);
  return { mean: s / n / 3, spread: sp / n, fringe: f / (q.length / 4), w: c.width, h: c.height };
});
const setSlider = (k, v) => page.evaluate(([k, v]) => { const el = document.querySelector(`#modal [data-k=${k}]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, [k, v]);

// --- the develop dialog: new controls ----------------------------------------------------------------------
{
  await page.setInputFiles('#fileInput', caFile); await waitPreview(1);
  const ctl = await page.evaluate(() => ({
    keys: [...document.querySelectorAll('#modal [data-k]')].map((e) => e.dataset.k),
    curve: !!document.querySelector('#modal #rawCurveBox .curves-graph'), ca: !!document.querySelector('#rawCaAuto'), ba: !!document.querySelector('#rawBefore'), preset: !!document.querySelector('#rawPreset'),
  }));
  check(['sharpen', 'sharpRadius', 'sharpDetail', 'sharpMask', 'vibrance', 'saturation', 'caRed', 'caBlue'].every((k) => ctl.keys.includes(k)) && ctl.curve && ctl.ca && ctl.ba && ctl.preset,
    `develop dialog has sharpening (amount, radius, detail, masking), tone curve, vibrance, saturation, CA (auto + red/cyan + blue/yellow), before/after and presets (${ctl.keys.length} sliders)`);
  const s0 = await previewStats();
  await setSlider('saturation', -100); await waitPreview(2); const sG = await previewStats();
  await setSlider('saturation', 0); await setSlider('vibrance', 100); await page.waitForTimeout(50); await waitPreview(3); const sV = await previewStats();
  check(sG.spread < 3 && sV.spread > s0.spread, `preview: saturation −100 → grey (colour spread ${s0.spread.toFixed(1)} → ${sG.spread.toFixed(1)}), vibrance +100 → stronger (${sV.spread.toFixed(1)})`);
  await setSlider('vibrance', 0); await waitPreview(4);
  // CA: automatic
  const fr0 = (await previewStats()).fringe;
  await page.check('#rawCaAuto'); await waitPreview(5);
  const est = await page.evaluate(() => document.querySelector('#rawCaEst').textContent), fr1 = (await previewStats()).fringe;
  check(fr1 < fr0 * 0.7 && /red \+\d+, blue -\d+/.test(est), `automatic CA removal: corner fringe ${fr0.toFixed(1)} → ${fr1.toFixed(1)} (shown: ${est})`);
  await page.uncheck('#rawCaAuto'); await setSlider('caRed', 75); await setSlider('caBlue', -50); await page.waitForTimeout(50); await waitPreview(6);
  const fr2 = (await previewStats()).fringe;
  check(fr2 < fr0 * 0.7, `manual red/cyan +75 and blue/yellow −50 remove the fringe too (${fr0.toFixed(1)} → ${fr2.toFixed(1)})`);
  // tone curve: drag the middle of the RGB curve up
  await page.evaluate(() => { document.querySelector('#rawCurveBox').open = true; });
  const before = await previewStats(), box = await page.locator('#rawCurveBox .curves-graph').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(50); await waitPreview(7);
  const after = await previewStats(), cs = await page.evaluate(() => ({ curve: window.tintwork.rawUI.settings.curve, label: document.querySelector('#rawCurveState').textContent }));
  check(after.mean > before.mean + 8 && cs.curve?.rgb?.length === 3 && cs.label === 'adjusted', `tone curve: dragging the RGB curve up with the mouse brightens the preview (mean ${before.mean.toFixed(0)} → ${after.mean.toFixed(0)}, ${cs.curve?.rgb?.length} points)`);
  // sharpening reaches the preview
  await setSlider('sharpen', 0); await waitPreview(8); const sh0 = await page.evaluate(() => { const c = document.querySelector('#rawCanvas'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.filter((_, i) => i % 4 === 1)); });
  await setSlider('sharpen', 150); await setSlider('sharpRadius', 2); await page.waitForTimeout(50); await waitPreview(9);
  const sh1 = await page.evaluate(() => { const c = document.querySelector('#rawCanvas'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.filter((_, i) => i % 4 === 1)); });
  const lap = (a, w) => { let e = 0; for (let i = w + 1; i < a.length - w - 1; i += 3) e += Math.abs(4 * a[i] - a[i - 1] - a[i + 1] - a[i - w] - a[i + w]); return e / a.length; };
  const pw = (await previewStats()).w;
  check(lap(sh1, pw) > lap(sh0, pw) * 1.15, `sharpening shows in the preview (edge energy ${lap(sh0, pw).toFixed(1)} → ${lap(sh1, pw).toFixed(1)})`);
  // before / after
  const cur = await previewStats();
  await page.click('#rawBefore'); await page.waitForFunction(() => window.tintwork.rawUI.beforeShown === true);
  const ba = await previewStats(), tag = await page.evaluate(() => !document.querySelector('#rawBaTag').classList.contains('hidden') && document.querySelector('#rawBefore').getAttribute('aria-pressed'));
  await page.keyboard.press('Backslash'); await page.waitForFunction(() => window.tintwork.rawUI.beforeShown === false);
  const back = await previewStats();
  check(Math.abs(ba.mean - cur.mean) > 5 && ba.fringe > cur.fringe * 1.3 && Math.abs(back.mean - cur.mean) < 0.5 && tag === 'true', `before/after: the button shows the default rendering (mean ${cur.mean.toFixed(0)} → ${ba.mean.toFixed(0)}, fringes back), the \\ key returns to the edit (${back.mean.toFixed(0)})`);
  await page.evaluate(() => { document.querySelector('#rawCurveBox').open = true; });
  await settle(); await page.waitForTimeout(100);
  await page.screenshot({ path: 'screenshots/12x-raw-develop-controls.png' });
  // presets
  await page.fill('#rawPresetName', 'Fringe fix'); await page.click('#rawPresetSave');
  const saved = await page.evaluate(() => window.tintwork.rawPresets());
  await page.click('#rawReset'); await waitPreview(10);
  const reset = await page.evaluate(() => ({ ...window.tintwork.rawUI.settings }));
  await page.selectOption('#rawPreset', 'preset:Fringe fix'); await page.waitForTimeout(50); await waitPreview(11);
  const applied = await page.evaluate(() => ({ s: { ...window.tintwork.rawUI.settings }, red: document.querySelector('[data-k=caRed]').value, del: document.querySelector('#rawPresetDel').disabled }));
  check(saved.length === 1 && saved[0].name === 'Fringe fix' && saved[0].settings.caRed === 75 && saved[0].settings.curve?.rgb?.length === 3 && reset.caRed === 0 && reset.curve === null && applied.s.caRed === 75 && applied.s.caBlue === -50 && applied.s.sharpen === 150 && applied.s.curve?.rgb?.length === 3 && applied.red === '75' && !applied.del,
    `presets: "Save preset" stores the settings (curve included), Reset clears them, choosing the preset restores them and the sliders (${saved.map((p) => p.name)})`);
  // open with the settings
  await page.click('#modalOk');
  const overlay = await page.waitForFunction(() => document.querySelector('.dev-overlay') || window.tintwork.state.doc?.depth === 16, null, { timeout: 30000 }).then(() => page.evaluate(() => !!document.querySelector('.dev-overlay')));
  await page.waitForFunction(() => window.tintwork.state.doc?.name === 'ca-test.dng' && window.tintwork.lastImport?.total && !document.querySelector('.dev-overlay'), null, { timeout: 30000 });
  const d = await page.evaluate(() => { const d = window.tintwork.state.doc; return { depth: d.depth, s: d.raw.settings, last: JSON.parse(localStorage.getItem('tintwork.rawLast')), li: window.tintwork.lastImport }; });
  check(overlay && d.depth === 16 && d.s.caRed === 75 && d.s.curve && d.last.sharpen === 150 && d.li.halfBands >= 1, `Open closes the dialog at once, shows the progressive placeholder (${d.li.halfBands} half-resolution bands), then a 16-bit document with the chosen settings, saved as "last used"`);
}

// --- batch: RAW files develop with last used settings or a preset -----------------------------------------
{
  await page.evaluate(() => { window.tintwork.saveRawPreset('Mono', { ...window.tintwork.RAW_DEFAULTS, saturation: -100 }); });
  const opts = await page.evaluate(async () => {
    window.tintwork.cmds.batch(); await new Promise((r) => setTimeout(r, 100));
    const sel = document.querySelector('#bRaw'), o = sel ? [...sel.options].map((x) => x.value) : null;
    document.querySelector('#modalCancel')?.click(); return o;
  });
  check(opts && opts[0] === 'last' && opts.includes('default') && opts.includes('preset:Mono') && opts.includes('preset:Fringe fix'), `batch dialog: "RAW files develop with" offers last used settings, defaults and saved presets (${opts})`);
  await toPage([plainFile, plain2]);
  const b = await page.evaluate(async () => {
    const t = window.tintwork, files = window.__files, out = {};
    const spreadOf = async (blob) => { const bm = await createImageBitmap(blob), c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, bm.width, bm.height).data; let s = 0, n = 0; for (let i = 0; i < d.length; i += 40) { s += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); n++; } return { s: s / n, w: bm.width }; };
    for (const choice of ['default', 'preset:Mono', 'last']) {
      const sink = t.memorySink(); const r = await t.runBatch(files, { rawSettings: t.rawSettingsFor(choice), variants: [{ mode: 'original', type: 'image/png' }], pattern: '{name}', sink });
      const names = Object.keys(sink.files).sort(); out[choice] = { done: r.done, names, spread: await Promise.all(names.map((n) => spreadOf(sink.files[n].blob))) };
    }
    return out;
  });
  const sp = (k) => b[k].spread.map((x) => x.s.toFixed(1)).join('/');
  check(b.default.done === 2 && b['preset:Mono'].done === 2 && b['preset:Mono'].spread.every((x) => x.s < 1.5) && b.default.spread.every((x) => x.s > 10) && b.last.spread.every((x) => x.s > 10),
    `batch of 2 RAW files: defaults keep colour (spread ${sp('default')}), the "Mono" preset is applied to every file (${sp('preset:Mono')}), last used works (${sp('last')})`);
}

// --- 24 MP: before (v1.1 single-thread numbers in the report) and after ---------------------------------------
const manifest = JSON.parse(readFileSync('test-assets/raw-samples.json', 'utf8')).samples;
const bigS = manifest.find((s) => s.local === 'sony-ilce-6000.arw');
if (bigS && existsSync(`test-assets/raw-samples/${bigS.local}`)) {
  const runs = [];
  for (let k = 0; k < 2; k++) {
    const t0 = Date.now();
    await page.setInputFiles('#fileInput', `test-assets/raw-samples/${bigS.local}`);
    await page.waitForFunction(() => window.tintwork.rawUI?.previews >= 1, null, { timeout: 60000 });
    const tDialog = Date.now() - t0; await settle(); await page.waitForTimeout(100);
    const t1 = Date.now(); await page.click('#modalOk');
    if (k === 1) { // the progressive placeholder, while the full resolution is still developing
      const shot = await page.waitForFunction(() => document.querySelector('.dev-overlay') && window.tintwork.lastDevelopProgress?.halfBands >= 7, null, { timeout: 20000, polling: 16 }).then(() => true).catch(() => false);
      if (shot) await page.screenshot({ path: 'screenshots/12x-raw-progressive.png' });
    }
    await page.waitForFunction((n) => window.tintwork.state.doc?.name === n && window.tintwork.lastImport?.total && !document.querySelector('.dev-overlay'), bigS.local, { timeout: 60000 });
    await settle(); const tOpen = Date.now() - t1;
    const r = await page.evaluate(() => ({ ...window.tintwork.lastImport, depth: window.tintwork.state.doc.depth }));
    runs.push({ tDialog, tOpen, total: tDialog + tOpen, ...r });
    await page.evaluate(() => window.tintwork.closeTab(undefined, { force: true }));
  }
  const r = runs.sort((a, b) => a.total - b.total)[0];
  console.log(`TIMING_24MP ${JSON.stringify(runs.map(({ notes, ...x }) => x))}`);
  check(r.depth === 16 && r.mp > 20 && r.total < 3500 && r.tOpen < 2200 && r.half < r.full, `24 MP ${bigS.local} (best of 2): file → dialog ${(r.tDialog / 1000).toFixed(2)} s; Open → placeholder at once, half resolution ${(r.half / 1000).toFixed(2)} s, full resolution on screen ${(r.tOpen / 1000).toFixed(2)} s; total ${(r.total / 1000).toFixed(2)} s (v1.1: 3.9 s) — ${r.bands} bands: develop ${r.worker.develop} + NR ${r.worker.nr} + sharpen ${r.worker.sharpen} ms per band, canvas ${r.build} ms`);
} else console.log('skip 24 MP timing: run `npm run fetch-raw`');

check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close(); server.close();
console.log(`${fails ? `${fails} of ${count} v1.2 check(s) FAILED` : `All ${count} v1.2 checks passed`} (${((Date.now() - T0) / 1000).toFixed(0)} s)`);
process.exit(fails ? 1 : 0);
