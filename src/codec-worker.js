// Codec worker: PSD read/write and camera RAW decode + develop, off the UI thread.
// RAW sessions keep the full-resolution linear image here, so slider changes only send a small preview back.
import { readPSD, writePSD } from './psd.js';
import * as R from './raw.js';

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
async function previewOf(s, settings) {
  const pipe = R.pipeline(s.meta, s.model, settings, s.autoW);
  const t = performance.now();
  const out = await developBands(s.small, devOpts(s, settings, pipe, s.small.factor, 1 / s.small.factor, 8));
  const tt = settings.wb === 'custom' ? { temp: settings.temp, tint: settings.tint } : s.model.tempTintFor(pipe.wb);
  return { width: out.width, height: out.height, data: out.data, temp: tt.temp, tint: tt.tint, ms: Math.round(performance.now() - t), ca: s.ca ? { red: s.ca.red / R.CA_UNIT * 100, blue: s.ca.blue / R.CA_UNIT * 100 } : null };
}

const handlers = {
  async psdRead({ bytes }) { return readPSD(new Uint8Array(bytes)); },
  async psdWrite({ doc }) { return { bytes: writePSD(doc) }; },
  /** Open a RAW file: decode the sensor data (or report why not), build the develop preview. */
  async rawOpen({ session, bytes, settings, env }) {
    if (env) { deviceMemory = +env.deviceMemory || 0; bandsOverride = +env.bands || 0; if ('decodeThreads' in env) noThreads = env.decodeThreads === false; if ('workerCap' in env) workerCap = env.workerCap == null ? null : Math.max(0, +env.workerCap | 0); }
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
  async rawPreview({ session, settings }) {
    const s = sessions.get(session); if (!s?.src) throw new Error('RAW session closed');
    return { preview: await previewOf(s, { ...R.DEFAULT_SETTINGS, ...settings }) };
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
    const out = await developBands(src, opts, {
      half: !!half,
      onHalf: half ? (b) => { firstHalf ||= performance.now() - t; progress({ stage: 'half', width: HW, height: HH, rows: b.rows, data: b.data, ms: Math.round(performance.now() - t) }, [b.data.buffer]); } : null,
    });
    if (xform) {
      const tx = performance.now(), k = OW / (xform.fullW || OW), m = xform.m;
      const mm = k === 1 ? m : { a: m.a * k, b: m.b * k, c: m.c * k, d: m.d * k, e: m.e * k, f: m.f * k };
      const d16 = R.resampleAffine(out.data, OW, OH, mm, xform.w, xform.h);
      const total = Math.round(performance.now() - t);
      return { width: xform.w, height: xform.h, developed: [OW, OH], data16: d16, data8: R.to8(d16), scaled: factor > 1, bands: out.bands, workers: out.workers,
        ms: { ...Object.fromEntries(Object.entries(out.ms).map(([q, v]) => [q, Math.round(v)])), xform: Math.round(performance.now() - tx), total } };
    }
    const total = Math.round(performance.now() - t);
    return { width: OW, height: OH, data16: out.data, data8: out.data8, scaled: factor > 1, bands: out.bands,
      workers: out.workers, ms: { ...Object.fromEntries(Object.entries(out.ms).map(([k, v]) => [k, Math.round(v)])), half: Math.round(firstHalf), total, ca: s.ca?.ms } };
  },
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
