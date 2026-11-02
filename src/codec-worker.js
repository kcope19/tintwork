// Codec worker: PSD read/write and camera RAW decode + develop, off the UI thread.
// RAW sessions keep the full-resolution linear image here, so slider changes only send a small preview back.
import { readPSD, writePSD } from './psd.js';
import * as R from './raw.js';
import * as G from './gpu-develop.js';

let flashraw = null, decoder = null; // decoder: { threads, reason, binary } of the loaded FlashRaw build
/**
 * Threaded decode needs SharedArrayBuffer, which browsers only allow on cross-origin isolated pages (served with
 * COOP: same-origin + COEP: require-corp, see _headers). Then the multithreaded build is used; otherwise, or if it
 * fails to start, FlashRaw falls back to the single-threaded SIMD (or scalar) build.
 */
const threadedDecodeOK = () => self.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
async function engine() {
  if (!flashraw) {
    flashraw = import('../vendor/flashraw/browser.js').then(async (m) => {
      const want = threadedDecodeOK() && !noThreads;
      await m.init({ threads: want ? Math.max(2, Math.min(8, self.navigator?.hardwareConcurrency || 4)) : false });
      const c = await m.getCapabilities();
      decoder = { threads: c.threads?.count || 0, reason: want ? c.threads?.reason || null : (noThreads ? 'turned off' : 'the page is not cross-origin isolated'), binary: c.wasm?.binary || null, isolated: self.crossOriginIsolated === true };
      return m;
    }).catch((e) => { flashraw = null; throw e; });
  }
  return flashraw;
}
let noThreads = false; // test override (env.decodeThreads === false)
const sessions = new Map();
const PREVIEW_SIDE = 1400;
const DRAFT_SIDE = 700; // live drafts while a slider or brush is moving, when the full preview is slow (CPU, software GPU)

function buffersOf(obj, out = []) { // transferable buffers inside a result (deduplicated)
  if (!obj || typeof obj !== 'object') return out;
  if (ArrayBuffer.isView(obj)) { if (!out.includes(obj.buffer)) out.push(obj.buffer); return out; }
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) buffersOf(v, out);
  return out;
}
// ---- develop band workers ---------------------------------------------------------------------------------------
const CORES = self.navigator?.hardwareConcurrency || 2;
const poolSize = () => R.poolSize(CORES, deviceMemory || self.navigator?.deviceMemory || 0);
let pool = null, jobSeq = 0;
function workers() {
  if (pool) return pool;
  pool = [];
  try {
    if (typeof Worker === 'function') for (let i = 0, n = poolSize(); i < n; i++) {
      const w = new Worker(new URL('./develop-worker.js', import.meta.url), { type: 'module', name: `tintwork-develop-${i + 1}` });
      const jobs = new Map();
      w.onmessage = (e) => { const m = e.data, j = jobs.get(m.id); if (!j) return; if (m.stage === 'half') j.onHalf?.(m.res); else { jobs.delete(m.id); m.stage === 'error' ? j.reject(new Error(m.error)) : j.resolve(m.res); } };
      w.onerror = (e) => { e.preventDefault?.(); for (const j of jobs.values()) j.reject(new Error(e.message || 'develop worker failed')); jobs.clear(); };
      pool.push({ w, jobs });
    }
  } catch { pool = []; }
  return pool;
}
/**
 * Develop the whole image (or preview) in bands across the worker pool. Every band reads only the part of the source
 * it needs (rows + halo, mapped through orientation, lens warp and CA). onHalf(band) streams half-resolution bands.
 * Bands are handed out as workers become free and each band's source is copied only when it is sent, so at most
 * `plan.workers` band buffers exist at once: on small-memory devices the plan uses fewer workers and smaller bands.
 */
