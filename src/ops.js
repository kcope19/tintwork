// Client for the pixel worker, with a same-thread fallback (e.g. when module
// workers are unavailable). All calls return Promises.
import { runOp, blendMasked, blurMask } from './pixels.js';

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
export async function process(name, img, params = {}, info = {}, mask = null) {
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
