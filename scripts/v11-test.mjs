// v1.1 test: PSD/PSB import + export (Node-side codec checks, third-party fixtures, browser round trips),
// camera RAW (synthesized DNGs with lens opcodes and an undecodable one with an embedded JPEG, the CC0 samples in
// test-assets/raw-samples/ when present: per-format decode + 24 MP open → display timing), develop dialog,
// file wiring (input accept, picker types, manifest file_handlers, service worker), batch. Screenshots: 11x-*.png.
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createStaticServer } from './serve.mjs';
import { findEmbeddedJpeg } from '../src/raw.js';
import { readPSD, writePSD, decodeAdjustment, encodeAdjustment, blendFromKey, BLEND_TO_PSD } from '../src/psd.js';

let fails = 0; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const T0 = Date.now();

// ---------------------------------------------------------------------------------------------------------
// 1. Node-side PSD codec
// ---------------------------------------------------------------------------------------------------------
const rgba = (w, h, f, Arr = Uint8Array) => { const a = new Arr(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set(f(x, y), (y * w + x) * 4); return a; };
const eq = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
for (const depth of [8, 16]) {
  const M = depth === 16 ? 65535 : 255, Arr = depth === 16 ? Uint16Array : Uint8Array, W = 64, H = 48;
  const bgPix = rgba(W, H, (x, y) => [Math.round((x / 63) * M), Math.round((y / 47) * M), depth === 16 ? 12345 : 77, M], Arr);
  const disc = rgba(20, 16, (x, y) => [M, Math.round(M / 3), x * 7 + (depth === 16 ? 1000 : 0), (x + y) % 3 ? M : 0], Arr);
  const mask = Uint8Array.from({ length: 20 * 16 }, (_, i) => (i * 13) & 255);
  const curves = encodeAdjustment('curves', { rgb: [[0, 0], [128, 170], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] });
  const doc = { width: W, height: H, depth, dpi: 240, composite: bgPix, layers: [
    { name: 'Background', top: 0, left: 0, width: W, height: H, opacity: 1, visible: true, blendKey: 'norm', pixels: bgPix },
    { name: '</Layer group>', section: 3, opacity: 1, visible: true, blendKey: 'norm' },
    { name: 'Disc ✓ ünïcode', top: 5, left: -3, width: 20, height: 16, opacity: 0.5, visible: false, blendKey: 'mul ', clipping: false, pixels: disc, mask: { top: 5, left: -3, width: 20, height: 16, data: mask, defaultColor: 0, disabled: true } },
    { name: 'Clipped', top: 10, left: 10, width: 20, height: 16, opacity: 1, visible: true, blendKey: 'scrn', clipping: true, pixels: disc },
    { name: 'Group', section: 1, opacity: 0.6, visible: true, blendKey: 'pass', sectionBlend: 'pass', mask: { top: 0, left: 0, width: W, height: H, data: new Uint8Array(W * H).fill(200), defaultColor: 255 } },
    { name: 'Curves', opacity: 0.9, visible: true, blendKey: 'norm', adjKey: curves[0], adjData: curves[1] },
  ] };
  const t = performance.now(), bytes = writePSD(doc), tw = performance.now() - t, back = readPSD(bytes);
  const L = back.layers;
  check(back.width === W && back.height === H && back.depth === depth && back.dpi === 240 && L.length === 6, `PSD ${depth}-bit: header, resolution and 6 layer records survive the round trip (${bytes.length} bytes, ${tw.toFixed(0)} ms)`);
  check(eq(L[0].pixels, bgPix) && eq(L[2].pixels, disc) && L[2].left === -3 && L[2].top === 5 && eq(back.composite.data, bgPix), `PSD ${depth}-bit: layer pixels (incl. off-canvas offset) and composite are bit-exact`);
  check(eq(L[2].mask.data, mask) && L[2].mask.disabled && L[4].mask.defaultColor === 255 && L[4].mask.data[0] === 200, `PSD ${depth}-bit: layer and group masks (data, disabled flag, default colour)`);
  check(L[2].name === 'Disc ✓ ünïcode' && Math.abs(L[2].opacity - 0.5) < 0.003 && !L[2].visible && L[2].blendKey.trim() === 'mul' && L[3].clipping && L[3].blendKey === 'scrn',
    `PSD ${depth}-bit: unicode name, opacity, hidden, blend mode, clipping`);
  check(L[1].kind === 'divider' && L[4].kind === 'group' && L[4].section === 1 && L[4].sectionBlend === 'pass' && Math.abs(L[4].opacity - 0.6) < 0.003, `PSD ${depth}-bit: group open/close markers with pass-through blend`);
  const cv = decodeAdjustment(L[5].adjKey, L[5].adjData);
  check(L[5].kind === 'adjust' && cv.type === 'curves' && JSON.stringify(cv.params.rgb) === '[[0,0],[128,170],[255,255]]', `PSD ${depth}-bit: curves adjustment layer (${JSON.stringify(cv.params.rgb)})`);
}
{ // adjustment codecs
  const cases = [['invert', {}], ['brightnessContrast', { brightness: 25, contrast: -30 }], ['exposure', { exposure: 1.25, offset: -0.02, gamma: 1.1 }], ['hueSaturation', { hue: 40, saturation: -20, lightness: 10 }],
    ['levels', { inBlack: 12, inWhite: 230, gamma: 1.4, outBlack: 5, outWhite: 250 }], ['curves', { rgb: [[0, 10], [100, 140], [255, 240]], r: [[0, 0], [200, 255]], g: [[0, 0], [255, 255]], b: [[30, 0], [255, 255]] }]];
  const res = cases.map(([type, p]) => { const e = encodeAdjustment(type, p); const d = e && decodeAdjustment(e[0], e[1]); return [type, !!e && d?.type === type && Object.entries(p).every(([k, v]) => JSON.stringify(d.params[k]) === JSON.stringify(v) || Math.abs(d.params[k] - v) < 0.01)]; });
  check(res.every((r) => r[1]), `adjustment layers encode/decode to the same values: ${res.map((r) => `${r[0]} ${r[1] ? '✓' : '✗'}`).join(', ')}`);
  const g = encodeAdjustment('grayscale', {}), gd = decodeAdjustment(g[0], g[1]);
  check(gd.type === 'hueSaturation' && gd.params.saturation === -100 && encodeAdjustment('lut3d', {}) === null && encodeAdjustment('whiteBalance', {}) === null, 'grayscale exports as hue/saturation −100; 3D LUT and white balance have no PSD equivalent (null)');
  const bl = ['norm', 'mul ', 'scrn', 'over', 'diff', 'lum ', 'pass'].map((k) => blendFromKey(k));
  const ap = ['lbrn', 'lddg', 'vLit', 'fsub'].map((k) => blendFromKey(k));
  check(bl.every((b) => !b.approx) && bl[1].blend === 'multiply' && bl[6].blend === 'pass-through' && ap.every((b) => b.approx && b.name) && BLEND_TO_PSD.multiply === 'mul ' && BLEND_TO_PSD['source-over'] === 'norm',
    `blend modes map both ways; PSD-only modes are approximated (${ap.map((b) => `${b.name}→${b.blend}`).join(', ')})`);
}
{ // third-party writer fixtures (ag-psd) and broken files
  for (const f of ['third-party-features.psd', 'third-party-features.psb']) {
    const p = readPSD(new Uint8Array(readFileSync(`test-assets/psd/${f}`))), k = Object.fromEntries(p.layers.map((l) => [l.name, l]));
    check(p.version === (f.endsWith('psb') ? 2 : 1) && p.layers.length === 12 && k['Title text'].kind === 'text' && k['Placed photo'].kind === 'smart' && !!k.Shadowed.effects && k['Disc linear burn'].blendKey === 'lbrn' &&
      k['Group with mask'].kind === 'group' && k['Group with mask'].mask?.defaultColor === 255 && k.Clipped.clipping && k.Brightness.adjKey === 'CgEd' && k['Photo filter'].adjKey === 'phfl',
      `${f} (independent writer): ${p.layers.length} records, text / smart object / effects / group mask / clipping / adjustments detected`);
  }
  const good = new Uint8Array(readFileSync('test-assets/psd/third-party-features.psd')), bad = good.slice();
  const dv = new DataView(bad.buffer), lmStart = 26 + 4 + dv.getUint32(26) ; const resLen = dv.getUint32(lmStart - 4 + 4 - 4 + 0) ; void resLen;
  // corrupt the layer records (keep the section lengths, so the composite is still reachable)
  const cm = dv.getUint32(26), irStart = 30 + cm, ir = dv.getUint32(irStart), lm = irStart + 4 + ir; bad.fill(0xee, lm + 14, lm + 60);
  let fb; try { fb = readPSD(bad); } catch (e) { fb = { err: e.message }; }
  check(fb && !fb.err && fb.layers === null && fb.composite && fb.warnings.some((w) => /flattened/.test(w)), `damaged layer records fall back to the composite with a warning (${fb?.err || fb?.warnings?.[0]})`);
  let thrown = null; try { readPSD(new Uint8Array([1, 2, 3, 4, 5, 6])); } catch (e) { thrown = e.message; }
  check(!!thrown, `non-PSD bytes are rejected (${thrown})`);
}
{ // container-level JPEG scanner (used when the decoder cannot open a file at all)
  const files = JSON.parse(readFileSync('test-assets/raw-samples.json', 'utf8')).samples.filter((x) => existsSync(`test-assets/raw-samples/${x.local}`));
  const found = files.map((x) => { const j = findEmbeddedJpeg(new Uint8Array(readFileSync(`test-assets/raw-samples/${x.local}`))); return j ? `${x.local.split('.').pop().toUpperCase()} ${j.width}×${j.height}` : null; });
  check(found.every(Boolean), `embedded-JPEG scanner finds the camera preview in every sample (${found.join(', ') || 'no samples present'})`);
  check(findEmbeddedJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3])) === null, 'embedded-JPEG scanner ignores truncated JPEG fragments');
}

