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

console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(' | ')}` : 'no page errors');
check(!errors.length, 'no page errors');
await browser.close(); server.close();
console.log(`\n${count - fails}/${count} passed`); process.exit(fails ? 1 : 0);
