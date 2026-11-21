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
let dbHandle = null; // v1.34: the open database, kept so the unload flush can start a transaction synchronously
const storedKeys = new Map(); // v1.34: slot -> Set of image keys known to be in IndexedDB (written this session)
const latestSaved = new Map(); // v1.34: slot -> savedAt of the newest record written synchronously (an older async write must not overwrite it)

function openDB() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB is not available'));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES);
    };
    req.onsuccess = () => { const db = req.result; dbHandle = db; db.onversionchange = () => { db.close(); dbPromise = null; dbHandle = null; }; resolve(db); };
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
  storedKeys.delete(slot);
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
  // v1.34: an unload flush wrote a newer record for this slot meanwhile: this older one must not replace it
  // (nor delete the images the newer record references)
  if ((latestSaved.get(slot) || 0) > record.savedAt) return 0;
  await tx([STORE, IMAGES], 'readwrite', (s, im) => {
    for (const [id, buf] of fresh) im.put(buf, `${slot}/${id}`);
    for (const k of stored) if (!want.has(k)) im.delete(k);
    s.put(record, slot);
  });
  storedKeys.set(slot, want);
  // keep at most MAX_SLOTS documents
  const all = await listAutosaves();
  for (const r of all.filter((x) => x.slot !== slot).slice(MAX_SLOTS - 1)) await deleteSlot(r.slot);
  return fresh.length;
}
/** Delete one slot, or every autosaved document when no slot is given. */
export async function clearAutosave(slot) {
  if (slot) return deleteSlot(slot);
  storedKeys.clear();
  await tx([STORE, IMAGES], 'readwrite', (s, im) => { s.clear(); im.clear(); });
}
/** v1.34: open the database ahead of time so an unload flush has a handle to use synchronously. */
export function warmAutosave() { return openDB().then(() => true, () => false); }
/**
 * v1.34: write a record from inside pagehide / visibilitychange without awaiting anything. IndexedDB requests
 * issued synchronously in the handler, followed by an explicit commit(), are handed to the browser's storage
 * process before the page goes away; awaiting a PNG encode first (the normal path) is what lost the last
 * second of edits. `images` maps imageId -> { ready(): ArrayBuffer|undefined (an encode already finished),
 * raw(): stored value|null (raw pixels read synchronously) }. Images already written for this slot are not
 * written again. Returns the number of bytes queued, or -1 when it could not start (no database handle yet,
 * or an image could not be produced synchronously). `onDone(ok)` runs when the transaction settles.
 */
export function writeAutosaveSync(record, images, { maxBytes = 96 * 1048576, onDone } = {}) {
  const db = dbHandle; if (!db) return -1;
  const slot = record.slot, have = storedKeys.get(slot) || new Set(), puts = [];
  let bytes = 0;
  for (const id of record.imageIds) {
    const key = `${slot}/${id}`; if (have.has(key)) continue;
    const src = images.get(id); if (!src) return -1;
    const v = src.ready() ?? src.raw(); if (!v) return -1;
    bytes += v.byteLength ?? v.data?.byteLength ?? 0; if (bytes > maxBytes) return -1;
    puts.push([key, v]);
  }
  let t;
  try {
    t = db.transaction([STORE, IMAGES], 'readwrite');
    const s = t.objectStore(STORE), im = t.objectStore(IMAGES);
    for (const [k, v] of puts) im.put(v, k);
    s.put(record, slot);
    latestSaved.set(slot, record.savedAt);
    t.oncomplete = () => { const set = storedKeys.get(slot) || new Set(); for (const [k] of puts) set.add(k); storedKeys.set(slot, set); onDone?.(true); };
    t.onerror = t.onabort = () => onDone?.(false);
    t.commit?.(); // send it now: the page may not get another turn of its event loop
  } catch { try { t?.abort(); } catch { /* already finished */ } return -1; }
  return bytes;
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
const done = new WeakMap(); // v1.34: canvas / DImage / Blob -> ArrayBuffer once its encode has finished (usable synchronously)
const settle = (key, p) => { p.then((b) => done.set(key, b), () => {}); return p; };
const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Canvas encode failed'))), 'image/png'));
/** Stable id for an immutable canvas plus a lazy PNG encoder (encoded at most once). */
export function imageRef(canvas) {
  let id = ids.get(canvas);
  if (!id) { id = `${SESSION}-${++seq}`; ids.set(canvas, id); }
  const encode = () => {
    if (!encoded.has(canvas)) { const p = toBlob(canvas).then((b) => b.arrayBuffer()); p.catch(() => encoded.delete(canvas)); encoded.set(canvas, settle(canvas, p)); }
    return encoded.get(canvas);
  };
  // v1.34: synchronous fallbacks for the unload flush: a finished PNG, else the raw RGBA pixels (read now)
  const ready = () => done.get(canvas);
  const raw = () => {
    if (canvas.width * canvas.height > RAW_PX) return null;
    try { const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height); return { raw: 'rgba8', width: d.width, height: d.height, data: d.data.buffer }; } catch { return null; }
  };
  return { id, encode, ready, raw };
}
const RAW_PX = 24e6; // larger canvases are not copied raw on unload (they rely on the regular autosave)
/** 16-bit layer data (deep.js DImage): stored as a 16-bit PNG (fast deflate level), ids start with 'D-'. */
export function deepRef(d) {
  let id = ids.get(d);
  if (!id) { id = `D-${SESSION}-${++seq}`; ids.set(d, id); }
  const encode = () => {
    if (!encoded.has(d)) encoded.set(d, settle(d, Promise.resolve().then(() => encodePNG({ width: d.width, height: d.height, data: d.data, depth: 16, level: 1 }).buffer)));
    return encoded.get(d);
  };
  return { id, encode, ready: () => done.get(d), raw: () => null };
}
export const isDeepId = (id) => id.startsWith('D-');
/** Original camera RAW file of a re-developable layer (a Blob, stored as its bytes); ids start with 'R-'. */
export function rawRef(blob) {
  let id = ids.get(blob);
  if (!id) { id = `R-${SESSION}-${++seq}`; ids.set(blob, id); }
  const encode = () => {
    if (!encoded.has(blob)) { const p = blob.arrayBuffer(); p.catch(() => encoded.delete(blob)); encoded.set(blob, settle(blob, p)); }
    return encoded.get(blob);
  };
  return { id, encode, ready: () => done.get(blob), raw: () => null };
}
export const isRawId = (id) => id.startsWith('R-');
/** v1.34: images a recovered record already holds in IndexedDB (the unload flush then skips them). */
export function noteStored(slot, imageIds) { const set = storedKeys.get(slot) || new Set(); for (const id of imageIds) set.add(`${slot}/${id}`); storedKeys.set(slot, set); }
/** Adopt decoded canvases under their stored ids so a recovered session does not re-encode them. */
export function adoptImage(canvas, id) { ids.set(canvas, id); }
/** PNG bytes (or a Blob from older records) -> ImageBitmap */
export const decodeImage = (data) => (data && data.raw === 'rgba8' // v1.34: raw pixels written by the unload flush
  ? createImageBitmap(new ImageData(new Uint8ClampedArray(data.data), data.width, data.height))
  : createImageBitmap(data instanceof Blob ? data : new Blob([data], { type: 'image/png' })));