let workerCap = null, deviceMemory = 0, bandsOverride = 0; // test override / navigator.deviceMemory from the page
async function developBands(src, opts, { half = false, onHalf = null } = {}) {
  const P = workers(), [FW, FH] = [src.fullW || src.width, src.fullH || src.height];
  const [OW, OH] = R.orientedSize(FW, FH, opts.orientation || 1), bits = opts.bits || 16;
  const plan = R.planWorkers({ width: OW, height: OH, pool: P.length, deviceMemory, cap: workerCap, bits });
  if (!P.length || plan.workers < 1) { // no nested workers: same maths, one thread
    const r = R.developRows(src, opts);
    return { width: r.width, height: r.height, data: r.data, data8: r.bits === 16 ? R.to8(r.data) : null, bands: 1, workers: 0, ms: r.ms };
  }
  const bands = R.planBands(src, opts, bandsOverride || plan.bands);
  const data = bits === 16 ? new Uint16Array(OW * OH * 4) : new Uint8ClampedArray(OW * OH * 4), data8 = bits === 16 ? new Uint8ClampedArray(OW * OH * 4) : null;
  const ms = { nr: 0, sharpen: 0, develop: 0, band: 0, extract: 0, assemble: 0 }, t0 = performance.now();
  let next = 0;
  const run = (slot) => new Promise((resolve, reject) => {
    const b = bands[next++];
    const te = performance.now(), region = R.extractRegion(src, b.rect), id = ++jobSeq; ms.extract += performance.now() - te;
    slot.jobs.set(id, { resolve, reject, onHalf });
    slot.w.postMessage({ id, region, opts: { ...opts, rows: b.rows }, half }, [region.data.buffer]);
  }).then((r) => {
    const ta = performance.now();
    data.set(r.data, r.rows[0] * OW * 4); if (data8) data8.set(r.data8, r.rows[0] * OW * 4);
    ms.assemble += performance.now() - ta;
    for (const k of ['nr', 'sharpen', 'develop']) ms[k] = Math.max(ms[k], r.ms[k] || 0);
    ms.band = Math.max(ms.band, r.ms.total || 0);
    if (next < bands.length) return run(slot);
  });
  const n = Math.min(plan.workers, P.length, bands.length);
  await Promise.all(P.slice(0, n).map(run));
  ms.wall = performance.now() - t0;
  return { width: OW, height: OH, data, data8, bands: bands.length, workers: n, ms };
}
/**
 * GPU develop engine (gpu-develop.js): WebGPU compute (develop + every filter), WebGL2 (per-pixel develop on the GPU,
 * filters here) or none (the CPU band workers above). 'auto' skips software adapters, which are slower than the CPU.
 * Any GPU error falls back to the CPU path for the rest of the session and is reported in the result.
 */
