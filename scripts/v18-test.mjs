// v1.8 test: the non-AI gaps closed after the v1.7 workflow benchmark (docs/WORKFLOW_BENCHMARK.md, docs/AUDIT.md).
//  - segment.js units: graph cut, GrabCut, geodesic (edge-aware) strokes, line detection / vanishing point,
//    largest inner rectangle, push-pull fill
//  - Object select tool on REAL public-domain / CC0 photos with published cut-outs (test-assets/real/)
//  - Image › Auto upright (keystone and rotate), crop / fill / keep the empty edges, Crop › Fit inside image
//  - saved export presets, Export with last preset, watermark on single / multi-size / batch export (8- and 16-bit)
//  - exact 8-bit Exclusion blend (the browser's canvas was up to 1.76 levels off the W3C formula)
// TW_ROOT=/path/to/other/checkout runs the same checks against another tree (used to confirm they fail on v1.7.0).
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f)); // the photos live in this tree (also for TW_ROOT runs)
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

// ---------------------------------------------------------------- 1. segment.js units (node)
let seg = null;
try { seg = await import(pathToFileURL(path.join(ROOT, 'src/segment.js')).href); } catch { /* v1.7 has none */ }
check(!!seg, 'src/segment.js exists (non-learning segmentation and line tools)');
if (seg) {
  // a noisy disc on a noisy, differently coloured background
  const W = 120, H = 100, img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }; let rnd = 7; const R = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5) * 40;
  const inDisc = (x, y) => (x - 60) ** 2 + (y - 50) ** 2 < 28 ** 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, f = inDisc(x, y); img.data.set([(f ? 200 : 60) + R(), (f ? 80 : 120) + R(), (f ? 60 : 170) + R(), 255], i); }
  const iou = (a, thr = 128) => { let I = 0, U = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const g = inDisc(x, y), b = a[y * W + x] >= thr; if (g && b) I++; if (g || b) U++; } return I / U; };
  const gc = seg.grabCut(img, { x: 20, y: 12, w: 80, h: 76 }), gm = gc.mask.map((v) => v * 255);
  check(iou(gm) > 0.95, `GrabCut separates a noisy disc from its box (IoU ${iou(gm).toFixed(3)})`);
  const os = seg.objectSelect(img, { x: 20, y: 12, w: 80, h: 76 });
  check(iou(os.alpha) > 0.95, `objectSelect (with the edge refine) keeps it (IoU ${iou(os.alpha).toFixed(3)})`);
  // max-flow on a 2-pixel graph: the cheaper side wins
  const cut = seg.gridMinCut(2, 1, new Float64Array(16).fill(0.1), new Float64Array([5, 0]), new Float64Array([0, 5]));
  check(cut[0] === 1 && cut[1] === 0, `grid min cut labels a 2-pixel graph by its terminal costs (${[...cut]})`);
  // geodesic distance: a strong edge costs more than the same length inside a flat region
  if (seg.geodesicDistance) {
    const g = { width: 40, height: 10, data: new Uint8ClampedArray(400 * 4) }; for (let i = 0; i < 400; i++) { const x = i % 40; g.data.set(x < 20 ? [50, 50, 50, 255] : [220, 220, 220, 255], i * 4); }
    const s = new Uint8Array(400); s[5 * 40 + 2] = 1; const D = seg.geodesicDistance(g, s);
    check(D[5 * 40 + 18] < 60 && D[5 * 40 + 22] > 150, `geodesic distance stops at an edge (16 px flat: ${D[5 * 40 + 18].toFixed(0)}, across the edge: ${D[5 * 40 + 22].toFixed(0)})`);
  } else check(false, 'geodesicDistance (edge-aware strokes) exists');
  // lines converging to a vanishing point above the frame
  const L = { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).fill(255) }, vp = [200, -1500];
  for (const x0 of [60, 120, 280, 340]) for (let y = 0; y < 300; y++) { const x = Math.round(x0 + (vp[0] - x0) * (300 - y) / (300 - vp[1])); for (let k = 0; k < 3; k++) L.data.set([0, 0, 0, 255], (y * 400 + x + k) * 4); }
  const lines = seg.detectLines(L, { orient: 'v' }), u = seg.estimateUpright(lines, 400, 300);
  const err = u.vp ? Math.abs(u.vp[1] - vp[1]) / Math.abs(vp[1]) : 1;
  check(u.mode === 'keystone' && err < 0.08 && Math.abs(u.vp[0] - 200) < 12, `vanishing point from 4 converging lines: ${u.mode} at ${u.vp?.map(Math.round)} (true 200,−1500; ${(err * 100).toFixed(1)}% off)`);
  // parallel tilted lines → a plain rotation
  const T = { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).fill(255) }, tan = Math.tan(3 * Math.PI / 180);
  for (const x0 of [80, 200, 320]) for (let y = 0; y < 300; y++) { const x = Math.round(x0 + (y - 150) * tan); for (let k = 0; k < 3; k++) T.data.set([0, 0, 0, 255], (y * 400 + x + k) * 4); }
  const ur = seg.estimateUpright(seg.detectLines(T, { orient: 'v' }), 400, 300);
  check(ur.mode === 'rotate' && Math.abs(Math.abs(ur.angle) - 3) < 0.4, `parallel lines tilted 3° read as a rotation (${ur.mode}, ${ur.angle?.toFixed(2)}°)`);
  // largest inner rectangle of a rotated square's alpha
  const A = new Uint8Array(100 * 100); for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) A[y * 100 + x] = Math.abs(x - 50) + Math.abs(y - 50) < 50 ? 255 : 0;
  const r = seg.largestInnerRect(A, 100, 100, { ratio: 1 }); let clean = !!r; if (r) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (A[y * 100 + x] < 250) clean = false;
  check(clean && r.w >= 46 && Math.abs(r.w - r.h) <= 1, `largest square inside a diamond: ${r?.w}×${r?.h}, no empty pixel inside (ideal 50×50)`);
  // push-pull fill leaves no hole and keeps the known pixels
  const F = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) }; for (let i = 0; i < 1024; i++) if (i % 32 > 8) F.data.set([100, 150, 200, 255], i * 4);
  const ff = seg.pushPullFill(F); let holes = 0, kept = true; for (let i = 0; i < 1024; i++) { if (ff.data[i * 4 + 3] < 255) holes++; if (i % 32 > 8 && ff.data[i * 4] !== 100) kept = false; }
  check(!holes && kept && Math.abs(ff.data[0] - 100) < 3, `push-pull fill: ${holes} holes left, known pixels kept ${kept}, filled colour ${ff.data[0]},${ff.data[1]},${ff.data[2]}`);
}

