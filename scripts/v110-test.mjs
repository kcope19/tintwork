// v1.10 test: non-AI polish from the v1.9 audit.
//  - Batch process can use a saved export preset (format, size, ppi and the preset's own watermark)
//  - watermark dialog: colour hidden for logos, logo fit sizing
//  - Auto upright on the high-rise photo (job 17) and a held-out photo; Full with real horizontals
//  - soft-proof preview
// TW_ROOT=/path/to/other/checkout runs the same checks against another tree (used to confirm they fail on v1.9.0).
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
  window.showDirectoryPicker = async (o) => { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(o?.mode === 'read' ? 'batch-in' : 'batch-out', { create: true }); };
});
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));
const open = async (name, bytes) => { await page.setInputFiles('#fileInput', { name, mimeType: /png$/.test(name) ? 'image/png' : 'image/jpeg', buffer: bytes }); await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), name, { timeout: 30000 }); await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); }); };
const toScreen = (p) => page.evaluate(({ x, y }) => { const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state; return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom }; }, p);
const drag = async (a, b, mods = []) => { const s = await toScreen(a), e = await toScreen(b); for (const m of mods) await page.keyboard.down(m); await page.mouse.move(s.x, s.y); await page.mouse.down(); for (let k = 1; k <= 10; k++) await page.mouse.move(s.x + (e.x - s.x) * k / 10, s.y + (e.y - s.y) * k / 10); await page.mouse.up(); for (const m of mods) await page.keyboard.up(m); };
const pngOf = (fn) => T(async (src) => { const c = new OffscreenCanvas(400, 200), x = c.getContext('2d'); new Function('x', src)(x); const b = await c.convertToBlob({ type: 'image/png' }); return [...new Uint8Array(await b.arrayBuffer())]; }, fn);
const resetStore = () => T(async () => { for (const k of Object.keys(localStorage)) if (k.startsWith('tintwork.')) localStorage.removeItem(k); const root = await navigator.storage.getDirectory(); for (const n of ['batch-in', 'batch-out']) await root.removeEntry(n, { recursive: true }).catch(() => {}); });

