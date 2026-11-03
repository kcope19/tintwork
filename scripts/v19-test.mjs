// v1.9 test: more non-AI gaps from docs/WORKFLOW_BENCHMARK.md / docs/AUDIT.md.
//  - image (logo) watermarks: position, opacity, scale; single, multi-size, batch and 16-bit export; kept in export presets
//  - Auto upright modes: Vertical, Level, Full (verticals + horizontals)
//  - faster spot healing on real photos (time and removal score on a public-domain portrait)
//  - Fill edges / crop fill on 16-bit layers
//  - soft-proof preview
// TW_ROOT=/path/to/other/checkout runs the same checks against another tree (used to confirm they fail on v1.8.0).
// TW_URL=https://… runs the app checks against a deployed site.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
let seg = null; try { seg = await import(pathToFileURL(path.join(ROOT, 'src/segment.js')).href); } catch { /* none */ }

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

// --- 1. image (logo) watermark
const hasLogo = await T(() => typeof window.tintwork.readyWatermark === 'function');
check(hasLogo, 'logo watermark API exists');
if (hasLogo) {
  await T(async () => { const t = window.tintwork; t.newDocument(3000, 2000, 'white', 'logotest'); const l = t.activeLayer(), x = l.canvas.getContext('2d'); x.fillStyle = '#304050'; x.fillRect(0, 0, 3000, 2000); t.touch(l); t.markDirty(); t.renderNow(); await t.compositeSettled?.(); localStorage.removeItem('tintwork.exportPresets'); localStorage.removeItem('tintwork.lastExportPreset'); localStorage.removeItem('tintwork.watermark'); });
  // a 200×100 logo: solid red with a transparent hole in the middle
  const logo = await T(async () => { const c = new OffscreenCanvas(200, 100), x = c.getContext('2d'); x.fillStyle = '#ff0000'; x.fillRect(0, 0, 200, 100); x.clearRect(80, 30, 40, 40); const b = await c.convertToBlob({ type: 'image/png' }); return [...new Uint8Array(await b.arrayBuffer())]; });
  // through the UI: File ▸ Export watermark…, Type: Logo image, Choose image…
  await T(() => window.tintwork.run('watermarkSettings'));
  await page.waitForSelector('#modal:not(.hidden) [data-wm=kind]');
  await page.selectOption('#modal [data-wm=kind]', 'image');
  const fc = page.waitForEvent('filechooser'); await page.click('#modal [data-wmpick]'); (await fc).setFiles({ name: 'mylogo.png', mimeType: 'image/png', buffer: Buffer.from(logo) });
  await page.waitForFunction(() => window.tintwork.watermarkSettings().kind === 'image', null, { timeout: 10000 }).catch(() => {});
  await page.fill('#modal [data-wm=scale]', '25'); await page.fill('#modal [data-wm=opacity]', '100'); await page.selectOption('#modal [data-wm=position]', 'tl');
  await T(() => { const s = document.querySelector('#modal [data-wm=shadow]'); if (s && s.checked) s.click(); });
  await page.click('#modalOk');
  const ws = await T(() => { const w = window.tintwork.watermarkSettings(); return { kind: w.kind, name: w.imageName, scale: w.scale, pos: w.position, op: w.opacity, has: !!w.image }; });
  check(ws.kind === 'image' && ws.has && ws.name === 'mylogo.png' && ws.scale === 25 && ws.pos === 'tl' && ws.op === 100, `watermark dialog stores a logo (${JSON.stringify(ws)})`);
  // measure where the red logo lands in an export, at two sizes (it scales with the output)
  const measure = (o) => T(async (o) => {
    const t = window.tintwork, w = t.watermarkSettings(); Object.assign(w, o.wm || {});
    let blob; if (o.long) { const sink = t.memorySink(); await t.exportVariants([{ mode: 'long', long: o.long, type: 'image/png' }], { sink, watermark: w }); blob = Object.values(sink.files)[0].blob; } else blob = await t.renderExportWith(o.type || 'image/png', 1, { watermark: w });
    const bm = await createImageBitmap(blob), c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, bm.width, bm.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0, hole = 0, rsum = 0;
    for (let y = 0; y < bm.height; y++) for (let xx = 0; xx < bm.width; xx++) { const i = (y * bm.width + xx) * 4; if (d[i] > 120 && d[i + 2] < 100) { n++; rsum += d[i]; x0 = Math.min(x0, xx); y0 = Math.min(y0, y); x1 = Math.max(x1, xx); y1 = Math.max(y1, y); } }
    if (n) { const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2), i = (cy * bm.width + cx) * 4; hole = d[i] < 100 ? 1 : 0; }
    return { W: bm.width, H: bm.height, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n, hole, r: n ? rsum / n : 0 };
  }, o);
  const full = await measure({});
  // 25% of the short side (2000) = 500 px wide, 250 high; margin 3% = 60 px from the top-left
  check(Math.abs(full.w - 500) <= 2 && Math.abs(full.h - 250) <= 2 && Math.abs(full.x0 - 60) <= 2 && Math.abs(full.y0 - 60) <= 2 && full.hole === 1, `full-size export: logo ${full.w}×${full.h} at ${full.x0},${full.y0} (expect 500×250 at 60,60), transparent hole kept ${!!full.hole}`);
  const small = await measure({ long: 1500 });
  check(Math.abs(small.w - 250) <= 2 && Math.abs(small.x0 - 30) <= 2, `1500 px multi-size export: logo ${small.w}×${small.h} at ${small.x0},${small.y0} (scales with the output: expect 250 wide at 30)`);
  const br = await measure({ wm: { position: 'br' } });
  check(Math.abs(br.x0 + br.w - (3000 - 60)) <= 2 && Math.abs(br.y0 + br.h - (2000 - 60)) <= 2, `bottom-right: logo ends at ${br.x0 + br.w},${br.y0 + br.h} (expect 2940,1940)`);
  const op = await T(async () => { const t = window.tintwork, w = { ...t.watermarkSettings(), opacity: 50 }; const b = await t.renderExportWith('image/png', 1, { watermark: w }); const bm = await createImageBitmap(b), c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return [...x.getImageData(100, 100, 1, 1).data]; });
  // 50% red over #304050 = (0.5·255 + 0.5·48, 0.5·64, 0.5·80) ≈ (152, 32, 40)
  check(Math.abs(op[0] - 152) <= 3 && Math.abs(op[1] - 32) <= 3 && Math.abs(op[2] - 40) <= 3, `opacity 50%: logo pixel ${op.slice(0, 3).join(',')} (expect ≈152,32,40)`);
  // 16-bit PNG carries the logo
  const deep = await T(async () => { const t = window.tintwork; t.run('mode16'); const b = await t.renderExportWith('image/png16', 1, { watermark: t.watermarkSettings() }); t.run('mode8'); const bm = await createImageBitmap(b), c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return [...x.getImageData(100, 100, 1, 1).data, ...x.getImageData(1500, 1000, 1, 1).data]; });
  check(deep[0] > 240 && deep[1] < 15 && Math.abs(deep[4] - 48) <= 2, `16-bit PNG export: logo pixel ${deep.slice(0, 3)} red, away from it ${deep.slice(4, 7)} untouched`);
  // batch carries it
  const bt = await T(async () => {
    const t = window.tintwork, c = new OffscreenCanvas(800, 600), x = c.getContext('2d'); x.fillStyle = '#336'; x.fillRect(0, 0, 800, 600); const blob = await c.convertToBlob({ type: 'image/png' });
    const files = [new File([blob], 'a.png', { type: 'image/png' }), new File([blob], 'b.png', { type: 'image/png' })], sink = t.memorySink();
    const r = await t.runBatch(files, { variants: [{ mode: 'original', type: 'image/png' }], sink, watermark: t.watermarkSettings() });
    const red = []; for (const f of Object.values(sink.files)) { const bm = await createImageBitmap(f.blob), cc = new OffscreenCanvas(bm.width, bm.height), xx = cc.getContext('2d'); xx.drawImage(bm, 0, 0); const d = xx.getImageData(0, 0, 400, 300).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 2] < 80) n++; red.push(n); }
    return { done: r.done, red };
  });
  // 600 short side → 150×75 logo minus a 30×30 hole = 10350 px
  check(bt.done === 2 && bt.red.every((n) => Math.abs(n - 10350) < 600), `batch: ${bt.done} files, logo pixels per file ${bt.red.join(', ')} (expect ≈10350)`);
  // export preset keeps its own logo: save a preset, change the global watermark to text, export with the preset
  const pr = await T(async () => {
    const t = window.tintwork, p = t.exportPresets.save({ name: 'Logo web', type: 'image/png', quality: 100, size: { mode: 'long', long: 1500 }, dpi: null, watermark: t.watermarkSettings() });
    localStorage.setItem('tintwork.lastExportPreset', p.id); t.saveWatermark({ kind: 'text', text: 'OTHER' });
    const stored = t.exportPresets.user().find((x) => x.id === p.id);
    return { kind: stored.watermark?.kind, has: !!stored.watermark?.image, global: t.watermarkSettings().kind };
  });
  check(pr.kind === 'image' && pr.has && pr.global === 'text', `a saved export preset keeps its logo watermark (${JSON.stringify(pr)})`);
  const n0 = await T(() => window.__pick.save);
  await page.keyboard.press('Control+Alt+Shift+e');
  await page.waitForFunction((n) => window.__pick.save > n && /Exported/.test(document.querySelector('#status').textContent), n0, { timeout: 20000 }).catch(() => {});
  const viaPreset = await T(async () => { const root = await navigator.storage.getDirectory(), f = await (await root.getFileHandle(window.__pick.lastSave)).getFile(), bm = await createImageBitmap(f), c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return { w: bm.width, px: [...x.getImageData(40, 40, 1, 1).data] }; });
  check(viaPreset.w === 1500 && viaPreset.px[0] > 240 && viaPreset.px[1] < 15, `Ctrl+Alt+Shift+E with that preset exports the logo, not the newer text (${viaPreset.w} px, pixel ${viaPreset.px.slice(0, 3)})`);
  // choosing the preset in the Export dialog makes its watermark current again
  await page.keyboard.press('Control+Shift+e'); await page.waitForSelector('#modal:not(.hidden) #ePreset');
  const lab = await T(() => ({ kind: window.tintwork.watermarkSettings().kind, label: document.querySelector('#modal [data-wmtext]')?.textContent, on: document.querySelector('#eWm')?.checked }));
  check(lab.kind === 'image' && /mylogo\.png/.test(lab.label || '') && lab.on, `Export dialog on that preset shows “Add ${lab.label}” ticked`);
  await page.click('#modalCancel').catch(() => {});
  // a v1.8-style preset (watermark: true) still uses the current watermark
  const v18 = await T(() => { const t = window.tintwork, p = t.exportPresets.save({ name: 'Old', type: 'image/png', watermark: true }); const s = t.exportPresets.user().find((x) => x.id === p.id); t.exportPresets.remove(p.id); return s.watermark; });
  check(v18 === true, `v1.8 presets (watermark: true) still load (${v18})`);
}