let enginePrefer = 'auto', engineP = null, engineNote = '';
function gpuEngine() {
  if (!engineP) engineP = G.openDevelopEngine(enginePrefer).then((r) => { engineNote = r.why || ''; return r.engine; }, (err) => { engineNote = err.message; return null; });
  return engineP;
}
async function dropEngine(why) { const e = await engineP; engineP = Promise.resolve(null); engineNote = why; try { e?.destroy(); } catch { /* gone */ } }
function setEnginePrefer(p) {
  p = ['auto', 'webgpu', 'webgl2', 'cpu'].includes(p) ? p : 'auto';
  if (p === enginePrefer && engineP) return;
  const old = engineP; enginePrefer = p; engineP = null; old?.then((e) => { try { e?.destroy(); } catch { /* gone */ } });
}
const engineLabel = (e) => (e ? (e.kind === 'webgpu' ? 'WebGPU' : 'WebGL2') : 'CPU');
async function engineInfo() {
  const e = await gpuEngine();
  return { prefer: enginePrefer, kind: e ? e.kind : 'cpu', label: engineLabel(e), renderer: e?.info.renderer || '', software: !!e?.info.software, note: engineNote, workers: workers().length };
}
/** Develop with the GPU engine when there is one; null when the CPU should do it (no engine, or it failed). */
async function gpuDevelop(src, opts, { full = false, cache = false } = {}) {
  const e = await gpuEngine(); if (!e) return null;
  if (full && e.kind !== 'webgpu') return null; // WebGL2 runs the filters on one CPU thread: the band workers are faster
  try {
    if (e.lost) throw new Error('GPU device lost');
    const [FW, FH] = [src.fullW || src.width, src.fullH || src.height], [OW, OH] = R.orientedSize(FW, FH, opts.orientation || 1), bits = opts.bits || 16;
    const t0 = performance.now();
    if (!full) { const r = await e.developRows(src, { ...opts, cacheSource: cache }); return { width: r.width, height: r.height, data: r.data, data8: null, bands: 1, workers: 0, engine: e.kind, ms: { gpu: r.ms.gpu, wall: performance.now() - t0 } }; }
    // full resolution: bands of about GPU_BAND_PX pixels (rows + halo) so the source and scratch buffers stay small
    const n = Math.max(1, Math.ceil((OW * OH) / Math.min(GPU_BAND_PX, e.maxPixels / 2)));
    const bands = n === 1 ? [{ rect: null, rows: [0, OH] }] : R.planBands(src, opts, n);
    const data = bits === 16 ? new Uint16Array(OW * OH * 4) : new Uint8ClampedArray(OW * OH * 4), data8 = bits === 16 ? new Uint8ClampedArray(OW * OH * 4) : null;
    const ms = { gpu: 0, extract: 0, assemble: 0 };
    for (const b of bands) {
      const te = performance.now(), region = b.rect ? R.extractRegion(src, b.rect) : src; ms.extract += performance.now() - te;
      const r = await e.developRows(region, { ...opts, rows: b.rows }); ms.gpu += r.ms.gpu;
      const ta = performance.now(); data.set(r.data, b.rows[0] * OW * 4); if (data8) data8.set(R.to8(r.data), b.rows[0] * OW * 4); ms.assemble += performance.now() - ta;
    }
    ms.wall = performance.now() - t0;
    return { width: OW, height: OH, data, data8, bands: bands.length, workers: 0, engine: e.kind, ms };
  } catch (err) {
    console.warn('GPU develop failed, using the CPU:', err);
    await dropEngine(`GPU develop failed (${err.message}); using the CPU`);
    return null;
  }
}
const GPU_BAND_PX = 4e6;

