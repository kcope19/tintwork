// File System Access API glue (Chrome / Edge on Windows, macOS, Linux, ChromeOS): open and save straight
// to disk, Save vs Save As, and a recent-files list (file handles kept in IndexedDB). Browsers without the
// API (Safari, Firefox, iOS) fall back to <input type=file> and downloads — callers check `fsaSupported`.

export const fsaSupported = typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;

export const PROJECT_TYPE = { description: 'Tintwork project', accept: { 'application/x-tintwork+json': ['.tintwork'] } };
export const OPEN_TYPES = [
  { description: 'Images and Tintwork projects', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'application/x-tintwork+json': ['.tintwork'], 'application/json': ['.json'] } },
];
export const EXPORT_TYPES = {
  'image/png': { description: 'PNG image', accept: { 'image/png': ['.png'] } },
  'image/jpeg': { description: 'JPEG image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
  'image/webp': { description: 'WebP image', accept: { 'image/webp': ['.webp'] } },
};

/** null when the user cancels the picker. */
export async function pickOpen() {
  try { const [h] = await window.showOpenFilePicker({ types: OPEN_TYPES, excludeAcceptAllOption: false, id: 'tintwork-open' }); return h || null; }
  catch (err) { if (err && err.name === 'AbortError') return null; throw err; }
}
export async function pickSave(suggestedName, type = PROJECT_TYPE) {
  try { return await window.showSaveFilePicker({ suggestedName, types: [type], id: 'tintwork-save' }); }
  catch (err) { if (err && err.name === 'AbortError') return null; throw err; }
}
/** Ask for permission on a stored handle (needs a user gesture the first time after a reload). */
export async function ensurePermission(handle, mode = 'read') {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  if (!handle.requestPermission) return false;
  return (await handle.requestPermission({ mode })) === 'granted';
}
export async function writeFile(handle, blob) {
  if (!(await ensurePermission(handle, 'readwrite'))) throw new Error('Permission to write the file was denied');
  const w = await handle.createWritable();
  try { await w.write(blob); await w.close(); } catch (err) { try { await w.abort(); } catch { /* ignore */ } throw err; }
}

// ---- recent files ----------------------------------------------------------------------------------
const DB = 'tintwork-files', STORE = 'recent', MAX_RECENT = 10;
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  try {
    return await new Promise((res, rej) => { const t = d.transaction(STORE, mode), s = t.objectStore(STORE); const out = fn(s); t.oncomplete = () => res(out && 'result' in out ? out.result : out); t.onerror = () => rej(t.error); });
  } finally { d.close(); }
}
/** Newest first: [{ id, name, kind: 'project' | 'image', time, handle }]. */
export async function listRecent() {
  try { const all = await tx('readonly', (s) => s.getAll()); return (all || []).sort((a, b) => b.time - a.time); } catch { return []; }
}
export async function addRecent(handle, kind) {
  if (!handle) return;
  try {
    const list = await listRecent();
    let same = null; for (const r of list) { try { if (r.handle && await r.handle.isSameEntry?.(handle)) { same = r; break; } } catch { /* stale */ } }
    const id = same ? same.id : `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await tx('readwrite', (s) => { s.put({ id, name: handle.name, kind, time: Date.now(), handle }); });
    const extra = (await listRecent()).slice(MAX_RECENT);
    if (extra.length) await tx('readwrite', (s) => { for (const r of extra) s.delete(r.id); });
  } catch (err) { console.warn('Could not store the recent file', err); }
}
export async function removeRecent(id) { try { await tx('readwrite', (s) => { s.delete(id); }); } catch { /* ignore */ } }
export async function clearRecent() { try { await tx('readwrite', (s) => { s.clear(); }); } catch { /* ignore */ } }