// --- 2. Auto upright modes: Level / Vertical / Full
const hasModes = await T(() => typeof window.tintwork.segment?.uprightHomography === 'function');
check(hasModes, 'upright modes exist (Level / Vertical / Full)');
if (hasModes) {
  // map truth points through the last correction (layer box → corner points), then angles from vertical / horizontal
  const mapped = async (segs) => { const r = await T((segs) => { const H = window.tintwork.lastUpright?.H; if (!H) return null; const ap = ([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; }; return segs.map(([a, b]) => [ap(a), ap(b)]); }, segs); return Array.isArray(r) ? r : segs.map(() => [[0, 0], [1e-9, 1e-9]]); };
  const vdeg = ([[x1, y1], [x2, y2]]) => Math.atan2(x2 - x1, y2 - y1) * 180 / Math.PI;
  const hdeg = ([[x1, y1], [x2, y2]]) => Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
  const norm = (a) => { while (a > 90) a -= 180; while (a <= -90) a += 180; return a; };
  const maxAbs = (a) => Math.max(...a.map((v) => Math.abs(norm(v))));
  const apply = async (cmd, edges = 'keep') => { await T((c) => window.tintwork.run(c), cmd); await page.locator(`#optionsbar [data-cmd="uprightEdges_${edges}"]`).click(); const lu = await T(() => window.tintwork.lastUpright); await page.keyboard.press('Enter'); await T(() => window.tintwork.idle()); return { ...lu, ...(await T(() => window.tintwork.lastUpright)) }; };
  // (a) a horizon tilted 3° with level stripes and no verticals
  const horizon = () => T(async () => {
    const t = window.tintwork; t.newDocument(1200, 800, 'white', 'horizon'); const l = t.activeLayer(), x = l.canvas.getContext('2d');
    x.fillStyle = '#9cc6e8'; x.fillRect(0, 0, 1200, 800); x.save(); x.translate(600, 400); x.rotate(3 * Math.PI / 180);
    x.fillStyle = '#1d3f5e'; x.fillRect(-900, 0, 1800, 700); x.fillStyle = '#e8e2d0'; for (const y of [120, 220, 300]) x.fillRect(-900, y, 1800, 10); x.restore();
    t.touch(l); t.markDirty(); t.renderNow(); await t.compositeSettled?.();
  });
  const rot3 = (pts) => { const t = 3 * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); return pts.map(([x, y]) => [600 + x * c - y * s, 400 + x * s + y * c]); };
  const hTruth = [rot3([[-500, 0], [500, 0]]), rot3([[-500, 120], [500, 120]]), rot3([[-500, 300], [500, 300]])];
  await horizon(); const lv = await apply('uprightLevel');
  const lvAfter = (await mapped(hTruth)).map(hdeg);
  check(lv.mode === 'level' && maxAbs(lvAfter) < 0.15, `Level: horizon tilted 3° → ${lvAfter.map((a) => a.toFixed(2)).join('° / ')}° (${lv.hlines} horizontal lines, ${lv.ms} ms)`);
  await horizon(); const au = await apply('autoUpright');
  const auAfter = (await mapped(hTruth)).map(hdeg);
  check(au.mode === 'level' && maxAbs(auAfter) < 0.15, `Auto with no verticals falls back to Level (${au.mode}, ${auAfter.map((a) => a.toFixed(2)).join('° / ')}°)`);
  await horizon(); const vo = await apply('uprightVertical');
  check(vo.mode === 'none', `Vertical on the same horizon does nothing (${vo.mode}): it only reads vertical lines`);
  // (b) a facade seen from below and from the side: both families converge (drawn through a known homography)
  const G = [[160, 70], [1080, 20], [1150, 880], [70, 820]]; // where the facade's 1200×900 rectangle lands
  const facade = () => T(async (G) => {
    const t = window.tintwork, m = t.mesh || null; t.newDocument(1220, 900, 'white', 'facade'); const l = t.activeLayer(), x = l.canvas.getContext('2d');
    // bilinear-free projective map from the unit square to G
    const H = (() => { const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = G, dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3, den = dx1 * dy2 - dx2 * dy1, g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den; return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1]; })();
    const P = (u, v) => { const w = H[6] * u + H[7] * v + 1; return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w]; };
    x.fillStyle = '#6d9ccc'; x.fillRect(0, 0, 1220, 900);
    const quad = (u0, v0, u1, v1, c) => { x.beginPath(); x.moveTo(...P(u0, v0)); x.lineTo(...P(u1, v0)); x.lineTo(...P(u1, v1)); x.lineTo(...P(u0, v1)); x.closePath(); x.fillStyle = c; x.fill(); };
    quad(0, 0, 1, 1, '#c9b79c');
    for (let i = 0; i < 6; i++) quad(0.06 + i * 0.155, 0.06, 0.06 + i * 0.155 + 0.07, 0.94, '#2c3440'); // window columns
    for (let j = 1; j < 5; j++) quad(0.02, j * 0.2 - 0.01, 0.98, j * 0.2 + 0.01, '#efe6d6'); // floor slabs
    t.touch(l); t.markDirty(); t.renderNow(); await t.compositeSettled?.();
    window.__facadeP = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
  }, G);
  const fv = [[G[0], G[3]], [G[1], G[2]]], fh = [[G[0], G[1]], [G[3], G[2]]];
  await facade(); const fu = await apply('uprightFull');
  const fm = await mapped([...fv, ...fh]), fva = fm.slice(0, 2).map(vdeg), fha = fm.slice(2).map(hdeg);
  check(fu.mode === 'full' && maxAbs(fva) < 0.3 && maxAbs(fha) < 0.3, `Full: facade edges ${[...fv.map(vdeg), ...fh.map(hdeg)].map((a) => norm(a).toFixed(1)).join('/')}° → verticals ${fva.map((a) => a.toFixed(2)).join('/')}°, horizontals ${fha.map((a) => a.toFixed(2)).join('/')}° (${fu.lines}+${fu.hlines} lines, ${fu.ms} ms)`);
  await facade(); const vu = await apply('uprightVertical');
  const vm = await mapped([...fv, ...fh]), vva = vm.slice(0, 2).map(vdeg), vha = vm.slice(2).map(hdeg);
  check(vu.mode === 'keystone' && maxAbs(vva) < 0.3 && maxAbs(vha) > 1, `Vertical: verticals ${vva.map((a) => a.toFixed(2)).join('/')}°, horizontals left as they were (${vha.map((a) => a.toFixed(1)).join('/')}°)`);
  await facade(); const lf = await apply('uprightLevel');
  const lm = await mapped([[[0, 0], [1220, 0]], [[0, 0], [0, 900]]]), side = (s) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
  check(lf.mode === 'level' && Math.abs(side(lm[0]) - 1220) < 1 && Math.abs(side(lm[1]) - 900) < 1 && Math.abs(norm(hdeg(lm[0]) - vdeg(lm[1]) * -1)) < 0.05, `Level is a pure rotation (frame sides ${side(lm[0]).toFixed(1)} × ${side(lm[1]).toFixed(1)}, rotated ${hdeg(lm[0]).toFixed(2)}°)`);
  // (c) options bar and Image menu
  await facade(); await T(() => window.tintwork.run('perspective'));
  const bar = await T(() => ['autoUpright', 'uprightLevel', 'uprightVertical', 'uprightFull'].map((c) => document.querySelectorAll(`#optionsbar [data-cmd="${c}"]`).length).join(''));
  check(bar === '1111', `Perspective options bar: Auto · Level · Vertical · Full (${bar})`);
  await page.locator('#optionsbar [data-cmd="uprightFull"]').click(); await page.waitForTimeout(100);
  check(await T(() => window.tintwork.lastUpright?.mode === 'full' && document.querySelector('#optionsbar [data-cmd="uprightFull"]').classList.contains('on')), 'clicking Full in the options bar runs it and highlights it');
  await page.keyboard.press('Escape');
  const menu = await T(() => ['uprightLevel', 'uprightVertical', 'uprightFull'].every((c) => document.querySelector(`#menus .menu-items button[data-cmd="${c}"]`)));
  check(menu, 'Image menu: Upright level / vertical / full');
  // (d) real photos (CC0): Full keeps the verticals within 1° (truth edges fitted to the photo, see WORKFLOW_BENCHMARK.md)
  for (const [f, seeds] of [['c6.jpg', [[[481, 368], [449, 573]], [[845, 368], [887, 598]]]], ['c4.jpg', [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]]]]) {
    await open(f, REAL(f)); const r = await apply('uprightFull', 'crop'); const a = (await mapped(seeds)).map(vdeg), holes = await T(async () => { const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) n++; return n; });
    check(r.mode === 'full' && maxAbs(a) < 1 && holes === 0, `real ${f}: Full from ${r.lines} vertical + ${r.hlines} horizontal lines, truth edges ${seeds.map(vdeg).map((v) => v.toFixed(2)).join('/')}° → ${a.map((v) => v.toFixed(2)).join('/')}°, cropped, ${holes} see-through pixels (${r.ms} ms)`);
  }
}