// ---------------------------------------------------------------- 2. the app
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`; // TW_URL: check a deployed site (unit tests still use this tree)
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  const W = (window.__pick = { save: 0, lastSave: null });
  window.showSaveFilePicker = async (o) => { W.save++; W.lastSave = o.suggestedName; const root = await navigator.storage.getDirectory(); return root.getFileHandle(o.suggestedName, { create: true }); };
});
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));
const open = async (name, bytes) => { await page.setInputFiles('#fileInput', { name, mimeType: /png$/.test(name) ? 'image/png' : 'image/jpeg', buffer: bytes }); await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), name, { timeout: 30000 }); await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); }); };
const toScreen = (p) => page.evaluate(({ x, y }) => { const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state; return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom }; }, p);
const drag = async (a, b, mods = []) => { const s = await toScreen(a), e = await toScreen(b); for (const m of mods) await page.keyboard.down(m); await page.mouse.move(s.x, s.y); await page.mouse.down(); for (let k = 1; k <= 10; k++) await page.mouse.move(s.x + (e.x - s.x) * k / 10, s.y + (e.y - s.y) * k / 10); await page.mouse.up(); for (const m of mods) await page.keyboard.up(m); };
const iouWith = (gtName, rect) => T(async ({ gt, rect }) => {
  const t = window.tintwork, s = t.doc.selection, bm = await createImageBitmap(new Blob([new Uint8Array(gt)])); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0);
  const g = x.getImageData(0, 0, bm.width, bm.height).data, r = rect || { x: 0, y: 0, w: bm.width, h: bm.height }; let I = 0, U = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let xx = r.x; xx < r.x + r.w; xx++) { const i = y * bm.width + xx, a = g[i * 4] >= 128, b = s ? s.mask[i] >= 128 : false; if (a && b) I++; if (a || b) U++; }
  return U ? I / U : 0;
}, { gt: [...REAL(gtName)], rect });
const EVERS_RECT = { x: 300, y: 150, w: 1056, h: 1408 }; // the published cut-out touches 3 sides of the frame: score inside its frame

// --- 2a. Object select
const hasTool = await page.locator('#toolbar button[data-tool="objsel"]').count() > 0;
check(hasTool, 'toolbar has an Object select tool');
check(await T(() => [...document.querySelectorAll('#menus .menu-items button')].some((b) => b.dataset.cmd === 'objectSelectTool')), 'Select menu has “Object select”');
if (hasTool) {
  await open('evers-scene.jpg', REAL('evers-scene.jpg'));
  await page.keyboard.press('w'); await page.keyboard.press('w');
  check(await T(() => window.tintwork.state.tool) === 'objsel', `W twice cycles magic wand → object select (${await T(() => window.tintwork.state.tool)})`);
  const W = await T(() => window.tintwork.doc.width), H = await T(() => window.tintwork.doc.height);
  await drag({ x: 280, y: 225 }, { x: W - 1, y: H - 1 }); await T(() => window.tintwork.objSel.settled());
  const box = await iouWith('evers-gt.png', EVERS_RECT), st = await T(() => ({ on: !!window.tintwork.objSel.state, ms: window.tintwork.objSel.state?.ms, label: document.querySelector('#status').textContent }));
  check(box > 0.68 && st.on, `box only on a real photo: IoU ${box.toFixed(3)} vs the published cut-out (session open ${st.on}, ${st.ms} ms)`);
  check(await page.locator('#optionsbar [data-objpaint]').count() >= 3 && await page.locator('#optionsbar [data-cmd="objSelDone"]').count() === 1, 'options bar: Box / + Subject / − Background and Done');
  await drag({ x: 520, y: 1300 }, { x: 640, y: 1450 }, ['Shift']); await T(() => window.tintwork.objSel.settled());
  const one = await iouWith('evers-gt.png', EVERS_RECT);
  check(one > box + 0.1, `one Shift-stroke on the missed suit spreads along it (edge-aware): IoU ${box.toFixed(3)} → ${one.toFixed(3)}`);
  await drag({ x: 1180, y: 960 }, { x: 1230, y: 1010 }, ['Alt']); await T(() => window.tintwork.objSel.settled());
  const two = await iouWith('evers-gt.png', EVERS_RECT);
  check(two > 0.9, `plus one Alt-stroke on the person behind: IoU ${two.toFixed(3)} (> 0.9)`);
  await page.locator('#optionsbar [data-cmd="objSelUndo"]').click(); await T(() => window.tintwork.objSel.settled());
  const undone = await iouWith('evers-gt.png', EVERS_RECT);
  check(Math.abs(undone - one) < 0.01, `Undo stroke goes back to the one-stroke result (${undone.toFixed(3)} vs ${one.toFixed(3)})`);
  await page.keyboard.press('Enter');
  const kept = await T(() => ({ on: !!window.tintwork.objSel.state, sel: !!window.tintwork.doc.selection }));
  check(!kept.on && kept.sel, 'Enter keeps the selection and ends the session');
  // Esc restores the previous selection
  await T(() => window.tintwork.run('selectAll'));
  await drag({ x: 300, y: 300 }, { x: 900, y: 900 }); await T(() => window.tintwork.objSel.settled());
  await page.keyboard.press('Escape');
  const back = await T(() => { const s = window.tintwork.doc.selection; return s && s.w === window.tintwork.doc.width && s.h === window.tintwork.doc.height; });
  check(back, 'Esc cancels and restores the selection from before');
  // holdout photo (not used to tune anything): box only
  await open('macaque.jpg', REAL('macaque.jpg'));
  await page.click('#toolbar button[data-tool="objsel"]');
  const mh = await T(() => window.tintwork.doc.height);
  await drag({ x: 0, y: 240 }, { x: 940, y: mh - 1 }); await T(() => window.tintwork.objSel.settled()); await page.keyboard.press('Enter');
  const mac = await iouWith('macaque-gt.png', null);
  check(mac > 0.95, `holdout real photo (CC0 cut-out), box only: IoU ${mac.toFixed(3)}`);
  // Alt + drag with no session yet subtracts from the selection (selection modes still apply to the box)
  await T(() => window.tintwork.run('selectAll'));
  await drag({ x: 0, y: 240 }, { x: 940, y: mh - 1 }, ['Alt']); await T(() => window.tintwork.objSel.settled()); await page.keyboard.press('Enter');
  const sub = await T(() => { const s = window.tintwork.doc.selection; let n = 0; for (let i = 0; i < s.mask.length; i++) if (s.mask[i] >= 128) n++; return n / s.mask.length; });
  check(sub > 0.3 && sub < 0.6, `Alt-drag a box subtracts the subject from Select all (${(sub * 100).toFixed(0)}% left)`);
}

// --- 2b. Auto upright + empty edges
const hasAuto = await T(() => [...document.querySelectorAll('#menus .menu-items button')].some((b) => b.dataset.cmd === 'autoUpright'));
check(hasAuto, 'Image menu has “Auto upright”');
const building = (legacy = false) => T(async (legacy) => {
  const t = window.tintwork; t.newDocument(1200, 1200, 'white', 'building'); const l = t.activeLayer(), x = l.canvas.getContext('2d');
  x.fillStyle = '#a9c4dc'; x.fillRect(0, 0, 1200, 1200); x.fillStyle = '#b5a48f'; x.beginPath(); x.moveTo(400, 100); x.lineTo(800, 100); x.lineTo(950, 1150); x.lineTo(250, 1150); x.closePath(); x.fill();
  x.strokeStyle = '#4a3d30'; x.lineWidth = 8; x.stroke(); t.touch(l); t.markDirty(); t.renderNow(); await t.compositeSettled?.();
}, legacy);
const leftEdge = () => T(async () => { const t = window.tintwork; await t.idle(); await t.compositeSettled?.(); const c = t.compositeCanvas(), x = c.getContext('2d'); const at = (y) => { const d = x.getImageData(0, y, c.width, 1).data; for (let i = 0; i < c.width; i++) if (d[i * 4 + 3] > 200 && d[i * 4] < 110 && d[i * 4 + 1] < 100) return i; return -1; }; return { a: at(Math.round(c.height * 0.15)), b: at(Math.round(c.height * 0.85)), w: c.width, h: c.height }; });
const transparentCorners = () => T(async () => { const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) n++; return n; });
if (hasAuto) {
  await building();
  await T(() => window.tintwork.run('autoUpright'));
  const lu = await T(() => window.tintwork.lastUpright);
  check(lu?.mode === 'keystone' && lu.lines >= 2, `Auto upright finds the converging walls (${lu?.mode}, ${lu?.lines} lines of ${lu?.found})`);
  check(await page.locator('#optionsbar [data-cmd="uprightEdges_crop"]').count() === 1, 'options bar offers Crop edges / Fill edges / Keep');
  await page.keyboard.press('Enter'); await T(() => window.tintwork.idle());
  const e = await leftEdge(), holes = await transparentCorners();
  check(e.a > 0 && Math.abs(e.a - e.b) <= 6, `after Enter the left wall is vertical (x ${e.a} at 15%, ${e.b} at 85%)`);
  check(holes === 0 && e.w < 1200, `default “Crop edges”: no transparent pixel left, cropped to ${e.w}×${e.h}`);
  check(await T(() => window.tintwork.history?.entries?.at?.(-1)?.label || [...document.querySelectorAll('#historyList li')].at(-1)?.textContent || '') !== '', 'the correction is one undoable step');
  // Fill edges keeps the size and leaves no hole
  await building(); await page.locator('#menus .menu > button', { hasText: /^Image$/ }).click(); await page.locator('#menus .menu.open .menu-items button[data-cmd="autoUpright"]').click();
  await page.locator('#optionsbar [data-cmd="uprightEdges_fill"]').click(); await page.keyboard.press('Enter'); await T(() => window.tintwork.idle());
  const ef = await leftEdge(), hf = await transparentCorners();
  check(ef.w === 1200 && ef.h === 1200 && hf === 0, `“Fill edges”: size kept (${ef.w}×${ef.h}), ${hf} transparent pixels`);
  // Keep leaves the corners empty; Image › Crop away empty edges removes them afterwards
  await building(); await T(() => window.tintwork.run('autoUpright'));
  await page.locator('#optionsbar [data-cmd="uprightEdges_keep"]').click(); await page.keyboard.press('Enter'); await T(() => window.tintwork.idle());
  const hk = await transparentCorners();
  check(hk > 1000, `“Keep”: the empty corners stay (${hk} transparent pixels)`);
  await T(() => window.tintwork.run('cropEmptyEdges'));
  const hk2 = await transparentCorners(), ek = await leftEdge();
  check(hk2 === 0 && Math.abs(ek.w / ek.h - 1) < 0.01, `Image ▸ Crop away empty edges: ${hk2} transparent pixels, aspect kept (${ek.w}×${ek.h})`);
  // Crop tool: Fit inside image
  await building(); await T(() => window.tintwork.run('autoUpright')); await page.locator('#optionsbar [data-cmd="uprightEdges_keep"]').click(); await page.keyboard.press('Enter'); await T(() => window.tintwork.idle());
  await page.click('#toolbar button[data-tool="crop"]');
  const fit = page.locator('#optionsbar [data-cmd="cropFitInside"]');
  check(await fit.count() === 1, 'Crop options bar has “Fit inside image”');
  if (await fit.count()) {
    await fit.click(); const cr = await T(() => window.tintwork.state.crop), inner = await T(() => window.tintwork.innerOpaqueRect({ keepRatio: false }));
    check(cr && inner && cr.x >= inner.x - 2 && cr.y >= inner.y - 2 && cr.x + cr.w <= inner.x + inner.w + 2 && cr.y + cr.h <= inner.y + inner.h + 2, `the crop box sits inside the image (crop ${cr && [cr.x, cr.y, cr.w, cr.h].map(Math.round)}, opaque ${inner && [inner.x, inner.y, inner.w, inner.h]})`);
    await page.keyboard.press('Escape');
  }
  // rotate mode: parallel bars tilted 3° → a rotation the right way round
  await T(async () => {
    const t = window.tintwork; t.newDocument(1000, 800, 'white', 'tilt'); const l = t.activeLayer(), x = l.canvas.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 1000, 800); x.save(); x.translate(500, 400); x.rotate(3 * Math.PI / 180); x.fillStyle = '#111'; for (const bx of [-330, -110, 110, 330]) x.fillRect(bx, -600, 30, 1200); x.restore(); t.touch(l); t.markDirty(); t.renderNow(); await t.compositeSettled?.();
  });
  await T(() => window.tintwork.run('autoUpright')); const lr = await T(() => window.tintwork.lastUpright); await page.keyboard.press('Enter'); await T(() => window.tintwork.idle());
  const tilt = await T(async () => { const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), x = c.getContext('2d'), pts = []; for (let y = Math.round(c.height * 0.2); y < c.height * 0.8; y += 4) { const d = x.getImageData(0, y, Math.round(c.width / 2), 1).data; for (let i = 0; i < d.length / 4; i++) if (d[i * 4] < 100 && d[i * 4 + 3] > 200) { pts.push([y, i]); break; } } const n = pts.length, my = pts.reduce((s, p) => s + p[0], 0) / n, mx = pts.reduce((s, p) => s + p[1], 0) / n; let a = 0, b = 0; for (const [y, xx] of pts) { a += (y - my) * (xx - mx); b += (y - my) ** 2; } return Math.atan(a / b) * 180 / Math.PI; });
  check(lr?.mode === 'rotate' && Math.abs(tilt) < 0.3, `tilted bars: ${lr?.mode} by ${lr?.angle?.toFixed(2)}°, bars now ${tilt.toFixed(2)}° from vertical`);
  // real photo (CC0): the outer edges come within 1° (Guided upright gets closer; see WORKFLOW_BENCHMARK.md)
  await open('c6.jpg', REAL('c6.jpg')); await T(() => window.tintwork.run('autoUpright')); await page.locator('#optionsbar [data-cmd="uprightEdges_crop"]').click(); await page.keyboard.press('Enter'); await T(() => window.tintwork.idle());
  const c6 = await T(() => window.tintwork.lastUpright);
  const c6t = await transparentCorners(); check(c6?.mode === 'keystone' && !!c6.H && c6t === 0, `real photo (high-rise looking up): ${c6?.mode} from ${c6?.lines} lines, H ${!!c6?.H}, ${c6t} see-through pixels after the crop`);
  // a 16-bit layer: Fill edges explains instead of failing
  await building(); await T(() => window.tintwork.run('mode16')); await T(() => window.tintwork.run('autoUpright')); await page.locator('#optionsbar [data-cmd="uprightEdges_keep"]').click(); await page.keyboard.press('Enter'); await T(() => window.tintwork.idle());
  const f16 = await T(() => window.tintwork.fillEmptyEdges());
  check(f16 === false && /16-bit/.test(await T(() => document.querySelector('#status').textContent)), 'Fill empty edges on a 16-bit layer says why it cannot (no silent change)');
  await T(() => window.tintwork.run('cropEmptyEdges'));
  check((await transparentCorners()) === 0, 'Crop away empty edges works on a 16-bit document');
}

// --- 2c. Export presets + watermark
const hasPresets = await T(() => !!window.tintwork.exportPresets);
check(hasPresets, 'export presets API exists');
if (hasPresets) {
  await T(async () => { const t = window.tintwork; t.newDocument(3000, 2000, 'white', 'wmtest'); const l = t.activeLayer(), x = l.canvas.getContext('2d'); const g = x.createLinearGradient(0, 0, 3000, 0); g.addColorStop(0, '#203040'); g.addColorStop(1, '#405060'); x.fillStyle = g; x.fillRect(0, 0, 3000, 2000); t.touch(l); t.markDirty(); t.renderNow(); await t.compositeSettled?.(); localStorage.removeItem('tintwork.exportPresets'); localStorage.removeItem('tintwork.lastExportPreset'); });
  const all = await T(() => window.tintwork.exportPresets.all().map((p) => p.id));
  check(['web', 'email', 'print', 'png'].every((id) => all.includes(id)), `built-in presets: ${all.join(', ')}`);
  await page.keyboard.press('Control+Shift+e'); await page.waitForSelector('#modal:not(.hidden) #ePreset');
  await page.selectOption('#ePreset', 'email');
  const shown = await T(() => ({ fmt: document.querySelector('#eFmt').value, q: document.querySelector('#eQ')?.value, size: document.querySelector('#eSize').value, v: document.querySelector('#eSizeV').value }));
  check(shown.fmt === 'image/jpeg' && +shown.q === 80 && shown.size === 'long' && +shown.v === 1200, `choosing “Email” fills the dialog (format ${shown.fmt}, quality ${shown.q}, ${shown.size} ${shown.v})`);
  page.once('dialog', (d) => d.accept('My blog 1600'));
  await T(() => { const s = document.querySelector('#eSizeV'); if (s) { s.value = 1600; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); } });
  await page.click('#ePresetSave'); await page.waitForTimeout(200);
  const user = await T(() => window.tintwork.exportPresets.user());
  check(user.length === 1 && user[0].name === 'My blog 1600' && user[0].size?.long === 1600 && user[0].quality === 80, `“Save preset…” stores a named preset (${user.map((p) => `${p.name}: ${p.type} ${p.quality} ${JSON.stringify(p.size)}`).join('; ')})`);
  await page.click('#modalCancel');
  // watermark settings + 8-bit render
  await T(() => window.tintwork.saveWatermark({ text: 'TEST MARK', size: 6, opacity: 80, position: 'br', color: '#ffffff', margin: 3, shadow: false }));
  const wm = await T(async () => {
    const t = window.tintwork, dec = async (b) => { const bm = await createImageBitmap(b); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x; };
    const a = await dec(await t.renderExportWith('image/png', 1, { watermark: t.watermarkSettings() })), b = await dec(await t.renderExportWith('image/png', 1, {}));
    const frac = (r) => { const p = a.getImageData(r.x, r.y, r.w, r.h).data, q = b.getImageData(r.x, r.y, r.w, r.h).data; let n = 0; for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) > 20) n++; return n / (p.length / 4); };
    return { br: frac({ x: 1800, y: 1700, w: 1150, h: 250 }), tl: frac({ x: 0, y: 0, w: 1500, h: 1000 }) };
  });
  check(wm.br > 0.03 && wm.tl === 0, `8-bit export: watermark in the bottom-right (${(wm.br * 100).toFixed(1)}% of that band changed), nothing elsewhere`);
  // 16-bit PNG
  const wm16 = await T(async () => { const t = window.tintwork; t.run('mode16'); const b1 = await t.renderExportWith('image/png16', 1, { watermark: t.watermarkSettings() }), b0 = await t.renderExportWith('image/png16', 1, {}); t.run('mode8'); return { a: b1.size, b: b0.size }; });
  check(wm16.a && wm16.a !== wm16.b, `16-bit PNG export carries the watermark (${wm16.a} vs ${wm16.b} bytes without)`);
  // multi-size + batch carry it, scaled with each size
  const vx = await T(async () => { const t = window.tintwork, sink = t.memorySink(); const out = await t.exportVariants([{ mode: 'long', long: 1200, type: 'image/png' }, { mode: 'long', long: 600, type: 'image/png' }], { sink, watermark: t.watermarkSettings() }); return out.map((o) => o.w); });
  check(Array.isArray(vx) && vx.join() === '1200,600', `multi-size export with a watermark: ${JSON.stringify(vx)}`);
  const bt = await T(async () => {
    const t = window.tintwork, c = new OffscreenCanvas(800, 600), x = c.getContext('2d'); x.fillStyle = '#336'; x.fillRect(0, 0, 800, 600); const blob = await c.convertToBlob({ type: 'image/png' });
    const files = [new File([blob], 'a.png', { type: 'image/png' }), new File([blob], 'b.png', { type: 'image/png' })], sink = t.memorySink();
    const r = await t.runBatch(files, { variants: [{ mode: 'original', type: 'image/png' }], sink, watermark: t.watermarkSettings() });
    const plain = t.memorySink(); await t.runBatch([files[0]], { variants: [{ mode: 'original', type: 'image/png' }], sink: plain });
    const dec = async (b) => { const bm = await createImageBitmap(b); const cc = new OffscreenCanvas(bm.width, bm.height), xx = cc.getContext('2d'); xx.drawImage(bm, 0, 0); return xx.getImageData(400, 450, 390, 140).data; };
    const p = await dec(Object.values(sink.files)[0].blob), q = await dec(Object.values(plain.files)[0].blob); let n = 0; for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) > 20) n++;
    return { done: r.done, changed: n };
  });
  check(bt.done === 2 && bt.changed > 200, `batch with a watermark: ${bt.done} files, ${bt.changed} watermark pixels in the corner`);
  // Export with last preset: one shortcut, the preset's size
  await page.keyboard.press('Control+Shift+e'); await page.waitForSelector('#modal:not(.hidden) #ePreset');
  await page.selectOption('#ePreset', 'web'); await page.click('#modalOk');
  await page.waitForFunction(() => window.__pick.save >= 1, null, { timeout: 20000 }).catch(() => {});
  check(await T(() => localStorage.getItem('tintwork.lastExportPreset')) === 'web', 'OK remembers the preset as the last one');
  const n0 = await T(() => window.__pick.save);
  await page.keyboard.press('Control+Alt+Shift+e');
  await page.waitForFunction((n) => window.__pick.save > n && /Exported/.test(document.querySelector('#status').textContent), n0, { timeout: 20000 }).catch(() => {});
  const last = await T(async () => { const root = await navigator.storage.getDirectory(), f = await (await root.getFileHandle(window.__pick.lastSave)).getFile(), bm = await createImageBitmap(f); return { n: window.__pick.save, w: bm.width, h: bm.height, type: f.type || window.__pick.lastSave }; });
  check(last.n === n0 + 1 && Math.max(last.w, last.h) === 2048, `Ctrl+Alt+Shift+E exports again with “Web” in one step (${last.w}×${last.h})`);
  const reopened = await T(async () => { document.querySelector('#modal:not(.hidden) #modalCancel')?.click(); return true; });
  await page.keyboard.press('Control+Shift+e'); await page.waitForSelector('#modal:not(.hidden) #ePreset');
  check(await T(() => document.querySelector('#ePreset').value) === 'web' && reopened, 'the Export dialog opens on the last preset');
  page.once('dialog', (d) => d.accept());
  await T(() => { document.querySelector('#ePreset').value = window.tintwork.exportPresets.user()[0]?.id || ''; document.querySelector('#ePreset').dispatchEvent(new Event('change')); });
  await page.click('#ePresetDel').catch(() => {}); await page.waitForTimeout(200);
  check((await T(() => window.tintwork.exportPresets.user().length)) === 0, '“Delete” removes a saved preset (built-ins cannot be deleted)');
  await page.click('#modalCancel').catch(() => {});
  check(await T(() => [...document.querySelectorAll('#menus .menu-items button')].some((b) => /Export with last preset/.test(b.textContent) && /Ctrl\+Alt\+Shift\+E/.test(b.textContent))), 'File menu: “Export with last preset” shows Ctrl+Alt+Shift+E');
}

// --- 2d. exact 8-bit Exclusion with a semi-transparent source
const ex = await T(async () => {
  const t = window.tintwork, cases = [[[200, 40, 120], [90, 210, 30], 0.6, 0.7], [[10, 250, 128], [255, 128, 0], 1, 0.5], [[128, 128, 128], [64, 192, 255], 0.35, 1]]; let worst = 0;
  for (const [B, S, a, op] of cases) {
    t.newDocument(8, 8, 'white', 'ex'); const bg = t.activeLayer(), c = bg.canvas.getContext('2d'); c.fillStyle = `rgb(${B})`; c.fillRect(0, 0, 8, 8); t.touch(bg);
    t.run('layerNew'); const top = t.activeLayer(), k = top.canvas.getContext('2d'); k.fillStyle = `rgba(${S},${a})`; k.fillRect(0, 0, top.canvas.width, top.canvas.height); t.touch(top);
    top.blend = 'exclusion'; top.opacity = op; t.markDirty(); t.renderNow(); await t.compositeSettled?.();
    const got = t.compositeCanvas().getContext('2d').getImageData(2, 2, 1, 1).data, as = Math.round(a * 255) / 255 * op;
    for (let ch = 0; ch < 3; ch++) { const b = B[ch] / 255, s = S[ch] / 255, ref = (1 - as) * b + as * (b + s - 2 * b * s); worst = Math.max(worst, Math.abs(ref * 255 - got[ch])); }
  }
  return worst;
});
check(typeof ex === 'number' && ex <= 0.75, `8-bit Exclusion with semi-transparent sources matches the W3C formula (worst ${typeof ex === 'number' ? ex.toFixed(2) : ex} levels; ≤ 0.75)`);

// --- 2e. wording and shortcuts
const words = await T(() => document.body.innerText + ' ' + [...document.querySelectorAll('[title],[aria-label]')].map((e) => e.title + ' ' + e.getAttribute('aria-label')).join(' '));
check(!/photoshop|adobe/i.test(words), 'no other editor brand names in the UI');
const guide = readFileSync(path.join(ROOT, 'docs/USER_GUIDE.md'), 'utf8');
check(/Object select/.test(guide) && /Auto upright/.test(guide) && /watermark/i.test(guide) && /preset/i.test(guide) && !/photoshop|adobe/i.test(guide), 'user guide covers Object select, Auto upright, presets and watermark (no other editor brand names)');
check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);

await browser.close(); server.close();
console.log(`\n${count - fails}/${count} v1.8 checks passed`);
process.exit(fails ? 1 : 0);