// --- 1. Batch process with a saved export preset (and the preset's own logo)
{
  await resetStore();
  // six 3000×2000 photos (flat colours) in the batch-in folder
  await T(async () => { const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('batch-in', { create: true });
    for (let i = 0; i < 6; i++) { const c = new OffscreenCanvas(3000, 2000), x = c.getContext('2d'); x.fillStyle = `hsl(${i * 60 + 30},40%,45%)`; x.fillRect(0, 0, 3000, 2000); const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 }); const w = await (await dir.getFileHandle(`p${i + 1}.jpg`, { create: true })).createWritable(); await w.write(b); await w.close(); } });
  // a preset with its own magenta logo; then the global watermark becomes text (the batch must still use the preset's logo)
  const logo = await pngOf("x.fillStyle = '#ff00ff'; x.fillRect(0, 0, 400, 200);");
  const pid = await T(async (logo) => { const t = window.tintwork; const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob([new Uint8Array(logo)], { type: 'image/png' })); });
    const p = t.exportPresets.save({ name: 'Blog 1600 logo', type: 'image/jpeg', quality: 82, size: { mode: 'long', long: 1600 }, dpi: 150, watermark: { kind: 'image', image: url, imageName: 'm.png', scale: 20, opacity: 100, position: 'br', margin: 3, shadow: false, fit: 'short' } });
    localStorage.setItem('tintwork.watermark', JSON.stringify({ kind: 'text', text: 'GLOBAL TEXT' })); return p.id; }, logo);
  const hasPreset = await T(() => { window.tintwork.run('batch'); return !!document.querySelector('#modal:not(.hidden) #bPreset'); });
  check(hasPreset, 'Batch process dialog has an Export preset choice');
  if (hasPreset) {
    await page.click('#bSrcDir'); await page.waitForFunction(() => /6 image/.test(document.querySelector('#bSrcInfo')?.textContent || ''));
    await page.selectOption('#bPreset', pid);
    const form = await T(() => ({ mode: document.querySelector('#modalBody tr[data-i="0"] select[data-f="mode"]').value, long: +document.querySelector('#modalBody tr[data-i="0"] input[data-f="long"]')?.value, type: document.querySelector('#modalBody tr[data-i="0"] select[data-f="type"]').value, rows: document.querySelectorAll('#modalBody tr[data-i]').length, wm: document.querySelector('#bWm').checked, label: document.querySelector('#modalBody [data-wmtext]').textContent }));
    check(form.mode === 'long' && form.long === 1600 && form.type === 'image/jpeg' && form.rows === 1 && form.wm && /m\.png/.test(form.label), `choosing the preset fills the outputs (${JSON.stringify(form)})`);
    await page.click('#modalOk');
    await page.waitForFunction(() => /Batch finished/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
    const outs = await T(async () => { const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('batch-out'); const r = []; for await (const [n, h] of dir.entries()) { const f = await h.getFile(), u8 = new Uint8Array(await f.arrayBuffer()), b = await createImageBitmap(f); const c = new OffscreenCanvas(b.width, b.height), x = c.getContext('2d'); x.drawImage(b, 0, 0); const d = x.getImageData(0, 0, b.width, b.height).data; let br = 0, tl = 0; for (let y = 0; y < b.height; y++) for (let xx = 0; xx < b.width; xx++) { const i = (y * b.width + xx) * 4; if (d[i] > 220 && d[i + 1] < 50 && d[i + 2] > 220) { if (xx > b.width / 2 && y > b.height / 2) br++; else tl++; } } r.push({ n, w: b.width, h: b.height, br, tl, dpi: u8[13] === 1 ? (u8[14] << 8) | u8[15] : null }); } return r; });
    // logo = 20 % of the 1067 px short side = 213 × 107 px ≈ 22,800 px
    check(outs.length === 6 && outs.every((o) => o.w === 1600 && o.h === 1067), `6 files at the preset's 1600 px (${outs.map((o) => `${o.w}×${o.h}`).join(', ')})`);
    check(outs.every((o) => o.br > 18000 && o.br < 26000 && o.tl === 0), `every file has the preset's own logo bottom-right, not the global text (${outs.map((o) => o.br).join(', ')} logo px)`);
    check(outs.every((o) => o.dpi === 150), `files carry the preset's 150 ppi (${outs.map((o) => o.dpi).join(', ')})`);
    // the next batch starts from the last preset (repeat in fewer steps)
    const again = await T(() => { window.tintwork.run('batch'); const v = document.querySelector('#bPreset')?.value; document.querySelector('#modalCancel')?.click(); return v; });
    check(again === pid, 'the next Batch process starts with the last preset chosen');
    // editing an output row by hand leaves the preset (so a stale logo is not silently used)
    const left = await T(async () => { window.tintwork.run('batch'); const s = document.querySelector('#modalBody tr[data-i="0"] select[data-f="type"]'); s.value = 'image/png'; s.dispatchEvent(new Event('change', { bubbles: true })); const v = document.querySelector('#bPreset').value; document.querySelector('#modalCancel')?.click(); return v; });
    check(left === '', 'changing an output by hand switches the preset back to “(set the outputs below)”');
  }
}

