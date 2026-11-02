// v1.4 test: re-develop after resize / rotate / flip / free transform (the layer's transform map is re-applied to a
// fresh develop), linked RAW files (File System Access handles, relink prompt), the defringe eyedropper and
// "show affected areas" mask, manual lens distortion with a grid and user lens profiles, and local adjustments
// (graduated + radial filters with exposure / contrast / temperature). Screenshots: 14x-*.png.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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
const dev = (src, set) => { const pipe = R.pipeline(meta, R.colorModel(meta), set, null); return R.developRows(src, { pipe, orientation: 1, settings: set, scale: 1, bits: 16, distortion: set.distortion || 0 }); };
const at = (r, x, y) => { const i = (y * r.width + x) * 4; return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]]; };
const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
{ // local adjustments: validation and weights
  const c = R.cleanLocal([{ type: 'radial', exposure: 9, contrast: -500, temp: 30, cx: 0.4, cy: 0.6, rx: 0, ry: 5, feather: 3, invert: 1 }, { type: 'bogus' }, null, { type: 'linear', x0: 0.5, y0: 0.2, x1: 0.5, y1: 0.2 }, ...Array(12).fill({ type: 'linear' })]);
  check(c.length === R.MAX_LOCALS && c[0].exposure === 4 && c[0].contrast === -100 && c[0].rx === 0.01 && c[0].ry === 2 && c[0].feather === 1 && c[0].invert === true && c[1].y1 > c[1].y0 && R.cleanLocal([]) === null && R.cleanLocal('x') === null,
    `local adjustments are validated: at most ${R.MAX_LOCALS} kept, values clamped, unknown types dropped, a zero-length graduated filter gets a length, none → null`);
  const lin = R.cleanLocal([{ type: 'linear', x0: 0.5, y0: 0, x1: 0.5, y1: 0.5 }])[0], rad = R.cleanLocal([{ type: 'radial', cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, feather: 0.5 }])[0];
  const w = [R.localWeight(lin, 0.5, -0.1), R.localWeight(lin, 0.5, 0.25), R.localWeight(lin, 0.5, 0.6), R.localWeight(rad, 0.5, 0.5), R.localWeight(rad, 0.5, 0.75), R.localWeight({ ...rad, invert: true }, 0.5, 0.5), R.localWeight({ ...rad, invert: true }, 0.95, 0.95)];
  check(w[0] === 1 && Math.abs(w[1] - 0.5) < 1e-9 && w[2] === 0 && w[3] === 1 && w[4] === 0 && w[5] === 0 && w[6] === 1, `weights: graduated 1 → 0.5 → 0 across its band (${w.slice(0, 3).map((v) => v.toFixed(2)).join(', ')}); radial 1 inside, 0 outside, inverted the other way round`);
  const diag = R.cleanLocal([{ type: 'linear', x0: 0, y0: 0, x1: 1, y1: 1 }])[0];
  const w1 = R.localWeight(diag, 0.5, 0.5, 2), w2 = R.localWeight(diag, 0.45, 0.7, 2), w3 = R.localWeight(diag, 0.45, 0.7, 1);
  check(Math.abs(w1 - w2) < 1e-9 && w1 > 0 && w1 < 1 && Math.abs(w3 - w1) > 0.01, 'a diagonal graduated filter fades at right angles to its line in image pixels (aspect-correct)');
}
{ // local adjustments in the develop
  const W = 200, H = 100, src = flat(W, H, () => [0.18, 0.18, 0.18]), base = { ...R.DEFAULT_SETTINGS };
  const b = dev(src, base);
  const r1 = dev(src, { ...base, local: [{ type: 'radial', exposure: 1, cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.3, feather: 0.2 }] });
  const k = lum(at(r1, 100, 50)) / lum(at(b, 100, 50)), corner = Math.abs(lum(at(r1, 5, 5)) - lum(at(b, 5, 5)));
  check(k > 1.4 && corner <= 1, `radial filter +1 EV brightens its centre (luma × ${k.toFixed(2)}) and leaves the corners alone (diff ${corner})`);
  const r2 = dev(src, { ...base, local: [{ type: 'linear', exposure: -1, x0: 0.5, y0: 0, x1: 0.5, y1: 0.5 }] });
  check(lum(at(r2, 100, 2)) < lum(at(b, 100, 2)) * 0.7 && Math.abs(lum(at(r2, 100, 90)) - lum(at(b, 100, 90))) <= 1 && lum(at(r2, 100, 25)) > lum(at(r2, 100, 2)), 'graduated filter −1 EV darkens the top (the sky side), fades over its band and leaves the bottom unchanged');
  const r3 = dev(src, { ...base, local: [{ type: 'radial', temp: 100, cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.4 }] }), p3 = at(r3, 100, 50), p0 = at(b, 100, 50);
  check(p3[0] > p0[0] * 1.1 && p3[2] < p0[2] * 0.9, `temperature +100 warms the area (R ${p0[0]} → ${p3[0]}, B ${p0[2]} → ${p3[2]})`);
  const ramp = flat(W, H, (x) => [0.02 + 0.6 * x / W, 0.02 + 0.6 * x / W, 0.02 + 0.6 * x / W]), rb = dev(ramp, base), rc = dev(ramp, { ...base, local: [{ type: 'radial', contrast: 100, cx: 0.5, cy: 0.5, rx: 2, ry: 2, feather: 0 }] });
  const spread = (r) => lum(at(r, 190, 50)) - lum(at(r, 10, 50));
  check(spread(rc) > spread(rb) * 1.1, `local contrast +100 widens the tonal spread (${spread(rb).toFixed(0)} → ${spread(rc).toFixed(0)})`);
  const none = dev(src, { ...base, local: [{ type: 'radial', cx: 0.5, cy: 0.5 }] });
  check(none.data.every((v, i) => v === b.data[i]), 'a local adjustment with all effects at 0 changes nothing');
}
{ // bands == whole with locals + distortion + defringe
  const src = flat(300, 200, (x, y) => ((x % 50 < 25) !== (y % 50 < 25) ? [0.7, 0.6, 0.5] : [0.05, 0.08, 0.1]));
  const set = { ...R.DEFAULT_SETTINGS, distortion: 40, fringePurple: 30, local: [{ type: 'linear', exposure: -0.7, x0: 0.3, y0: 0, x1: 0.6, y1: 0.6 }, { type: 'radial', exposure: 0.6, temp: -40, contrast: 30, cx: 0.4, cy: 0.6, rx: 0.3, ry: 0.2, invert: true }] };
  const pipe = R.pipeline(meta, R.colorModel(meta), set, null), opts = { pipe, orientation: 1, settings: set, scale: 1, bits: 16, distortion: 40 };
  const whole = R.developRows(src, opts), out = new Uint16Array(whole.data.length);
  for (const b of R.planBands(src, opts, 5)) { const r = R.developRows(R.extractRegion(src, b.rect), { ...opts, rows: b.rows }); out.set(r.data, b.rows[0] * r.width * 4); }
  let worst = 0; for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - whole.data[i]));
  check(worst <= 1, `band develop (5 bands) equals the whole-image develop with 2 local adjustments + distortion + defringe (max difference ${worst})`);
}
{ // manual distortion
  const W = 300, H = 200, grid = flat(W, H, (x, y) => (x % 20 < 2 || y % 20 < 2 ? [0.8, 0.8, 0.8] : [0.1, 0.1, 0.1])), base = { ...R.DEFAULT_SETTINGS };
  const r0 = dev(grid, base), rp = dev(grid, { ...base, distortion: 80 }), rn = dev(grid, { ...base, distortion: -80 });
  const opaque = (r) => [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, 0], [0, H / 2]].every(([x, y]) => at(r, x, y)[3] === 65535 && lum(at(r, x, y)) > 0);
  let moved = 0; for (let i = 0; i < r0.data.length; i += 4) if (Math.abs(r0.data[i] - rp.data[i]) > 2000) moved++;
  const cen = Math.abs(lum(at(rp, 150, 100)) - lum(at(r0, 150, 100)));
  check(opaque(rp) && opaque(rn) && moved > W * H * 0.05 && cen < 300, `distortion ±80 bends the image (${(moved / (W * H) * 100).toFixed(0)} % of pixels change) but the centre stays put and every corner and edge is still filled`);
  check(R.cleanSettings({ distortion: 400 }).distortion === 100 && R.cleanSettings({ distortion: -7 }).distortion === -7 && R.DEFAULT_SETTINGS.distortion === 0, 'distortion is part of the settings (−100..100, default 0)');
  const prof = [{ focal: 24, k: 40 }, { focal: 70, k: -20 }];
  check(R.profileDistortion(prof, 24) === 40 && R.profileDistortion(prof, 47) === 10 && R.profileDistortion(prof, 10) === 40 && R.profileDistortion(prof, 200) === -20 && R.profileDistortion(prof, NaN) === 40 && R.profileDistortion([], 30) === null && R.profileDistortion([{ focal: 0, k: 12 }], 35) === 12,
    'user lens profiles: saved focal lengths are used as they are, interpolated in between, clamped outside; no profile → null');
}
{ // defringe eyedropper + mask
  const W = 60, H = 30, px = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set([...(x < 20 ? [60000, 60000, 60000] : x < 22 ? [42000, 12000, 52000] : x < 40 ? [3000, 3000, 3000] : x < 42 ? [14000, 40000, 16000] : [3000, 3000, 3000]), 65535], (y * W + x) * 4);
  const p = R.pickFringe(px, W, H, 19, 15, 3), g = R.pickFringe(px, W, H, 40, 15, 2), n = R.pickFringe(px, W, H, 30, 15, 2);
  const red = new Uint16Array(4 * 9).fill(0); for (let i = 0; i < 9; i++) red.set([50000, 8000, 6000, 65535], i * 4);
  const rr = R.pickFringe(red, 3, 3, 1, 1, 1);
  check(p.kind === 'purple' && p.lo <= p.hue && p.hi >= p.hue && p.hi - p.lo >= 10 && p.lo >= 200 && g.kind === 'green' && g.lo >= 40 && g.hi <= 190 && n.kind === null && n.why === 'neutral' && rr.kind === null && rr.why === 'hue',
    `eyedropper: picks the most saturated pixel nearby — purple ${p.hue}° → range ${p.lo}–${p.hi}°, green ${g.hue}° → ${g.lo}–${g.hi}°; grey → “neutral”, red → “not a fringe hue”`);
  const m = px.slice(); R.defringe(m, W, H, { ...R.DEFAULT_SETTINGS, fringePurple: 100, fringeMask: true });
  const v = (x) => m[(15 * W + x) * 4];
  check(v(5) === 65535 && v(30) === 65535 && v(20) < 30000 && m[(15 * W + 20) * 4 + 1] < v(20) && v(40) === 65535, `affected-areas mask: white where nothing changes, dark (with a tint) on the purple fringe (${v(20)}), green fringe untouched when only purple is on`);
  const m0 = px.slice(); R.defringe(m0, W, H, { ...R.DEFAULT_SETTINGS, fringeMask: true });
  check(m0.every((x, i) => (i % 4 === 3 ? x === 65535 : x === 65535)), 'with both amounts at 0 the mask is all white (nothing would change)');
}
{ // affine resampling
  const W = 7, H = 5, src = new Uint16Array(W * H * 4); for (let i = 0; i < W * H; i++) src.set([i * 100, i * 7, 65535 - i, 65535], i * 4);
  const cw = { a: 0, b: -1, c: 1, d: 0, e: 0, f: H }; // rotateMap('cw', W, H): new (H × W) → old
  const r = R.resampleAffine(src, W, H, cw, H, W);
  let ok = true; for (let y = 0; y < W; y++) for (let x = 0; x < H; x++) { const ox = y, oy = H - 1 - x; for (let c = 0; c < 4; c++) if (r[(y * H + x) * 4 + c] !== src[(oy * W + ox) * 4 + c]) ok = false; }
  check(ok, 'quarter turns are resampled exactly (every pixel copied, no interpolation)');
  const big = new Uint16Array(64 * 64 * 4); for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) big.set([x * 1000, y * 1000, 30000, 65535], (y * 64 + x) * 4);
  const half = R.resampleAffine(big, 64, 64, { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }, 32, 32), v = half[(10 * 32 + 10) * 4];
  check(Math.abs(v - 20500) <= 600 && half[3] === 65535, `a 50 % map averages (box pre-shrink + bilinear): pixel 10 → ${v} (expected ≈ 20500)`);
  const off = R.resampleAffine(big, 64, 64, { a: 1, b: 0, c: 0, d: 1, e: 60, f: 0 }, 10, 4);
  check(off[3] === 65535 && off[(0 * 10 + 9) * 4 + 3] === 0, 'pixels that map outside the developed image are transparent');
  const t1 = { a: 0, b: -1, c: 1, d: 0, e: 0, f: 5 }, t2 = { a: 2, b: 0, c: 0, d: 2, e: 3, f: 1 }, M = R.affineCompose(t1, t2);
  const ap = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f], q = ap(t1, ...ap(t2, 1.5, 2.5)), q2 = ap(M, 1.5, 2.5);
  check(Math.abs(q[0] - q2[0]) < 1e-12 && Math.abs(q[1] - q2[1]) < 1e-12 && JSON.stringify(R.affineCompose(t1, R.affineIdentity())) === JSON.stringify(t1), 'affineCompose(m, t) applies t first, then m; identity is neutral');
}

