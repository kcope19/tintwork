// Tintwork image-math audit: checks the real compositing / adjustment / export pipeline against reference
// formulas written independently here (W3C Compositing and Blending Level 1 for blend modes, the usual levels
// formula, Rec. 709 luma, 16-bit PNG byte layout from the PNG spec). Run: node scripts/math-audit.mjs [--json out.json]
import { chromium } from 'playwright';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { createStaticServer } from './serve.mjs';

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}/?platform=win`;
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL); await page.waitForFunction(() => window.tintwork && window.tintwork.newDocument);
const results = []; let fails = 0;
const check = (ok, msg) => { results.push({ ok: !!ok, msg }); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// --- reference blend formulas (W3C Compositing Level 1, separable modes; b = backdrop, s = source, 0..1)
const REF = {
  multiply: (b, s) => b * s, screen: (b, s) => b + s - b * s,
  overlay: (b, s) => REF['hard-light'](s, b), darken: Math.min, lighten: Math.max,
  'color-dodge': (b, s) => (b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'hard-light': (b, s) => (s <= 0.5 ? b * 2 * s : REF.screen(b, 2 * s - 1)),
  'soft-light': (b, s) => { if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b); const D = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b); return b + (2 * s - 1) * (D - b); },
  difference: (b, s) => Math.abs(b - s), exclusion: (b, s) => b + s - 2 * b * s,
};
const PAIRS = [[[200, 60, 30], [90, 180, 240]], [[40, 128, 250], [128, 30, 200]], [[255, 0, 128], [64, 255, 191]]];

for (const depth of [8, 16]) {
  for (const mode of Object.keys(REF)) {
    for (const opacity of [1, 0.5]) {
      const got = await page.evaluate(async ({ PAIRS, mode, depth, opacity }) => {
        const t = window.tintwork, out = [];
        for (const [B, S] of PAIRS) {
          t.newDocument(8, 8, 'white', 'math');
          if (depth === 16) t.run('mode16');
          const bg = t.activeLayer(); const c = bg.canvas.getContext('2d'); c.fillStyle = `rgb(${B})`; c.fillRect(0, 0, 8, 8); t.touch(bg);
          if (depth === 16) { const d = t.createDeep(8, 8); for (let i = 0; i < 64; i++) { d.data.set([B[0] * 257, B[1] * 257, B[2] * 257, 65535], i * 4); } t.setDeep(bg, d); }
          t.run('layerNew'); const top = t.activeLayer(); const k = top.canvas.getContext('2d'); k.fillStyle = `rgb(${S})`; k.fillRect(0, 0, top.canvas.width, top.canvas.height); t.touch(top);
          if (depth === 16) { const d = t.createDeep(top.canvas.width, top.canvas.height); for (let i = 0; i < d.width * d.height; i++) d.data.set([S[0] * 257, S[1] * 257, S[2] * 257, 65535], i * 4); t.setDeep(top, d); }
          top.blend = mode; top.opacity = opacity; t.markDirty(); t.renderNow(); await t.compositeSettled?.();
          if (depth === 16) { const d = t.compositeDeepDoc(); out.push([...d.data.slice(4 * 9, 4 * 9 + 3)].map((v) => v / 65535)); }
          else out.push([...t.compositeCanvas().getContext('2d').getImageData(1, 1, 1, 1).data.slice(0, 3)].map((v) => v / 255));
        }
        return out;
      }, { PAIRS, mode, depth, opacity });
      let worst = 0;
      PAIRS.forEach(([B, S], i) => { for (let ch = 0; ch < 3; ch++) { const b = B[ch] / 255, s = S[ch] / 255, ref = (1 - opacity) * b + opacity * REF[mode](b, s); worst = Math.max(worst, Math.abs(ref - got[i][ch])); } });
      const tol = depth === 8 ? 1.1 / 255 : 2 / 65535 + 1e-6; // 8-bit: the browser's canvas rounds intermediates (≤ 1.04 levels); exclusion is exact (v1.8)
      check(worst <= tol, `${depth}-bit ${mode} @ ${opacity * 100}% matches W3C formula (worst error ${(worst * (depth === 8 ? 255 : 65535)).toFixed(2)} ${depth === 8 ? '/255' : '/65535'})`);
    }
  }
}

// --- adjustments against reference formulas
const adj = await page.evaluate(async () => {
  const px = await import('./src/pixels.js');
  const ramp = () => { const img = new ImageData(256, 1); for (let v = 0; v < 256; v++) img.data.set([v, v, v, 255], v * 4); return img; };
  const read = (img) => Array.from({ length: 256 }, (_, v) => img.data[v * 4]);
  const levels = read(px.adjustments.levels(ramp(), { inBlack: 20, inWhite: 230, gamma: 1.6, outBlack: 10, outWhite: 245 }));
  const invert = read(px.adjustments.invert(ramp()));
  const g = new ImageData(3, 1); g.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]); px.adjustments.grayscale(g);
  return { levels, invert, gray: [g.data[0], g.data[4], g.data[8]] };
});
const refLevels = Array.from({ length: 256 }, (_, v) => { const x = Math.min(1, Math.max(0, (v - 20) / 210)) ** (1 / 1.6); return 10 + x * 235; });
check(adj.levels.every((v, i) => Math.abs(v - refLevels[i]) <= 1), `levels (20/230, γ 1.6, out 10/245) within 1 level of the reference at all 256 inputs (max err ${Math.max(...adj.levels.map((v, i) => Math.abs(v - refLevels[i]))).toFixed(2)})`);
check(adj.invert.every((v, i) => v === 255 - i), 'invert is exactly 255 − v');
check(Math.abs(adj.gray[0] - 0.2126 * 255) <= 1 && Math.abs(adj.gray[1] - 0.7152 * 255) <= 1 && Math.abs(adj.gray[2] - 0.0722 * 255) <= 1, `grayscale uses Rec. 709 luma (R,G,B → ${adj.gray.join(', ')})`);

// --- 16-bit PNG export keeps 16-bit values (decoded here with an independent PNG reader)
const png = await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(256, 4, 'white', 'deep'); t.run('mode16');
  const d = t.createDeep(256, 4); for (let y = 0; y < 4; y++) for (let x = 0; x < 256; x++) { const v = x * 256 + y * 17 + 3; d.data.set([v, 65535 - v, (v * 7) & 0xffff, 65535], (y * 256 + x) * 4); }
  t.setDeep(t.activeLayer(), d); t.markDirty(); t.renderNow();
  const blob = await t.renderExport('image/png16', 1);
  return { bytes: [...new Uint8Array(await blob.arrayBuffer())], want: [...d.data] };
});
function decodePNG16(buf) {
  let p = 8, w, h, depth, ctype; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len); if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; } if (type === 'IDAT') idat.push(data); p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), ch = { 2: 3, 6: 4, 0: 1, 4: 2 }[ctype], bpp = ch * depth / 8, stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)); for (let i = 0; i < stride; i++) { const a = i >= bpp ? out[y * stride + i - bpp] : 0, b = y ? out[(y - 1) * stride + i] : 0, c = y && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0; let v = line[i]; if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } out[y * stride + i] = v & 255; } }
  return { w, h, depth, ch, px: (x, y, k) => out.readUInt16BE(y * stride + (x * ch + k) * 2) };
}
const dec = decodePNG16(Buffer.from(png.bytes));
let mism = 0; const distinct = new Set();
for (let y = 0; y < 4; y++) for (let x = 0; x < 256; x++) for (let k = 0; k < 3; k++) { const v = dec.px(x, y, k); distinct.add(v); if (v !== png.want[(y * 256 + x) * 4 + k]) mism++; }
check(dec.depth === 16, `PNG 16-bit export has bit depth ${dec.depth}`);
check(mism === 0, `16-bit PNG round-trip is exact (${mism} mismatched samples of ${256 * 4 * 3}; ${distinct.size} distinct values)`);
check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);

const outArg = process.argv.indexOf('--json'); if (outArg > 0) fs.writeFileSync(process.argv[outArg + 1], JSON.stringify({ date: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.length - fails}/${results.length} math checks passed`);
await browser.close(); server.close(); process.exit(fails ? 1 : 0);
