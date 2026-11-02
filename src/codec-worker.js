// Codec worker: PSD read/write and camera RAW decode + develop, off the UI thread.
// RAW sessions keep the full-resolution linear image here, so slider changes only send a small preview back.
import { readPSD, writePSD } from './psd.js';
import * as R from './raw.js';

let flashraw = null;
async function engine() {
  if (!flashraw) {
    flashraw = import('../vendor/flashraw/browser.js').then(async (m) => { await m.init({ threads: false }); return m; })
      .catch((e) => { flashraw = null; throw e; });
  }
  return flashraw;
}
const sessions = new Map();
const PREVIEW_SIDE = 1400;

function buffersOf(obj, out = []) { // transferable buffers inside a result (deduplicated)
  if (!obj || typeof obj !== 'object') return out;
  if (ArrayBuffer.isView(obj)) { if (!out.includes(obj.buffer)) out.push(obj.buffer); return out; }
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) buffersOf(v, out);
  return out;
}
async function previewOf(s, settings) {
  const pipe = R.pipeline(s.meta, s.model, settings, s.autoW);
  const t = performance.now();
  const out = R.develop(s.small, { pipe, orientation: s.orientation, factor: s.small.factor, lens: settings.lens === false ? null : s.lensOpts, vignette: (settings.vignette || 0) / 100, out8: true });
  R.denoise(out.data8, out.width, out.height, settings.nrLuma, settings.nrColor, 1 / s.small.factor);
  const tt = settings.wb === 'custom' ? { temp: settings.temp, tint: settings.tint } : s.model.tempTintFor(pipe.wb);
  return { width: out.width, height: out.height, data: out.data8, temp: tt.temp, tint: tt.tint, ms: Math.round(performance.now() - t) };
}

const handlers = {
  async psdRead({ bytes }) { return readPSD(new Uint8Array(bytes)); },
  async psdWrite({ doc }) { return { bytes: writePSD(doc) }; },
  /** Open a RAW file: decode the sensor data (or report why not), build the develop preview. */
  async rawOpen({ session, bytes, settings }) {
    const fr = await engine(), t0 = performance.now();
    const raw = await fr.FlashRaw.open(new Uint8Array(bytes));
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
    s.lensOpts = lens.warp || lens.vignette ? { ...lens, frame: { fullW: aa?.width || frame.width, fullH: aa?.height || frame.height, offX, offY } } : null;
    s.small = R.downscale(s.src, PREVIEW_SIDE);
    s.autoW = R.autoMultipliers(s.model, s.small);
    const [ow, oh] = R.orientedSize(frame.width, frame.height, s.orientation);
    Object.assign(info, {
      width: ow, height: oh, knownCamera: s.model.known, asShot: s.model.asShotTT, auto: s.model.tempTintFor(s.autoW),
      lens: s.lensOpts ? { distortion: !!lens.warp, vignette: !!lens.vignette } : null, incomplete: !!frame.incomplete,
      warnings: (frame.warnings || []).map((w) => w.message || String(w.kind)), baselineExposure: meta.dng?.baselineExposure || 0,
    });
    const preview = await previewOf(s, { ...R.DEFAULT_SETTINGS, ...settings });
    return { info, decoded: true, decodeMs, preview };
  },
  async rawPreview({ session, settings }) {
    const s = sessions.get(session); if (!s?.src) throw new Error('RAW session closed');
    return { preview: await previewOf(s, { ...R.DEFAULT_SETTINGS, ...settings }) };
  },
  /** Full-resolution develop to 16 bits/channel (with an 8-bit copy for the canvas). */
  async rawDevelop({ session, settings, maxPixels }) {
    const s = sessions.get(session); if (!s?.src) throw new Error('RAW session closed');
    const set = { ...R.DEFAULT_SETTINGS, ...settings }, t = performance.now();
    let src = s.src, factor = 1;
    if (maxPixels && src.width * src.height > maxPixels) { // device limit: develop from a box-downscaled copy
      const k = Math.ceil(Math.sqrt((src.width * src.height) / maxPixels));
      src = R.downscale(src, Math.floor(Math.max(src.width, src.height) / k)); factor = src.factor;
    }
    const pipe = R.pipeline(s.meta, s.model, set, s.autoW);
    const out = R.develop(src, { pipe, orientation: s.orientation, factor, lens: set.lens === false ? null : s.lensOpts, vignette: (set.vignette || 0) / 100, out16: true });
    const t1 = performance.now();
    R.denoise(out.data16, out.width, out.height, set.nrLuma, set.nrColor, 1 / factor);
    const t2 = performance.now();
    const data8 = R.to8(out.data16);
    return { width: out.width, height: out.height, data16: out.data16, data8, scaled: factor > 1, ms: { develop: Math.round(t1 - t), nr: Math.round(t2 - t1), total: Math.round(performance.now() - t) } };
  },
  async rawJpeg({ session }) {
    const s = sessions.get(session); if (!s) throw new Error('RAW session closed');
    const p = await s.raw.preview();
    if (!p) throw new Error('This file has no embedded preview');
    return { bytes: p.data.slice(), mimeType: p.mimeType, width: p.width, height: p.height, orientation: p.orientation || 1 };
  },
  async rawClose({ session }) {
    const s = sessions.get(session);
    if (s) { try { s.raw.close(); } catch { /* already closed */ } sessions.delete(session); }
    return {};
  },
};

self.onmessage = async (e) => {
  const { id, op, ...args } = e.data;
  try {
    const res = await handlers[op](args);
    self.postMessage({ id, ok: true, res }, buffersOf(res));
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err), name: err?.name });
  }
};