// ---- develop benchmark (Help › Run performance benchmark): synthetic sensor data, the real develop paths ----------
function benchSource(W, H) { // half-float linear RGB: gradients, saturated blocks, fine detail
  const tab = new Uint16Array(4096), f = new Float32Array(1), u = new Uint32Array(f.buffer);
  for (let i = 0; i < 4096; i++) { f[0] = (i / 4095) ** 2.2; const x = u[0], e = ((x >>> 23) & 255) - 112, m = x & 0x7fffff; tab[i] = e <= 0 ? 0 : (e << 10) | (m >>> 13); }
  const d = new Uint16Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0, i = y * W * 3; x < W; x++, i += 3) {
    const blk = ((x >> 7) + (y >> 7)) & 1, fine = ((x ^ y) & 7) * 40;
    d[i] = tab[((x * 3000) / W + fine + blk * 500) & 4095]; d[i + 1] = tab[((y * 3000) / H + fine) & 4095]; d[i + 2] = tab[(((x + y) * 1500) / (W + H) + 1200 + blk * 900 + fine) & 4095];
  }
  return { width: W, height: H, data: d, half: true };
}
function benchPipe() {
  const lut = new Float32Array(R.LUT_SIZE + 1);
  for (let i = 0; i <= R.LUT_SIZE; i++) { const x = i / R.LUT_SIZE; lut[i] = 65535 * Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055); }
  return { C: [1.7, -0.5, -0.2, -0.2, 1.5, -0.3, 0, -0.4, 1.4], knee: 0.8, cK: 0.5, shadows: 0.1, lut, vib: 0.15, sat: 1.05 };
}
const BENCH_LOCALS = (k) => [
  { type: 'linear', x0: 0.5, y0: 0, x1: 0.5, y1: 0.5, exposure: -0.8, dehaze: 30, highlights: -30 },
  { type: 'radial', cx: 0.5, cy: 0.55, rx: 0.3, ry: 0.25, exposure: 0.5, clarity: 30, whites: 20, parts: [{ op: 'subtract', type: 'radial', cx: 0.5, cy: 0.55, rx: 0.08, ry: 0.08 }] },
  { type: 'brush', shadows: 40, hue: 15, strokes: Array.from({ length: k }, (_, i) => ({ size: 0.06, feather: 0.5, flow: 0.8, pts: [0.1 + i * 0.02, 0.6, 0.15 + i * 0.02, 0.65, 0.2 + i * 0.02, 0.7] })) },
];
async function devBench({ kinds = ['cpu', 'webgpu', 'webgl2'], sizes = [12, 24], dims = {}, runs = 5 } = {}, progress) {
  const res = { engines: {}, rows: [] }, pipe = benchPipe(), med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const set = (k) => ({ ...R.DEFAULT_SETTINGS, nrColor: 25, sharpen: 40, local: BENCH_LOCALS(k) });
  const small = benchSource(PREVIEW_SIDE, Math.round(PREVIEW_SIDE / 1.5)), pmp = Math.round((small.width * small.height) / 1e5) / 10;
  for (const kind of kinds) {
    let e = null;
    if (kind !== 'cpu') {
      try { e = kind === 'webgpu' ? await G.createWebGPUDevelop() : G.createWebGL2Develop(); } catch (err) { res.engines[kind] = { error: err.message }; continue; }
      if (!e) { res.engines[kind] = { error: kind === 'webgpu' ? 'WebGPU is not available here' : 'WebGL2 is not available here' }; continue; }
      res.engines[kind] = { renderer: e.info.renderer, software: !!e.info.software };
    } else res.engines.cpu = { renderer: `CPU (${workers().length} develop workers)`, software: false };
    const run = async (src, opts, full) => {
      if (!e) return full ? developBands(src, opts) : developBands(src, opts);
      if (full) { // the same banding as gpuDevelop
        const [OW, OH] = R.orientedSize(src.width, src.height, 1), n = Math.max(1, Math.ceil((OW * OH) / GPU_BAND_PX)), bands = R.planBands(src, opts, n);
        for (const b of bands) await e.developRows(R.extractRegion(src, b.rect), { ...opts, rows: b.rows });
        return;
      }
      return e.developRows(src, { ...opts, cacheSource: true });
    };
    try {
      // preview update (slider drag): same settings each time except one slider
      progress?.({ text: `Develop · ${kind} · preview updates…` });
      const pOpts = (i, k = 3) => { const st = set(k); st.local[0].exposure = -0.8 + i * 0.01; return { pipe, orientation: 1, factor: 1, settings: st, locals: R.prepareLocals(st.local, small, 1), scale: 1 / 4, bits: 8 }; };
      await run(small, pOpts(0), false); // warm-up: shader compile, worker start
      const tp = []; for (let i = 1; i <= runs; i++) { const t = performance.now(); await run(small, pOpts(i), false); tp.push(performance.now() - t); }
      res.rows.push({ mp: pmp, op: 'dev_preview', kind, ms: Math.round(med(tp) * 10) / 10 });
      // painting: each update adds a brush stroke (prepareLocals rasterises it incrementally)
      const tb = []; for (let i = 1; i <= runs; i++) { const t = performance.now(); await run(small, pOpts(0, 3 + i), false); tb.push(performance.now() - t); }
      res.rows.push({ mp: pmp, op: 'dev_paint', kind, ms: Math.round(med(tb) * 10) / 10 });
      if (kind === 'webgl2') continue; // full-resolution WebGL2 develops use the CPU band workers (see gpuDevelop)
      for (const mp of sizes) {
        const [W, H] = dims[mp] || [Math.round(Math.sqrt(mp * 1.5e6)), Math.round(Math.sqrt(mp * 1e6 / 1.5))];
        progress?.({ text: `Develop · ${kind} · ${mp} MP full resolution…` });
        const src = benchSource(W, H), st = set(3), o = { pipe, orientation: 1, factor: 1, settings: st, locals: R.prepareLocals(st.local, R.downscale(src, PREVIEW_SIDE), 1), scale: 1, bits: 16 };
        const t = performance.now(); await run(src, o, true);
        res.rows.push({ mp, op: 'dev_full', kind, ms: Math.round(performance.now() - t) });
      }
    } catch (err) { res.rows.push({ mp: pmp, op: 'dev_preview', kind, ms: null, error: err.message }); }
    finally { try { e?.destroy(); } catch { /* gone */ } }
  }
  return res;
}
const lensFor = (s, set) => (set.lens === false ? s.lensOff : s.lensOpts);
function caFor(s, set) {
  if (set.caAuto && !s.ca) { const t = performance.now(); s.ca = R.estimateCA(s.src); s.ca.ms = Math.round(performance.now() - t); }
  return R.caScales(set, s.ca);
}
function devOpts(s, set, pipe, factor, scale, bits) {
  // local adjustments: validated once, auto-mask brush colours sampled from the preview copy (the same for every band)
  const locals = set.local ? R.prepareLocals(set.local, s.small, s.orientation) : null;
  return { pipe, orientation: s.orientation, factor, lens: lensFor(s, set), vignette: (set.vignette || 0) / 100, ca: caFor(s, set), distortion: set.distortion || 0, settings: set, locals, scale, bits };
}
function draftOf(s) {
  if (!s.draftSrc) { const d = R.downscale(s.small, DRAFT_SIDE); s.draftSrc = { ...d, factor: s.small.factor * d.factor }; }
  return s.draftSrc;
}
async function previewOf(s, settings, draft = false) {
  const pipe = R.pipeline(s.meta, s.model, settings, s.autoW);
  const t = performance.now(), src = draft ? draftOf(s) : s.small;
  const opts = devOpts(s, settings, pipe, src.factor, 1 / src.factor, 8);
  const out = (await gpuDevelop(src, opts, { cache: true })) || { ...(await developBands(src, opts)), engine: 'cpu' };
  const tt = settings.wb === 'custom' ? { temp: settings.temp, tint: settings.tint } : s.model.tempTintFor(pipe.wb);
  return { width: out.width, height: out.height, data: out.data, temp: tt.temp, tint: tt.tint, ms: Math.round(performance.now() - t), engine: out.engine, draft, ca: s.ca ? { red: s.ca.red / R.CA_UNIT * 100, blue: s.ca.blue / R.CA_UNIT * 100 } : null };
}

