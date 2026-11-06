/**
 * Output sharpening for export / batch (v1.16). Approximate screen / matte / glossy
 * amounts at three strengths. Applied after resize, before watermark. Not a printer profile.
 * Radius scales gently with the long edge so a 4k export is not over-sharpened vs a 1200 px web file.
 */
import { sharpen as sharpenPixels } from './pixels.js';

/** id → { amount 0..150 (pixels.sharpen scale), radius px at ~2000 long edge, threshold 0..255 } */
export const EXPORT_SHARP_PRESETS = {
  off: null,
  'screen-low': { amount: 40, radius: 0.5, threshold: 0 },
  'screen-std': { amount: 70, radius: 0.7, threshold: 0 },
  'screen-high': { amount: 110, radius: 1.0, threshold: 0 },
  'matte-low': { amount: 55, radius: 0.8, threshold: 2 },
  'matte-std': { amount: 90, radius: 1.0, threshold: 1 },
  'matte-high': { amount: 130, radius: 1.2, threshold: 0 },
  'glossy-low': { amount: 50, radius: 0.6, threshold: 1 },
  'glossy-std': { amount: 85, radius: 0.85, threshold: 0 },
  'glossy-high': { amount: 125, radius: 1.1, threshold: 0 },
};

export const EXPORT_SHARP_GROUPS = [
  { media: 'Screen', ids: ['screen-low', 'screen-std', 'screen-high'], labels: ['Low', 'Standard', 'High'] },
  { media: 'Matte paper', ids: ['matte-low', 'matte-std', 'matte-high'], labels: ['Low', 'Standard', 'High'] },
  { media: 'Glossy paper', ids: ['glossy-low', 'glossy-std', 'glossy-high'], labels: ['Low', 'Standard', 'High'] },
];

export function exportSharpLabel(id) {
  if (!id || id === 'off') return 'Off';
  for (const g of EXPORT_SHARP_GROUPS) {
    const i = g.ids.indexOf(id);
    if (i >= 0) return `${g.media}: ${g.labels[i]}`;
  }
  return id;
}

export function exportSharpOptionsHTML(selected = 'off') {
  const sel = selected && EXPORT_SHARP_PRESETS[selected] !== undefined ? selected : 'off';
  let html = `<option value="off"${sel === 'off' ? ' selected' : ''}>Off</option>`;
  for (const g of EXPORT_SHARP_GROUPS) {
    html += `<optgroup label="${g.media}">`;
    g.ids.forEach((id, i) => { html += `<option value="${id}"${sel === id ? ' selected' : ''}>${g.labels[i]}</option>`; });
    html += '</optgroup>';
  }
  return html;
}

/** Scale radius so a 500 px thumbnail is not as crunchy as a 4000 px print file. */
export function scaledSharpParams(id, longEdge) {
  const p = EXPORT_SHARP_PRESETS[id];
  if (!p) return null;
  // Floor scale so box-blur unsharp still moves pixels on short web exports (~800–1200 px).
  const scale = Math.max(0.7, Math.min(1.35, (longEdge || 2000) / 2000));
  // pixels.gaussianBlur needs radius ≳0.8 or the 3-box sizes collapse to a no-op.
  return { amount: p.amount, radius: Math.max(0.85, Math.min(3, p.radius * scale)), threshold: p.threshold };
}

/**
 * Sharpen an 8-bit canvas in place. Returns true if anything ran.
 * `id` is an EXPORT_SHARP_PRESETS key; `longEdge` defaults to max(canvas width, height).
 */
export function applyExportSharpen(canvas, id, longEdge = 0) {
  if (!id || id === 'off' || !canvas) return false;
  const params = scaledSharpParams(id, longEdge || Math.max(canvas.width, canvas.height));
  if (!params) return false;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  sharpenPixels(img, params);
  ctx.putImageData(img, 0, 0);
  return true;
}