// ---------------------------------------------------------------------------------------------------------
// 2. Synthesized DNGs (written here): lens opcodes, and an undecodable one with an embedded JPEG
// ---------------------------------------------------------------------------------------------------------
function tiff(ifds) { // ifds: [{ entries: [[tag, type, values|Uint8Array]], data?: Uint8Array, sub?: index }]; little-endian
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8, 12: 8 };
  const parts = []; let off = 8;
  const layout = ifds.map((ifd) => { const n = ifd.entries.length, size = 2 + n * 12 + 4; const at = off; off += size; return { at, n }; });
  const blobs = []; const blobAt = (u8) => { const a = off; blobs.push(u8); off += u8.length + (u8.length & 1); return a; };
  const enc = (type, vals) => {
    if (vals instanceof Uint8Array) return vals;
    const b = new DataView(new ArrayBuffer(vals.length * SZ[type]));
    vals.forEach((v, i) => {
      if (type === 3) b.setUint16(i * 2, v, true); else if (type === 4) b.setUint32(i * 4, v, true);
      else if (type === 5 || type === 10) { const den = 10000; (type === 5 ? b.setUint32 : b.setInt32).call(b, i * 8, Math.round(v * den), true); b.setUint32(i * 8 + 4, den, true); }
      else if (type === 12) b.setFloat64(i * 8, v, true); else b.setUint8(i, v);
    });
    return new Uint8Array(b.buffer);
  };
  const dataAt = ifds.map((ifd) => (ifd.data ? blobAt(ifd.data) : 0));
  const resolved = ifds.map((ifd, k) => ifd.entries.map(([tag, type, vals]) => {
    if (vals === 'DATA') vals = [dataAt[k]]; else if (vals === 'DATALEN') vals = [ifd.data.length]; else if (typeof vals === 'object' && vals?.ifd != null) vals = [layout[vals.ifd].at];
    if (type === 2 && typeof vals === 'string') vals = new Uint8Array([...Buffer.from(vals + '\0')]);
    const raw = enc(type, vals), count = type === 2 || type === 7 || vals instanceof Uint8Array ? raw.length / (SZ[type] || 1) : vals.length;
    return { tag, type, count, raw, at: raw.length > 4 ? blobAt(raw) : -1 };
  }).sort((a, b) => a.tag - b.tag));
  const out = new Uint8Array(off), dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true);
  resolved.forEach((es, k) => {
    let p = layout[k].at; dv.setUint16(p, es.length, true); p += 2;
    for (const e of es) { dv.setUint16(p, e.tag, true); dv.setUint16(p + 2, e.type, true); dv.setUint32(p + 4, e.count, true); if (e.at >= 0) dv.setUint32(p + 8, e.at, true); else out.set(e.raw, p + 8); p += 12; }
    dv.setUint32(p, 0, true);
  });
  let p = layout.length ? layout[layout.length - 1].at + 2 + resolved[resolved.length - 1].length * 12 + 4 : 8; void p;
  let q = layout[layout.length - 1].at + 2 + resolved[resolved.length - 1].length * 12 + 4;
  for (const b of blobs) { out.set(b, q); q += b.length + (b.length & 1); }
  return out;
}
const be = () => { const a = []; const o = { u32: (v) => { a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return o; }, f64: (v) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v); a.push(...new Uint8Array(b.buffer)); return o; }, bytes: () => new Uint8Array(a) }; return o; };
function opcodeList(ops) {
  const w = be(); w.u32(ops.length);
  for (const op of ops) {
    const p = be();
    if (op.id === 1) { p.u32(op.planes.length); for (const pl of op.planes) [...pl.kr, ...pl.kt].forEach((v) => p.f64(v)); p.f64(op.cx).f64(op.cy); }
    if (op.id === 3) { op.k.forEach((v) => p.f64(v)); p.f64(op.cx).f64(op.cy); }
    const pb = p.bytes(); w.u32(op.id).u32(0x01030000).u32(op.optional ? 1 : 0).u32(pb.length); for (const b of pb) w.bytes; const head = w.bytes(); void head; op._p = pb; // appended below
    ops._chunks = (ops._chunks || []).concat([pb]);
  }
  // rebuild in one pass (header + params interleaved)
  const out = be(); out.u32(ops.length); const chunks = [];
  ops.forEach((op, i) => { out.u32(op.id).u32(0x01030000).u32(op.optional ? 1 : 0).u32(ops._chunks[i].length); chunks.push([out.bytes().length, ops._chunks[i]]); for (const b of ops._chunks[i]) out.u32; });
  const parts = []; let h = be(); h.u32(ops.length); parts.push(h.bytes());
  ops.forEach((op, i) => { const x = be(); x.u32(op.id).u32(0x01030000).u32(op.optional ? 1 : 0).u32(ops._chunks[i].length); parts.push(x.bytes(), ops._chunks[i]); });
  const len = parts.reduce((s, x) => s + x.length, 0), u = new Uint8Array(len); let o = 0; for (const x of parts) { u.set(x, o); o += x.length; }
  return u;
}
const XYZ2SRGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
function makeDNG({ W = 720, H = 480, lens = true, compression = 1, preview = null, scene }) {
  const neutral = [0.5, 1, 0.7], black = 256, white = 16383, k0 = 0.6;
  const cfa = new Uint8Array(W * H * 2), dv = new DataView(cfa.buffer), cx = (W - 1) / 2, cy = (H - 1) / 2, rmax = Math.hypot(cx, cy);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : ((x & 1) === 0 ? 1 : 2), r2 = ((x - cx) ** 2 + (y - cy) ** 2) / rmax ** 2;
    const v = scene(x, y)[c] * neutral[c] / (lens ? 1 + k0 * r2 : 1); // vignetted by exactly what the opcode undoes
    dv.setUint16((y * W + x) * 2, Math.max(0, Math.min(white, Math.round(black + v * (white - black)))), true);
  }
  const cm = XYZ2SRGB.map((v, i) => v * neutral[Math.floor(i / 3)]);
  const rawEntries = [[254, 4, [0]], [256, 4, [W]], [257, 4, [H]], [258, 3, [16]], [259, 3, [compression]], [262, 3, [32803]], [273, 4, 'DATA'], [277, 3, [1]], [278, 4, [H]], [279, 4, 'DATALEN'], [284, 3, [1]],
    [33421, 3, [2, 2]], [33422, 1, [0, 1, 1, 2]], [50714, 4, [black]], [50717, 4, [white]]];
  if (lens) rawEntries.push([51022, 7, opcodeList([{ id: 1, planes: [{ kr: [1, 0.06, 0, 0], kt: [0, 0] }], cx: 0.5, cy: 0.5 }, { id: 3, k: [k0, 0, 0, 0, 0], cx: 0.5, cy: 0.5, optional: true }])]);
  const ifd0 = [[271, 2, 'Tintwork'], [272, 2, 'Synthetic DNG'], [274, 3, [1]], [50706, 1, [1, 4, 0, 0]], [50707, 1, [1, 1, 0, 0]], [50708, 2, 'Tintwork Synthetic DNG'],
    [50721, 10, cm], [50728, 5, neutral], [50778, 3, [21]]];
  if (preview) {
    ifd0.push([254, 4, [1]], [256, 4, [preview.w]], [257, 4, [preview.h]], [258, 3, [8, 8, 8]], [259, 3, [7]], [262, 3, [6]], [273, 4, 'DATA'], [277, 3, [3]], [278, 4, [preview.h]], [279, 4, 'DATALEN'], [330, 4, { ifd: 1 }]);
    return tiff([{ entries: ifd0, data: preview.jpeg }, { entries: rawEntries, data: cfa }]);
  }
  return tiff([{ entries: [...ifd0, ...rawEntries], data: cfa }]);
}
const grid = (x, y) => { const g = 0.36 + ((x >> 5) + (y >> 5)) % 2 * 0.24; const line = x % 48 < 2 || y % 48 < 2 ? 0.08 : g; return [line, line, line]; };
const lensDNG = makeDNG({ scene: grid });
if (process.env.V11_DUMP) { (await import('node:fs')).writeFileSync(process.env.V11_DUMP, lensDNG); process.exit(0); }