// --- 2. watermark dialog: Color only for text; logo fit sizing
{
  await resetStore(); await T(() => window.tintwork.newDocument(3000, 1000, 'white', 'wm'));
  await T(() => window.tintwork.run('watermarkSettings')); await page.waitForSelector('#modal:not(.hidden) [data-wm=kind]');
  const vis = async () => T(() => { const v = (sel) => { const e = document.querySelector(`#modal ${sel}`); return !!e && !e.closest('.hidden') && e.offsetParent !== null; }; return { color: v('[data-wm=color]'), shadow: v('[data-wm=shadow]'), text: v('[data-wm=text]'), fit: v('[data-wm=fit]') }; });
  const a = await vis(); await page.selectOption('#modal [data-wm=kind]', 'image'); const b = await vis();
  check(a.color && a.text && !a.fit && !b.color && !b.text && b.fit && b.shadow, `Color shows for text only; logo shows size mode and shadow (text ${JSON.stringify(a)}, logo ${JSON.stringify(b)})`);
  await page.click('#modalCancel').catch(() => {});
  const sizes = await T(async () => {
    const t = window.tintwork, c = new OffscreenCanvas(400, 100), x = c.getContext('2d'); x.fillStyle = '#ff0000'; x.fillRect(0, 0, 400, 100);
    const url = await new Promise(async (r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(await c.convertToBlob({ type: 'image/png' })); });
    const r = {};
    for (const fit of ['short', 'width', 'fit']) { const w = { ...t.watermarkSettings(), kind: 'image', image: url, imageName: 'r.png', scale: 30, opacity: 100, shadow: false, margin: 0, position: 'tl', fit }; await t.readyWatermark(w);
      const cv = new OffscreenCanvas(3000, 1000); t.drawWatermark(cv, w); const d = cv.getContext('2d').getImageData(0, 0, 3000, 1000).data; let x1 = 0, y1 = 0; for (let y = 0; y < 1000; y += 1) for (let xx = 0; xx < 3000; xx += 1) if (d[(y * 3000 + xx) * 4 + 3] > 128) { x1 = Math.max(x1, xx + 1); y1 = Math.max(y1, y + 1); } r[fit] = [x1, y1]; }
    return r;
  });
  // 3000×1000 image, 400×100 logo, 30 %: short side → 300×75; width → 900×225; fit inside 900×300 → 900×225 (width-bound)
  check(sizes.short?.[0] === 300 && sizes.width?.[0] === 900 && sizes.fit?.[0] === 900 && sizes.fit?.[1] === 225, `logo size modes on a 3000×1000 export at 30 %: ${JSON.stringify(sizes)}`);
  const tall = await T(async () => { const t = window.tintwork, c = new OffscreenCanvas(100, 400), x = c.getContext('2d'); x.fillStyle = '#ff0000'; x.fillRect(0, 0, 100, 400);
    const url = await new Promise(async (r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(await c.convertToBlob({ type: 'image/png' })); });
    const w = { ...t.watermarkSettings(), kind: 'image', image: url, scale: 30, opacity: 100, shadow: false, margin: 0, position: 'tl', fit: 'fit' }; await t.readyWatermark(w); const cv = new OffscreenCanvas(3000, 1000); t.drawWatermark(cv, w); const d = cv.getContext('2d').getImageData(0, 0, 3000, 1000).data; let x1 = 0, y1 = 0; for (let y = 0; y < 1000; y++) for (let xx = 0; xx < 400; xx++) if (d[(y * 3000 + xx) * 4 + 3] > 128) { x1 = Math.max(x1, xx + 1); y1 = Math.max(y1, y + 1); } return [x1, y1]; });
  check(tall[0] === 75 && tall[1] === 300, `a tall logo with Fit stays inside 30 % of the height (${tall.join('×')}, expected 75×300)`);
}

