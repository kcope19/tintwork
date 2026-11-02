// One-tap looks: original presets, each a short stack of ordinary adjustment layers. Applying a look adds
// a pass-through group named after it (fully editable: every layer can be opened, hidden or deleted); the
// group's opacity is the look's intensity. User looks use the same format and can be exported as JSON.
const id = [[0, 0], [255, 255]];
const curves = (rgb = id, r = id, g = id, b = id) => ({ type: 'curves', params: { rgb, r, g, b } });
const wb = (temperature, tint = 0) => ({ type: 'whiteBalance', params: { temperature, tint } });
const hs = (saturation, hue = 0, lightness = 0) => ({ type: 'hueSaturation', params: { hue, saturation, lightness } });
const bc = (brightness, contrast) => ({ type: 'brightnessContrast', params: { brightness, contrast } });
const lv = (inBlack, inWhite, gamma, outBlack = 0, outWhite = 255) => ({ type: 'levels', params: { inBlack, inWhite, gamma, outBlack, outWhite } });
const ex = (exposure, offset = 0, gamma = 1) => ({ type: 'exposure', params: { exposure, offset, gamma } });

export const LOOKS = [
  { id: 'warm-afternoon', name: 'Warm afternoon', layers: [wb(22, 4), curves([[0, 0], [70, 64], [190, 198], [255, 255]]), hs(8)] },
  { id: 'cool-morning', name: 'Cool morning', layers: [wb(-20, -3), curves([[0, 8], [128, 132], [255, 250]]), hs(-6)] },
  { id: 'soft-matte', name: 'Soft matte', layers: [curves([[0, 28], [64, 70], [192, 190], [255, 238]]), hs(-12)] },
  { id: 'crisp-punch', name: 'Crisp punch', layers: [bc(4, 22), hs(14)] },
  { id: 'faded-film', name: 'Faded film', layers: [curves([[0, 34], [128, 126], [255, 232]], [[0, 10], [255, 250]], id, [[0, 22], [255, 228]]), hs(-18), wb(8, 3)] },
  { id: 'teal-amber', name: 'Teal & amber', layers: [curves(id, [[0, 0], [70, 58], [190, 205], [255, 255]], id, [[0, 18], [80, 92], [180, 170], [255, 225]]), hs(10)] },
  { id: 'mono-classic', name: 'Mono classic', layers: [{ type: 'grayscale', params: {} }, curves([[0, 0], [64, 54], [192, 202], [255, 255]])] },
  { id: 'mono-high-key', name: 'Mono high key', layers: [{ type: 'grayscale', params: {} }, ex(0.45, 0, 1.15), curves([[0, 18], [255, 255]])] },
  { id: 'golden-hour', name: 'Golden hour', layers: [wb(34, 8), lv(4, 250, 1.06), hs(12, -2)] },
  { id: 'nordic-fade', name: 'Nordic fade', layers: [wb(-10, 0), curves([[0, 22], [128, 136], [255, 244]]), hs(-30)] },
  { id: 'vivid-pop', name: 'Vivid pop', layers: [lv(6, 248, 1), hs(28), bc(0, 10)] },
  { id: 'moody-dusk', name: 'Moody dusk', layers: [ex(-0.35), wb(-14, 10), curves([[0, 10], [80, 66], [200, 205], [255, 248]]), hs(-10)] },
];
/** Validate / normalise a look (built-in, saved or imported). Unknown layer types are dropped. */
export function normalizeLook(o, allowed) {
  if (!o || typeof o.name !== 'string' || !Array.isArray(o.layers)) return null;
  const layers = o.layers.filter((l) => l && allowed.has(l.type) && l.type !== 'lut3d').map((l) => ({ type: l.type, params: JSON.parse(JSON.stringify(l.params || {})) }));
  if (!layers.length) return null;
  return { id: String(o.id || `user-${Date.now().toString(36)}`), name: o.name.slice(0, 60), layers, user: !!o.user };
}
export const lookToLayers = (look) => look.layers.map((l) => ({ type: l.type, params: JSON.parse(JSON.stringify(l.params)) }));