const handlers = {
  async psdRead({ bytes }) { return readPSD(new Uint8Array(bytes)); },
  async psdWrite({ doc }) { return { bytes: writePSD(doc) }; },
  /** Open a RAW file: decode the sensor data (or report why not), build the develop preview. */
  async rawOpen({ session, bytes, settings, env }) {
    if (env) { deviceMemory = +env.deviceMemory || 0; bandsOverride = +env.bands || 0; if ('decodeThreads' in env) noThreads = env.decodeThreads === false; if ('workerCap' in env) workerCap = env.workerCap == null ? null : Math.max(0, +env.workerCap | 0); if (env.engine) setEnginePrefer(env.engine); }
    workers(); // start the develop workers now: they load while the sensor data decodes
    const fr = await engine(), t0 = performance.now(), src = new Uint8Array(bytes);
    let raw;
    try { raw = await fr.FlashRaw.open(src.slice()); }
    catch (err) { // the container itself is unreadable: look for the camera's JPEG by scanning the bytes
      const j = R.findEmbeddedJpeg(src);
      if (!j) throw err;
      sessions.set(session, { fallbackJpeg: j });
      const ext = /compression in (\w+)/i.exec(err?.message || '')?.[1] || 'RAW';
      return { info: { format: ext.toUpperCase(), describe: '', width: j.width, height: j.height, jpeg: { width: j.width, height: j.height } }, decoded: false, reason: err?.message || String(err), openMs: Math.round(performance.now() - t0) };
    }
    const meta = raw.metadata, previews = (meta.previews || []).filter((p) => p.encoding === 'jpeg' || /jpeg/.test(p.mimeType || ''));
    const big = previews.sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
    const info = { format: meta.format, describe: R.describe(meta), width: meta.width, height: meta.height, jpeg: big ? { width: big.width, height: big.height } : null };
    const s = { raw, meta, info };
    sessions.set(session, s);
    let frame;
    try { frame = await raw.decode({ output: 'linear-rgb', sampleType: 'f16', corruptionPolicy: 'recover' }); }
    catch (err) { return { info, decoded: false, reason: err?.message || String(err), openMs: Math.round(performance.now() - t0) }; }
    const decodeMs = Math.round(performance.now() - t0);
    s.src = { width: frame.width, height: frame.height, data: frame.data, half: true };
    s.orientation = frame.orientation || 1;
    s.model = R.colorModel(meta);
    const lens = R.lensInfo(meta), aa = frame.activeArea, cr = frame.crop;
    const offX = cr && aa && cr.x + cr.width <= aa.width ? cr.x : 0, offY = cr && aa && cr.y + cr.height <= aa.height ? cr.y : 0;
    const lensFrame = { fullW: aa?.width || frame.width, fullH: aa?.height || frame.height, offX, offY };
    s.lensOpts = lens.warp || lens.vignette ? { warp: lens.warp, vignette: lens.vignette, frame: lensFrame } : null;
    s.lensOff = lens.baked ? { vignette: lens.baked, invertVignette: true, frame: lensFrame } : null; // undo what the decoder applied
    s.small = R.downscale(s.src, PREVIEW_SIDE);
    s.autoW = R.autoMultipliers(s.model, s.small);
    const [ow, oh] = R.orientedSize(frame.width, frame.height, s.orientation);
    Object.assign(info, {
      width: ow, height: oh, knownCamera: s.model.known, asShot: s.model.asShotTT, auto: s.model.tempTintFor(s.autoW),
      lens: s.lensOpts || s.lensOff ? { distortion: !!lens.warp, vignette: !!(lens.vignette || lens.baked) } : null, incomplete: !!frame.incomplete,
      warnings: (frame.warnings || []).map((w) => w.message || String(w.kind)), baselineExposure: meta.dng?.baselineExposure || 0,
      lensModel: meta.lens?.model || null, lensMake: meta.lens?.make || null, focal: +meta.exposure?.focalLength || null,
      camera: meta.camera?.canonicalModel ? `${meta.camera.canonicalMake || ''} ${meta.camera.canonicalModel}`.trim() : meta.camera?.name || null,
    });
    const preview = await previewOf(s, { ...R.DEFAULT_SETTINGS, ...settings });
    info.decoder = decoder;
    return { info, decoded: true, decodeMs, preview };
  },
  async rawPreview({ session, settings, draft = false }) {
    const s = sessions.get(session); if (!s?.src) throw new Error('RAW session closed');
    return { preview: await previewOf(s, { ...R.DEFAULT_SETTINGS, ...settings }, !!draft) };
  },
  /**
   * Defringe eyedropper: the fringe colour around (u, v) (fractions of the preview) in a preview developed without
   * defringe, so the picked colour is the fringe itself and not what is left of it.
   */
  async rawPick({ session, settings, u, v }) {
    const s = sessions.get(session); if (!s?.src) throw new Error('RAW session closed');
    const p = await previewOf(s, { ...R.DEFAULT_SETTINGS, ...settings, fringePurple: 0, fringeGreen: 0, fringeMask: false });
    return R.pickFringe(p.data, p.width, p.height, u * p.width - 0.5, v * p.height - 0.5, Math.max(2, Math.round(p.width / 400)));
  },
  /** Range-mask eyedropper: luminance and hue at (u, v) as the luminance / colour range masks see them. */
  async rawRange({ session, settings, u, v }) {
    const s = sessions.get(session); if (!s?.src) throw new Error('RAW session closed');
    const set = { ...R.DEFAULT_SETTINGS, ...settings };
    return R.rangeSample(s.small, R.pipeline(s.meta, s.model, set, s.autoW), s.orientation, u, v);
  },
  /**
   * Full-resolution develop to 16 bits/channel (with an 8-bit copy for the canvas). xform (re-develop into a layer
   * that was cropped, resized, rotated, flipped or transformed): { m, w, h, fullW, fullH } — the result is resampled
   * through m (layer pixels → developed pixels of a fullW × fullH develop) into w × h.
   */
  async rawDevelop({ session, settings, maxPixels, half, xform }, progress) {
    const s = sessions.get(session); if (!s?.src) throw new Error('RAW session closed');
    const set = { ...R.DEFAULT_SETTINGS, ...settings }, t = performance.now();
    let src = s.src, factor = 1;
    if (maxPixels && src.width * src.height > maxPixels) { // device limit: develop from a box-downscaled copy
      const k = Math.ceil(Math.sqrt((src.width * src.height) / maxPixels));
      src = R.downscale(src, Math.floor(Math.max(src.width, src.height) / k)); factor = src.factor;
    }
    const pipe = R.pipeline(s.meta, s.model, set, s.autoW);
    const opts = devOpts(s, set, pipe, factor, 1 / factor, 16);
    const [OW, OH] = R.orientedSize(src.width, src.height, s.orientation), hw = Math.floor(src.width / 2), hh = Math.floor(src.height / 2), [HW, HH] = R.orientedSize(hw, hh, s.orientation);
    let firstHalf = 0;
    const out = (await gpuDevelop(src, opts, { full: true })) || await developBands(src, opts, {
      half: !!half,
      onHalf: half ? (b) => { firstHalf ||= performance.now() - t; progress({ stage: 'half', width: HW, height: HH, rows: b.rows, data: b.data, ms: Math.round(performance.now() - t) }, [b.data.buffer]); } : null,
    });
    if (xform) {
      const tx = performance.now(), k = OW / (xform.fullW || OW), m = xform.m;
      const mm = k === 1 ? m : { a: m.a * k, b: m.b * k, c: m.c * k, d: m.d * k, e: m.e * k, f: m.f * k };
      const d16 = R.resampleAffine(out.data, OW, OH, mm, xform.w, xform.h);
      const total = Math.round(performance.now() - t);
      return { width: xform.w, height: xform.h, developed: [OW, OH], data16: d16, data8: R.to8(d16), scaled: factor > 1, bands: out.bands, workers: out.workers, engine: out.engine || 'cpu',
        ms: { ...Object.fromEntries(Object.entries(out.ms).map(([q, v]) => [q, Math.round(v)])), xform: Math.round(performance.now() - tx), total } };
    }
    const total = Math.round(performance.now() - t);
    return { width: OW, height: OH, data16: out.data, data8: out.data8, scaled: factor > 1, bands: out.bands,
      workers: out.workers, engine: out.engine || 'cpu', ms: { ...Object.fromEntries(Object.entries(out.ms).map(([k, v]) => [k, Math.round(v)])), half: Math.round(firstHalf), total, ca: s.ca?.ms } };
  },
  /** Develop engine: switch ({ prefer }) and/or describe the one in use. */
  async devEngine({ prefer } = {}) { if (prefer) setEnginePrefer(prefer); return engineInfo(); },
  async devBench(args, progress) { return devBench(args, progress); },
  async rawJpeg({ session }) {
    const s = sessions.get(session); if (!s) throw new Error('RAW session closed');
    const p = s.fallbackJpeg || await s.raw.preview();
    if (!p) throw new Error('This file has no embedded preview');
    return { bytes: p.data.slice(), mimeType: p.mimeType, width: p.width, height: p.height, orientation: p.orientation || 1 };
  },
  async rawClose({ session }) {
    const s = sessions.get(session);
    if (s) { try { s.raw?.close(); } catch { /* already closed */ } sessions.delete(session); }
    return {};
  },
};

self.onmessage = async (e) => {
  const { id, op, ...args } = e.data;
  try {
    const res = await handlers[op](args, (p, transfer) => self.postMessage({ id, progress: p }, transfer || []));
    self.postMessage({ id, ok: true, res }, buffersOf(res));
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err), name: err?.name });
  }
};
