// Crop / resize presets (v0.9): common social-media and print sizes, plus the user's own presets.
// Social sizes are generic aspect ratios with a typical pixel size; print sizes are in inches at a chosen DPI.

export const BUILTIN_PRESETS = [
  { id: 'sq', group: 'Social', name: 'Square 1:1', w: 1080, h: 1080 },
  { id: 'portrait45', group: 'Social', name: 'Portrait 4:5', w: 1080, h: 1350 },
  { id: 'story', group: 'Social', name: 'Story / vertical video 9:16', w: 1080, h: 1920 },
  { id: 'land169', group: 'Social', name: 'Landscape 16:9', w: 1920, h: 1080 },
  { id: 'land191', group: 'Social', name: 'Link preview 1.91:1', w: 1200, h: 628 },
  { id: 'banner3', group: 'Banners', name: 'Header banner 3:1', w: 1500, h: 500 },
  { id: 'banner4', group: 'Banners', name: 'Profile banner 4:1', w: 1584, h: 396 },
  { id: 'banner16', group: 'Banners', name: 'Channel art 16:9', w: 2560, h: 1440 },
  { id: 'web728', group: 'Banners', name: 'Leaderboard ad 728×90', w: 728, h: 90 },
  { id: 'p4x6', group: 'Print', name: '4 × 6 in', inW: 4, inH: 6 },
  { id: 'p5x7', group: 'Print', name: '5 × 7 in', inW: 5, inH: 7 },
  { id: 'p8x10', group: 'Print', name: '8 × 10 in', inW: 8, inH: 10 },
  { id: 'pA4', group: 'Print', name: 'A4 (210 × 297 mm)', inW: 8.27, inH: 11.69 },
];
export const RATIO_ONLY = [
  { id: 'r11', name: '1:1', rw: 1, rh: 1 }, { id: 'r45', name: '4:5', rw: 4, rh: 5 }, { id: 'r23', name: '2:3', rw: 2, rh: 3 },
  { id: 'r34', name: '3:4', rw: 3, rh: 4 }, { id: 'r57', name: '5:7', rw: 5, rh: 7 }, { id: 'r169', name: '16:9', rw: 16, rh: 9 }, { id: 'r916', name: '9:16', rw: 9, rh: 16 },
];
const KEY = 'tintwork.sizePresets';
export function customPresets() { try { return JSON.parse(localStorage.getItem(KEY) || '[]').filter((p) => p && p.id && p.name); } catch { return []; } }
export function saveCustomPreset(p) {
  const list = customPresets().filter((x) => x.id !== p.id && x.name !== p.name);
  const id = p.id || `c-${Date.now().toString(36)}`; list.push({ ...p, id, group: 'Custom' }); localStorage.setItem(KEY, JSON.stringify(list)); return id;
}
export function deleteCustomPreset(id) { localStorage.setItem(KEY, JSON.stringify(customPresets().filter((x) => x.id !== id))); }
export const allPresets = () => [...BUILTIN_PRESETS, ...customPresets()];
export const presetById = (id) => allPresets().find((p) => p.id === id) || RATIO_ONLY.find((p) => p.id === id) || null;

/** Target pixel size of a preset (print presets use dpi); `landscape` swaps to the wider orientation. */
export function presetPixels(p, dpi = 300, orient = 'auto', srcW = 0, srcH = 0) {
  let w = p.w ?? (p.inW != null ? Math.round(p.inW * dpi) : p.rw), h = p.h ?? (p.inH != null ? Math.round(p.inH * dpi) : p.rh);
  // 'auto': print sizes follow the photo's orientation; social sizes keep theirs
  const want = orient === 'auto' ? (p.inW != null && srcW && srcH ? (srcW > srcH ? 'landscape' : 'portrait') : null) : orient;
  if ((want === 'landscape' && h > w) || (want === 'portrait' && w > h)) [w, h] = [h, w];
  return { w, h };
}
/** Largest rect of aspect rw:rh centred in W×H. */
export function centredRatioRect(W, H, rw, rh) {
  const r = rw / rh; let w = W, h = Math.round(W / r);
  if (h > H) { h = H; w = Math.round(H * r); }
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w: Math.max(1, w), h: Math.max(1, h) };
}
/** Constrain a dragged crop rect (from anchor a to point b) to aspect rw:rh, keeping the drag direction. */
export function constrainRect(a, b, rw, rh, bounds) {
  const sx = b.x >= a.x ? 1 : -1, sy = b.y >= a.y ? 1 : -1, r = rw / rh;
  let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  if (w / Math.max(h, 1e-6) > r) h = w / r; else w = h * r;
  // keep inside the image
  const maxW = sx > 0 ? bounds.w - a.x : a.x, maxH = sy > 0 ? bounds.h - a.y : a.y;
  const k = Math.min(1, maxW / Math.max(w, 1e-6), maxH / Math.max(h, 1e-6)); w *= k; h *= k;
  w = Math.round(w); h = Math.round(h);
  return { x: sx > 0 ? a.x : a.x - w, y: sy > 0 ? a.y : a.y - h, w, h };
}
export const describePreset = (p, dpi = 300) => {
  if (p.inW != null) return `${p.name} · ${Math.round(p.inW * dpi)}×${Math.round(p.inH * dpi)} px at ${dpi} DPI`;
  if (p.w != null) return `${p.name} · ${p.w}×${p.h} px`;
  return p.name;
};
