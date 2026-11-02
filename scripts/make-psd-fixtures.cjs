// Builds the third-party-writer PSD/PSB fixtures in test-assets/psd/ with ag-psd (MIT, dev-only, not shipped):
//   npm i --no-save ag-psd && node scripts/make-psd-fixtures.cjs
// The image content is generated here (gradients and discs), so the fixtures carry no third-party artwork.
const { writePsd, initializeCanvas } = require('ag-psd');
const fs = require('fs'), path = require('path');
const fake = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {}, getImageData: (x, y, a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }) }) });
initializeCanvas(fake, (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));
const W = 160, H = 120;
const img = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4); return { width: w, height: h, data: d }; };
const disc = (w, h, rgb) => img(w, h, (x, y) => { const r = Math.hypot(x - w / 2 + 0.5, y - h / 2 + 0.5) / (Math.min(w, h) / 2); return r <= 1 ? [...rgb, 255] : [0, 0, 0, 0]; });
const bg = img(W, H, (x, y) => [Math.round((x / (W - 1)) * 255), Math.round((y / (H - 1)) * 200), 90, 255]);
const psd = {
  width: W, height: H, imageData: bg, // composite: only the background (enough for the composite fallback check)
  children: [
    { name: 'Background', left: 0, top: 0, imageData: bg },
    { name: 'Disc linear burn', left: 10, top: 10, imageData: disc(60, 60, [240, 120, 30]), blendMode: 'linear burn', opacity: 0.9 },
    { name: 'Title text', left: 20, top: 80, imageData: img(90, 20, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 0]),
      text: { text: 'Tintwork', transform: [1, 0, 0, 1, 20, 95], style: { font: { name: 'ArialMT' }, fontSize: 18, fillColor: { r: 255, g: 255, b: 255 } } } },
    { name: 'Placed photo', left: 90, top: 10, imageData: disc(50, 50, [30, 160, 220]),
      placedLayer: { id: 'f2b5c0de-0000-4000-8000-000000000001', placed: 'f2b5c0de-0000-4000-8000-000000000001', type: 'raster', transform: [90, 10, 140, 10, 140, 60, 90, 60], width: 50, height: 50 } },
    { name: 'Shadowed', left: 60, top: 40, imageData: disc(30, 30, [200, 30, 200]),
      effects: { dropShadow: [{ enabled: true, color: { r: 0, g: 0, b: 0 }, opacity: 0.6, angle: 120, distance: { units: 'Pixels', value: 4 }, size: { units: 'Pixels', value: 4 } }] } },
    { name: 'Group with mask', opened: true, blendMode: 'normal', opacity: 0.75,
      mask: { left: 0, top: 0, imageData: img(W, H, (x) => { const v = x < W / 2 ? 255 : 64; return [v, v, v, 255]; }), defaultColor: 255 },
      children: [
        { name: 'Inner', left: 100, top: 70, imageData: disc(40, 40, [20, 220, 90]), blendMode: 'screen' },
        { name: 'Clipped', left: 100, top: 70, imageData: img(40, 20, () => [250, 250, 20, 255]), clipping: true, blendMode: 'multiply' },
      ] },
    { name: 'Brightness', adjustment: { type: 'brightness/contrast', brightness: 15, contrast: 10 } },
    { name: 'Levels', adjustment: { type: 'levels', rgb: { shadowInput: 10, highlightInput: 240, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1.2 } } },
    { name: 'Photo filter', adjustment: { type: 'photo filter', color: { r: 236, g: 138, b: 0 }, density: 25, preserveLuminosity: true } },
  ],
};
const out = path.join(__dirname, '..', 'test-assets', 'psd');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'third-party-features.psd'), Buffer.from(writePsd(psd, { generateThumbnail: false })));
fs.writeFileSync(path.join(out, 'third-party-features.psb'), Buffer.from(writePsd(psd, { generateThumbnail: false, psb: true })));
// flattened only (no layer records): exercises the composite path
fs.writeFileSync(path.join(out, 'flat-only.psd'), Buffer.from(writePsd({ width: W, height: H, imageData: bg }, { generateThumbnail: false })));
console.log('wrote', fs.readdirSync(out).join(', '));
