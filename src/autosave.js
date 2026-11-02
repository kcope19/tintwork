// Crash recovery: keeps a copy of the open document in IndexedDB.
// One record ("current") holds the layer stack with PNG blobs per layer/mask.
const DB = 'tintwork', STORE = 'autosave', KEY = 'current';
let dbPromise = null;

function openDB() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB is not available'));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error || new Error('IndexedDB could not be opened')); };
    req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB blocked')); };
  });
  return dbPromise;
}
async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode), store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error || new Error('IndexedDB error'));
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}
export const readAutosave = () => tx('readonly', (s) => s.get(KEY));
export const writeAutosave = (record) => tx('readwrite', (s) => s.put(record, KEY));
export const clearAutosave = () => tx('readwrite', (s) => s.delete(KEY));
/** Flag the stored copy as safely saved elsewhere (no recovery prompt next time). */
export async function markAutosaveClean() {
  const r = await readAutosave(); if (r && r.dirty) { r.dirty = false; await writeAutosave(r); }
}

// Stored as ArrayBuffers rather than Blobs: some browsers (e.g. private / ephemeral
// Safari sessions) refuse Blobs in IndexedDB but accept plain binary data.
const blobCache = new Map(); // `${id}:${rev}` -> Promise<ArrayBuffer> (canvases are immutable per rev)
const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Canvas encode failed'))), 'image/png'));
async function cachedBlob(key, canvas, used) {
  used.add(key);
  if (!blobCache.has(key)) {
    const p = toBlob(canvas).then((b) => b.arrayBuffer());
    p.catch(() => blobCache.delete(key));
    blobCache.set(key, p);
  }
  return blobCache.get(key);
}
/** PNG bytes (or a Blob from older records) -> ImageBitmap */
export const decodeImage = (data) => createImageBitmap(data instanceof Blob ? data : new Blob([data], { type: 'image/png' }));
/**
 * Build a record from a document. Each layer's canvas is encoded once per revision.
 * @param {object} d  document { width, height, name, layers, activeId }
 */
export async function buildRecord(d, meta = {}) {
  const used = new Set();
  const layers = await Promise.all(d.layers.map(async (l) => ({
    name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y,
    kind: l.kind || null, adj: l.adj || null, text: l.text || null,
    png: await cachedBlob(`${l.id}:${l.rev}`, l.canvas, used),
    mask: l.mask ? { enabled: l.mask.enabled, png: await cachedBlob(`${l.id}:m${l.mask.rev}`, l.mask.canvas, used) } : null,
  })));
  for (const k of blobCache.keys()) if (!used.has(k)) blobCache.delete(k); // keep only the current revisions
  return {
    format: 'tintwork-autosave', version: 1, // layer/mask images are PNG bytes savedAt: Date.now(), dirty: true,
    width: d.width, height: d.height, name: d.name, activeIndex: Math.max(0, d.layers.findIndex((l) => l.id === d.activeId)),
    layers, ...meta,
  };
}
