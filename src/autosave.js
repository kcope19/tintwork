import { encodePNG } from './png.js';
// Crash recovery: keeps copies of open documents in IndexedDB.
//
// Format v2 (Tintwork 0.4): one small record per document "slot" (the layer stack of the last
// N undo steps, JSON-like) plus PNG images stored separately in the 'images' store and shared
// between steps, so an edit only writes the pixels that changed. Up to MAX_SLOTS documents are
// kept (oldest evicted). Format v1 records (one 'current' record with inline PNGs) remain readable.
const DB = 'tintwork', STORE = 'autosave', IMAGES = 'images';
export const MAX_SLOTS = 5;
let dbPromise = null;

function openDB() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB is not available'));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES);
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
    req.onerror = () => { dbPromise = null; reject(req.error || new Error('IndexedDB could not be opened')); };
    req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB blocked')); };
  });
  return dbPromise;
}
/** Run fn(stores) in one transaction; resolves with the result of the request fn returns (if any). */
async function tx(names, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const req = fn(...names.map((n) => t.objectStore(n)));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error || new Error('IndexedDB error'));
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}
const slotRange = (slot) => IDBKeyRange.bound(`${slot}/`, `${slot}/\uffff`);
const imageIdsOf = (r) => r?.imageIds || [];

/** All autosaved documents, newest first (each record carries its own `slot`). */
export async function listAutosaves() {
  const [keys, values] = await Promise.all([
    tx([STORE], 'readonly', (s) => s.getAllKeys()),
    tx([STORE], 'readonly', (s) => s.getAll()),
  ]);
  return values.map((r, i) => ({ ...r, slot: r.slot || keys[i] })).filter((r) => r && r.format === 'tintwork-autosave')
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}
/** One slot's record, or the newest record when no slot is given. */
export async function readAutosave(slot) {
  if (slot) { const r = await tx([STORE], 'readonly', (s) => s.get(slot)); return r ? { ...r, slot: r.slot || slot } : r; }
  return (await listAutosaves())[0] || null;
}
/** PNG bytes for every image a v2 record references: Map imageId -> ArrayBuffer. */
export async function readImages(r) {
  const out = new Map();
  await tx([IMAGES], 'readonly', (s) => { for (const id of imageIdsOf(r)) { const q = s.get(`${r.slot}/${id}`); q.onsuccess = () => out.set(id, q.result); } });
  for (const id of imageIdsOf(r)) if (!out.get(id)) throw new Error(`Autosaved image ${id} is missing`);
  return out;
}
async function deleteSlot(slot) {
  await tx([STORE, IMAGES], 'readwrite', (s, im) => { s.delete(slot); im.delete(slotRange(slot)); });
}
/**
 * Store a record. `images` maps imageId -> () => Promise<ArrayBuffer>; only images that are not yet
 * stored for this slot are encoded and written, and images no longer referenced are deleted.
 */
export async function writeAutosave(record, images = new Map()) {
  const slot = record.slot;
  const stored = new Set(await tx([IMAGES], 'readonly', (im) => im.getAllKeys(slotRange(slot))));
  const want = new Set(record.imageIds.map((id) => `${slot}/${id}`));
  const fresh = [];
  for (const id of record.imageIds) if (!stored.has(`${slot}/${id}`)) fresh.push([id, await images.get(id)()]);
  await tx([STORE, IMAGES], 'readwrite', (s, im) => {
    for (const [id, buf] of fresh) im.put(buf, `${slot}/${id}`);
    for (const k of stored) if (!want.has(k)) im.delete(k);
    s.put(record, slot);
  });
  // keep at most MAX_SLOTS documents
  const all = await listAutosaves();
  for (const r of all.filter((x) => x.slot !== slot).slice(MAX_SLOTS - 1)) await deleteSlot(r.slot);
  return fresh.length;
}
/** Delete one slot, or every autosaved document when no slot is given. */
export async function clearAutosave(slot) {
  if (slot) return deleteSlot(slot);
  await tx([STORE, IMAGES], 'readwrite', (s, im) => { s.clear(); im.clear(); });
}
/** Flag a slot as safely saved elsewhere (no recovery prompt for it next time). */
export async function markAutosaveClean(slot) {
  const r = await readAutosave(slot);
  if (r && r.dirty) { r.dirty = false; await tx([STORE], 'readwrite', (s) => s.put(r, r.slot)); }
}

// Images are stored as ArrayBuffers rather than Blobs: some browsers (e.g. private / ephemeral
// Safari sessions) refuse Blobs in IndexedDB but accept plain binary data.
const SESSION = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ids = new WeakMap(); // canvas -> image id (history canvases are immutable, so an id names fixed pixels)
let seq = 0;
const encoded = new WeakMap(); // canvas -> Promise<ArrayBuffer>
const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Canvas encode failed'))), 'image/png'));
/** Stable id for an immutable canvas plus a lazy PNG encoder (encoded at most once). */
export function imageRef(canvas) {
  let id = ids.get(canvas);
  if (!id) { id = `${SESSION}-${++seq}`; ids.set(canvas, id); }
  const encode = () => {
    if (!encoded.has(canvas)) { const p = toBlob(canvas).then((b) => b.arrayBuffer()); p.catch(() => encoded.delete(canvas)); encoded.set(canvas, p); }
    return encoded.get(canvas);
  };
  return { id, encode };
}
/** 16-bit layer data (deep.js DImage): stored as a 16-bit PNG (fast deflate level), ids start with 'D-'. */
export function deepRef(d) {
  let id = ids.get(d);
  if (!id) { id = `D-${SESSION}-${++seq}`; ids.set(d, id); }
  const encode = () => {
    if (!encoded.has(d)) encoded.set(d, Promise.resolve().then(() => encodePNG({ width: d.width, height: d.height, data: d.data, depth: 16, level: 1 }).buffer));
    return encoded.get(d);
  };
  return { id, encode };
}
export const isDeepId = (id) => id.startsWith('D-');
/** Original camera RAW file of a re-developable layer (a Blob, stored as its bytes); ids start with 'R-'. */
export function rawRef(blob) {
  let id = ids.get(blob);
  if (!id) { id = `R-${SESSION}-${++seq}`; ids.set(blob, id); }
  const encode = () => {
    if (!encoded.has(blob)) { const p = blob.arrayBuffer(); p.catch(() => encoded.delete(blob)); encoded.set(blob, p); }
    return encoded.get(blob);
  };
  return { id, encode };
}
export const isRawId = (id) => id.startsWith('R-');
/** Adopt decoded canvases under their stored ids so a recovered session does not re-encode them. */
export function adoptImage(canvas, id) { ids.set(canvas, id); }
/** PNG bytes (or a Blob from older records) -> ImageBitmap */
export const decodeImage = (data) => createImageBitmap(data instanceof Blob ? data : new Blob([data], { type: 'image/png' }));