// --- 3. Fill empty edges on 16-bit layers
{
  const r = await T(async () => {
    const t = window.tintwork; t.newDocument(900, 600, 'white', 'deepfill'); t.run('mode16'); const l = t.activeLayer(), d = t.createDeep(900, 600), D = d.data;
    // a 16-bit ramp 30000 → 30600 (≈ 2 eight-bit steps across 900 px), with a transparent wedge in the top-left and a soft-edged hole
    for (let y = 0; y < 600; y++) for (let x = 0; x < 900; x++) { const i = (y * 900 + x) * 4, v = 30000 + Math.round(x * 600 / 899); D[i] = v; D[i + 1] = 20000 + y * 10; D[i + 2] = 40000; D[i + 3] = x + y < 200 ? 0 : x + y < 204 ? 32768 : 65535; }
    t.setDeep(l, d); t.touch(l); t.commit('Ramp with a hole'); t.renderNow(); await t.compositeSettled?.();
    const before = new Uint16Array(t.deepOf(l).data);
    const ok = t.fillEmptyEdges(), after = t.deepOf(t.activeLayer()).data;
    let alpha0 = 0, changedOpaque = 0, off257 = 0, filled = 0, maxErr = 0;
    for (let i = 0; i < after.length; i += 4) {
      if (after[i + 3] !== 65535) alpha0++;
      if (before[i + 3] === 65535) { if (after[i] !== before[i] || after[i + 1] !== before[i + 1] || after[i + 2] !== before[i + 2]) changedOpaque++; }
      else if (before[i + 3] === 0) { filled++; if (after[i] % 257 || after[i + 1] % 257) off257++; const x = (i / 4) % 900; maxErr = Math.max(maxErr, Math.abs(after[i] - (30000 + x * 600 / 899))); }
    }
    const depth = t.doc.depth; t.undo(); await t.idle?.(); const back = t.deepOf(t.activeLayer()).data[3];
    return { ok, alpha0, changedOpaque, off257, filled, maxErr: Math.round(maxErr), depth, back, status: document.querySelector('#status').textContent };
  });
  check(r.ok === true && r.alpha0 === 0 && r.depth === 16, `16-bit Fill empty edges: ${r.filled} empty pixels filled, ${r.alpha0} left transparent, document still ${r.depth}-bit (${r.status})`);
  check(r.changedOpaque === 0, `16-bit fill leaves every opaque pixel exactly as it was (${r.changedOpaque} changed)`);
  check(r.off257 > r.filled * 0.5 && r.maxErr < 400, `the fill is 16-bit, not an 8-bit copy (${r.off257}/${r.filled} filled values between 8-bit steps; red within ${r.maxErr} of the ramp)`);
  check(r.back === 0, 'Undo brings the empty corner back');
  // through the UI: 16-bit upright with “Fill edges”
  const u = await T(async () => {
    const t = window.tintwork; t.newDocument(1000, 1000, 'white', 'deepup'); const l = t.activeLayer(), x = l.canvas.getContext('2d');
    x.fillStyle = '#a9c4dc'; x.fillRect(0, 0, 1000, 1000); x.fillStyle = '#5a4a3a'; x.beginPath(); x.moveTo(250, 120); x.lineTo(750, 120); x.lineTo(880, 980); x.lineTo(120, 980); x.closePath(); x.fill();
    t.touch(l); t.markDirty(); t.run('mode16'); t.renderNow(); await t.compositeSettled?.(); return t.doc.depth;
  });
  await T(() => window.tintwork.run('autoUpright')); await page.locator('#optionsbar [data-cmd="uprightEdges_fill"]').click(); await page.keyboard.press('Enter'); await T(() => window.tintwork.idle());
  const uf = await T(async () => { const t = window.tintwork, l = t.activeLayer(), d = t.deepOf(l); let n = 0; for (let i = 3; i < d.data.length; i += 4) if (d.data[i] < 65535) n++; return { n, w: t.doc.width, h: t.doc.height, filled: t.lastUpright?.filled, depth: t.doc.depth, mode: t.lastUpright?.mode }; });
  check(u === 16 && uf.filled && uf.n === 0 && uf.depth === 16 && uf.w === 1000, `16-bit upright with “Fill edges”: ${uf.mode}, size kept ${uf.w}×${uf.h}, ${uf.n} transparent 16-bit pixels`);
  await T(() => window.tintwork.run('mode8'));
}

// --- wording, errors
const words = await T(() => document.body.innerText + ' ' + [...document.querySelectorAll('[title],[aria-label]')].map((e) => e.title + ' ' + e.getAttribute('aria-label')).join(' '));
check(!/photoshop|adobe/i.test(words), 'no other editor brand names in the UI');
const guide = readFileSync(path.join(ROOT, 'docs/USER_GUIDE.md'), 'utf8');
check(/logo/i.test(guide) && /Level/.test(guide) && /Full/.test(guide) && !/photoshop|adobe/i.test(guide), 'user guide covers logo watermarks and the upright modes (no other editor brand names)');
check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close(); server.close();
console.log(`\n${count - fails}/${count} v1.9 checks passed`);
process.exit(fails ? 1 : 0);
