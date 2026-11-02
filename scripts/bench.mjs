// Tintwork v0.5 benchmark: GPU (WebGL2) vs CPU paths at 12 MP and 24 MP, plus a banding check (8-bit vs 16-bit).
// Usage: node scripts/bench.mjs [chromium|webkit|all] [--sizes=12,24]
// Headless browsers on a machine without a GPU render WebGL with a *software* rasteriser (Chromium: SwiftShader;
// WebKit on Linux: Mesa llvmpipe), so GPU numbers here are a lower bound for real hardware.
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
  const browser = await bt.launch(name === 'chromium' ? { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : {});
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
  await page.goto(url); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  const info = await page.evaluate(() => { window.tintwork.setEnginePref('gpu'); const e = window.tintwork.engine; return e ? e.info : { error: window.tintwork.gfx.reason }; });
  console.log(`\n== ${name}: ${info.renderer || info.error}${info.software ? ' (software GL)' : ''} max texture ${info.maxTextureSize}`);
  for (const mp of sizesArg) {
    const [W, H] = SIZES[mp];
    const r = await page.evaluate(async ({ W, H }) => {
      const t = window.tintwork, e = t.engine, out = {};
      e && e.setBudget(4096);
      const now = () => performance.now();
      const src = document.createElement('canvas'); src.width = W; src.height = H; const x = src.getContext('2d', { willReadFrequently: true });
      const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#203050'); g.addColorStop(0.5, '#d09060'); g.addColorStop(1, '#40e0b0'); x.fillStyle = g; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 40; i++) { x.fillStyle = `hsla(${i * 37},70%,50%,0.5)`; x.fillRect((i * 997) % W, (i * 613) % H, W / 6, H / 6); }
      const img = x.getImageData(0, 0, W, H), info = { docW: W, docH: H, offX: 0, offY: 0 };
      const cur = t.defaultAdjParams('curves'); cur.rgb = [[0, 0], [64, 110], [190, 200], [255, 255]];
      const time = async (fn) => { const t0 = now(); await fn(); return Math.round(now() - t0); };
      for (const [label, op, p] of [['blur25', 'gaussianBlur', { radius: 25 }], ['curves', 'curves', cur]]) {
        if (e) { t.ops.setAccelerator(e); await t.ops.process(op, img, p, info, null); out[`${label}_gpu`] = await time(() => t.ops.process(op, img, p, info, null)); out[`${label}_gpu_path`] = t.ops.lastOpPath(); }
        t.ops.setAccelerator(null); out[`${label}_cpu`] = await time(() => t.ops.process(op, img, p, info, null));
        t.ops.setAccelerator(e || null);
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
      const target = document.createElement('canvas'); const flush = () => target.getContext('2d').getImageData(0, 0, 1, 1);
      if (e) {
        out.comp_gpu_cold = await time(() => { t.composite(target); flush(); });
        t.touch(d.layers[5]); out.comp_gpu_warm1 = await time(() => { t.composite(target); flush(); }); // one layer changed
        out.comp_gpu_mem = Math.round(e.usedMB);
      }
      out.comp_cpu = await time(() => { t.composite(target, { cpu: true }); flush(); });
      d.layers.length = 1; target.width = target.height = 0; src.width = src.height = 0;
      return out;
    }, { W, H });
    results.push({ browser: name, renderer: info.renderer, software: !!info.software, mp, ...r });
    console.log(`${mp} MP`, JSON.stringify(r));
  }
  // Banding: smooth 16-bit ramp 100..140 (of 255) across 4096 px, heavy curve stretching it to full range.
  const band = await page.evaluate(async () => {
    const t = window.tintwork, W = 4096, H = 8;
    const ramp = t.createDeep(W, H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, v = Math.round((100 + 40 * x / (W - 1)) * 257); ramp.data[i] = ramp.data[i + 1] = ramp.data[i + 2] = v; ramp.data[i + 3] = 65535; }
    const cur = t.defaultAdjParams('curves'); cur.rgb = [[0, 0], [100, 0], [120, 140], [140, 255], [255, 255]];
    const res = {};
    // 8-bit pipeline: ramp quantised to 8 bits, then curves
    const img8 = t.deepToImageData(ramp); const o8 = await t.ops.process('curves', img8, cur, { docW: W, docH: H, offX: 0, offY: 0 }, null);
    const s8 = new Set(); for (let x = 0; x < W; x++) s8.add(o8.data[x * 4]); res.levels8 = s8.size;
    const o16 = await t.ops.processDeep('curves', ramp, cur, {}, null);
    const s16 = new Set(); for (let x = 0; x < W; x++) s16.add(o16.data[x * 4]); res.levels16 = s16.size;
    // what reaches an 8-bit screen/file: plain rounding vs dithered
    const r8 = t.deepToImageData(o16), dth = t.deepToImageData(o16, { dither: true });
    const sr = new Set(); for (let x = 0; x < W; x++) sr.add(r8.data[x * 4]); res.levels16to8 = sr.size;
    // longest run of identical values (band width in px) in the output row
    const run = (arr, step) => { let best = 1, cur = 1; for (let x = 1; x < W; x++) { if (arr[x * step] === arr[(x - 1) * step]) { cur++; best = Math.max(best, cur); } else cur = 1; } return best; };
    res.maxBand8px = run(o8.data, 4); res.maxBand16to8px = run(r8.data, 4);
    let sum = 0; for (let x = 0; x < W; x++) sum += Math.abs(dth.data[x * 4] - o16.data[x * 4] / 257); res.ditherMeanErr = +(sum / W).toFixed(3);
    return res;
  });
  results.push({ browser: name, banding: band });
  console.log('banding', JSON.stringify(band));
  await browser.close();
}
for (const b of arg === 'all' ? ['chromium', 'webkit'] : [arg]) await run(b);
server.close();
console.log('\nJSON', JSON.stringify(results));