// --- 3/4. upright on real photos: lines re-fitted on a sharper copy (v1.10). Same edge fit as the benchmark (copied).
/** JS port of the sub-pixel edge fit used to measure real photos: strongest horizontal gradient within ±win px of a seed line. */
const edgeAngle = (page, seeds, win = 4) => page.evaluate(async ({ seeds, win }) => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
  return seeds.map(([[x1, y1], [x2, y2]]) => {
    const xs = [], ys = [];
    if (Math.abs(x2 - x1) > Math.abs(y2 - y1)) { // v1.10: a horizontal edge, the same fit with x and y swapped (strongest vertical gradient per column)
      for (let x = Math.ceil(Math.min(x1, x2)); x < Math.max(x1, x2); x++) {
        if (x < 0 || x >= W) continue; const yr = y1 + (y2 - y1) * (x - x1) / (x2 - x1), a = Math.round(yr - win), b = Math.round(yr + win); if (a < 1 || b >= H - 1) continue;
        let k = -1, best = 12; const col = []; for (let y = a; y <= b; y++) { const v = Math.abs(g(x, y + 1) - g(x, y - 1)); col.push(v); if (v > best) { best = v; k = y - a; } }
        if (k < 0) continue; let dy = 0; if (k > 0 && k < col.length - 1) { const l = col[k - 1], cc = col[k], r = col[k + 1], den = l - 2 * cc + r; dy = den ? 0.5 * (l - r) / den : 0; }
        ys.push(a + k + dy); xs.push(x);
      }
      let keep = xs.map(() => true), s = 0, c0 = 0;
      for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null, n, h: true }; const mx = idx.reduce((q, i) => q + xs[i], 0) / n, my = idx.reduce((q, i) => q + ys[i], 0) / n; let sxy = 0, sxx = 0; for (const i of idx) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } s = sxy / sxx; c0 = my - s * mx; keep = ys.map((y, i) => Math.abs(y - (s * xs[i] + c0)) < 1.5); }
      return { deg: Math.atan(s) * 180 / Math.PI, n: keep.filter(Boolean).length, of: xs.length, h: true };
    }
    for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
      if (y < 0 || y >= H) continue; const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win); if (a < 1 || b >= W - 1) continue;
      let k = -1, best = 12; const row = []; for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); row.push(v); if (v > best) { best = v; k = x - a; } }
      if (k < 0) continue; let dx = 0; if (k > 0 && k < row.length - 1) { const l = row[k - 1], cc = row[k], r = row[k + 1], den = l - 2 * cc + r; dx = den ? 0.5 * (l - r) / den : 0; }
      xs.push(a + k + dx); ys.push(y);
    }
    let keep = xs.map(() => true), s = 0, c0 = 0, res = [];
    for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null, n }; const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n; let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; } s = sxy / syy; c0 = mx - s * my; res = xs.map((x, i) => Math.abs(x - (s * ys[i] + c0))); keep = res.map((r) => r < 1.5); }
    return { deg: Math.atan(s) * 180 / Math.PI, n: keep.filter(Boolean).length, of: xs.length };
  });
}, { seeds, win });
/** Map points of the original photo through the last upright correction (homography, then the edge crop). */
const mapUpright = (page, pts) => page.evaluate((pts) => { const u = window.tintwork.lastUpright, H = u.H, c = u.crop || { x: 0, y: 0 }; return pts.map(([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w - c.x, (H[3] * x + H[4] * y + H[5]) / w - c.y]; }); }, pts);
const uprightRun = async (file, cmd, seeds) => {
  await open(file, REAL(file)); const before = await edgeAngle(page, seeds);
  await T((c) => window.tintwork.run(c), cmd);
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 }).catch(() => {}); await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const lu = await T(() => window.tintwork.lastUpright); if (!lu?.H) return { before, after: [], lu };
  const mapped = []; for (const sd of seeds) mapped.push(await mapUpright(page, sd));
  return { before, after: await edgeAngle(page, mapped), lu };
};
const fmt = (es) => es.map((e) => (e.deg == null ? '—' : `${e.deg.toFixed(2)}°`)).join(' / ');
{
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; });
  // job 17's high-rise: both measured edges within 0.5° (v1.9: −0.50° / 0.10°)
  const c6 = await uprightRun('c6.jpg', 'autoUpright', [[[481, 368], [449, 573]], [[845, 368], [887, 598]]]);
  check(c6.after.length === 2 && c6.after.every((e) => e.deg != null && Math.abs(e.deg) < 0.5 && e.n >= 0.5 * e.of), `Auto upright on the high-rise: ${fmt(c6.before)} → ${fmt(c6.after)} (bar 0.5°)`);
  // held-out tower (added after the change, not used to tune it)
  const tw = await uprightRun('tower.jpg', 'autoUpright', [[[640, 235], [643, 539]], [[801, 235], [813, 501]], [[939, 345], [956, 549]]]);
  check(tw.after.length === 3 && tw.after.every((e) => e.deg != null && Math.abs(e.deg) < 0.5 && e.n >= 0.5 * e.of), `held-out tower, Auto upright: ${fmt(tw.before)} → ${fmt(tw.after)} (bar 0.5°)`);
  // Full on the held-out shop front: horizontals are used and their worst tilt drops by at least 2/3.
  // (Weaker than the 0.5° bar: the photo does NOT reach 0.5° on every edge; see docs/WORKFLOW_BENCHMARK.md.)
  const br = await uprightRun('brick.jpg', 'uprightFull', [[[1030, 572], [1274, 594]], [[1072, 615], [1189, 623]], [[1035, 817], [1274, 823]]]);
  const worst = (es) => Math.max(...es.filter((e) => e.deg != null && e.of).map((e) => Math.abs(e.deg)));
  check(br.lu?.hlines >= 3 && br.after.length === 3 && worst(br.after) < worst(br.before) / 3, `held-out shop front, Full: ${br.lu?.hlines} horizontal lines used, horizontals ${fmt(br.before)} → ${fmt(br.after)}`);
}

