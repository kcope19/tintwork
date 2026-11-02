// Batch export helpers (v0.9): output naming patterns, variant sizes, and a small zip writer fallback.
import { zipSync } from '../vendor/fflate/fflate.js';

/** Tokens: {name} source name without extension, {n} 1-based index (padded {n:3}), {w} {h} output size,
 * {preset} preset / size label, {ext} extension, {date} YYYY-MM-DD. Unsafe filename characters become "_". */
export function formatName(pattern, t) {
  const out = String(pattern || '{name}').replace(/\{(\w+)(?::(\d+))?\}/g, (m, k, pad) => {
    if (k === 'n' || k === 'N') return String(t[k] ?? 1).padStart(+pad || 1, '0');
    if (k === 'date') return (t.date || new Date()).toISOString().slice(0, 10);
    return t[k] != null ? String(t[k]) : m;
  });
  return out.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim() || 'image';
}
/** Output size for a variant: { mode: 'original' | 'long' | 'width' | 'exact' | 'scale', long, w, h, pct }. Never upsizes unless allowUp. */
export function variantSize(W, H, v) {
  let w = W, h = H;
  if (v.mode === 'long') { const k = v.long / Math.max(W, H); w = W * k; h = H * k; }
  else if (v.mode === 'width') { w = v.w; h = (H * v.w) / W; }
  else if (v.mode === 'exact') { w = v.w; h = v.h; }
  else if (v.mode === 'scale') { w = (W * v.pct) / 100; h = (H * v.pct) / 100; }
  if (!v.allowUp && v.mode !== 'exact' && w > W) { w = W; h = H; }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}
/** Unique names within one run: "a.jpg", "a-2.jpg", ... */
export function uniqueNamer() {
  const used = new Set();
  return (name) => { let n = name, i = 2; const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    while (used.has(n.toLowerCase())) n = `${base}-${i++}${ext}`; used.add(n.toLowerCase()); return n; };
}
/** Zip {name: Uint8Array} (stored, images are already compressed). */
export const zipFiles = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: 0 }]])));
