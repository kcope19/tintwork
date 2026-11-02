// v1.3 test: re-developable RAW layers (settings + source kept in the layer, the project file and the autosave; crop
// aware), split before / after view with a draggable divider, develop preset files (export / import), defringe
// (purple / green by hue range), the memory-aware worker plan (navigator.deviceMemory) and threaded RAW decode when
// the page is cross-origin isolated (COOP / COEP, see _headers). Screenshots: 13x-*.png.
import { chromium } from 'playwright';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createStaticServer } from './serve.mjs';
import * as R from '../src/raw.js';
import { makeDNG } from './lib/dng-fixture.mjs';

let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const T0 = Date.now();
mkdirSync('screenshots', { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// 1. Node
// ---------------------------------------------------------------------------------------------------------
const hueOf = (r, g, b) => { const hi = Math.max(r, g, b), lo = Math.min(r, g, b), c = hi - lo; if (!c) return -1; let h = hi === r ? ((g - b) / c) % 6 : hi === g ? (b - r) / c + 2 : (r - g) / c + 4; h *= 60; return h < 0 ? h + 360 : h; };
{ // defringe on a synthetic edge: bright | 2 px purple (or green) fringe | dark, plus a flat purple patch
  const W = 120, H = 40, make = (fr) => { const a = new Uint16Array(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = x < 30 ? [60000, 60000, 60000] : x < 32 ? fr : x < 60 ? [3000, 3000, 3000] : [30000, 9000, 38000]; a.set([...v, 65535], (y * W + x) * 4); } return a; };
  const purple = [42000, 12000, 52000], green = [14000, 40000, 16000];
  const chroma = (a, x) => { const i = (20 * W + x) * 4; return Math.max(a[i], a[i + 1], a[i + 2]) - Math.min(a[i], a[i + 1], a[i + 2]); };
  const p0 = make(purple), p1 = p0.slice(); R.defringe(p1, W, H, { ...R.DEFAULT_SETTINGS, fringePurple: 100 });
  check(chroma(p1, 30) < chroma(p0, 30) * 0.1 && chroma(p1, 90) === chroma(p0, 90), `defringe purple 100: the edge fringe loses its colour (chroma ${chroma(p0, 30)} → ${chroma(p1, 30)}) while a flat purple area keeps it (${chroma(p1, 90)})`);
  const g0 = make(green), g1 = g0.slice(), g2 = g0.slice(); R.defringe(g1, W, H, { ...R.DEFAULT_SETTINGS, fringePurple: 100 }); R.defringe(g2, W, H, { ...R.DEFAULT_SETTINGS, fringeGreen: 100 });
  check(chroma(g1, 30) === chroma(g0, 30) && chroma(g2, 30) < chroma(g0, 30) * 0.1, `green fringe: untouched by the purple control, removed by green 100 (${chroma(g0, 30)} → ${chroma(g2, 30)})`);
  const n0 = make(purple), n1 = n0.slice(); R.defringe(n1, W, H, { ...R.DEFAULT_SETTINGS, fringePurple: 100, fringePurpleLo: 200, fringePurpleHi: 240 });
  const h = hueOf(purple[0], purple[1], purple[2]);
  check(chroma(n1, 30) === chroma(n0, 30), `the hue range matters: a ${h.toFixed(0)}° fringe is kept when the purple range is 200–240°`);
  const h0 = make(purple), h1 = h0.slice(); R.defringe(h1, W, H, { ...R.DEFAULT_SETTINGS, fringePurple: 50 });
  const l0 = 0.2126 * h0[(20 * W + 30) * 4] + 0.7152 * h0[(20 * W + 30) * 4 + 1] + 0.0722 * h0[(20 * W + 30) * 4 + 2], l1 = 0.2126 * h1[(20 * W + 30) * 4] + 0.7152 * h1[(20 * W + 30) * 4 + 1] + 0.0722 * h1[(20 * W + 30) * 4 + 2];
  check(chroma(h1, 30) > chroma(h1, 30) * 0 && chroma(h1, 30) < chroma(h0, 30) * 0.7 && chroma(h1, 30) > chroma(p1, 30) && Math.abs(l1 - l0) < 2, `amount 50 removes part of the fringe (chroma ${chroma(h1, 30)}) and keeps brightness (luma ${l0.toFixed(0)} → ${l1.toFixed(0)})`);
  const e0 = make(purple), e1 = e0.slice(); R.defringe(e1, W, H, R.DEFAULT_SETTINGS);
  check(e1.every((v, i) => v === e0[i]), 'defringe at 0 (the default) leaves the pixels untouched');
  // through developRows: bands == whole image with defringe on
  const src = { width: 300, height: 200, data: new Float32Array(300 * 200 * 3), half: false };
  for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) { const sq = (x % 50 < 25) !== (y % 50 < 25); src.data.set(sq ? [0.8, 0.8, 0.8] : x % 50 === 25 || y % 50 === 25 ? [0.4, 0.05, 0.55] : [0.03, 0.03, 0.03], (y * 300 + x) * 3); }
  const meta = { blackLevel: [0, 0, 0, 0], whiteLevel: 1, cameraMultipliers: [1, 1, 1], colorMatrix: null }, set = { ...R.DEFAULT_SETTINGS, fringePurple: 80, fringeGreen: 40 };
  const pipe = R.pipeline(meta, R.colorModel(meta), set, null), opts = { pipe, orientation: 1, settings: set, scale: 1, bits: 16 };
  const whole = R.developRows(src, opts), out = new Uint16Array(whole.data.length);
  for (const b of R.planBands(src, opts, 5)) { const r = R.developRows(R.extractRegion(src, b.rect), { ...opts, rows: b.rows }); out.set(r.data, b.rows[0] * r.width * 4); }
  let worst = 0; for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - whole.data[i]));
  check(worst <= 1 && whole.ms.defringe >= 0, `band develop with defringe on equals the whole-image develop (max difference ${worst})`);
  const t = Date.now(), big = new Uint16Array(6000 * 700 * 4).fill(30000); for (let i = 0; i < big.length; i += 4 * 97) big[i] = 60000; R.defringe(big, 6000, 700, { fringePurple: 50, fringeGreen: 50 });
  const msBand = Date.now() - t;
  check(msBand < 1500, `defringe cost: ${msBand} ms for one 6000 × 700 band (24 MP ÷ 7 workers; it runs only when an amount is above 0)`);
  const c = R.cleanSettings({ fringePurple: 500, fringePurpleLo: 330, fringePurpleHi: 250, fringeGreenLo: 10 });
  check(c.fringePurple === 100 && c.fringePurpleLo === 250 && c.fringePurpleHi === 330 && c.fringeGreenLo === 40, `defringe settings are clamped and an inverted hue range is swapped (${c.fringePurple}, ${c.fringePurpleLo}–${c.fringePurpleHi}°, green from ${c.fringeGreenLo}°)`);
}
{ // memory-aware worker plan
  const rows = [8, 4, 2, 1].map((dm) => { const pool = R.poolSize(8, dm), p = R.planWorkers({ width: 6000, height: 4000, pool, deviceMemory: dm }); return { dm, pool, ...p }; });
  const unknown = R.planWorkers({ width: 6000, height: 4000, pool: R.poolSize(8, 0), deviceMemory: 0 });
  check(rows.every((r) => r.inFlightMB <= r.budgetMB && r.workers >= 1) && rows[0].workers === 7 && rows[3].workers === 1 && rows[1].workers < rows[0].workers && rows[2].workers < rows[1].workers && unknown.workers === 7,
    `24 MP plan by device memory (8 cores): ${rows.map((r) => `${r.dm} GB → pool ${r.pool}, ${r.workers} worker${r.workers > 1 ? 's' : ''} × ${r.bands} bands (${r.inFlightMB} / ${r.budgetMB} MB)`).join('; ')}; unknown → ${unknown.workers} × ${unknown.bands}`);
  const small = R.planWorkers({ width: 1200, height: 800, pool: 7, deviceMemory: 2 });
  const halo = rows.every((r) => r.bands * 2 * R.BAND_HALO <= 4000 * R.MAX_HALO_OVERHEAD + 2 * R.BAND_HALO * r.workers);
  check(small.workers === 3 && small.bands === 3 && halo, `small images are not split further (1 MP on 2 GB: ${small.workers} × ${small.bands}); extra halo rows stay ≤ 25 %`);
  const off = R.planWorkers({ width: 6000, height: 4000, pool: 7, cap: 0 });
  check(off.workers === 0 && off.bands === 1, 'worker cap 0 (test override) develops on one thread');
}
{ // preset files
  const f = R.presetFile([{ name: 'Warm', settings: { wb: 'custom', temp: 6500, exposure: 0.3 } }, { name: 'Mono', settings: { saturation: -100 } }]);
  const back = R.parsePresetFile(JSON.stringify(f));
  check(f.format === 'tintwork-raw-presets' && f.version === 1 && back.length === 2 && back[0].settings.temp === 6500 && back[1].settings.saturation === -100 && 'fringePurple' in back[0].settings, 'preset file round trip: format + version, every setting written out (incl. new keys), read back');
  const one = R.parsePresetFile({ name: '  Single  ', settings: { exposure: 9, bogus: 1, wb: 'nope' } });
  check(one.length === 1 && one[0].name === 'Single' && one[0].settings.exposure === 5 && !('bogus' in one[0].settings) && one[0].settings.wb === 'as-shot', 'a single { name, settings } is accepted; values are clamped, unknown keys and invalid white balance dropped');
  const dup = R.parsePresetFile([{ name: 'A', settings: { exposure: 1 } }, { name: 'a', settings: { exposure: 2 } }, { name: '', settings: {} }, { name: 'B' }]);
  check(dup.length === 1 && dup[0].settings.exposure === 2, 'within one file the last preset of a name wins; nameless or settings-less entries are skipped');
  const errs = ['not json', '{"format":"tintwork-raw-presets"}', '{"foo":1}', '[]'].map((x) => { try { R.parsePresetFile(x); return null; } catch (e) { return e.message; } });
  check(errs.every(Boolean), `invalid preset files are rejected with a message (${errs.join(' | ')})`);
}