// --- 5. soft proof: paper white and ink black on screen only
{
  await T(async () => { const t = window.tintwork; t.newDocument(600, 200, 'white', 'proof'); const l = t.activeLayer(), x = l.canvas.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, 200, 200); x.fillStyle = '#000000'; x.fillRect(200, 0, 200, 200); x.fillStyle = '#808080'; x.fillRect(400, 0, 200, 200); t.touch(l); t.markDirty(); t.renderNow(); await t.compositeSettled?.(); t.run('zoomFit'); });
  await page.waitForTimeout(300);
  const sample = async () => { const out = []; for (const px of [100, 300, 500]) { const p = await toScreen({ x: px, y: 100 }); const buf = await page.screenshot({ clip: { x: Math.round(p.x) - 2, y: Math.round(p.y) - 2, width: 5, height: 5 } }); const v = await T(async (b) => { const bm = await createImageBitmap(new Blob([new Uint8Array(b)], { type: 'image/png' })); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return [...x.getImageData(2, 2, 1, 1).data.slice(0, 3)]; }, [...buf]); out.push(v); } return out; };
  const off = await sample();
  const hasProof = await T(() => typeof window.tintwork.setProof === 'function' && !!document.querySelector('#menus .menu-items button[data-cmd="proofGlossy"]'));
  check(hasProof, 'View menu has Proof: glossy / matte paper');
  if (hasProof) {
    await T(() => window.tintwork.run('proofMatte')); await page.waitForTimeout(200); const matte = await sample();
    const near = (a, b, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    check(near(off[0], [255, 255, 255]) && near(off[1], [0, 0, 0]), `proof off shows the pixels as they are (${JSON.stringify(off)})`);
    check(near(matte[0], [240, 238, 230]) && near(matte[1], [48, 47, 46]) && matte[2][0] > 120 && matte[2][0] < 132, `matte proof: white → paper white, black → ink black, mid-grey stays mid (${JSON.stringify(matte)})`);
    const px = await T(async () => { const t = window.tintwork, b = await t.renderExportWith('image/png', 1, {}); const bm = await createImageBitmap(b), c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return [...x.getImageData(100, 100, 1, 1).data.slice(0, 3), ...x.getImageData(300, 100, 1, 1).data.slice(0, 3)]; });
    check(px.join() === '255,255,255,0,0,0', `export is unchanged while proofing (${px})`);
    await T(() => window.tintwork.run('proofOff')); await page.waitForTimeout(200); const back = await sample();
    check(near(back[0], [255, 255, 255]) && near(back[1], [0, 0, 0]), 'Proof: off restores the view');
  }
}

console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(' | ')}` : 'no page errors');
check(!errors.length, 'no page errors');
await browser.close(); server.close();
console.log(`\n${count - fails}/${count} passed`); process.exit(fails ? 1 : 0);
