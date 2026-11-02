// Main-thread client of codec-worker.js (PSD and camera RAW).
let worker = null, seq = 0, sessionSeq = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./codec-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, res, error, name, progress } = e.data, p = pending.get(id); if (!p) return;
    if (progress) { try { p.onProgress?.(progress); } catch (err) { console.error(err); } return; }
    pending.delete(id);
    if (ok) p.resolve(res); else { const err = new Error(error); err.name = name || 'Error'; p.reject(err); }
  };
  worker.onerror = (e) => { // a crash (for example out of memory) fails every pending request
    const err = new Error(e.message || 'The file decoder stopped unexpectedly (the image may be too large for this device).');
    for (const p of pending.values()) p.reject(err);
    pending.clear(); worker.terminate(); worker = null;
  };
  return worker;
}
function call(op, args = {}, transfer = [], onProgress = null) {
  return new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, op, ...args }, transfer);
  });
}
export const RAW_EXTS = ['dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl', 'pef', 'srw', 'erf', '3fr', 'fff', 'iiq', 'mos', 'mef', 'mrw', 'x3f', 'kdc', 'dcr'];
export const PSD_EXTS = ['psd', 'psb'];
const extOf = (name) => (/\.([^.]+)$/.exec(name || '')?.[1] || '').toLowerCase();
export const isRawName = (name) => RAW_EXTS.includes(extOf(name));
export const isPsdName = (name) => PSD_EXTS.includes(extOf(name));
export const isPsdBytes = (b) => b.length > 4 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53; // 8BPS

export const readPSDAsync = (bytes) => call('psdRead', { bytes }, [bytes.buffer]);
export const writePSDAsync = (doc) => call('psdWrite', { doc }, transferablesOf(doc));
function transferablesOf(doc) {
  const out = [];
  const add = (a) => { if (a && ArrayBuffer.isView(a) && !out.includes(a.buffer)) out.push(a.buffer); };
  add(doc.composite); for (const l of doc.layers) { add(l.pixels); add(l.mask?.data); }
  return out;
}
/** A RAW develop session: the decoded sensor image stays in the worker until close(). */
export async function openRawSession(bytes, settings) {
  const session = ++sessionSeq;
  const res = await call('rawOpen', { session, bytes, settings }, [bytes.buffer]);
  return {
    ...res, session, firstPreview: res.preview,
    preview: (s) => call('rawPreview', { session, settings: s }).then((r) => r.preview),
    /** Full-resolution develop; onHalf({ width, height, rows, data }) receives half-resolution bands as they finish. */
    develop: (s, maxPixels, onHalf = null) => call('rawDevelop', { session, settings: s, maxPixels, half: !!onHalf }, [], onHalf),
    jpeg: () => call('rawJpeg', { session }),
    close: () => call('rawClose', { session }).catch(() => {}),
  };
}