// ---------------------------------------------------------------------------------------------------------
// 2. Browser
// ---------------------------------------------------------------------------------------------------------
const server = createStaticServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const tmp = 'test-assets/.v14'; mkdirSync(tmp, { recursive: true });
const plainFile = `${tmp}/plain.dng`, fringeFile = `${tmp}/fringe.dng`;
writeFileSync(plainFile, makeDNG({ W: 480, H: 320, lens: false, scene: (x, y) => [0.15 + 0.6 * x / 480, 0.3 + 0.2 * Math.sin(y / 25), 0.12 + 0.5 * y / 320] }));
const fringeScene = (x, y) => {
  if (x < 480) { const u = x % 120, v = y % 120; if (u >= 30 && u < 90 && v >= 30 && v < 90) return [0.85, 0.85, 0.85]; if (u >= 26 && u < 94 && v >= 26 && v < 94) return [0.45, 0.06, 0.6]; }
  return [0.03, 0.03, 0.03];
};
writeFileSync(fringeFile, makeDNG({ W: 900, H: 600, lens: false, scene: fringeScene }));

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => localStorage.setItem('tintwork.engine', 'cpu'));
const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(async () => { await window.tintwork.clearAutosave?.(); for (const k of ['tintwork.rawPresets', 'tintwork.rawLast', 'tintwork.lensProfiles', 'tintwork.rawLink']) localStorage.removeItem(k); });
const settle = () => page.evaluate(async () => { await window.tintwork.idle(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
const waitPreview = (n) => page.waitForFunction((n) => { const u = window.tintwork.rawUI; return u && u.previews >= n && u.idle; }, n, { timeout: 30000 });
const previews = () => page.evaluate(() => window.tintwork.rawUI.previews);
const setSlider = (k, v) => page.evaluate(([k, v]) => { const el = document.querySelector(`#modal [data-k=${k}]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, [k, v]);
const prev = (fx, fy) => page.evaluate(([fx, fy]) => { const c = document.querySelector('#rawCanvas'), d = c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data; return [d[0], d[1], d[2]]; }, [fx, fy]);
const L = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'v14in'; i.hidden = true; document.body.append(i); });
const openDialog = async (f) => { await page.evaluate(() => { document.querySelector('#v14in').value = ''; }); await page.setInputFiles('#v14in', f);
  await page.evaluate(() => { window.tintwork.openRAW(document.querySelector('#v14in').files[0], true); }); await waitPreview(1); };
const layerInfo = () => page.evaluate(() => { const l = window.tintwork.activeLayer(); return { w: l.canvas.width, h: l.canvas.height, raw: l.raw && { m: l.raw.m, cw: l.raw.cw, ch: l.raw.ch, same: l.raw.rev === l.rev, link: l.raw.link || null, file: !!l.raw.file, settings: l.raw.settings, untracked: l.raw.untracked || null } }; });
const pixels = () => page.evaluate(() => { const c = window.tintwork.activeLayer().canvas; return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data); });
const cmp = (a, b) => { if (!a || !b || a.length !== b.length) return { max: Infinity, mean: Infinity, n: 0 }; let m = 0, s = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) { if (a[i + 3] < 255 || b[i + 3] < 255) { if ((a[i + 3] > 0) !== (b[i + 3] > 0) && Math.min(a[i + 3], b[i + 3]) === 0 && Math.max(a[i + 3], b[i + 3]) === 255) { m = Math.max(m, 255); } continue; } for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); m = Math.max(m, d); s += d; } n++; }
  return { max: m, mean: s / (3 * n || 1), n }; };
const redevelop = async () => { await page.evaluate(() => { window.tintwork.redevelopRaw(); }); await page.waitForFunction(() => window.tintwork.rawUI?.redevelop && window.tintwork.rawUI.previews >= 1 && window.tintwork.rawUI.idle, null, { timeout: 30000 }); };
const apply = async () => { const n = await page.evaluate(() => window.tintwork.history.index); await page.click('#modalOk');
  await page.waitForFunction((n) => window.tintwork.history.index > n && window.tintwork.history.entries[window.tintwork.history.index].label === 'Re-develop RAW' && !window.tintwork.rawUI, n, { timeout: 30000 }); await settle(); };
const develop = async () => { await page.click('#modalOk'); await page.waitForFunction(() => !window.tintwork.rawUI && !document.querySelector('.dev-overlay') && window.tintwork.activeLayer()?.raw, null, { timeout: 30000 }); await settle(); };

// --- develop dialog: distortion + grid + lens profile ---------------------------------------------------------
{
  await openDialog(plainFile);
  const ui0 = await page.evaluate(() => ({ dist: !!document.querySelector('#modal [data-k=distortion]'), grid: !!document.querySelector('#rawGrid'), key: window.tintwork.rawUI.lensKey, save: !document.querySelector('#rawLensSave').disabled, store: document.querySelector('#rawStore')?.value, linkOff: document.querySelector('#rawStore option[value=link]')?.disabled }));
  check(ui0.dist && ui0.grid && ui0.key && ui0.save && ui0.store === 'embed' && ui0.linkOff, `dialog: Distortion slider, grid and “Save for this lens” (lens: “${ui0.key}”); RAW file is embedded by default, linking is off for a file without a handle`);
  const clear = await page.evaluate(() => { const o = window.tintwork.rawUI.overlay(), d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  await page.keyboard.press('g'); await page.waitForTimeout(50);
  const grid = await page.evaluate(() => { const o = window.tintwork.rawUI.overlay(), d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return { n, on: window.tintwork.rawUI.showGrid, box: document.querySelector('#rawGrid').checked, size: [o.width, o.height], cv: [document.querySelector('#rawCanvas').clientWidth, document.querySelector('#rawCanvas').clientHeight] }; });
  check(clear === 0 && grid.on && grid.box && grid.n > 1000 && Math.abs(grid.size[0] - grid.cv[0]) <= 2, `G shows a grid over the preview to line up straight edges (${grid.n} grid pixels on a ${grid.size.join('×')} overlay)`);
  const snap = () => page.evaluate(() => { const c = document.querySelector('#rawCanvas'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data); });
  const e0 = await snap(), n0 = await previews();
  await setSlider('distortion', 70); await waitPreview(n0 + 1);
  const e1 = await snap(); let ch = 0; for (let i = 0; i < e0.length; i += 4) if (Math.abs(e0[i + 1] - e1[i + 1]) > 6) ch++;
  check(ch > e0.length / 4 * 0.05, `moving Distortion re-draws the preview (${(ch / (e0.length / 4) * 100).toFixed(0)} % of preview pixels move)`);
  await page.click('#rawLensSave');
  const prof = await page.evaluate(() => JSON.parse(localStorage.getItem('tintwork.lensProfiles') || '{}'));
  const k = Object.keys(prof)[0];
  check(k === ui0.key && prof[k][0].k === 70, `“Save for this lens” stores the distortion as the user's own lens profile (${JSON.stringify(prof)})`);
  await page.click('#modalCancel'); await page.waitForTimeout(150);
  await openDialog(plainFile);
  const re = await page.evaluate(() => ({ v: +document.querySelector('#modal [data-k=distortion]').value, p: window.tintwork.rawUI.lensFromProfile, note: document.querySelector('#rawLensProf').textContent }));
  check(re.v === 70 && re.p && /profile/.test(re.note), `the next photo from that lens opens with the saved distortion (${re.v}; “${re.note}”)`);
  await page.click('#modalCancel'); await page.waitForTimeout(150);
  const batch = await page.evaluate(async () => { const t = window.tintwork; await t.openRAW(document.querySelector('#v14in').files[0], false, { ...t.RAW_DEFAULTS }); const r = { k: t.activeLayer().raw.settings.distortion, lp: t.lastImport.lensProfile }; await t.closeTab(undefined, { force: true }); return r; });
  check(batch.k === 70 && batch.lp === 70, 'batch / non-interactive opens apply the lens profile too');
  await page.evaluate(() => window.tintwork.forgetLensProfile(window.tintwork.lensProfiles && Object.keys(window.tintwork.lensProfiles())[0]));
}
// --- defringe eyedropper + mask ---------------------------------------------------------------------------------
{
  await openDialog(fringeFile);
  await page.click('#rawFringePick');
  const on = await page.evaluate(() => ({ p: window.tintwork.rawUI.picking, cur: getComputedStyle(window.tintwork.rawUI.overlay()).cursor }));
  const box = await page.evaluate(() => { const r = window.tintwork.rawUI.overlay().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const n0 = await previews();
  await page.mouse.click(box.x + box.w * (27.5 / 900), box.y + box.h * (60 / 600));
  await page.waitForFunction(() => window.tintwork.rawUI.lastPick, null, { timeout: 10000 }); await waitPreview(n0 + 1);
  const pk = await page.evaluate(() => { const u = window.tintwork.rawUI; return { pick: u.lastPick, s: { a: u.settings.fringePurple, lo: u.settings.fringePurpleLo, hi: u.settings.fringePurpleHi }, picking: u.picking }; });
  check(on.p && on.cur === 'crosshair' && pk.pick.kind === 'purple' && pk.s.lo === pk.pick.lo && pk.s.hi === pk.pick.hi && pk.s.a === 50 && !pk.picking,
    `defringe eyedropper: clicking a purple rim picks its hue (${pk.pick.hue}°) and sets the purple range to ${pk.s.lo}–${pk.s.hi}° (amount 50)`);
  await page.click('#rawFringePick'); await page.mouse.click(box.x + box.w * 0.8, box.y + box.h * 0.5);
  await page.waitForFunction(() => window.tintwork.rawUI.lastPick?.kind === null, null, { timeout: 10000 });
  const neutral = await page.evaluate(() => ({ why: window.tintwork.rawUI.lastPick.why, toast: document.body.innerText.includes('too neutral') }));
  check(neutral.why === 'neutral' && neutral.toast, 'a neutral spot is refused with a hint (“too neutral to be a fringe”)');
  const n1 = await previews(); await page.check('#rawFringeMask'); await waitPreview(n1 + 1);
  const mask = await page.evaluate(() => { const c = document.querySelector('#rawCanvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let white = 0, dark = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 250 && d[i + 1] > 250) white++; else if (d[i] < 180) dark++; } return { white: white / (d.length / 4), dark }; });
  check(mask.white > 0.8 && mask.dark > 50, `“Show affected areas” turns the preview into a mask: ${(mask.white * 100).toFixed(0)} % white (untouched), ${mask.dark} dark pixels along the purple rims`);
  await page.waitForTimeout(100); await page.evaluate(() => document.querySelector('#toast')?.remove()); await page.screenshot({ path: 'screenshots/14x-raw-defringe-mask.png' });
  const n2 = await previews(); await page.uncheck('#rawFringeMask'); await waitPreview(n2 + 1);
  const st = await page.evaluate(() => window.tintwork.rawUI.settings.fringeMask);
  check(!st, 'the mask is a view only: it is never saved in the settings');
  await page.click('#modalCancel'); await page.waitForTimeout(150);
}
// --- local adjustments ------------------------------------------------------------------------------------------
{
  await openDialog(plainFile);
  const c0 = await prev(0.5, 0.5), t0 = await prev(0.5, 0.03), b0 = await prev(0.5, 0.97);
  let n = await previews(); await page.click('#rawAddRadial'); await waitPreview(n + 1);
  const c1 = await prev(0.5, 0.5), k1 = await prev(0.03, 0.97);
  n = await previews(); await page.click('#rawAddLinear'); await waitPreview(n + 1);
  const t1 = await prev(0.5, 0.03), b1 = await prev(0.5, 0.97);
  const st = await page.evaluate(() => ({ list: window.tintwork.rawUI.settings.local, sel: window.tintwork.rawUI.localSel, opts: document.querySelector('#rawLocalSel').options.length }));
  check(st.list?.length === 2 && st.list[0].type === 'radial' && st.list[1].type === 'linear' && st.sel === 1 && st.opts === 3 && L(c1) > L(c0) + 5 && Math.abs(L(k1) - L(await prev(0.03, 0.97))) < 1 && L(t1) < L(t0) - 5 && Math.abs(L(b1) - L(b0)) < 2,
    `+ Radial brightens the centre (luma ${L(c0).toFixed(0)} → ${L(c1).toFixed(0)}); + Graduated darkens the top (${L(t0).toFixed(0)} → ${L(t1).toFixed(0)}) and leaves the bottom (${L(b0).toFixed(0)} → ${L(b1).toFixed(0)})`);
  // drag the radial filter's centre with the mouse
  await page.evaluate(() => window.tintwork.rawUI.selectLocal(0));
  const box = await page.evaluate(() => { const r = window.tintwork.rawUI.overlay().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  n = await previews();
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5); await page.mouse.down(); await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.55, { steps: 5 }); await page.mouse.move(box.x + box.w * 0.7, box.y + box.h * 0.6, { steps: 5 }); await page.mouse.up();
  await waitPreview(n + 1);
  const moved = await page.evaluate(() => window.tintwork.rawUI.settings.local[0]);
  check(Math.abs(moved.cx - 0.7) < 0.02 && Math.abs(moved.cy - 0.6) < 0.02, `dragging the radial filter moves it (centre ${moved.cx.toFixed(2)}, ${moved.cy.toFixed(2)})`);
  // the sliders edit the selected one
  n = await previews();
  await page.evaluate(() => { const el = document.querySelector('#modal [data-l=temp]'); el.value = 80; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await waitPreview(n + 1);
  const warm = await prev(0.7, 0.6);
  check((await page.evaluate(() => window.tintwork.rawUI.settings.local[0].temp)) === 80 && warm[0] > warm[2], `the Temperature slider changes the selected local adjustment (temp 80 → R ${warm[0]} > B ${warm[2]})`);
  await page.evaluate(() => window.tintwork.rawUI.setLocal(0, { invert: true }));
  await page.waitForTimeout(80); await waitPreview(n + 2);
  await page.keyboard.press('g'); await page.waitForTimeout(100);
  await page.evaluate(() => window.tintwork.rawUI.selectLocal(1)); await page.waitForTimeout(80);
  await page.evaluate(() => document.querySelector('#toast')?.remove()); await page.screenshot({ path: 'screenshots/14x-raw-local-adjustments.png' });
  await page.keyboard.press('g');
  n = await previews(); await page.keyboard.press('Delete'); await waitPreview(n + 1);
  const left = await page.evaluate(() => window.tintwork.rawUI.settings.local);
  check(left.length === 1 && left[0].type === 'radial' && left[0].invert, 'Delete removes the selected local adjustment');
  await develop();
  const li = await layerInfo();
  check(li.raw.settings.local?.length === 1 && li.raw.settings.local[0].temp === 80, 'the local adjustments are kept in the layer\'s develop settings (re-developing reopens them)');
  await page.evaluate(() => window.tintwork.closeTab(undefined, { force: true }));
}
// --- re-develop after rotate / flip / resize / free transform -------------------------------------------------
{
  await openDialog(plainFile); await develop();
  const steps = [
    ['rotate 90° clockwise', () => window.tintwork.transformDoc('cw', 'Rotate 90° clockwise'), 1],
    ['flip horizontal', () => window.tintwork.transformDoc('fh', 'Flip horizontal'), 1],
    ['image resize to 50 %', () => { const d = window.tintwork.state.doc; window.tintwork.resizeImage(Math.round(d.width / 2), Math.round(d.height / 2)); }, 0],
    ['free transform (rotate 12°, scale 80 %)', () => { const t = window.tintwork; t.startTransform(); const x = t.xf; x.rot = 12 * Math.PI / 180; x.sx = 0.8; x.sy = 0.8; t.previewTransform?.(); t.applyTransform(); }, 0],
  ];
  for (const [name, fn, exact] of steps) {
    await page.evaluate(fn); await settle();
    const A = await layerInfo(), P0 = await pixels();
    await redevelop(); await apply();
    const B = await layerInfo(), P1 = await pixels(), d = cmp(P0, P1);
    const good = exact ? d.max <= 1 : d.mean < 3 && d.n > 1000;
    check(A.raw.same && B.w === A.w && B.h === A.h && good && B.raw.same, `re-develop after ${name}: the fresh develop lands exactly where the layer is (${B.w}×${B.h}; ${d.n} pixels, max diff ${d.max}, mean ${d.mean.toFixed(2)})`);
  }
  // change a setting after the transforms: the layer updates in place
  const P0 = await pixels(); await redevelop(); await setSlider('exposure', 1); await waitPreview(2); await apply();
  const P1 = await pixels(), m0 = P0.reduce((s, v, i) => (i % 4 === 3 ? s : s + v), 0), m1 = P1.reduce((s, v, i) => (i % 4 === 3 ? s : s + v), 0);
  check(m1 > m0 * 1.2 && P1.length === P0.length, `a new exposure re-develops the rotated, flipped, resized and transformed layer in place (brightness × ${(m1 / m0).toFixed(2)})`);
  const lab = await page.evaluate(() => window.tintwork.lastImport.xformMs);
  check(Number.isFinite(lab), `the resample into the layer runs in the develop worker (${lab} ms)`);
  // a transform of selected pixels cannot be followed
  await page.evaluate(async () => { const t = window.tintwork, d = t.state.doc, S = await import('/src/selection.js'); t.setSelection(S.makeSelection(d.width, d.height, S.rectMask(d.width, d.height, { x: 40, y: 40, w: 60, h: 60 })), 'Rectangle select'); });
  const hasSel = await page.evaluate(() => !!window.tintwork.state.doc.selection);
  if (hasSel) {
    await page.evaluate(() => { const t = window.tintwork; t.startTransform(); t.xf.rot = 0.3; t.previewTransform?.(); t.applyTransform(); }); await settle();
    await page.evaluate(() => { window.tintwork.redevelopRaw(); }); await page.waitForTimeout(300);
    const msg = await page.evaluate(() => ({ ui: !!window.tintwork.rawUI, text: document.body.innerText }));
    check(!msg.ui && /selected pixels/.test(msg.text), 'after transforming selected pixels, re-develop explains that it cannot follow the change');
  } else console.log('skip: no selectRect hook');
  await page.evaluate(() => window.tintwork.closeTab(undefined, { force: true }));
}
// --- linked RAW (File System Access handles; OPFS handles stand in for files on disk) --------------------------
{
  const url = `data:application/octet-stream;base64,${readFileSync(plainFile).toString('base64')}`;
  await page.evaluate(async (url) => { const root = await navigator.storage.getDirectory(), b = await (await fetch(url)).blob(); for (const dir of [root, await root.getDirectoryHandle('moved', { create: true })]) { const h = await dir.getFileHandle('plain.dng', { create: true }), w = await h.createWritable(); await w.write(b); await w.close(); } }, url);
  await page.evaluate(async () => { const h = await (await navigator.storage.getDirectory()).getFileHandle('plain.dng'); window.tintwork.openHandle(h, { remember: false }); });
  await waitPreview(1);
  const st0 = await page.evaluate(() => ({ dis: document.querySelector('#rawStore option[value=link]').disabled, v: document.querySelector('#rawStore').value }));
  await page.selectOption('#rawStore', 'link');
  await develop();
  const li = await layerInfo(), title = await page.getAttribute('#layerList li .thumb', 'title');
  check(!st0.dis && st0.v === 'embed' && li.raw.link?.name === 'plain.dng' && li.raw.link.size > 100000 && !li.raw.file && /linked/.test(title), `a RAW file opened from disk can be linked instead of embedded (embed stays the default; layer: “${title}”)`);
  check(await page.evaluate(() => localStorage.getItem('tintwork.rawLink')) === '1', 'the choice is remembered for the next RAW file');
  const proj = await page.evaluate(async () => { const d = await window.tintwork.projectData(); const r = d.layers[0].raw; return { v: d.version, json: JSON.stringify(d), link: r.link, data: !!r.data, len: JSON.stringify(d).length }; });
  check(proj.v === 8 && proj.link?.id && !proj.data && proj.len < 400000, `project files (version 8) store only the link (${proj.len} bytes, no copy of the RAW file)`);
  const P0 = await pixels(); await redevelop(); await setSlider('exposure', 0.5); await waitPreview(2); await apply(); const P1 = await pixels();
  check(cmp(P0, P1).mean > 5, 're-develop reads the linked file through its handle');
  // reopen the project after the in-memory handles are forgotten: the handle comes back from IndexedDB
  await page.evaluate(async (json) => { window.tintwork.forgetLinkHandles(); await window.tintwork.loadProject(JSON.parse(json), 'linked.tintwork'); }, proj.json); await settle();
  await redevelop(); const ok1 = await page.evaluate(() => !!window.tintwork.rawUI); await page.click('#modalCancel'); await page.waitForTimeout(150);
  check(ok1 && (await page.evaluate(() => window.tintwork.lastRelink.count)) === 0, 'a reopened project finds its linked file again (handle kept in the browser\'s storage)');
  // the file is moved: relink prompt → locate
  await page.evaluate(async () => { await (await navigator.storage.getDirectory()).removeEntry('plain.dng'); window.tintwork.setRelinkPicker(async () => (await (await navigator.storage.getDirectory()).getDirectoryHandle('moved')).getFileHandle('plain.dng')); });
  await page.evaluate(() => { window.tintwork.redevelopRaw(); });
  await page.waitForFunction(() => window.tintwork.lastRelink.open, null, { timeout: 10000 });
  const pr = await page.evaluate(() => ({ title: document.querySelector('#modalTitle').textContent, body: document.querySelector('#modalBody').textContent, ok: document.querySelector('#modalOk').textContent, r: window.tintwork.lastRelink }));
  await page.screenshot({ path: `${tmp}/relink.png` });
  check(/not found/.test(pr.title) && /plain\.dng/.test(pr.body) && /moved, renamed or deleted/.test(pr.body) && /Locate/.test(pr.ok) && pr.r.why === 'moved', `a moved or deleted linked file opens a clear relink prompt (“${pr.title}”: ${pr.body.trim().slice(0, 90)}…)`);
  await page.click('#modalOk');
  await page.waitForFunction(() => window.tintwork.rawUI?.redevelop && window.tintwork.rawUI.idle, null, { timeout: 30000 });
  await page.click('#modalCancel'); await page.waitForTimeout(150);
  await redevelop(); await page.click('#modalCancel'); await page.waitForTimeout(150);
  check((await page.evaluate(() => window.tintwork.lastRelink.count)) === 1, 'Locate file… points the link at the chosen file; the next re-develop uses it without asking');
  // cancelling the prompt leaves the layer alone
  await page.evaluate(async () => { await (await (await navigator.storage.getDirectory()).getDirectoryHandle('moved')).removeEntry('plain.dng'); window.tintwork.setRelinkPicker(async () => null); });
  const before = await pixels();
  await page.evaluate(() => { window.tintwork.redevelopRaw(); }); await page.waitForFunction(() => window.tintwork.lastRelink.open, null, { timeout: 10000 });
  await page.click('#modalCancel'); await page.waitForTimeout(250);
  check(!(await page.evaluate(() => window.tintwork.rawUI)) && cmp(before, await pixels()).max === 0 && !(await page.evaluate(() => window.tintwork.lastRelink.open)), 'Cancel on the relink prompt keeps the layer as it is');
  // embed: put a file back and copy it into the project
  await page.evaluate(async (url) => { const root = await navigator.storage.getDirectory(), b = await (await fetch(url)).blob(), h = await root.getFileHandle('plain.dng', { create: true }), w = await h.createWritable(); await w.write(b); await w.close(); window.tintwork.setRelinkPicker(async () => root.getFileHandle('plain.dng')); }, url);
  const emb = page.evaluate(() => window.tintwork.embedLinkedRaw());
  await page.waitForFunction(() => window.tintwork.lastRelink.open, null, { timeout: 10000 }); await page.click('#modalOk');
  const done = await emb, after = await layerInfo(), p2 = await page.evaluate(async () => { const r = (await window.tintwork.projectData()).layers[0].raw; return { data: !!r.data, link: !!r.link }; });
  check(done && after.raw.file && !after.raw.link && after.raw.same && p2.data && !p2.link, 'Layer ▸ Embed linked RAW file copies the file into the project (no link left)');
  await page.evaluate(() => window.tintwork.setRelinkPicker(null));
}
const ui = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('[title]')].map((e) => e.title).join(' '));
check(!/photoshop|adobe/i.test(ui), 'no product names of other editors in the UI');
check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close(); server.close();
console.log(fails ? `${fails} of ${count} v1.4 check(s) FAILED (${((Date.now() - T0) / 1000).toFixed(0)} s)` : `All ${count} v1.4 checks passed (${((Date.now() - T0) / 1000).toFixed(0)} s)`);
process.exit(fails ? 1 : 0);