// ---------------------------------------------------------------------------------------------------------
// 2. Browser
// ---------------------------------------------------------------------------------------------------------
const server = createStaticServer(), isoServer = createStaticServer({ isolated: true });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); await new Promise((r) => isoServer.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`, isoBase = `http://127.0.0.1:${isoServer.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const tmp = 'test-assets/.v13'; mkdirSync(tmp, { recursive: true });
const colourScene = (x, y) => [0.45 + 0.2 * Math.sin(x / 40), 0.3, 0.12 + 0.1 * Math.cos(y / 30)];
const plainFile = `${tmp}/plain.dng`, fringeFile = `${tmp}/fringe.dng`;
writeFileSync(plainFile, makeDNG({ W: 480, H: 320, lens: false, scene: colourScene }));
// white squares with a 3 px purple rim on a dark ground (left), a flat purple patch (right)
const fringeScene = (x, y) => {
  if (x >= 600 && x < 800 && y >= 200 && y < 400) return [0.3, 0.05, 0.42];
  if (x < 480) { const u = x % 120, v = y % 120; if (u >= 30 && u < 90 && v >= 30 && v < 90) return [0.85, 0.85, 0.85]; if (u >= 27 && u < 93 && v >= 27 && v < 93) return [0.45, 0.06, 0.6]; }
  return [0.03, 0.03, 0.03];
};
writeFileSync(fringeFile, makeDNG({ W: 900, H: 600, lens: false, scene: fringeScene }));
const manifest = JSON.parse(readFileSync('test-assets/raw-samples.json', 'utf8')).samples;
const bigS = manifest.find((s) => s.local === 'sony-ilce-6000.arw'), bigFile = bigS && `test-assets/raw-samples/${bigS.local}`, haveBig = bigFile && existsSync(bigFile);

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => localStorage.setItem('tintwork.engine', 'cpu'));
const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(async () => { await window.tintwork.clearAutosave?.(); localStorage.removeItem('tintwork.rawPresets'); localStorage.removeItem('tintwork.rawLast'); });
const settle = () => page.evaluate(async () => { await window.tintwork.idle(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
const waitPreview = (n) => page.waitForFunction((n) => { const u = window.tintwork.rawUI; return u && u.previews >= n && u.idle; }, n, { timeout: 30000 });
const setSlider = (k, v) => page.evaluate(([k, v]) => { const el = document.querySelector(`#modal [data-k=${k}]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, [k, v]);
const colsSpread = (f0, f1) => page.evaluate(([f0, f1]) => { // mean colour spread of the preview columns f0..f1 (fractions)
  const c = document.querySelector('#rawCanvas'), d = c.getContext('2d').getImageData(Math.floor(c.width * f0), 0, Math.max(1, Math.floor(c.width * (f1 - f0))), c.height).data; let s = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 3) { s += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); n++; } return s / n;
}, [f0, f1]);

// --- dialog: defringe in the preview -----------------------------------------------------------------------
{
  await page.setInputFiles('#fileInput', fringeFile); await waitPreview(1);
  const keys = await page.evaluate(() => [...document.querySelectorAll('#modal [data-k]')].map((e) => e.dataset.k));
  check(['fringePurple', 'fringePurpleLo', 'fringePurpleHi', 'fringeGreen', 'fringeGreenLo', 'fringeGreenHi'].every((k) => keys.includes(k)) && await page.isVisible('#rawSplitBtn') && await page.isVisible('#rawPresetExport'),
    'develop dialog has the Defringe section (purple and green amount + hue range), a Split button and preset Export / Import');
  const fringe = () => page.evaluate(() => { // purple chroma around the squares (left half) and inside the flat patch (right)
    const c = document.querySelector('#rawCanvas'), x = c.getContext('2d'), W = c.width, H = c.height;
    const m = (x0, y0, x1, y1) => { const d = x.getImageData(Math.floor(W * x0), Math.floor(H * y0), Math.floor(W * (x1 - x0)), Math.floor(H * (y1 - y0))).data; let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; if (r > g + 20 && b > g + 20) { s += Math.max(r, g, b) - Math.min(r, g, b); } n++; } return s / n; };
    return { edges: m(0, 0, 480 / 900, 1), patch: m(650 / 900, 250 / 600, 750 / 900, 350 / 600) };
  });
  const f0 = await fringe();
  await setSlider('fringePurple', 100); await waitPreview(2); const f1 = await fringe();
  check(f1.edges < f0.edges * 0.5 && Math.abs(f1.patch - f0.patch) < f0.patch * 0.05 + 0.5, `defringe in the preview: purple rims along the edges ${f0.edges.toFixed(1)} → ${f1.edges.toFixed(1)}, flat purple patch kept (${f0.patch.toFixed(1)} → ${f1.patch.toFixed(1)})`);
  await page.click('#modalCancel');
}

// --- split view --------------------------------------------------------------------------------------------
{
  await page.setInputFiles('#fileInput', plainFile); await waitPreview(1);
  await setSlider('saturation', -100); await waitPreview(2);
  await page.click('#rawSplitBtn'); await page.waitForFunction(() => window.tintwork.rawUI.view === 'split');
  const a = { left: await colsSpread(0.02, 0.4), right: await colsSpread(0.6, 0.98) };
  const vis = await page.evaluate(() => ({ div: !document.querySelector('#rawSplit').classList.contains('hidden'), after: !document.querySelector('#rawAfterTag').classList.contains('hidden'), pressed: document.querySelector('#rawSplitBtn').getAttribute('aria-pressed') }));
  check(a.left > 10 && a.right < 3 && vis.div && vis.after && vis.pressed === 'true', `split view: before (default colour) on the left, after (saturation −100) on the right (spread ${a.left.toFixed(1)} | ${a.right.toFixed(1)}), divider and Before / After labels shown`);
  // drag the divider with the mouse to 75 %
  const cb = await page.locator('#rawCanvas').boundingBox(), dv = await page.locator('#rawSplit').boundingBox();
  const content = await page.evaluate(() => { const c = document.querySelector('#rawCanvas'), k = Math.min(c.clientWidth / c.width, c.clientHeight / c.height); return { w: c.width * k, h: c.height * k }; });
  const cx0 = cb.x + (cb.width - content.w) / 2;
  check(Math.abs(dv.x + dv.width / 2 - (cx0 + content.w * 0.5)) < 4, `the divider starts in the middle of the image (object-fit content box, ${(dv.x + dv.width / 2 - cx0).toFixed(0)} of ${content.w.toFixed(0)} px)`);
  await page.mouse.move(dv.x + dv.width / 2, dv.y + dv.height / 2); await page.mouse.down();
  await page.mouse.move(cx0 + content.w * 0.6, dv.y + dv.height / 2, { steps: 5 }); await page.mouse.move(cx0 + content.w * 0.75, dv.y + dv.height / 2, { steps: 5 }); await page.mouse.up();
  const sp = await page.evaluate(() => window.tintwork.rawUI.split), b = { left: await colsSpread(0.5, 0.72), right: await colsSpread(0.78, 0.98) };
  const dv2 = await page.locator('#rawSplit').boundingBox();
  check(Math.abs(sp - 0.75) < 0.02 && b.left > 10 && b.right < 3 && Math.abs(dv2.x + dv2.width / 2 - (cx0 + content.w * 0.75)) < 4, `dragging the divider to 75 % moves the split (split ${sp.toFixed(3)}; 50–72 % now before: ${b.left.toFixed(1)}, 78–98 % after: ${b.right.toFixed(1)})`);
  await page.focus('#rawSplit'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  const sp2 = await page.evaluate(() => window.tintwork.rawUI.split);
  check(Math.abs(sp2 - (sp - 0.04)) < 0.005, `the divider also moves with the arrow keys (${sp.toFixed(2)} → ${sp2.toFixed(2)})`);
  // changing a setting keeps the split view and updates the after side
  await setSlider('saturation', 0); await waitPreview(3);
  const c2 = { right: await colsSpread(0.8, 0.98), view: await page.evaluate(() => window.tintwork.rawUI.view) };
  check(c2.view === 'split' && c2.right > 10, `editing a slider keeps the split view and redraws the after side (spread ${c2.right.toFixed(1)})`);
  await setSlider('saturation', -100); await waitPreview(4);
  await page.evaluate(() => window.tintwork.rawUI.setSplit(0.5)); await settle(); await page.waitForTimeout(100);
  await page.screenshot({ path: 'screenshots/13x-raw-split-view.png' });
  await page.keyboard.press('y'); await page.waitForFunction(() => window.tintwork.rawUI.view === 'after');
  check(await page.evaluate(() => document.querySelector('#rawSplit').classList.contains('hidden')) && await colsSpread(0.02, 0.4) < 3, 'Y (or the Split button) leaves split view');
}

// --- preset export / import --------------------------------------------------------------------------------
{
  await page.fill('#rawPresetName', 'Mono v13'); await page.click('#rawPresetSave');
  await setSlider('exposure', 0.75); await page.fill('#rawPresetName', 'Bright v13'); await page.click('#rawPresetSave');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rawPresetExport')]);
  const path = `${tmp}/${dl.suggestedFilename()}`; await dl.saveAs(path);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  check(dl.suggestedFilename().endsWith('.json') && file.format === 'tintwork-raw-presets' && file.presets.length === 2 && file.presets.find((p) => p.name === 'Bright v13')?.settings.exposure === 0.75 && file.presets.find((p) => p.name === 'Mono v13')?.settings.saturation === -100,
    `Export presets… downloads ${dl.suggestedFilename()} with both presets and their settings`);
  await page.evaluate(() => localStorage.removeItem('tintwork.rawPresets'));
  writeFileSync(`${tmp}/one.json`, JSON.stringify({ name: 'Mono v13', settings: { saturation: -40 } }));
  await page.setInputFiles('#rawPresetFile', path); await page.waitForFunction(() => window.tintwork.rawUI.imported?.length === 2);
  const opts1 = await page.evaluate(() => [...document.querySelectorAll('#rawPreset option')].map((o) => o.textContent));
  await page.setInputFiles('#rawPresetFile', `${tmp}/one.json`); await page.waitForFunction(() => window.tintwork.rawUI.imported?.length === 1);
  const list = await page.evaluate(() => window.tintwork.rawPresets());
  check(opts1.includes('Mono v13') && opts1.includes('Bright v13') && list.length === 2 && list.find((p) => p.name === 'Mono v13').settings.saturation === -40,
    'Import presets… adds the presets from the file to the menu; importing a preset with the same name replaces it');
  writeFileSync(`${tmp}/bad.json`, '{"hello": "world"}');
  await page.setInputFiles('#rawPresetFile', `${tmp}/bad.json`); await page.waitForTimeout(200);
  const toast = await page.evaluate(() => document.querySelector('#toast')?.textContent || '');
  check(/could not be imported/.test(toast) && (await page.evaluate(() => window.tintwork.rawPresets().length)) === 2, `a file that is not a preset file is refused with a message (“${toast.split('\n').pop()}”)`);
  await page.selectOption('#rawPreset', 'preset:Bright v13'); await waitPreview(6);
  check(await page.evaluate(() => window.tintwork.rawUI.settings.exposure === 0.75), 'an imported preset applies from the menu');
}

// --- open → RAW layer → re-develop ------------------------------------------------------------------------
const layerInfo = () => page.evaluate(() => { const t = window.tintwork, l = t.activeLayer(), c = l.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
  return { w: c.width, h: c.height, mean: s / (d.length / 4) / 3, raw: l.raw && { name: l.raw.name, size: l.raw.file?.size, settings: l.raw.settings, cx: l.raw.cx, cy: l.raw.cy, cw: l.raw.cw, ch: l.raw.ch, same: l.raw.rev === l.rev }, label: t.history.entries[t.history.index].label, deep: !!l.deep }; });
const pixels = () => page.evaluate(() => { const l = window.tintwork.activeLayer(), c = l.canvas; return { px: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data), deep: l.deep && Array.from({ length: 50 }, (_, k) => { const x = (k * 37) % c.width, y = (k * 23) % c.height; return l.deep.data[((y - (l.deepOY || 0)) * l.deep.width + (x - (l.deepOX || 0))) * 4 + 1]; }) }; });
const maxDiff = (a, b) => { if (!a || !b || a.length !== b.length) return Infinity; let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const redevelop = async (how = 'api') => {
  if (how === 'dblclick') await page.dblclick('#layerList li .thumb'); else await page.evaluate(() => { window.tintwork.redevelopRaw(); });
  await page.waitForFunction(() => window.tintwork.rawUI?.redevelop && window.tintwork.rawUI.previews >= 1 && window.tintwork.rawUI.idle, null, { timeout: 30000 });
};
const apply = async () => { await page.click('#modalOk'); await page.waitForFunction(() => window.tintwork.history.entries[window.tintwork.history.index].label === 'Re-develop RAW' && !window.tintwork.rawUI, null, { timeout: 30000 }); await settle(); };
{
  await page.click('#modalOk');
  await page.waitForFunction(() => window.tintwork.state.doc?.name === 'plain.dng' && !document.querySelector('.dev-overlay') && window.tintwork.lastImport?.total, null, { timeout: 30000 }); await settle();
  const L0 = await layerInfo(), title = await page.getAttribute('#layerList li .thumb', 'title');
  check(L0.raw?.name === 'plain.dng' && L0.raw.size > 100000 && L0.raw.settings.exposure === 0.75 && L0.raw.same && /re-develop/.test(title), `the developed layer keeps its RAW source (${L0.raw?.name}, ${(L0.raw?.size / 1024).toFixed(0)} KB) and settings; the thumbnail says “${title}”`);
  await redevelop('dblclick');
  const dlg = await page.evaluate(() => ({ title: document.querySelector('#modalTitle').textContent, ok: document.querySelector('#modalOk').textContent, exp: +document.querySelector('#modal [data-k=exposure]').value, jpeg: !!document.querySelector('#rawJpeg') }));
  check(/^Re-develop plain\.dng/.test(dlg.title) && dlg.ok === 'Apply' && dlg.exp === 0.75 && !dlg.jpeg, `double-clicking the RAW layer reopens the develop dialog (“${dlg.title}”, ${dlg.ok}) with its settings (exposure ${dlg.exp})`);
  await setSlider('exposure', -1); await waitPreview(2); await page.waitForTimeout(100);
  await page.screenshot({ path: 'screenshots/13x-raw-redevelop.png' });
  await apply();
  const L1 = await layerInfo();
  check(L1.mean < L0.mean - 20 && L1.raw.settings.exposure === -1 && L1.raw.same && L1.deep && L1.label === 'Re-develop RAW', `Apply re-develops the layer in place (mean ${L0.mean.toFixed(0)} → ${L1.mean.toFixed(0)}, 16-bit data replaced) as one undo step`);
  await page.evaluate(() => window.tintwork.undo()); await settle();
  const L2 = await layerInfo();
  check(Math.abs(L2.mean - L0.mean) < 0.01 && L2.raw.settings.exposure === 0.75, 'undo restores the previous develop and its settings');
  await page.evaluate(() => window.tintwork.redo()); await settle();
  // crop, then re-develop with the same settings: the same pixels (8- and 16-bit) in the crop window
  await page.evaluate(() => window.tintwork.cropTo({ x: 100, y: 50, w: 200, h: 150 })); await settle();
  const C0 = await layerInfo(), P0 = await pixels();
  await redevelop(); await apply();
  const C1 = await layerInfo(), P1 = await pixels();
  check(C0.raw.cx === 100 && C0.raw.cy === 50 && C0.raw.same && C1.w === 200 && C1.h === 150 && maxDiff(P0.px, P1.px) <= 1 && maxDiff(P0.deep, P1.deep) <= 1,
    `after a crop, re-developing keeps the crop window (${C1.w}×${C1.h} at ${C0.raw.cx},${C0.raw.cy}; 8-bit max diff ${maxDiff(P0.px, P1.px)}, 16-bit max diff ${maxDiff(P0.deep, P1.deep)})`);
  // an edited layer asks first
  await page.evaluate(() => { const t = window.tintwork, l = t.activeLayer(); l.canvas.getContext('2d').fillRect(0, 0, 20, 20); l.rev += 1000; t.commit('Paint'); });
  await page.evaluate(() => { window.tintwork.redevelopRaw(); }); await page.waitForFunction(() => /edited after it was developed/.test(document.querySelector('#modalBody')?.textContent || ''));
  const okLabel = await page.textContent('#modalOk'); await page.click('#modalCancel'); await page.waitForTimeout(200);
  check(okLabel === 'Re-develop' && !(await page.evaluate(() => window.tintwork.rawUI)), 'a layer edited after developing asks before re-developing (Cancel keeps the edits)');
  await page.evaluate(() => window.tintwork.undo()); await settle();
}
// --- project file and autosave keep the RAW source -----------------------------------------------------------
{
  const P0 = await pixels();
  const proj = await page.evaluate(async () => { const d = await window.tintwork.projectData(), r = d.layers[0].raw; return { json: JSON.stringify(d), v: d.version, raw: r && { ...r, data: r.data?.slice(0, 40), len: r.data?.length } }; });
  check(proj.v >= 7 && proj.raw?.cx === 100 && /^data:/.test(proj.raw.data) && proj.raw.len > 100000 && proj.raw.settings.exposure === -1, `project files (version 7) embed the RAW file (${(proj.raw?.len / 1024).toFixed(0)} KB as a data URL), settings and crop window`);
  await page.evaluate(async (json) => { await window.tintwork.loadProject(JSON.parse(json), 'reopened.tintwork'); }, proj.json); await settle();
  const L = await layerInfo();
  await redevelop(); await apply();
  const P1 = await pixels(), L1 = await layerInfo();
  check(L.raw?.name === 'plain.dng' && L.raw.cx === 100 && L.raw.same && L1.w === 200 && maxDiff(P0.px, P1.px) <= 1, `a reopened project can be re-developed (same crop, 8-bit max diff ${maxDiff(P0.px, P1.px)})`);
  await page.evaluate(() => window.tintwork.autosaveNow());
  const rec = await page.evaluate(async () => { const r = await window.tintwork.readAutosave(); return { ids: r.imageIds.filter((i) => i.startsWith('R-')).length, slot: r.slot }; });
  await page.evaluate(async () => { const t = window.tintwork, r = await t.readAutosave(); await t.restoreAutosave(r); }); await settle();
  const A = await layerInfo(); await redevelop(); await apply(); const P2 = await pixels();
  check(rec.ids === 1 && A.raw?.size === L.raw.size && maxDiff(P0.px, P2.px) <= 1, `autosave stores the RAW file once (${rec.ids} R- record for ${await page.evaluate(() => window.tintwork.history.entries.length)} undo steps) and a recovered document can be re-developed`);
}

// --- decoder threads: not isolated (here) vs cross-origin isolated (COOP/COEP) ------------------------------
const headers = readFileSync('_headers', 'utf8');
check(/Cross-Origin-Opener-Policy: same-origin/.test(headers) && /Cross-Origin-Embedder-Policy: require-corp/.test(headers) && /^\/\*$/m.test(headers), '_headers (Netlify / Cloudflare Pages) sends COOP same-origin + COEP require-corp for every path');
const dec0 = await page.evaluate(() => ({ iso: crossOriginIsolated, d: window.tintwork.lastDecoder }));
check(!dec0.iso && dec0.d?.threads === 0 && /isolated/.test(dec0.d.reason), `without COOP/COEP the single-threaded decoder is used (${dec0.d?.binary}; reason: ${dec0.d?.reason})`);
const iso = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await iso.addInitScript(() => localStorage.setItem('tintwork.engine', 'cpu'));
const ip = await iso.newPage(); ip.on('pageerror', (e) => errors.push(`isolated: ${e.message}`));
await ip.goto(`${isoBase}?platform=win`); await ip.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await ip.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'v13in'; i.hidden = true; i.onchange = () => { window.__f = i.files[0]; }; document.body.append(i); });
const openIn = async (p, f) => { await p.evaluate(() => { document.querySelector('#v13in').value = ''; }); await p.setInputFiles('#v13in', f);
  return p.evaluate(async () => { const t = window.tintwork; await t.openRAW(document.querySelector('#v13in').files[0], false); const d = t.state.doc; const r = { ...t.lastImport, decoder: t.lastDecoder, w: d.width, depth: d.depth }; await t.closeTab(undefined, { force: true }); return r; }); };
const ri = await openIn(ip, plainFile);
check(await ip.evaluate(() => crossOriginIsolated) && ri.decoder?.threads > 1 && /threads/.test(ri.decoder.binary || '') && ri.depth === 16, `with COOP/COEP the page is cross-origin isolated and the multithreaded decoder runs (${ri.decoder?.threads} threads, ${ri.decoder?.binary})`);
await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'v13in'; i.hidden = true; i.onchange = () => { window.__f = i.files[0]; }; document.body.append(i); });
const timings = {};
if (haveBig) {
  const best = async (p) => { const rs = []; for (let k = 0; k < 2; k++) rs.push(await openIn(p, bigFile)); return rs.sort((a, b) => a.total - b.total)[0]; };
  const a = await best(page), b = await best(ip);
  timings.single = a; timings.threaded = b;
  console.log('TIMING_24MP_DECODE', JSON.stringify({ single: { decode: a.decode, total: a.total, workers: a.workers, bands: a.bands }, threaded: { decode: b.decode, total: b.total, threads: b.decoder?.threads, workers: b.workers, bands: b.bands } }));
  check(b.decode < a.decode * 0.8 && b.w === 6000, `24 MP ${bigS.local}: decode ${a.decode} ms single-threaded → ${b.decode} ms with ${b.decoder?.threads} decoder threads; whole open ${a.total} → ${b.total} ms (${b.workers} develop workers × ${b.bands} bands)`);
  // device memory: 1 GB → one develop worker, 2 GB → two
  for (const [dm, want] of [[1, 1], [2, 2]]) {
    await page.evaluate((dm) => window.tintwork.setDevelopEnv({ deviceMemory: dm }), dm);
    const r = await openIn(page, bigFile);
    check(r.workers === want && r.w === 6000, `navigator.deviceMemory ${dm} GB caps the 24 MP develop at ${r.workers} worker${r.workers > 1 ? 's' : ''} × ${r.bands} bands (${r.total} ms)`);
  }
  await page.evaluate(() => window.tintwork.setDevelopEnv({ deviceMemory: navigator.deviceMemory || 0 }));
} else console.log('skip 24 MP timing: run npm run fetch-raw first');
await iso.close();

const ui = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('[title]')].map((e) => e.title).join(' '));
check(!/photoshop|adobe/i.test(ui), 'no product names of other editors in the UI');
check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close(); server.close(); isoServer.close();
console.log(fails ? `${fails} of ${count} v1.3 check(s) FAILED (${((Date.now() - T0) / 1000).toFixed(0)} s)` : `All ${count} v1.3 checks passed (${((Date.now() - T0) / 1000).toFixed(0)} s)`);
process.exit(fails ? 1 : 0);