// ---------------------------------------------------------------------------------------------------------
// 3. Browser
// ---------------------------------------------------------------------------------------------------------
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem('tintwork.engine', 'cpu'));
const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(async () => { await window.tintwork.clearAutosave?.(); });
await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'v11in'; i.hidden = true; i.onchange = () => { window.__files = [...i.files]; }; document.body.append(i); });
const toPage = async (files) => { await page.setInputFiles('#v11in', files); await page.waitForFunction((n) => window.__files?.length === n, files.length); };
const settle = () => page.evaluate(async () => { await window.tintwork.idle(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });

// --- wiring -----------------------------------------------------------------------------------------------
{
  const w = await page.evaluate(async () => {
    const files = await import('./src/files.js'); const exts = Object.values(files.OPEN_TYPES[0].accept).flat();
    const menu = [...document.querySelectorAll('#menubar *')].some((e) => e.textContent.trim().startsWith('Export layered PSD'));
    return { input: document.querySelector('#fileInput').accept, exts, psdExport: !!files.EXPORT_TYPES['image/vnd.adobe.photoshop'], menu, ver: window.tintwork.APP_VERSION };
  });
  const need = ['.psd', '.psb', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2'];
  check(need.every((e) => w.input.includes(e) && w.exts.includes(e)) && w.psdExport && w.menu && w.ver === '1.1.0', `file input, open picker, PSD save type and "Export layered PSD…" menu item (${need.join(' ')})`);
  const man = JSON.parse(readFileSync('manifest.webmanifest', 'utf8')), acc = Object.values(man.file_handlers[0].accept).flat();
  check(need.every((e) => acc.includes(e)), 'PWA file_handlers register PSD/PSB and camera RAW extensions');
  const sw = readFileSync('sw.js', 'utf8');
  check(/tintwork-shell-v1\.1\.0/.test(sw) && ['codecs.js', 'codec-worker.js', 'psd.js', 'raw.js', 'flashraw/browser.js'].every((f) => sw.includes(f)), 'service worker cache bumped to v1.1.0 and lists the codec files');
  const lic = await page.evaluate(async () => (await fetch('./vendor/flashraw/LICENSE-MIT')).status);
  check(lic === 200 && existsSync('vendor/flashraw/LICENSE-APACHE') && /flashraw/.test(readFileSync('vendor/README.md', 'utf8')), 'FlashRaw is vendored with its licence files and listed in vendor/README.md');
}

// --- PSD: export a layered document, reopen it, compare -----------------------------------------------------
async function buildLayered(depth) {
  return page.evaluate(async (depth) => {
    const t = window.tintwork; t.newDocument(1200, 800, 'white', `poster-${depth}`);
    if (depth === 16) t.setDepth(16);
    const d = t.state.doc;
    const art = (name, w, h, x, y, draw, opts = {}) => { const l = t.createLayer(name, w, h, { x, y, ...opts }); draw(l.canvas.getContext('2d'), w, h); return l; };
    const sky = art('Sky', 1200, 800, 0, 0, (c, w, h) => { const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1d3b6a'); g.addColorStop(0.6, '#e8875a'); g.addColorStop(1, '#f6d38b'); c.fillStyle = g; c.fillRect(0, 0, w, h); });
    const grp = t.createLayer('Sun group', 1, 1, { kind: 'group', blend: 'pass-through', collapsed: false, editMask: true });
    const sun = art('Sun', 360, 360, 600, 160, (c, w) => { const g = c.createRadialGradient(w / 2, w / 2, 10, w / 2, w / 2, w / 2); g.addColorStop(0, '#fff6c8'); g.addColorStop(1, 'rgba(255,190,80,0)'); c.fillStyle = g; c.fillRect(0, 0, w, w); }, { parent: grp.id, blend: 'screen' });
    const glow = art('Glow (clipped)', 360, 360, 600, 160, (c, w) => { c.fillStyle = '#ff5a1f'; c.fillRect(0, w / 2, w, w / 2); }, { parent: grp.id, clip: true, blend: 'soft-light', opacity: 0.7 });
    const hills = art('Hills', 1200, 360, 0, 440, (c, w, h) => { c.fillStyle = '#23324a'; c.beginPath(); c.moveTo(0, h); for (let x = 0; x <= w; x += 20) c.lineTo(x, 120 + Math.sin(x / 130) * 60 + Math.sin(x / 47) * 18); c.lineTo(w, h); c.fill(); }, { blend: 'multiply', opacity: 0.92 });
    const mc = document.createElement('canvas'); mc.width = 1200; mc.height = 360; const mx = mc.getContext('2d'); const mg = mx.createLinearGradient(0, 0, 1200, 0); mg.addColorStop(0, 'rgba(255,255,255,0.35)'); mg.addColorStop(1, '#fff'); mx.fillStyle = mg; mx.fillRect(0, 0, 1200, 360);
    hills.mask = { canvas: mc, enabled: true, rev: 1 };
    if (depth === 16) { // a real 16-bit gradient (2048 levels across the sky), not an 8-bit drawing
      const W = 1200, H = 800, a = new Uint16Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y * W + x) * 4, f = y / (H - 1); a[k] = Math.round(7600 + f * 55000 + x * 3); a[k + 1] = Math.round(15200 + f * 36000); a[k + 2] = Math.round(27000 + f * 9000 - x * 2); a[k + 3] = 65535; }
      t.setDeep(sky, t.createDeep(W, H, a));
    }
    d.layers.push(sky, sun, glow, grp, hills); t.normalizeTree(d); d.activeId = hills.id;
    t.addAdj('curves', { rgb: [[0, 0], [100, 120], [255, 250]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [128, 118], [255, 255]] }, 'Warm curves');
    t.addAdj('hueSaturation', { hue: 0, saturation: 12, lightness: 0 }, 'Saturation');
    t.commit('poster'); await t.idle();
    return t.state.doc.layers.length;
  }, depth);
}
const samplePts = [[100, 100], [300, 500], [700, 300], [780, 340], [900, 700], [1150, 600], [50, 780], [640, 420]];
const compositeOf = () => page.evaluate(async (pts) => { const t = window.tintwork; await t.idle(); const o = []; for (const [x, y] of pts) o.push((await t.compositePixelAsync(x, y)).slice(0, 4)); return o; }, samplePts);
const maxDiff = (a, b) => Math.max(...a.flatMap((p, i) => p.map((v, k) => Math.abs(v - b[i][k]))));
for (const depth of [8, 16]) {
  const n = await buildLayered(depth), before = await compositeOf();
  const exp = await page.evaluate(async () => {
    const t = window.tintwork, t0 = performance.now(), { blob, notes } = await t.documentToPSD(), ms = performance.now() - t0;
    window.__psd = blob; const tree = t.state.doc.layers.map((l) => [l.name, l.kind || '', l.blend, +l.opacity.toFixed(2), l.parent == null ? '' : t.layerById(t.state.doc, l.parent).name, !!l.clip, !!l.mask, l.visible]);
    return { size: blob.size, notes, ms: Math.round(ms), tree, head: [...new Uint8Array(await blob.slice(0, 26).arrayBuffer())] };
  });
  check(exp.head[0] === 0x38 && exp.head[1] === 0x42 && exp.head[2] === 0x50 && exp.head[3] === 0x53 && exp.head[23] === depth, `PSD export ${depth}-bit: valid header (${(exp.size / 1024).toFixed(0)} KB in ${exp.ms} ms)`);
  // the file must also read back in Node with the standalone reader
  const bytes = await page.evaluate(async () => [...new Uint8Array(await window.__psd.arrayBuffer())]);
  const nodeRead = readPSD(new Uint8Array(bytes));
  check(nodeRead.depth === depth && nodeRead.layers.filter((l) => l.kind !== 'divider').length === n && nodeRead.layers.some((l) => l.kind === 'group' && l.sectionBlend === 'pass'), `PSD export ${depth}-bit: ${nodeRead.layers.length} records incl. pass-through group (Node reader)`);
  const imp = await page.evaluate(async (depth) => {
    const t = window.tintwork; await t.openFile(new File([window.__psd], `poster-${depth}.psd`)); await t.idle();
    return { tree: t.state.doc.layers.map((l) => [l.name, l.kind || '', l.blend, +l.opacity.toFixed(2), l.parent == null ? '' : t.layerById(t.state.doc, l.parent).name, !!l.clip, !!l.mask, l.visible]), depth: t.state.doc.depth || 8, notes: t.lastImport.notes, name: t.state.doc.name };
  }, depth);
  check(JSON.stringify(imp.tree) === JSON.stringify(exp.tree) && imp.depth === depth, `PSD round trip ${depth}-bit: layer tree, names, blend modes, opacity, groups, clipping, masks, visibility identical (${imp.tree.length} layers)`);
  const after = await compositeOf(), md = maxDiff(before, after);
  check(md <= (depth === 16 ? 1 : 1), `PSD round trip ${depth}-bit: composite matches (max channel difference ${md})`);
  if (depth === 16) {
    const deep = await page.evaluate(() => { const t = window.tintwork, l = t.state.doc.layers.find((x) => x.name === 'Sky'), d = t.deepOf(l); let fine = 0; for (let i = 0; i < d.data.length; i += 4) if (d.data[i] % 257) fine++; return fine; });
    check(deep > 1000, `PSD 16-bit import keeps 16-bit precision (${deep} pixels between 8-bit levels)`);
  }
  if (depth === 8) {
    await page.evaluate(() => { const t = window.tintwork; const g = t.state.doc.layers.find((l) => l.kind === 'group'); t.state.doc.activeId = g.id; g.collapsed = false; t.updateLayersPanel(); });
    await settle(); await page.screenshot({ path: 'screenshots/11x-psd-layers.png' });
  }
}
{ // styles are baked; adjustment without a PSD equivalent leaves a note; batch PSD output
  const r = await page.evaluate(async () => {
    const t = window.tintwork; t.newDocument(300, 200, 'white', 'fx');
    const l = t.createLayer('Styled', 100, 100, { x: 50, y: 50 }); l.canvas.getContext('2d').fillRect(0, 0, 100, 100);
    const d = t.state.doc; d.layers.push(l); d.activeId = l.id; l.styles = [t.defaultEffect('dropShadow')];
    t.addAdj('lut3d', t.defaultAdjParams('lut3d'), 'LUT'); t.commit('fx'); await t.idle();
    const { blob, notes } = await t.documentToPSD();
    const s = t.memorySink(); const files = [new File([blob], 'fx.psd')];
    const b = await t.runBatch(files, { variants: [{ mode: 'original', type: t.PSD_TYPE }, { mode: 'long', long: 120, type: t.PSD_TYPE }], pattern: '{name}-{w}', sink: s });
    const out = Object.keys(s.files).sort();
    const heads = await Promise.all(out.map(async (n) => [...new Uint8Array(await s.files[n].blob.slice(0, 4).arrayBuffer())].map((c) => String.fromCharCode(c)).join('')));
    return { notes, batch: { done: b.done, out, heads } };
  });
  check(r.notes.some((n) => /styles baked/i.test(n)) && r.notes.some((n) => /LUT/.test(n)), `PSD export notes: ${r.notes.join(' | ')}`);
  check(r.batch.done === 1 && r.batch.out.length === 2 && r.batch.heads.every((h) => h === '8BPS'), `batch writes PSD outputs (layered at full size, flattened when resized): ${r.batch.out.join(', ')}`);
}
{ // third-party PSD/PSB through the real file input: flattening notes, groups, masks, adjustments
  for (const f of ['third-party-features.psd', 'third-party-features.psb']) {
    await page.setInputFiles('#fileInput', `test-assets/psd/${f}`);
    await page.waitForFunction((f) => window.tintwork.state.doc?.name === f, f, { timeout: 15000 });
    await settle();
    const r = await page.evaluate(() => { const t = window.tintwork, d = t.state.doc; return { notes: d.importNotes, modal: !document.querySelector('#modal').classList.contains('hidden') && document.querySelector('#modalBody').textContent,
      layers: d.layers.map((l) => [l.name, l.kind || 'pixel', l.blend, l.parent == null ? '' : t.layerById(d, l.parent).name, !!l.clip, !!l.mask, l.adj?.type || '']) }; });
    const by = Object.fromEntries(r.layers.map((l) => [l[0], l]));
    const okTree = by['Group with mask']?.[1] === 'group' && by['Group with mask'][5] && by.Inner?.[3] === 'Group with mask' && by.Clipped?.[4] && by.Clipped?.[2] === 'multiply' && by.Brightness?.[6] === 'brightnessContrast' && by.Levels?.[6] === 'levels' && !by['Photo filter'] && by['Disc linear burn']?.[2] === 'multiply';
    const okNotes = ['Text layers', 'Smart objects', 'effects', 'Blend modes approximated', 'no Tintwork equivalent'].every((k) => r.notes.some((n) => n.includes(k)));
    check(okTree && okNotes && /converted/.test(r.modal || ''), `${f} opened: ${r.layers.length} layers, group + mask + clipping + adjustments mapped, notes shown (${r.notes.length})`);
    if (f.endsWith('.psd')) { await page.screenshot({ path: 'screenshots/11x-psd-import-notes.png' }); }
    await page.keyboard.press('Escape');
  }
  await page.setInputFiles('#fileInput', 'test-assets/psd/flat-only.psd');
  await page.waitForFunction(() => window.tintwork.state.doc?.name === 'flat-only.psd');
  const flat = await page.evaluate(async () => { const t = window.tintwork; return { n: t.state.doc.layers.length, px: (await t.compositePixelAsync(159, 0)).slice(0, 3) }; });
  check(flat.n === 1 && flat.px[0] === 255, `a PSD without layer pixels opens its composite (${JSON.stringify(flat)})`);
}

// --- RAW: synthesized DNG with lens opcodes -----------------------------------------------------------------
await page.setInputFiles('#fileInput', { name: 'synthetic-lens.dng', mimeType: 'image/x-adobe-dng', buffer: Buffer.from(lensDNG) });
await page.waitForFunction(() => window.tintwork.rawUI?.previews >= 1, null, { timeout: 30000 });
{
  const info = await page.evaluate(() => { const u = window.tintwork.rawUI; return { ...u.info, lensBox: !document.querySelector('#rawLens').disabled, checked: document.querySelector('#rawLens').checked }; });
  check(info.lens?.distortion && info.lens?.vignette && info.lensBox && info.checked && info.width === 720, `DNG lens opcodes detected (WarpRectilinear + FixVignetteRadial), correction box enabled (${JSON.stringify(info.lens)})`);
  check(Math.abs(info.asShot.temp - 6500) < 400, `as-shot white balance from AsShotNeutral reads as daylight (${info.asShot.temp} K, tint ${info.asShot.tint})`);
  const devStats = async (lens) => page.evaluate(async (lens) => {
    const u = window.tintwork.rawUI, s = { ...u.settings, lens, nrColor: 0 };
    const sess = await window.tintwork.openRawSession(new Uint8Array(await window.__lensFile.arrayBuffer()), s); const r = await sess.develop(s); sess.close();
    const L = (x, y) => { let a = 0; for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) { const k = ((y + j) * r.width + x + i) * 4; a += r.data16[k] + r.data16[k + 1] + r.data16[k + 2]; } return a / 169 / 3; };
    // corner vs centre brightness on the grid's light squares, measured over a whole block
    const blk = (x0, y0) => { let a = 0, n = 0; for (let y = y0; y < y0 + 40; y++) for (let x = x0; x < x0 + 40; x++) { const k = (y * r.width + x) * 4; a += r.data16[k + 1]; n++; } return a / n; };
    return { w: r.width, h: r.height, centre: blk(340, 220), corner: blk(20, 20), edgeRow: [...r.data8.slice((5 * r.width) * 4, (5 * r.width + 60) * 4)].filter((_, i) => i % 4 === 1), mid: L(360, 240) };
  }, lens);
  await page.evaluate(() => { window.__files = null; }); await toPage([{ name: 'synthetic-lens.dng', mimeType: 'image/x-adobe-dng', buffer: Buffer.from(lensDNG) }]);
  await page.evaluate(() => { window.__lensFile = window.__files[0]; });
  const on = await devStats(true), off = await devStats(false);
  const ratioOn = on.corner / on.centre, ratioOff = off.corner / off.centre, edgeDiff = on.edgeRow.reduce((s, v, i) => s + Math.abs(v - off.edgeRow[i]), 0) / on.edgeRow.length;
  check(ratioOn > ratioOff * 1.15 && edgeDiff > 4, `lens correction on vs off: vignette lifts the corners (corner/centre ${ratioOff.toFixed(2)} → ${ratioOn.toFixed(2)}), distortion moves edge detail (mean Δ ${edgeDiff.toFixed(1)})`);
  // dialog controls drive the preview
  const getPrev = () => page.evaluate(() => { const c = document.querySelector('#rawCanvas'), d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 8, 8).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return { mean: s / 192, n: window.tintwork.rawUI.previews }; });
  const p0 = await getPrev();
  await page.fill('[data-k=exposure]', '1'); await page.dispatchEvent('[data-k=exposure]', 'input');
  await page.waitForFunction((n) => window.tintwork.rawUI.idle && window.tintwork.rawUI.previews > n, p0.n);
  const p1 = await getPrev();
  await page.fill('#rawTemp', '3000'); await page.dispatchEvent('#rawTemp', 'input');
  await page.waitForFunction((n) => window.tintwork.rawUI.idle && window.tintwork.rawUI.previews > n, p1.n);
  const wb = await page.evaluate(() => { const c = document.querySelector('#rawCanvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let r = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; b += d[i + 2]; } return { mode: document.querySelector('#rawWb').value, rb: r / b }; });
  check(p1.mean > p0.mean * 1.25 && wb.mode === 'custom' && wb.rb < 0.9, `develop sliders update the live preview (exposure +1: ${p0.mean.toFixed(0)} → ${p1.mean.toFixed(0)}; 3000 K custom → cooler, R/B ${wb.rb.toFixed(2)})`);
  await page.selectOption('#rawWb', 'auto'); await page.waitForFunction(() => window.tintwork.rawUI.idle && document.querySelector('#rawWb').value === 'auto');
  await page.waitForTimeout(100);
  const auto = await page.evaluate(() => +document.querySelector('#rawTemp').value);
  check(Math.abs(auto - 6500) < 900, `auto white balance on a neutral grey scene lands near daylight (${auto} K)`);
  await page.click('#rawReset'); await page.waitForFunction(() => window.tintwork.rawUI.idle && document.querySelector('[data-k=exposure]').value === '0');
  await page.click('#modalOk');
  await page.waitForFunction(() => window.tintwork.state.doc?.name === 'synthetic-lens.dng' && document.querySelector('#modal').classList.contains('hidden'), null, { timeout: 30000 });
  const docInfo = await page.evaluate(() => { const t = window.tintwork, d = t.state.doc, l = d.layers[0], dd = t.deepOf(l); let fine = 0; for (let i = 0; i < dd.data.length; i += 4) if (dd.data[i + 1] % 257) fine++; return { w: d.width, h: d.height, depth: d.depth, fine, raw: d.raw }; });
  check(docInfo.depth === 16 && docInfo.w === 720 && docInfo.fine > 10000, `develop "Open" creates a 16 bits/channel document (${docInfo.w}×${docInfo.h}, ${docInfo.fine} pixels with sub-8-bit detail)`);
}
{ // undecodable DNG (unknown compression) with an embedded JPEG
  const jpeg = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 320; c.height = 240; const x = c.getContext('2d'); x.fillStyle = '#c03030'; x.fillRect(0, 0, 320, 240); x.fillStyle = '#30c030'; x.fillRect(160, 0, 160, 240); const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); return [...new Uint8Array(await b.arrayBuffer())]; });
  const fb = makeDNG({ W: 320, H: 240, lens: false, compression: 65000, scene: grid, preview: { w: 320, h: 240, jpeg: new Uint8Array(jpeg) } });
  await page.setInputFiles('#fileInput', { name: 'undecodable.dng', mimeType: 'image/x-adobe-dng', buffer: Buffer.from(fb) });
  await page.waitForFunction(() => window.tintwork.state.doc?.name === 'undecodable.dng' || window.tintwork.rawUI, null, { timeout: 30000 }).catch(() => {});
  await settle();
  const r = await page.evaluate(async () => { const t = window.tintwork, d = t.state.doc; return { name: d.name, preview: !!d.rawPreview, w: d.width, depth: d.depth || 8, notes: d.importNotes, modal: document.querySelector('#modalTitle').textContent, dialog: !!t.rawUI, toast: document.querySelector('#toast')?.textContent, status: document.querySelector('#status')?.textContent, px: (await t.compositePixelAsync(40, 120)).slice(0, 3) }; });
  check(r.name === 'undecodable.dng' && r.preview && r.w === 320 && r.depth === 8 && /embedded JPEG/.test(r.notes?.[0] || '') && /camera JPEG/i.test(r.modal) && r.px[0] > 150 && r.px[1] < 90,
    `undecodable RAW opens the embedded JPEG and says so (“${(r.notes?.[0] || '').slice(0, 90)}…”)` + (process.env.V11_DEBUG ? JSON.stringify(r) : ''));
  await page.keyboard.press('Escape');
}

