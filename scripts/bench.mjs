// Tintwork v0.6 benchmark: CPU (Canvas 2D + worker) vs WebGL2 vs WebGPU on the same tasks at 12 MP and 24 MP,
// plus a banding check (8-bit vs 16-bit).
// Usage: node scripts/bench.mjs [chromium|webkit|all] [--sizes=12,24]
// IMPORTANT: headless browsers on a machine without a GPU run both GPU APIs on a *software* rasteriser
// (Chromium: SwiftShader for WebGL2 and WebGPU; WebKit on Linux: a software GL). GPU numbers here are a
// lower bound and are not representative of a real Windows GPU. Each result records the adapter name.
import { chromium, webkit } from 'playwright';
import { createStaticServer } from './serve.mjs';

const arg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all';
const sizesArg = (process.argv.find((a) => a.startsWith('--sizes=')) || '--sizes=12,24').slice(8).split(',').map(Number);
const SIZES = { 12: [4000, 3000], 24: [6000, 4000] };
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const results = [];

async function run(name) {
  const bt = name === 'webkit' ? webkit : chromium;
  const browser = await bt.launch(name === 'chromium' ? { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] } : {});
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
  await page.goto(url); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  const engines = await page.evaluate(async () => {
    const t = window.tintwork, out = {};
    for (const [k, pref] of [['webgl', 'gpu'], ['webgpu', 'webgpu']]) {
      const e = await t.setEnginePref(pref);
      out[k] = e && e.kind === (k === 'webgl' ? 'webgl' : 'webgpu') || (e && k === 'webgl' && e.kind !== 'webgpu') ? { renderer: e.info.renderer, software: !!e.info.software, present: e.present || 'canvas' } : { error: t.gfx.reason || t.gfx.webgpuReason || 'unavailable' };
    }
    return out;
  });
  console.log(`\n== ${name}\n  WebGL2: ${engines.webgl.renderer || engines.webgl.error}${engines.webgl.software ? ' (SOFTWARE)' : ''}\n  WebGPU: ${engines.webgpu.renderer || engines.webgpu.error}${engines.webgpu.software ? ' (SOFTWARE)' : ''}${engines.webgpu.present ? `, output ${engines.webgpu.present}` : ''}`);
  for (const mp of sizesArg) {
    const [W, H] = SIZES[mp];
    const r = { mp };
    for (const eng of ['cpu', 'webgl', 'webgpu']) {
      if (eng !== 'cpu' && engines[eng].error) { r[eng] = { error: engines[eng].error }; continue; }
      r[eng] = await page.evaluate(async ({ W, H, eng }) => {
        const t = window.tintwork, out = {};
        const e = await t.setEnginePref(eng === 'cpu' ? 'cpu' : eng === 'webgl' ? 'gpu' : 'webgpu');
        if (e) e.setBudget(4096);
        const now = () => performance.now(), time = async (fn) => { const t0 = now(); await fn(); return Math.round(now() - t0); };
        const src = document.createElement('canvas'); src.width = W; src.height = H; const x = src.getContext('2d', { willReadFrequently: true });
        const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#203050'); g.addColorStop(0.5, '#d09060'); g.addColorStop(1, '#40e0b0'); x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 40; i++) { x.fillStyle = `hsla(${i * 37},70%,50%,0.5)`; x.fillRect((i * 997) % W, (i * 613) % H, W / 6, H / 6); }
        const img = x.getImageData(0, 0, W, H), info = { docW: W, docH: H, offX: 0, offY: 0 };
        const cur = t.defaultAdjParams('curves'); cur.rgb = [[0, 0], [64, 110], [190, 200], [255, 255]];
        // filters (ImageData in → ImageData out, includes upload + readback for the GPU engines)
        for (const [label, op, p] of [['blur25', 'gaussianBlur', { radius: 25 }], ['curves', 'curves', cur]]) {
          if (e) await t.ops.process(op, img, p, info, null); // warm-up: shader compile + allocation
          out[label] = await time(() => t.ops.process(op, img, p, info, null));
          out[`${label}_path`] = t.ops.lastOpPath() === 'gpu' ? t.ops.lastOpKind() : 'cpu';
        }
        // 10-layer composite (full-size layers, mixed blend modes, two masked)
        t.newDocument(W, H, 'white');
        const d = t.doc, blends = ['source-over', 'multiply', 'screen', 'overlay', 'soft-light', 'difference', 'color', 'luminosity', 'darken', 'lighten'];
        for (let i = 0; i < 10; i++) {
          const l = t.createLayer(`L${i}`, W, H, { blend: blends[i], opacity: 0.7 });
          l.canvas.getContext('2d').drawImage(src, (i * 50) % 200, 0);
          if (i % 5 === 2) { const m = document.createElement('canvas'); m.width = W; m.height = H; const mc = m.getContext('2d'); mc.fillRect(0, 0, W / 2, H); l.mask = { canvas: m, enabled: true, rev: 900000 + i }; }
          d.layers.push(l); t.touch(l);
        }
        const target = document.createElement('canvas'); target.width = W; target.height = H; const tc = target.getContext('2d', { willReadFrequently: true }); const flush = () => tc.getImageData(0, 0, 1, 1);
        const comp = async () => {
          if (eng === 'webgpu') await e.compositeAsync(t.gpuLayerList(d), W, H, tc, { background: null });
          else t.composite(target, eng === 'cpu' ? { cpu: true } : {});
          flush();
        };
        out.comp_cold = await time(comp);
        t.touch(d.layers[5]); out.comp_warm = await time(comp); // one layer changed
        if (e) out.gpu_mem_mb = Math.round(e.usedMB);
        // large brush stroke: 400 px soft brush across the canvas, mouse samples every 8 px (≈63 dabs)
        d.layers.length = 1; const bl = t.createLayer('stroke', W, H); d.layers.push(bl); d.activeId = bl.id; t.touch(bl);
        const pts = []; for (let px = 500; px <= 3500; px += 8) pts.push({ x: px, y: H / 2 + Math.sin(px / 300) * 300 });
        t.state.opts.brushSize = 400; t.state.opts.brushHardness = 50; t.state.opts.smoothing = 0;
        if (eng === 'webgpu' && !e.syncOutput) {
          // the in-app stroke needs synchronous output; measure the same dabs through the async engine call
          const c = bl.canvas, step = 400 * 0.12; let last = pts[0], dabs = [[pts[0].x, pts[0].y]];
          const t0 = now();
          const flushDabs = async () => {
            if (!dabs.length) return;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [dx, dy] of dabs) { x0 = Math.min(x0, dx - 201); y0 = Math.min(y0, dy - 201); x1 = Math.max(x1, dx + 201); y1 = Math.max(y1, dy + 201); }
            x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
            const f = new Float32Array(dabs.length * 4); dabs.forEach(([dx, dy], i) => f.set([dx, dy, 200, 0.5], i * 4));
            await e.stampDabsAsync(c, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, f, new Float32Array(dabs.length).fill(1), { color: [232, 85, 58] }); dabs = [];
          };
          await flushDabs();
          let acc = 0;
          for (let i = 1; i < pts.length; i++) { const p = pts[i]; acc += Math.hypot(p.x - last.x, p.y - last.y); while (acc >= step) { acc -= step; dabs.push([p.x, p.y]); } last = p; if (dabs.length) await flushDabs(); }
          out.brush = Math.round(now() - t0); out.brush_path = 'webgpu (async engine call)';
        } else {
          out.brush = await time(() => { out.brush_path = t.paintStroke(pts).dabPath; flush(); });
        }
        d.layers.length = 1; target.width = target.height = 0; src.width = src.height = 0;
        return out;
      }, { W, H, eng });
    }
    results.push({ browser: name, engines, ...r });
    console.log(`${mp} MP`, JSON.stringify(r));
  }
  // Banding: smooth 16-bit ramp 100..140 (of 255) across 4096 px, heavy curve stretching it to full range.
  const band = await page.evaluate(async () => {
    const t = window.tintwork, W = 4096, H = 8; await t.setEnginePref('cpu');
    const ramp = t.createDeep(W, H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, v = Math.round((100 + 40 * x / (W - 1)) * 257); ramp.data[i] = ramp.data[i + 1] = ramp.data[i + 2] = v; ramp.data[i + 3] = 65535; }
    const cur = t.defaultAdjParams('curves'); cur.rgb = [[0, 0], [100, 0], [120, 140], [140, 255], [255, 255]];
    const res = {};
    const img8 = t.deepToImageData(ramp); const o8 = await t.ops.process('curves', img8, cur, { docW: W, docH: H, offX: 0, offY: 0 }, null);
    const s8 = new Set(); for (let x = 0; x < W; x++) s8.add(o8.data[x * 4]); res.levels8 = s8.size;
    const o16 = await t.ops.processDeep('curves', ramp, cur, {}, null);
    const s16 = new Set(); for (let x = 0; x < W; x++) s16.add(o16.data[x * 4]); res.levels16 = s16.size;
    const r8 = t.deepToImageData(o16), dth = t.deepToImageData(o16, { dither: true });
    const sr = new Set(); for (let x = 0; x < W; x++) sr.add(r8.data[x * 4]); res.levels16to8 = sr.size;
    let sum = 0; for (let x = 0; x < W; x++) sum += Math.abs(dth.data[x * 4] - o16.data[x * 4] / 257); res.ditherMeanErr = +(sum / W).toFixed(3);
    await t.setEnginePref('auto');
    return res;
  });
  results.push({ browser: name, banding: band });
  console.log('banding', JSON.stringify(band));
  await browser.close();
}
for (const b of arg === 'all' ? ['chromium', 'webkit'] : [arg]) await run(b);
server.close();
console.log('\nJSON', JSON.stringify(results));
