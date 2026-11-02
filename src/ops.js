// Client for the pixel worker, with a same-thread fallback (e.g. when module
// workers are unavailable). All calls return Promises.
import { runOp, blendMasked, blurMask, healRegion, spotHeal, colorRangeMask, refineMask } from './pixels.js';
import { runDeep, blendMaskedDeep, createDeep } from './deep.js';

let worker = null;
let workerReady = false;
const pending = new Map();
let seq = 0;

try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    if (e.data.ready) { workerReady = true; return; }
    const job = pending.get(e.data.id); if (!job) return;
    pending.delete(e.data.id);
    if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data);
  };
  worker.onerror = (e) => {
    console.warn('Pixel worker unavailable, falling back to main thread', e.message);
    worker = null; workerReady = false;
    for (const job of pending.values()) job.fallback();
    pending.clear();
  };
} catch { worker = null; }

export const workerStatus = () => ({ available: !!worker, ready: workerReady, busy: pending.size });

function post(msg, transfer, fallback) {
  if (!worker) return Promise.resolve().then(fallback);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, fallback: () => Promise.resolve().then(fallback).then(resolve, reject) });
    worker.postMessage({ id, ...msg }, transfer);
  });
}

/**
 * Run an operation on a copy of `img` (ImageData). Returns a new ImageData.
 * `mask` (Uint8Array, same pixel count) blends the result with the original.
 */
// Optional GPU accelerator (see gpu.js). When set and it supports the op, filters run on the GPU
// synchronously; any GPU failure falls back to the worker / inline CPU path below.
let accel = null;
export function setAccelerator(engine) { accel = engine; }
export const accelerator = () => accel;
let lastPath = 'cpu';
/** Which engine ran the most recent process()/processDeep() call: 'gpu' | 'cpu'. */
export const lastOpPath = () => lastPath;
/** 'webgpu' | 'webgl' for the last GPU op (meaningful when lastOpPath() is 'gpu'). */
let lastKind = '';
export const lastOpKind = () => lastKind;

export async function process(name, img, params = {}, info = {}, mask = null) {
  if (accel && accel.supports(name, img.width, img.height)) {
    try {
      const out = await accel.processImageData(name, img, params, info);
      if (mask) blendMasked(img.data, out.data, mask);
      lastPath = 'gpu'; lastKind = accel.kind || 'webgl';
      return out;
    } catch (err) { console.warn('GPU op failed, using CPU', err); }
  }
  lastPath = 'cpu';
  const data = new Uint8ClampedArray(img.data);
  const { width, height } = img;
  const inline = () => {
    const out = new ImageData(new Uint8ClampedArray(img.data), width, height);
    const orig = mask ? new Uint8ClampedArray(img.data) : null;
    runOp(name, out, params, info);
    if (mask) blendMasked(orig, out.data, mask);
    return { buffer: out.data.buffer };
  };
  const m = mask ? new Uint8Array(mask) : null;
  const res = await post({ kind: 'op', name, width, height, buffer: data.buffer, params, info, mask: m && m.buffer },
    m ? [data.buffer, m.buffer] : [data.buffer], inline);
  return new ImageData(new Uint8ClampedArray(res.buffer), width, height);
}

export async function featherMask(mask, W, H, radius) {
  const copy = new Uint8Array(mask);
  const res = await post({ kind: 'blurMask', mask: copy.buffer, W, H, radius }, [copy.buffer],
    () => ({ mask: blurMask(mask, W, H, radius).buffer }));
  return new Uint8Array(res.mask);
}

/** Healing brush: dst/src are ImageData of the same rectangle, cover a Uint8Array. Returns ImageData. */
export async function heal(dst, src, cover) {
  const { width: w, height: h } = dst;
  const a = new Uint8ClampedArray(dst.data), b = new Uint8ClampedArray(src.data), c = new Uint8Array(cover);
  const res = await post({ kind: 'heal', dst: a.buffer, src: b.buffer, cover: c.buffer, w, h }, [a.buffer, b.buffer, c.buffer],
    () => ({ data: healRegion(dst.data, src.data, cover, w, h).buffer }));
  return new ImageData(new Uint8ClampedArray(res.data), w, h);
}
/** Spot healing: img is the ImageData around the spot, cover the brushed area. */
export async function spot(img, cover) {
  const { width: w, height: h } = img;
  const a = new Uint8ClampedArray(img.data), c = new Uint8Array(cover);
  const res = await post({ kind: 'spotHeal', img: a.buffer, cover: c.buffer, w, h }, [a.buffer, c.buffer],
    () => { const r = spotHeal(img.data, cover, w, h); return { data: r.data.buffer, offset: r.offset }; });
  return { img: new ImageData(new Uint8ClampedArray(res.data), w, h), offset: res.offset };
}

/** Color range: 0..255 selection mask from an ImageData (see pixels.colorRangeMask). */
export async function colorRange(img, params) {
  const { width, height } = img, data = new Uint8ClampedArray(img.data);
  const res = await post({ kind: 'colorRange', buffer: data.buffer, width, height, params }, [data.buffer],
    () => ({ mask: colorRangeMask(img, params).buffer }));
  return new Uint8Array(res.mask);
}

/** Refine edge: smooth / shift edge / feather a 0..255 selection mask (see pixels.refineMask). */
export async function refine(mask, W, H, params) {
  const copy = new Uint8Array(mask);
  const res = await post({ kind: 'refineMask', mask: copy.buffer, W, H, params }, [copy.buffer],
    () => ({ mask: refineMask(mask, W, H, params).buffer }));
  return new Uint8Array(res.mask);
}

/** 16-bit version of process(): `d` is a DImage (see deep.js); returns a new DImage. */
export async function processDeep(name, d, params = {}, info = {}, mask = null) {
  const { width, height } = d;
  if (accel && accel.supportsDeep && accel.supportsDeep(name, width, height, info)) {
    try {
      const out = await accel.processDeep(name, d, params, info);
      if (mask) blendMaskedDeep(d.data, out.data, mask);
      lastPath = 'gpu'; lastKind = accel.kind || 'webgl';
      return out;
    } catch (err) { console.warn('GPU 16-bit op failed, using CPU', err); }
  }
  lastPath = 'cpu';
  const inline = () => {
    const out = createDeep(width, height, new Uint16Array(d.data));
    runDeep(name, out, params, info);
    if (mask) blendMaskedDeep(d.data, out.data, mask);
    return { buffer: out.data.buffer };
  };
  const data = new Uint16Array(d.data), m = mask ? new Uint8Array(mask) : null;
  const res = await post({ kind: 'deep', name, width, height, buffer: data.buffer, params, info, mask: m && m.buffer },
    m ? [data.buffer, m.buffer] : [data.buffer], inline);
  return createDeep(width, height, new Uint16Array(res.buffer));
}