// --- RAW: the CC0 sample files ---------------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync('test-assets/raw-samples.json', 'utf8')).samples;
const present = manifest.filter((s) => existsSync(`test-assets/raw-samples/${s.local}`));
if (!present.length) console.log('skip RAW samples: run `npm run fetch-raw` to download the CC0 files (test-assets/raw-samples/)');
const perFormat = [];
for (const s of present) {
  await page.evaluate(() => { window.__files = null; }); await toPage([`test-assets/raw-samples/${s.local}`]);
  const r = await page.evaluate(async () => {
    const t = window.tintwork, f = window.__files[0], before = t.state.doc;
    const t0 = performance.now(); await t.openRAW(f, false); const ms = Math.round(performance.now() - t0);
    const d = t.state.doc; if (d === before) return { failed: true };
    const c = t.compositeCanvas(), x = c.getContext('2d'), W = c.width, H = c.height; let sum = 0, n = 0, clip = 0;
    for (let j = 1; j < 10; j++) for (let i = 1; i < 10; i++) { const p = x.getImageData(Math.floor((W * i) / 10), Math.floor((H * j) / 10), 1, 1).data; sum += p[0] + p[1] + p[2]; n++; if (p[0] > 250 && p[1] > 250 && p[2] > 250) clip++; }
    const out = { w: d.width, h: d.height, depth: d.depth || 8, preview: !!d.rawPreview, ms, timing: t.lastImport, mean: sum / n / 3, clip, notes: d.importNotes };
    await t.closeTab(undefined, { force: true });
    return out;
  });
  const fmt = s.local.split('.').pop().toUpperCase();
  perFormat.push({ fmt, cam: `${s.make} ${s.model}`, ...r });
  check(!r.failed && r.depth === 16 && !r.preview && r.w * r.h > 0.9 * s.mp * 1e6 && r.mean > 20 && r.mean < 235 && r.clip < 40,
    `${fmt} ${s.make} ${s.model}: full decode → ${r.w}×${r.h} 16-bit in ${(r.ms / 1000).toFixed(1)} s (decode ${r.timing?.decode} ms, develop ${r.timing?.develop} ms; mean ${r.mean?.toFixed(0)})`);
}
// 24 MP interactive: open → develop dialog → Open → on screen
const big = present.find((s) => s.local === 'sony-ilce-6000.arw') || present.find((s) => s.mp > 20);
if (big) {
  const t0 = Date.now();
  await page.setInputFiles('#fileInput', `test-assets/raw-samples/${big.local}`);
  await page.waitForFunction(() => window.tintwork.rawUI?.previews >= 1, null, { timeout: 60000 });
  const tDialog = Date.now() - t0;
  await settle(); await page.waitForTimeout(150);
  await page.screenshot({ path: 'screenshots/11x-raw-develop.png' });
  const t1 = Date.now(); await page.click('#modalOk');
  await page.waitForFunction((n) => window.tintwork.state.doc?.name === n && window.tintwork.lastImport?.total && document.querySelector('#modal').classList.contains('hidden'), big.local, { timeout: 60000 });
  await settle(); const tOpen = Date.now() - t1;
  const r = await page.evaluate(() => ({ ...window.tintwork.lastImport, depth: window.tintwork.state.doc.depth }));
  const total = tDialog + tOpen;
  check(r.depth === 16 && r.mp > 20 && total < 9000, `24 MP ${big.local}: file → develop dialog ${(tDialog / 1000).toFixed(1)} s, Open → on screen ${(tOpen / 1000).toFixed(1)} s, total ${(total / 1000).toFixed(1)} s (decode ${r.decode} ms, develop ${r.worker?.develop} ms + noise reduction ${r.worker?.nr} ms, canvas ${r.build} ms)`);
  perFormat.push({ interactive: true, tDialog, tOpen, total, ...r });
}
check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
console.log(`PER_FORMAT ${JSON.stringify(perFormat.map(({ notes, timing, ...p }) => p))}`);
await browser.close(); server.close();
console.log(`${fails ? `${fails} v1.1 check(s) FAILED` : 'All v1.1 checks passed'} (${((Date.now() - T0) / 1000).toFixed(0)} s)`);
process.exit(fails ? 1 : 0);
