// 24 MP performance profile (CPU engine in headless Chromium): adjustment-layer slider drag, destructive
// adjustment, brush stroke, layer visibility toggle, pan/zoom, open-to-first-frame and export.
// Usage: node scripts/perf.mjs [engine=cpu] [--json out.json]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { createStaticServer } from './serve.mjs';
const eng = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'cpu';
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=8192'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addInitScript((e) => localStorage.setItem('tintwork.engine', e), eng);
const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
const W = 6000, H = 4000;
const res = await page.evaluate(async ({ W, H }) => {
  const t = window.tintwork; await t.gfx.ready; const out = {};
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[s.length >> 1]); };
  const frame = async () => { t.markDirty(); const t0 = performance.now(); t.renderNow(); await t.idle(); await t.compositeSettled(); t.renderNow(); return performance.now() - t0; };
  // open: a 24 MP photo-like image as a JPEG file
  const src = document.createElement('canvas'); src.width = W; src.height = H; const c = src.getContext('2d');
  const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#2a4d6e'); g.addColorStop(0.5, '#d8a868'); g.addColorStop(1, '#40603a'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  for (let i = 0; i < 400; i++) { c.fillStyle = `hsla(${i * 37 % 360},50%,50%,0.3)`; c.beginPath(); c.arc((i * 7919) % W, (i * 104729) % H, 40 + (i % 9) * 30, 0, 7); c.fill(); }
  const blob = await new Promise((r) => src.toBlob(r, 'image/jpeg', 0.9)); const file = new File([blob], 'perf24.jpg', { type: 'image/jpeg' });
  let t0 = performance.now(); await t.openFile(file); t.renderNow(); out.open = Math.round(performance.now() - t0);
  out.engine = t.gfx.engine ? (t.gfx.engine.kind || 'webgl') : 'cpu';
  // pan / zoom (no recomposite)
  const pz = []; for (let i = 0; i < 10; i++) { t.state.panX += 13; t.state.zoom *= i % 2 ? 1.1 : 0.9; const a = performance.now(); t.renderNow(); pz.push(performance.now() - a); }
  out.panZoom = med(pz);
  // a second pixel layer + layer toggle
  t.run('layerNew'); const top = t.activeLayer(); const tc = top.canvas.getContext('2d'); tc.fillStyle = 'rgba(255,0,0,0.4)'; tc.fillRect(1000, 1000, 3000, 2000); t.touch(top); await frame();
  const tg = []; for (let i = 0; i < 6; i++) { top.visible = !top.visible; t.touch(top); tg.push(await frame()); }
  out.layerToggle = med(tg);
  // adjustment layer slider drag
  const adj = t.addAdj('brightnessContrast', { brightness: 0, contrast: 0 }, 'BC'); await frame();
  // as the adjustment dialog does: each slider step marks the change interactive (proxy preview)
  const sd = []; for (let i = 1; i <= 6; i++) { t.adjInteractive(); adj.adj = { type: 'brightnessContrast', params: { brightness: i * 5, contrast: i * 2 } }; sd.push(await frame()); }
  out.adjLayerDrag = med(sd);
  const s0 = performance.now(); await new Promise((r) => setTimeout(r, 260)); await frame(); out.adjLayerSettleFull = Math.round(performance.now() - s0);
  // full recomposite with the adjustment cached (e.g. after a layer move)
  const fr = []; for (let i = 0; i < 4; i++) fr.push(await frame()); out.fullRecompositeCached = med(fr);
  // destructive adjustment on the 24 MP layer (worker), incl. history snapshot
  t.state.doc.activeId = t.state.doc.layers[0].id;
  const da = []; for (let i = 0; i < 3; i++) { const a = performance.now(); await t.applyAdjustDirect('brightnessContrast', { brightness: 3, contrast: 0 }); await t.idle(); da.push(performance.now() - a); }
  out.adjustApply = med(da);
  out.heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
  t.fitToScreen(); t.setTool('brush'); t.state.opts.brushSize = 120; t.renderNow();
  return out;
}, { W, H });
// brush stroke with the real mouse: time per pointer move (incl. frame)
const box = await page.locator('#viewport').boundingBox();
await page.mouse.move(box.x + 200, box.y + 300); await page.mouse.down();
const steps = 40, t0 = Date.now();
for (let i = 0; i < steps; i++) { await page.mouse.move(box.x + 200 + i * 15, box.y + 300 + Math.sin(i / 5) * 80); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); }
const strokeMs = Date.now() - t0; const u0 = Date.now(); await page.mouse.up();
await page.evaluate(() => window.tintwork.idle()); res.brushPerMove = Math.round(strokeMs / steps); res.brushCommit = Date.now() - u0;
const ex = await page.evaluate(async () => { const t = window.tintwork, s = t.memorySink(), a = performance.now(); await t.exportVariants([{ mode: 'original', type: 'image/jpeg', quality: 90 }], { sink: s }); return Math.round(performance.now() - a); });
res.exportJpeg = ex; res.errors = errors;
console.log(JSON.stringify(res, null, 1));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(res, null, 1));
await browser.close(); server.close();
