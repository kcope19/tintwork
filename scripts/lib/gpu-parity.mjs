// GPU ↔ CPU develop parity, run inside a page served from the app origin (it imports /src/raw.js and
// /src/gpu-develop.js). Playwright serialises the function, so it must stay self-contained.
// which: 'webgpu' | 'webgl2', optionally ':dev' (develop stage only), ':post' (filters given exact input) or
// ':onlyKEY' (one local control); FILT picks a single filter (nr, nrc, sharp, sharpm, sharp06, defr, defrm, clar,
// tex, lsharp, lnoise). Returns { info, out: [{ name, max, over1, of, hist, cpuMs, gpuMs, … }] } or { error }.
export const parityInPage = async ([which, FILT]) => {
  const R = await import('/src/raw.js'); const G = await import('/src/gpu-develop.js');
  const f2h = (() => { const b = new ArrayBuffer(4), f = new Float32Array(b), u = new Uint32Array(b); return (v) => { f[0] = v; const x = u[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 255) - 127 + 15, m = x & 0x7fffff; if (e <= 0) return s | Math.round((m | 0x800000) / 2 ** (14 - e)); if (e >= 31) return s | 0x7bff; return s | (e << 10) | Math.round(m / 8192) ; }; })();
  const mkSrc = (W, H, half) => { const d = half ? new Uint16Array(W * H * 3) : new Float32Array(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; const vals = [ (x / W) * 0.9 + 0.05 * Math.sin(y * 0.3), (y / H) * 0.8 + ((x >> 3) + (y >> 3)) % 2 * 0.1, 0.5 + 0.45 * Math.sin(x * 0.05 + y * 0.07) * ((x * 7 + y * 13) % 17 > 8 ? 1 : 0.3) ]; for (let c = 0; c < 3; c++) d[i + c] = half ? f2h(Math.max(0, vals[c])) : Math.max(0, vals[c]); } return { width: W, height: H, data: d, half }; };
  const lut = new Float32Array(R.LUT_SIZE + 1); for (let i = 0; i <= R.LUT_SIZE; i++) { const x = i / R.LUT_SIZE; lut[i] = Math.min(65535, 65535 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)); }
  const lut2 = lut.map((v, i) => Math.min(65535, v * 0.9 + 3000 * Math.sin(i / 3000)));
  const pipe = (o = {}) => ({ C: [1.6, -0.4, -0.1, -0.15, 1.3, -0.15, 0.02, -0.5, 1.5].map((v) => v * 1.4), knee: 0.7, cK: 0.6, shadows: 0.1, lut, luts: [lut, lut2, lut], vib: 0.2, sat: 1.1, ...o });
  const S = (o) => ({ ...R.DEFAULT_SETTINGS, ...o });
  const brushStroke = (auto) => ({ size: 0.08, feather: 0.5, flow: 0.8, auto, pts: [0.2, 0.3, 0.3, 0.35, 0.45, 0.4, 0.6, 0.5] });
  const L1 = [
    { type: 'linear', x0: 0.5, y0: 0, x1: 0.5, y1: 0.6, exposure: -1, highlights: -40, whites: 30, blacks: -20, dehaze: 40, hue: 25, clarity: 50, saturation: 20 },
    { type: 'radial', cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.25, feather: 0.6, exposure: 0.7, temp: 30, tint: -20, contrast: 30, texture: 40, sharpness: 60, parts: [{ op: 'subtract', type: 'radial', cx: 0.55, cy: 0.5, rx: 0.1, ry: 0.1, feather: 0.5 }, { op: 'add', type: 'linear', x0: 0.1, y0: 1, x1: 0.1, y1: 0.8 }, { op: 'intersect', type: 'linear', x0: 0, y0: 0.5, x1: 1, y1: 0.5, invert: true }], lum: { lo: 10, hi: 90, soft: 20 } },
    { type: 'brush', strokes: [brushStroke(false), { ...brushStroke(true), pts: [0.7, 0.2, 0.75, 0.6] }, { ...brushStroke(false), erase: true, size: 0.03 }], noise: 60, shadows: 40, dehaze: -50, color: { hue: 200, range: 40, soft: 30 }, hue: -60 },
  ];
  const cases = [
    { name: 'fast float, NR+sharpen', W: 320, H: 240, half: false, opts: { pipe: pipe(), settings: S({ nrLuma: 30, nrColor: 40, sharpen: 60, sharpRadius: 1.2, sharpMask: 20 }) } },
    { name: 'fast half, orient 6, 8-bit, defringe', W: 300, H: 200, half: true, opts: { pipe: pipe({ cK: Infinity }), orientation: 6, bits: 8, settings: S({ fringePurple: 80, fringeGreen: 60, sharpen: 30, sharpRadius: 0.6 }) } },
    { name: 'slow: lens warp+vig+CA+distortion', W: 400, H: 300, half: true, opts: { pipe: pipe(), ca: [0.002, -0.0015], vignette: 0.25, distortion: 30, lens: { warp: { center: [0.5, 0.5], planes: [{ kr: [1, 0.03, -0.01, 0.002], kt: [0.0002, -0.0003] }] }, vignette: { center: [0.48, 0.52], k: [0.3, 0.1, 0, 0, 0] }, frame: { fullW: 400, fullH: 300, offX: 0, offY: 0 } }, settings: S({}) } },
    { name: 'locals all, 16-bit', W: 360, H: 240, half: true, opts: { pipe: pipe(), settings: S({ local: L1, nrColor: 20 }) } },
    { name: 'locals all, 8-bit, overlay', W: 360, H: 240, half: false, opts: { pipe: pipe(), bits: 8, scale: 0.4, settings: S({ local: L1, maskShow: 1 }) } },
    { name: 'band rows + halo', W: 300, H: 400, half: true, opts: { pipe: pipe(), rows: [100, 220], settings: S({ local: L1, sharpen: 50, nrLuma: 20 }) } },
    { name: 'fringe mask view', W: 200, H: 150, half: false, opts: { pipe: pipe(), settings: S({ fringeMask: true, fringePurple: 70 }) } },
  ];
  const STAGE = which.split(':')[1] || 'all';
  if (STAGE === 'dev') for (const c of cases) { const st = c.opts.settings; c.opts.settings = { ...st, nrLuma: 0, nrColor: 0, sharpen: 0, fringePurple: 0, fringeGreen: 0, fringeMask: false, local: st.local ? st.local.map((a) => ({ ...a, clarity: 0, texture: 0, sharpness: 0, noise: 0 })) : null }; }
  if (STAGE.startsWith('only')) { const k = STAGE.slice(4); for (const c of cases) { const a = c.opts.settings.local; if (a) c.opts.settings = { ...c.opts.settings, nrLuma: 0, nrColor: 0, sharpen: 0, local: a.map((m) => { const o = { ...m }; for (const kk of Object.keys(R.LOCAL_RANGES)) o[kk] = kk === k ? (m[kk] || 30) : 0; return o; }) }; } }
  if (STAGE === 'post') {
    const lin = new Float32Array(R.LUT_SIZE + 1).map((_, i) => Math.min(65535, i * 4));
    const ex = (W, H) => { const d = new Float32Array(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) d[(y * W + x) * 3 + c] = Math.round(12288 * (0.5 + 0.5 * Math.sin(x * 0.11 * (c + 1) + y * 0.07) * ((x * 7 + y * 13 + c * 5) % 17 > 8 ? 1 : 0.4))) / 16384; return { width: W, height: H, data: d, half: false }; };
    for (const c of cases) { c.half = false; c.mk = ex; c.opts = { ...c.opts, ca: null, vignette: 0, distortion: 0, lens: null, pipe: { C: [1, 0, 0, 0, 1, 0, 0, 0, 1], knee: 1e9, cK: Infinity, shadows: 0, lut: lin, vib: 0, sat: 1 } };
      const st = c.opts.settings; if (st.local) c.opts.settings = { ...st, local: st.local.map((m) => { const o = { ...m, lum: null, color: null }; for (const k of Object.keys(R.LOCAL_RANGES)) if (!['clarity', 'texture', 'sharpness', 'noise'].includes(k)) o[k] = 0; return o; }) }; }
  }
  if (FILT) {
    const one = { nrLuma: 0, nrColor: 0, sharpen: 0, sharpRadius: 1.2, sharpMask: 0, fringePurple: 0, fringeGreen: 0, fringeMask: false };
    const F = { nr: { nrLuma: 40 }, nrc: { nrColor: 50 }, sharp: { sharpen: 70 }, sharpm: { sharpen: 70, sharpMask: 30 }, sharp06: { sharpen: 70, sharpRadius: 0.6 }, defr: { fringePurple: 80, fringeGreen: 60 }, defrm: { fringePurple: 80, fringeMask: true } }[FILT] || {};
    const LK = { clar: 'clarity', tex: 'texture', lsharp: 'sharpness', lnoise: 'noise' }[FILT];
    for (const c of cases) { const st = c.opts.settings; c.opts.settings = { ...st, ...one, ...F, local: LK ? L1.map((m) => ({ ...m, exposure: 0, temp: 0, tint: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, whites: 0, blacks: 0, dehaze: 0, hue: 0, clarity: 0, texture: 0, sharpness: 0, noise: 0, [LK]: 70, lum: null, color: null })) : null, maskShow: 0 }; }
  }
  let eng;
  try { eng = which.startsWith('webgpu') ? await G.createWebGPUDevelop() : G.createWebGL2Develop(); } catch (e) { return { error: e.message }; }
  if (!eng) return { error: 'no engine' };
  const out = [];
  for (const c of cases) {
    const src = c.mk ? c.mk(c.W, c.H) : mkSrc(c.W, c.H, c.half);
    const t0 = performance.now(); const cpu = R.developRows(src, c.opts); const t1 = performance.now();
    let gpu; try { gpu = await eng.developRows(src, c.opts); } catch (e) { out.push({ name: c.name, error: e.message }); continue; }
    const t2 = performance.now();
    const a = cpu.data, b = gpu.data; let max = 0, n1 = 0, at = -1; const hist = new Uint32Array(8);
    if (a.length !== b.length) { out.push({ name: c.name, error: `length ${a.length} vs ${b.length}` }); continue; }
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) { max = d; at = i; } if (d > 1) n1++; hist[Math.min(7, d)]++; }
    out.push({ name: c.name, max, over1: n1, of: a.length, hist: [...hist], at, cpuV: at >= 0 ? [...a.slice(at - at % 4, at - at % 4 + 4)] : null, gpuV: at >= 0 ? [...b.slice(at - at % 4, at - at % 4 + 4)] : null, px: at >= 0 ? [((at >> 2) % cpu.width), Math.floor((at >> 2) / cpu.width)] : null, cpuMs: +(t1 - t0).toFixed(1), gpuMs: +(t2 - t1).toFixed(1) });
  }
  return { info: eng.info, out };
};
