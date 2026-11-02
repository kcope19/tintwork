// End-to-end smoke test: serves the app, drives it in headless Chromium,
// exercises the main features and writes screenshots to ./screenshots.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'screenshots');
const assets = path.join(root, 'test-assets');
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(assets, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

const errors = [];
const check = (cond, msg) => { if (!cond) { errors.push(msg); console.error('FAIL', msg); } else console.log('ok  ', msg); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
// This suite covers the download fallback (Firefox / Safari / no File System Access API); the save-picker
// path is covered by windows-test.mjs.
await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; delete window.showDirectoryPicker; });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto(url);
await page.screenshot({ path: path.join(shots, '01-welcome.png') });

// --- generate a synthetic "landscape photo" test image --------------------
const testImg = path.join(assets, 'landscape.png');
if (!fs.existsSync(testImg)) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1067; const x = c.getContext('2d');
    const sky = x.createLinearGradient(0, 0, 0, 700); sky.addColorStop(0, '#2b5f9e'); sky.addColorStop(0.6, '#f0a35e'); sky.addColorStop(1, '#f7d39a');
    x.fillStyle = sky; x.fillRect(0, 0, 1600, 1067);
    const sun = x.createRadialGradient(1100, 520, 10, 1100, 520, 260); sun.addColorStop(0, '#fff6d8'); sun.addColorStop(0.25, '#ffd27a'); sun.addColorStop(1, '#ffd27a00');
    x.fillStyle = sun; x.fillRect(0, 0, 1600, 1067);
    const ridge = (y0, amp, col, seed) => { x.fillStyle = col; x.beginPath(); x.moveTo(0, 1067);
      for (let i = 0; i <= 1600; i += 8) x.lineTo(i, y0 - amp * (Math.sin(i / 170 + seed) * 0.6 + Math.sin(i / 61 + seed * 2) * 0.25 + Math.sin(i / 23 + seed) * 0.08));
      x.lineTo(1600, 1067); x.fill(); };
    ridge(640, 120, '#6b5a7e', 1); ridge(720, 90, '#4a3f5e', 3); ridge(820, 70, '#2f2a3d', 5);
    const lake = x.createLinearGradient(0, 860, 0, 1067); lake.addColorStop(0, '#d98b5a'); lake.addColorStop(1, '#1d2433');
    x.fillStyle = lake; x.fillRect(0, 870, 1600, 197);
    x.fillStyle = '#ffffff22'; for (let i = 0; i < 40; i++) x.fillRect(900 + Math.sin(i) * 120, 880 + i * 4.5, 320 - i * 6, 2);
    for (let i = 0; i < 60; i++) { const tx = (i * 97) % 1600, th = 40 + (i * 37) % 60; x.fillStyle = '#141820'; x.beginPath(); x.moveTo(tx, 880); x.lineTo(tx + 12, 880 - th); x.lineTo(tx + 24, 880); x.fill(); }
    return c.toDataURL('image/png');
  });
  fs.writeFileSync(testImg, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

// --- open via the real file picker ------------------------------------------
await page.setInputFiles('#fileInput', testImg);
await page.waitForFunction(() => window.tintwork.doc?.layers.length === 1);
check(await page.evaluate(() => window.tintwork.doc.width === 1600 && window.tintwork.doc.height === 1067), 'image opened at 1600x1067');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shots, '02-opened.png') });

const idle = () => page.evaluate(() => window.tintwork.idle());
const viewBox = await page.locator('#view').boundingBox();
const docToScreen = async (x, y) => page.evaluate(([x, y]) => {
  const s = window.tintwork.state; const r = document.querySelector('#view').getBoundingClientRect();
  return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom };
}, [x, y]);

const menuCmd = async (cmd) => {
  const menu = page.locator('.menu', { has: page.locator(`.menu-items [data-cmd="${cmd}"]`) });
  await menu.locator('> button').click();
  await menu.locator(`.menu-items [data-cmd="${cmd}"]`).click();
};

// --- adjustment: hue/saturation via keyboard shortcut + sliders ------------------
await page.locator('#viewport').focus();
await page.keyboard.press('Control+u');
await page.waitForSelector('#modal:not(.hidden)');
const setSlider = (key, v) => page.evaluate(([key, v]) => { const i = document.querySelector(`#modalBody input[data-key="${key}"]`); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }, [key, v]);
await setSlider('saturation', 35); await setSlider('hue', -12);
await page.waitForTimeout(300); await idle();
await page.screenshot({ path: path.join(shots, '03-hue-saturation-preview.png') });
await page.click('#modalOk'); await idle();
check(await page.evaluate(() => window.tintwork.history.entries.at(-1).label === 'Hue / saturation / lightness'), 'hue/saturation applied to history');

// --- brightness/contrast via menu ----------------------------------------------
await menuCmd('brightnessContrast');
await setSlider('contrast', 18); await setSlider('brightness', 6);
await page.click('#modalOk'); await idle();

// --- new layer in Screen blend + brush strokes -------------------------------------
await page.click('#layersPanel [data-cmd="layerNew"]');
await page.selectOption('#blendMode', 'screen');
await page.evaluate(() => { window.tintwork.setFg('#ff7a3d'); window.tintwork.state.opts.brushSize = 60; window.tintwork.state.opts.brushHardness = 20; });
await page.keyboard.press('b');
const path1 = [[250, 300], [400, 220], [560, 300], [700, 240], [850, 330]];
let p0 = await docToScreen(...path1[0]);
await page.mouse.move(p0.x, p0.y); await page.mouse.down();
for (const [x, y] of path1.slice(1)) { const p = await docToScreen(x, y); await page.mouse.move(p.x, p.y, { steps: 12 }); }
await page.mouse.up();
await page.evaluate(() => { window.tintwork.setFg('#7a5cff'); window.tintwork.state.opts.brushHardness = 90; window.tintwork.state.opts.brushSize = 22; });
p0 = await docToScreen(260, 420); await page.mouse.move(p0.x, p0.y); await page.mouse.down();
for (const [x, y] of [[420, 470], [600, 400], [760, 470]]) { const p = await docToScreen(x, y); await page.mouse.move(p.x, p.y, { steps: 12 }); }
await page.mouse.up();
check(await page.evaluate(() => window.tintwork.history.entries.filter((e) => e.label === 'Brush stroke').length === 2), 'two brush strokes recorded');
const painted = await page.evaluate(() => { const l = window.tintwork.activeLayer(); return l.canvas.getContext('2d').getImageData(400 - l.x, 220 - l.y, 1, 1).data[3]; });
check(painted > 200, `brush painted pixels on the new layer (alpha ${painted})`);
await page.locator('#layerOpacity').fill('85'); await page.locator('#layerOpacity').dispatchEvent('change');
await page.screenshot({ path: path.join(shots, '04-layer-blend-brush.png') });

// --- text layer --------------------------------------------------------------
await page.keyboard.press('t');
const tp = await docToScreen(110, 90); await page.mouse.click(tp.x, tp.y);
await page.waitForSelector('#modal:not(.hidden)');
await page.fill('#tText', 'Golden hour');
await page.fill('#tSize', '110');
await page.locator('#tText').dispatchEvent('input');
await page.click('#modalOk'); await idle();
check(await page.evaluate(() => window.tintwork.activeLayer().name.startsWith('Text: Golden')), 'text layer created');

// --- selection + vignette on the background ---------------------------------
await page.evaluate(() => { const d = window.tintwork.doc; d.activeId = d.layers[0].id; window.tintwork.commit('Select background layer'); });
const cornerBefore = await page.evaluate(() => [...window.tintwork.doc.layers[0].canvas.getContext('2d').getImageData(5, 1060, 1, 1).data]);
await menuCmd('vignette');
await page.click('#modalOk'); await idle();
const cornerAfter = await page.evaluate(() => [...window.tintwork.doc.layers[0].canvas.getContext('2d').getImageData(5, 1060, 1, 1).data]);
check(cornerAfter[0] + cornerAfter[1] + cornerAfter[2] < cornerBefore[0] + cornerBefore[1] + cornerBefore[2], 'vignette darkened the corner');
// rectangle selection, then grayscale only inside it, then deselect
await page.keyboard.press('m');
const a = await docToScreen(1180, 640), b = await docToScreen(1560, 1020);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
check(await page.evaluate(() => !!window.tintwork.doc.selection), 'rectangle selection made');
await page.keyboard.press('Control+Shift+U'); await idle();
const grayInside = await page.evaluate(() => { const l = window.tintwork.doc.layers[0]; const p = l.canvas.getContext('2d').getImageData(1300, 900, 1, 1).data; return p[0] === p[1] && p[1] === p[2]; });
const colorOutside = await page.evaluate(() => { const l = window.tintwork.doc.layers[0]; const p = l.canvas.getContext('2d').getImageData(300, 100, 1, 1).data; return !(p[0] === p[1] && p[1] === p[2]); });
check(grayInside && colorOutside, 'grayscale limited to the selection');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(shots, '05-selection-grayscale.png') });
await page.keyboard.press('Control+d');

// --- filters & levels via the API, undo/redo -------------------------------
await menuCmd('levels'); await setSlider('inBlack', 12); await setSlider('inWhite', 240); await page.click('#modalOk'); await idle();
await menuCmd('sharpen'); await page.click('#modalOk'); await idle();
const n = await page.evaluate(() => window.tintwork.history.index);
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
check(await page.evaluate(() => window.tintwork.history.index) === n - 2, 'undo x2');
await page.keyboard.press('Control+Shift+Z'); await page.keyboard.press('Control+Shift+Z');
check(await page.evaluate(() => window.tintwork.history.index) === n, 'redo x2');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(shots, '06-history-levels-sharpen.png') });

// --- transforms --------------------------------------------------------------
await menuCmd('rotateCW');
check(await page.evaluate(() => window.tintwork.doc.width === 1067 && window.tintwork.doc.height === 1600), 'rotate 90° swaps dimensions');
await page.keyboard.press('Control+z');
await menuCmd('flipH'); await page.keyboard.press('Control+z');

// --- export (PNG / JPEG / WebP) -----------------------------------------------
for (const [fmt, ext] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]) {
  await page.keyboard.press('Control+Shift+E');
  await page.selectOption('#eFmt', fmt);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#modalOk')]);
  const out = path.join(root, 'test-assets', `export.${ext}`); await dl.saveAs(out);
  check(fs.statSync(out).size > 10000 && dl.suggestedFilename().endsWith(ext), `export ${ext} (${fs.statSync(out).size} bytes)`);
}

// --- save project and reload it ----------------------------------------------
const layerCount = await page.evaluate(() => window.tintwork.doc.layers.length);
const [pdl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
const projPath = path.join(root, 'test-assets', 'project.tintwork.json'); await pdl.saveAs(projPath);
await page.evaluate(() => window.tintwork.newDocument(200, 200));
await page.setInputFiles('#fileInput', projPath);
await page.waitForFunction((n) => window.tintwork.doc?.layers.length === n, layerCount);
check(await page.evaluate(() => window.tintwork.doc.layers[1].blend === 'screen' && Math.abs(window.tintwork.doc.layers[1].opacity - 0.85) < 0.01), 'project round-trip keeps blend + opacity');

// --- drag & drop (places as layer when a doc is open) -------------------------
const b64 = fs.readFileSync(testImg).toString('base64');
await page.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bin], 'dropped.png', { type: 'image/png' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, b64);
await page.waitForFunction((n) => window.tintwork.doc.layers.length === n + 1, layerCount);
check(true, 'drag & drop placed image as a new layer');
await page.keyboard.press('Control+z');

// --- crop tool ------------------------------------------------------------------
await page.keyboard.press('c');
const c1 = await docToScreen(100, 60), c2 = await docToScreen(1500, 1000);
await page.mouse.move(c1.x, c1.y); await page.mouse.down(); await page.mouse.move(c2.x, c2.y, { steps: 5 }); await page.mouse.up();
await page.screenshot({ path: path.join(shots, '07-crop-preview.png') });
await page.keyboard.press('Enter');
check(await page.evaluate(() => window.tintwork.doc.width === 1400 && window.tintwork.doc.height === 940), 'crop applied (1400x940)');
await page.keyboard.press('b');
await page.mouse.move(viewBox.x + 400, viewBox.y + 300);
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(shots, '08-after-crop.png') });

// menu screenshot
await page.click('#menus .menu:nth-child(7) > button');
await page.waitForTimeout(100);
await page.screenshot({ path: path.join(shots, '09-filter-menu.png') });

// ============================================================================
// v0.2: selections, layer masks, worker, clone stamp
// ============================================================================
await page.keyboard.press('Escape');
const selAt = (x, y) => page.evaluate(([x, y]) => { const s = window.tintwork.doc.selection; return s ? s.mask[y * s.W + x] : 0; }, [x, y]);
const layerPx = (i, x, y) => page.evaluate(([i, x, y]) => { const l = window.tintwork.doc.layers[i]; return [...l.canvas.getContext('2d').getImageData(x - l.x, y - l.y, 1, 1).data]; }, [i, x, y]);
const compPx = (x, y) => page.evaluate(([x, y]) => window.tintwork.compositePixel(x, y), [x, y]);
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const dragDoc = async (pts, steps = 4) => {
  let s = await docToScreen(pts[0][0], pts[0][1]);
  await page.mouse.move(s.x, s.y); await page.mouse.down();
  for (const [x, y] of pts.slice(1)) { s = await docToScreen(x, y); await page.mouse.move(s.x, s.y, { steps }); }
  await page.mouse.up();
};
const clickDoc = async (x, y) => { const s = await docToScreen(x, y); await page.mouse.click(s.x, s.y); };
// fresh 800x600 document: left half red, right half blue
const freshDoc = () => page.evaluate(() => {
  const t = window.tintwork; t.newDocument(800, 600, 'white', 'v02-test');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d');
  x.fillStyle = '#ff0000'; x.fillRect(0, 0, 400, 600); x.fillStyle = '#0000ff'; x.fillRect(400, 0, 400, 600);
  t.touch(l); t.commit('Test pattern'); t.fitToScreen();
});
await freshDoc();

// lasso (freehand) ------------------------------------------------------------
await page.keyboard.press('l');
await dragDoc([[100, 100], [300, 100], [300, 300], [100, 300], [100, 102]], 8);
check(await selAt(200, 200) === 255 && await selAt(50, 50) === 0 && await selAt(350, 350) === 0, 'lasso selects inside the outline only');
// Shift = add (rectangle)
await page.keyboard.press('m');
await page.keyboard.down('Shift'); await dragDoc([[500, 100], [700, 200]]); await page.keyboard.up('Shift');
check(await selAt(600, 150) === 255 && await selAt(200, 200) === 255, 'Shift adds to the selection');
// Alt = subtract
await page.keyboard.down('Alt'); await dragDoc([[150, 150], [250, 250]]); await page.keyboard.up('Alt');
check(await selAt(200, 200) === 0 && await selAt(120, 120) === 255, 'Alt subtracts a hole from the selection');
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shots, '10-lasso-selection.png') });
// intersect from the options bar
await page.click('#optionsbar [data-selmode="intersect"]');
await dragDoc([[0, 0], [200, 600]]);
check(await selAt(120, 120) === 255 && await selAt(280, 120) === 0 && await selAt(600, 150) === 0, 'intersect keeps only the overlap');
await page.click('#optionsbar [data-selmode="new"]');
// polygonal lasso: click points, click the start to close
await page.keyboard.press('p');
for (const [x, y] of [[450, 300], [750, 300], [750, 550], [450, 550]]) await clickDoc(x, y);
check(await page.evaluate(() => window.tintwork.state.poly?.pts.length === 4), 'polygonal lasso collects points');
await clickDoc(451, 301);
check(await selAt(600, 420) === 255 && await selAt(400, 420) === 0 && await selAt(120, 120) === 0, 'polygonal lasso closes into a selection');
// magic wand (reuses the fill code)
await page.keyboard.press('w');
await clickDoc(100, 500);
check(await selAt(10, 10) === 255 && await selAt(399, 599) === 255 && await selAt(401, 10) === 0, 'magic wand selects the red half only');
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shots, '11-magic-wand.png') });
await page.keyboard.press('Control+Shift+I');
check(await selAt(10, 10) === 0 && await selAt(600, 10) === 255, 'invert selection');
await page.keyboard.press('Control+a');
check(await selAt(0, 0) === 255 && await selAt(799, 599) === 255, 'select all');
await page.keyboard.press('Control+d');
check(await page.evaluate(() => window.tintwork.doc.selection === null), 'deselect');
// feather + adjustment through the soft selection
await page.keyboard.press('m');
await dragDoc([[200, 200], [600, 400]]);
await page.keyboard.press('Shift+F6');
await page.fill('#fRadius', '20');
await page.click('#modalOk'); await idle();
const edge = await selAt(200, 300), inner = await selAt(300, 300), outer = await selAt(170, 300);
check(edge > 40 && edge < 220 && inner === 255 && outer > 0 && outer < 128, `feather softens the edge (outer ${outer}, edge ${edge}, inner ${inner})`);
await page.keyboard.press('Control+i'); await idle();
const inv = await layerPx(0, 300, 300), out0 = await layerPx(0, 100, 300), soft = await layerPx(0, 200, 300);
check(near(inv, [0, 255, 255, 255]) && near(out0, [255, 0, 0, 255]) && soft[1] > 30 && soft[1] < 225, `invert through a feathered selection blends at the edge (edge px ${soft.slice(0, 3)})`);
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shots, '12-feather-adjust.png') });
await page.keyboard.press('Control+d');
// selection history: undo restores the previous selection object
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
check(await selAt(300, 300) === 255, 'undo restores the feathered selection');
await page.keyboard.press('Control+Shift+Z'); await page.keyboard.press('Control+Shift+Z');

// layer masks ---------------------------------------------------------------
await page.click('#layersPanel [data-cmd="layerNew"]');
await page.evaluate(() => window.tintwork.setFg('#00ff00'));
await page.keyboard.press('Alt+Backspace');
check(near(await compPx(300, 300), [0, 255, 0, 255]), 'green fill layer covers the image');
await page.click('#layersPanel [data-cmd="addMask"]');
check(await page.evaluate(() => { const l = window.tintwork.activeLayer(); return !!l.mask && l.editMask; }) && await page.locator('#layerList .mask-thumb').count() === 1, 'layer mask added with thumbnail and targeted');
await page.evaluate(() => { const t = window.tintwork; t.setFg('#000000'); Object.assign(t.state.opts, { brushSize: 80, brushHardness: 100, brushOpacity: 100 }); });
await page.keyboard.press('b');
await dragDoc([[280, 300], [320, 300]]);
const below = await layerPx(0, 300, 300);
check(near(await compPx(300, 300), below) && near(await layerPx(1, 300, 300), [0, 255, 0, 255]), 'painting black on the mask hides the layer (pixels untouched)');
await page.keyboard.press('e');
await page.evaluate(() => Object.assign(window.tintwork.state.opts, { eraserSize: 60, eraserHardness: 100, eraserOpacity: 100 }));
await clickDoc(600, 300);
check(near(await compPx(600, 300), await layerPx(0, 600, 300)), 'eraser on the mask hides');
await page.evaluate(() => window.tintwork.setFg('#ffffff'));
await page.keyboard.press('b');
await page.evaluate(() => Object.assign(window.tintwork.state.opts, { brushSize: 20 }));
await clickDoc(300, 300);
check(near(await compPx(300, 300), [0, 255, 0, 255]), 'painting white on the mask reveals again');
await page.mouse.move(viewBox.x + 5, viewBox.y + 5);
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shots, '13-layer-mask.png') });
await page.click('#layerList .mask-thumb', { modifiers: ['Shift'] });
check(near(await compPx(600, 300), [0, 255, 0, 255]) && await page.evaluate(() => !window.tintwork.activeLayer().mask.enabled), 'Shift+click disables the mask');
await page.click('#layerList .mask-thumb', { modifiers: ['Shift'] });
check(!near(await compPx(600, 300), [0, 255, 0, 255]), 're-enabling the mask hides again');
// save + reload keeps the mask
const [mdl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
const maskProj = path.join(root, 'test-assets', 'project.tintwork.json'); await mdl.saveAs(maskProj);
const savedBelow = await compPx(600, 300);
await page.evaluate(() => window.tintwork.newDocument(100, 100));
await page.setInputFiles('#fileInput', maskProj);
await page.waitForFunction(() => window.tintwork.doc?.layers.length === 2 && !!window.tintwork.doc.layers[1].mask);
check(near(await compPx(600, 300), savedBelow) && near(await compPx(300, 300), [0, 255, 0, 255]), 'project round-trip keeps the layer mask');
await page.evaluate(() => { const d = window.tintwork.doc; d.activeId = d.layers[1].id; window.tintwork.updateLayersPanel(); });
await menuCmd('applyMask');
check(await page.evaluate(() => !window.tintwork.doc.layers[1].mask) && (await layerPx(1, 600, 300))[3] === 0 && (await layerPx(1, 300, 300))[3] === 255, 'apply mask bakes it into the layer alpha');
await page.keyboard.press('Control+z');
await menuCmd('deleteMask');
check(await page.evaluate(() => !window.tintwork.doc.layers[1].mask) && near(await compPx(600, 300), [0, 255, 0, 255]), 'delete mask discards it');
// mask from selection
await page.keyboard.press('m'); await dragDoc([[0, 0], [400, 600]]);
await menuCmd('addMaskFromSelection');
check(near(await compPx(100, 300), [0, 255, 0, 255]) && !near(await compPx(600, 300), [0, 255, 0, 255]), 'mask from selection reveals only the selection');
await page.keyboard.press('Control+d');

// web worker: large image stays responsive -------------------------------------
check(await page.evaluate(() => window.tintwork.workerAvailable), 'pixel worker available');
await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(4000, 3000, 'white', 'large');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d');
  const g = x.createLinearGradient(0, 0, 4000, 3000); g.addColorStop(0, '#203060'); g.addColorStop(1, '#f0c080');
  x.fillStyle = g; x.fillRect(0, 0, 4000, 3000);
  for (let i = 0; i < 400; i++) { x.fillStyle = `hsl(${i * 37 % 360},70%,55%)`; x.fillRect((i * 997) % 3900, (i * 613) % 2900, 100, 100); }
  t.touch(l); t.commit('Large test'); t.fitToScreen();
});
const inlineMs = await page.evaluate(async () => {
  const { gaussianBlur } = await import('/src/pixels.js');
  const img = new ImageData(4000, 3000); const t0 = performance.now(); gaussianBlur(img, 25); return performance.now() - t0;
});
await page.evaluate(() => {
  window.__gap = 0; let last = performance.now();
  window.__gapTimer = setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; }, 10);
});
const t0 = Date.now();
await menuCmd('gaussianBlur'); await setSlider('radius', 25);
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(shots, '14-worker-large.png') });
await page.click('#modalOk'); await idle();
const workerMs = Date.now() - t0;
const maxGap = await page.evaluate(() => { clearInterval(window.__gapTimer); return window.__gap; });
check(maxGap < inlineMs * 0.6, `large blur stays responsive (max UI stall ${Math.round(maxGap)} ms vs ${Math.round(inlineMs)} ms blocking inline; total ${workerMs} ms)`);
check(await page.evaluate(() => window.tintwork.history.entries.at(-1).label === 'Gaussian blur'), 'worker blur committed');

// clone stamp -------------------------------------------------------------------
await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(800, 600, 'white', 'clone');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d'); x.fillStyle = '#d02090'; x.fillRect(100, 100, 120, 120);
  t.touch(l); t.commit('Clone source'); t.fitToScreen();
  Object.assign(t.state.opts, { cloneSize: 60, cloneHardness: 100, cloneOpacity: 100, cloneAligned: true });
});
await page.keyboard.press('s');
await page.keyboard.down('Alt'); await clickDoc(160, 160); await page.keyboard.up('Alt');
await dragDoc([[500, 400], [540, 400]]);
check(near(await layerPx(0, 520, 400), [208, 32, 144, 255]) && near(await layerPx(0, 650, 300), [255, 255, 255, 255]), 'clone stamp copies source pixels');
check(await page.evaluate(() => window.tintwork.history.entries.at(-1).label === 'Clone stamp'), 'clone stamp recorded in history');
const sMove = await docToScreen(560, 400); await page.mouse.move(sMove.x, sMove.y);
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shots, '15-clone-stamp.png') });

// healing brush & spot healing -----------------------------------------------------
// horizontal brightness ramp with a fine texture, plus two dark blemishes
await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(800, 600, 'white', 'heal');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d'), img = x.createImageData(800, 600);
  for (let y = 0; y < 600; y++) for (let xx = 0; xx < 800; xx++) {
    const i = (y * 800 + xx) * 4, v = 60 + (140 * xx) / 800 + (((xx >> 1) + (y >> 1)) % 2) * 10;
    img.data[i] = v; img.data[i + 1] = v * 0.9; img.data[i + 2] = v * 0.8; img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  x.fillStyle = '#000'; x.beginPath(); x.arc(500, 300, 10, 0, 7); x.fill(); x.beginPath(); x.arc(620, 180, 8, 0, 7); x.fill();
  t.touch(l); t.commit('Heal test'); t.fitToScreen();
  Object.assign(t.state.opts, { healSize: 40, healHardness: 100, spotSize: 30, spotHardness: 100, cloneAligned: false });
});
await page.screenshot({ path: path.join(shots, '20-heal-before.png') });
const lum = (p) => p[0];
await page.keyboard.press('r');
await page.keyboard.down('Alt'); await clickDoc(300, 450); await page.keyboard.up('Alt');
await dragDoc([[495, 300], [505, 300]]); await idle();
const healed = await layerPx(0, 500, 300);
// a plain clone would give the source brightness (~112); healing matches the local level (~147)
check(Math.abs(lum(healed) - 147) < 15, `healing brush matches local brightness (center R=${healed[0]}, local ≈147, source ≈112)`);
check(await page.evaluate(() => window.tintwork.history.entries.at(-1).label === 'Healing brush'), 'healing brush recorded in history');
await page.keyboard.press('j');
await clickDoc(620, 180); await idle();
const spotPx = await layerPx(0, 620, 180);
check(Math.abs(lum(spotPx) - 168) < 18, `spot healing removes the blemish (center R=${spotPx[0]}, local ≈168)`);
check(await page.evaluate(() => window.tintwork.history.entries.at(-1).label === 'Spot healing'), 'spot healing recorded in history');
await page.mouse.move(viewBox.x + 5, viewBox.y + 5);
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(shots, '21-heal-after.png') });

// ============================================================================
// v0.3: adjustment layers + curves editor
// ============================================================================
const adjDoc = (w = 600, h = 400) => page.evaluate(([w, h]) => {
  const t = window.tintwork; t.newDocument(w, h, 'white', 'adjust-test');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d');
  x.fillStyle = 'rgb(100,100,100)'; x.fillRect(0, 0, w / 2, h);
  x.fillStyle = 'rgb(200,50,50)'; x.fillRect(w / 2, 0, w / 2, h);
  t.touch(l); t.commit('Adjust test'); t.fitToScreen();
}, [w, h]);
await adjDoc();
await page.evaluate(() => window.tintwork.run('adjLayer_invert'));
check(await page.evaluate(() => { const l = window.tintwork.activeLayer(); return l.kind === 'adjust' && l.adj.type === 'invert' && !!l.mask; }), 'invert adjustment layer created with a mask');
check(near(await compPx(100, 100), [155, 155, 155, 255]), 'invert layer affects the layer below in the composite');
check(near(await layerPx(0, 100, 100), [100, 100, 100, 255], 0), 'adjustment layer leaves the pixels below untouched');
// paint the adjustment's mask: hide it on the right half
await page.evaluate(() => { const t = window.tintwork; t.setSelection(t.makeSelection(600, 400, t.rectMask(600, 400, { x: 300, y: 0, w: 300, h: 400 }))); });
await page.evaluate(() => window.tintwork.run('clear')); await page.evaluate(() => window.tintwork.run('deselect'));
check(near(await compPx(450, 200), [200, 50, 50, 255]), 'masked-out area of an adjustment layer is unaffected');
check(near(await compPx(100, 200), [155, 155, 155, 255]), 'revealed area of an adjustment layer still adjusted');
await page.evaluate(() => { const l = window.tintwork.activeLayer(); l.opacity = 0.5; window.tintwork.touch(l); window.tintwork.commit('Opacity'); });
check(near(await compPx(100, 200), [128, 128, 128, 255], 2), 'adjustment layer opacity blends 50% (≈128)');
await page.evaluate(() => window.tintwork.undo());
check(near(await compPx(100, 200), [155, 155, 155, 255]), 'undo restores adjustment layer opacity');
// layers painted above an adjustment layer are not affected by it
await page.evaluate(() => { const t = window.tintwork; t.run('layerNew'); const l = t.activeLayer(), x = l.canvas.getContext('2d'); x.fillStyle = 'rgb(10,20,30)'; x.fillRect(0, 0, 50, 50); t.touch(l); t.commit('Paint above'); });
check(near(await compPx(20, 20), [10, 20, 30, 255]), 'layers above an adjustment layer are not adjusted');
await page.evaluate(() => window.tintwork.undo());
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(shots, '2x-adjust-invert-masked.png') });

// curves layer, edited with the interactive editor
await adjDoc();
await page.evaluate(() => window.tintwork.run('adjLayer_curves'));
await page.waitForSelector('#modal:not(.hidden) .curves-graph');
check(await page.locator('#modalTitle').textContent() === 'Curves layer', 'new curves layer opens the curve editor');
const graph = await page.locator('.curves-graph').boundingBox();
const gpt = (x, y) => ({ x: graph.x + (x / 255) * graph.width, y: graph.y + (1 - y / 255) * graph.height });
let g = gpt(100, 100); await page.mouse.move(g.x, g.y); await page.mouse.down();
g = gpt(100, 180); await page.mouse.move(g.x, g.y, { steps: 6 }); await page.mouse.up();
check(await page.evaluate(() => JSON.stringify(window.tintwork.activeLayer().adj.params.rgb)) === '[[0,0],[100,180],[255,255]]', 'clicking the curve adds a point and dragging moves it');
check(near(await compPx(100, 100), [180, 180, 180, 255], 2), `curve maps 100 → 180 live (got ${(await compPx(100, 100))[0]})`);
await page.screenshot({ path: path.join(shots, '2x-curves-editor.png') });
// add a second point then drag it off the graph to remove it
g = gpt(200, 222); await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x, graph.y + graph.height + 80, { steps: 6 }); await page.mouse.up();
check(await page.evaluate(() => window.tintwork.activeLayer().adj.params.rgb.length) === 3, 'dragging a point off the graph removes it');
const beforeRed = await compPx(450, 100);
await page.locator('.curves [data-ch="r"]').click();
g = gpt(200, 200); await page.mouse.move(g.x, g.y); await page.mouse.down(); g = gpt(200, 120); await page.mouse.move(g.x, g.y, { steps: 6 }); await page.mouse.up();
const afterRed = await compPx(450, 100);
check(Math.abs(afterRed[0] - beforeRed[0]) > 15 && afterRed[1] === beforeRed[1] && afterRed[2] === beforeRed[2], `red channel curve only changes red (${beforeRed} → ${afterRed})`);
const curvedPx = await compPx(100, 100);
await page.locator('#modalOk').click();
check(await page.evaluate(() => window.tintwork.history.entries.at(-1).label === 'Edit Curves layer'), 'curve edit committed to history');
// re-edit by double-clicking the layer thumbnail; cancel restores
await page.locator('#layerList li.active .thumb:not(.mask-thumb)').dblclick();
await page.waitForSelector('#modal:not(.hidden) .curves-graph');
await page.locator('.curves .curves-reset').click();
const resetPx = await compPx(100, 100);
check(resetPx[1] === 100 && resetPx[0] !== 100, `re-opened editor updates live: RGB reset keeps the red curve (${resetPx})`);
await page.locator('#modalCancel').click();
check(near(await compPx(100, 100), curvedPx, 0), 'cancelling a re-edit restores the previous curves');

// levels + brightness via the parameter dialog, then merge down bakes it in
await adjDoc();
await page.evaluate(() => window.tintwork.run('adjLayer_levels'));
await page.waitForSelector('#modal:not(.hidden) input[type=range]');
await page.locator('#modalBody input[data-key="inBlack"]').evaluate((el) => { el.value = 50; el.dispatchEvent(new Event('input')); });
const lvPx = await compPx(100, 100);
check(lvPx[0] < 100 && lvPx[0] > 50, `levels layer (black point 50) darkens 100 → ${lvPx[0]}`);
await page.locator('#modalOk').click();
await page.locator('#layerList li.active .thumb:not(.mask-thumb)').dblclick();
check(await page.locator('#modalTitle').textContent() === 'Levels layer' && await page.locator('#modalBody input[data-key="inBlack"]').inputValue() === '50', 'double-click re-opens a levels layer with its values');
await page.locator('#modalCancel').click();
await page.evaluate(() => window.tintwork.mergeDown());
check(await page.evaluate(() => window.tintwork.doc.layers.length === 1), 'merge down removes the adjustment layer');
check(near(await layerPx(0, 100, 100), lvPx, 1), 'merge down bakes the adjustment into the pixels');
// cancelling a brand-new adjustment layer removes it
await page.evaluate(() => window.tintwork.run('adjLayer_exposure'));
await page.locator('#modalCancel').click();
check(await page.evaluate(() => window.tintwork.doc.layers.length === 1 && window.tintwork.history.entries.at(-1).label === 'Merge adjustment down'), 'cancelling a new adjustment layer removes it and its history step');
// grayscale + hue/sat from the chooser button in the Layers panel
await page.locator('[data-cmd="adjLayerMenu"]').click();
await page.locator('#modalBody [data-adj-type="grayscale"]').click();
const gpx = await compPx(450, 100);
check(Math.abs(gpx[0] - gpx[1]) <= 1 && Math.abs(gpx[1] - gpx[2]) <= 1, 'grayscale adjustment layer desaturates the composite');
// export includes adjustment layers
const exportedPx = await page.evaluate(async () => {
  const b = await window.tintwork.renderExport('image/png'); const bmp = await createImageBitmap(b);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0); return [...x.getImageData(450, 100, 1, 1).data];
});
check(near(exportedPx, gpx, 1), 'export renders adjustment layers');
// project round trip keeps adjustment layers
const proj = await page.evaluate(() => JSON.stringify(window.tintwork.serializeProject()));
check(proj.includes('"kind":"adjust"') && proj.includes('"grayscale"'), 'project file stores adjustment layers');

// big document: adjustment computed in the worker without blocking
await adjDoc(3000, 2000);
const tAdj0 = Date.now();
await page.evaluate(() => { window.tintwork.run('adjLayer_invert'); });
const blockMs = Date.now() - tAdj0;
await idle(); await page.waitForTimeout(50); await idle();
check(near(await compPx(100, 100), [155, 155, 155, 255]), `large-document adjustment layer computed (worker path, ${blockMs} ms to add)`);
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(shots, '2x-adjust-layers-panel.png') });

// ============================================================================
// v0.3: editable text layers
// ============================================================================
await page.evaluate(() => { const t = window.tintwork; t.newDocument(600, 400, 'white', 'text-test'); t.fitToScreen(); });
await page.keyboard.press('t');
await clickDoc(100, 100);
await page.waitForSelector('#modal:not(.hidden) #tText');
await page.locator('#tText').fill('Hi');
await page.locator('#tSize').fill('80'); await page.locator('#tSize').dispatchEvent('input');
await page.locator('#tColor').evaluate((el) => { el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.locator('#modalOk').click();
const tl = () => page.evaluate(() => { const l = window.tintwork.activeLayer(); return { kind: l.kind, text: l.text, x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height, name: l.name, n: window.tintwork.doc.layers.length }; });
let T = await tl();
check(T.kind === 'text' && T.text.text === 'Hi' && T.text.size === 80 && T.text.color === '#ff0000' && T.name === 'Text: Hi', 'text tool creates an editable text layer');
check(T.x + T.text.ox === 100 && T.y + T.text.oy === 100, 'text anchored at the clicked point');
const redCount = () => page.evaluate(() => { const t = window.tintwork; t.composite(); const d = document.createElement('canvas'); d.width = 600; d.height = 400; t.composite(d, { sync: true });
  const px = d.getContext('2d').getImageData(0, 0, 600, 400).data; let n = 0, minX = 1e9, maxX = -1;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 80) { n++; const x = (i / 4) % 600; minX = Math.min(minX, x); maxX = Math.max(maxX, x); } return { n, minX, maxX }; });
const red1 = await redCount();
check(red1.n > 500, `text rendered in the chosen color (${red1.n} red px)`);
// re-open by clicking it with the text tool and change text, font size, alignment
await clickDoc(110, 130);
await page.waitForSelector('#modal:not(.hidden) #tText');
check(await page.locator('#tText').inputValue() === 'Hi' && await page.locator('#modalTitle').textContent() === 'Edit text', 'clicking existing text with the text tool re-opens it for editing');
await page.locator('#tText').fill('Hello\nworld!'); await page.locator('#tText').dispatchEvent('input');
await page.locator('#tSize').fill('48'); await page.locator('#tSize').dispatchEvent('input');
const leftEdge = async () => page.evaluate(() => { const l = window.tintwork.activeLayer(); return l.x + l.text.oy; });
const edge0 = await leftEdge();
await page.locator('#tAlign [data-align="center"]').click();
check(Math.abs(await leftEdge() - edge0) <= 1, 'changing alignment keeps the text block in place (±1px)');
await page.waitForTimeout(100);
await page.screenshot({ path: path.join(shots, '2x-text-edit.png') });
await page.locator('#modalOk').click();
T = await tl();
check(T.text.text === 'Hello\nworld!' && T.text.size === 48 && T.text.align === 'center' && T.n === 2, 'edited text, size and alignment saved on the same layer');
check(T.h > 48 * 2, 'multi-line text grows the layer');
// alignment actually changes where the short line sits
const lineSpan = (y0, y1) => page.evaluate(([y0, y1]) => { const l = window.tintwork.activeLayer(), c = l.canvas.getContext('2d'), w = l.canvas.width;
  const px = c.getImageData(0, y0, w, y1 - y0).data; let a = 1e9, b = -1; for (let i = 3; i < px.length; i += 4) if (px[i] > 128) { const x = ((i - 3) / 4) % w; a = Math.min(a, x); b = Math.max(b, x); } return [a, b]; }, [y0, y1]);
const lh = Math.round(48 * 1.2), pad = Math.ceil(48 * 0.35);
const [l1a, l1b] = await lineSpan(pad, pad + lh - 4), [l2a, l2b] = await lineSpan(pad + lh, pad + 2 * lh - 4);
check(Math.abs((l1a + l1b) / 2 - (l2a + l2b) / 2) < 6, `center alignment centers both lines (${(l1a + l1b) / 2} vs ${(l2a + l2b) / 2})`);
// font + style
await page.evaluate(() => window.tintwork.editLayer());
await page.locator('#tFont').selectOption('serif'); await page.locator('#tItalic').check();
await page.locator('#modalOk').click();
T = await tl();
check(T.text.font === 'serif' && T.text.italic === true, 'font family and italic editable');
// move with the move tool, then re-edit keeps the position
await page.keyboard.press('v');
const before = await tl();
await dragDoc([[before.x + before.text.ox, before.y + 30], [before.x + before.text.ox + 40, before.y + 50]]);
const moved = await tl();
check(moved.x === before.x + 40 && moved.y === before.y + 20 && moved.kind === 'text', 'move tool moves a text layer and it stays editable');
await page.locator('#layerList li.active .thumb:not(.mask-thumb)').dblclick();
await page.locator('#tText').fill('Moved'); await page.locator('#tText').dispatchEvent('input');
await page.locator('#modalOk').click();
T = await tl();
check(T.x + T.text.ox === moved.x + moved.text.ox && T.y + T.text.oy === moved.y + moved.text.oy, `re-editing a moved text layer keeps its anchor (${JSON.stringify([T.x, T.text.ox, T.y, T.text.oy, moved.x, moved.text.ox, moved.y, moved.text.oy])})`);
// cancel restores, undo restores
await page.evaluate(() => window.tintwork.editLayer());
await page.locator('#tText').fill('Nope'); await page.locator('#tText').dispatchEvent('input');
await page.locator('#modalCancel').click();
check((await tl()).text.text === 'Moved', 'cancelling a text edit restores it');
await page.evaluate(() => window.tintwork.undo());
check((await tl()).text.text === 'Hello\nworld!', 'undo restores the previous text');
await page.evaluate(() => window.tintwork.redo());
await page.waitForTimeout(100);
await page.screenshot({ path: path.join(shots, '2x-text-layers.png') });
// project round-trip keeps text editable
const tproj = await page.evaluate(() => JSON.stringify(window.tintwork.serializeProject()));
check(tproj.includes('"kind":"text"') && tproj.includes('Moved'), 'project file stores text layers');
// painting converts the text to pixels
await page.keyboard.press('b');
await dragDoc([[T.x + 5, T.y + 5], [T.x + 30, T.y + 10]]);
check(await page.evaluate(() => window.tintwork.activeLayer().kind === undefined && /\(pixels\)$/.test(window.tintwork.activeLayer().name)), 'painting on a text layer converts it to pixels');
await page.evaluate(() => window.tintwork.undo());
check(await page.evaluate(() => window.tintwork.activeLayer().kind === 'text'), 'undo brings the editable text back');

// ============================================================================
// v0.3: ellipse selection + moving selected pixels
// ============================================================================
await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(500, 300, 'white', 'move-test');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d'); x.fillStyle = 'rgb(0,0,255)'; x.fillRect(50, 50, 100, 100);
  t.touch(l); t.commit('Blue square'); t.fitToScreen();
});
await page.keyboard.press('o');
check(await page.evaluate(() => window.tintwork.state.tool === 'ellipse'), 'O selects the ellipse select tool');
await dragDoc([[200, 100], [300, 200]]);
check(await selAt(250, 150) === 255 && await selAt(205, 105) === 0 && await selAt(250, 103) > 0 && await selAt(296, 150) > 0, 'ellipse selection fills the inscribed ellipse only');
check(await page.evaluate(() => window.tintwork.history.entries.at(-1).label === 'Ellipse select'), 'ellipse selection recorded in history');
const aaEdge = await page.evaluate(() => { const s = window.tintwork.doc.selection; let partial = 0; for (const v of s.mask) if (v > 0 && v < 255) partial++; return partial; });
check(aaEdge > 50, `ellipse selection edge is anti-aliased (${aaEdge} partial px)`);
await page.keyboard.down('Alt'); await dragDoc([[230, 130], [270, 170]]); await page.keyboard.up('Alt');
check(await selAt(250, 150) === 0 && await selAt(215, 150) === 255, 'Alt + ellipse subtracts a hole');
await page.waitForTimeout(120);
await page.screenshot({ path: path.join(shots, '2x-ellipse-select.png') });
// move selected pixels
await page.keyboard.press('m');
await dragDoc([[50, 50], [150, 150]]);
await page.keyboard.press('v');
await dragDoc([[100, 100], [160, 130], [200, 150]]);
check(near(await layerPx(0, 175, 125), [0, 0, 255, 255], 0) && near(await layerPx(0, 245, 195), [0, 0, 255, 255], 0), 'move tool moves the selected pixels (+100, +50)');
check((await layerPx(0, 75, 75))[3] === 0, 'moved pixels leave a transparent hole');
check(near(await layerPx(0, 30, 30), [255, 255, 255, 255], 0), 'pixels outside the selection stay put');
check(await selAt(175, 125) === 255 && await selAt(75, 75) === 0, 'selection travels with the moved pixels');
check(await page.evaluate(() => window.tintwork.history.entries.at(-1).label === 'Move selection'), 'move recorded as "Move selection"');
await page.waitForTimeout(120);
await page.screenshot({ path: path.join(shots, '2x-move-selection.png') });
await page.evaluate(() => window.tintwork.undo());
check(near(await layerPx(0, 75, 75), [0, 0, 255, 255], 0) && near(await layerPx(0, 175, 125), [255, 255, 255, 255], 0), 'undo puts the moved pixels back');
// Alt-drag moves a copy
await page.keyboard.down('Alt'); await dragDoc([[100, 100], [300, 150]]); await page.keyboard.up('Alt');
check(near(await layerPx(0, 75, 75), [0, 0, 255, 255], 0) && near(await layerPx(0, 275, 125), [0, 0, 255, 255], 0), 'Alt + move duplicates the selected pixels');
check(await page.evaluate(() => window.tintwork.history.entries.at(-1).label === 'Duplicate selection'), 'Alt-move recorded as "Duplicate selection"');
// without a selection the move tool still moves the whole layer
await page.evaluate(() => window.tintwork.run('deselect'));
await dragDoc([[100, 100], [110, 105]]);
check(await page.evaluate(() => { const l = window.tintwork.doc.layers[0]; return l.x === 10 && l.y === 5; }), 'without a selection the move tool moves the whole layer');

// ============================================================================
// v0.3: autosave to IndexedDB + crash recovery
// ============================================================================
// start from an empty autosave store (earlier documents of this run each have their own slot)
await page.evaluate(async () => { await window.tintwork.autosaveNow(); await window.tintwork.clearAutosave(); });
await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(320, 200, 'white', 'autosave-test');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d'); x.fillStyle = 'rgb(10,200,30)'; x.fillRect(20, 20, 100, 60); t.touch(l); t.commit('Green box');
  t.newAdjustmentLayer('invert'); t.closeModal?.();
  t.run('layerNew'); const p = t.activeLayer(); p.name = 'Painted'; const px = p.canvas.getContext('2d'); px.fillStyle = 'rgb(250,0,0)'; px.fillRect(200, 100, 40, 40); t.touch(p); t.commit('Paint');
  p.opacity = 0.5; p.mask = null; t.commit('Opacity');
});
// a text layer too
await page.keyboard.press('t'); await clickDoc(150, 150);
await page.locator('#tText').fill('Saved?'); await page.locator('#tText').dispatchEvent('input'); await page.locator('#modalOk').click();
const beforeCrash = await page.evaluate(() => { const t = window.tintwork; return { n: t.doc.layers.length, kinds: t.doc.layers.map((l) => l.kind || 'pixels'), px: t.compositePixel(50, 50), px2: t.compositePixel(220, 120) }; });
await page.waitForTimeout(1800); // debounced autosave
await page.evaluate(() => window.tintwork.autosaveNow());
const stored = await page.evaluate(async () => { const r = await window.tintwork.readAutosave(); return r && { dirty: r.dirty, n: r.layerCount, v: r.version, steps: r.history.entries.length, ids: r.imageIds.length, name: r.name }; });
check(stored && stored.dirty && stored.v === 2 && stored.n === beforeCrash.n && stored.steps >= 5 && stored.ids > 0 && stored.name === 'autosave-test', `document autosaved to IndexedDB with its undo history (${stored?.steps} steps, ${stored?.ids} images)`);
// simulate a crash: reload without saving
await page.reload();
await page.waitForSelector('#modal:not(.hidden)', { timeout: 5000 });
check(await page.locator('#modalTitle').textContent() === 'Recover unsaved work?' && (await page.locator('#modalBody').textContent()).includes('autosave-test'), 'reload after a crash offers to recover the autosaved document');
await page.screenshot({ path: path.join(shots, '2x-autosave-recover.png') });
await page.locator('#modalOk').click();
await page.waitForFunction(() => window.tintwork.doc?.layers.length > 0);
const afterCrash = await page.evaluate(() => { const t = window.tintwork; return { n: t.doc.layers.length, kinds: t.doc.layers.map((l) => l.kind || 'pixels'), px: t.compositePixel(50, 50), px2: t.compositePixel(220, 120), text: t.doc.layers.find((l) => l.kind === 'text')?.text.text, op: t.doc.layers[2].opacity, name: t.doc.name }; });
check(afterCrash.n === beforeCrash.n && JSON.stringify(afterCrash.kinds) === JSON.stringify(beforeCrash.kinds), `recovered all layers with their kinds (${afterCrash.kinds.join(', ')})`);
check(near(afterCrash.px, beforeCrash.px, 1) && near(afterCrash.px2, beforeCrash.px2, 1), 'recovered document is pixel-identical (composite incl. adjustment layer)');
check(afterCrash.text === 'Saved?' && afterCrash.op === 0.5 && afterCrash.name === 'autosave-test', 'recovered text stays editable; opacity and name kept');
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(shots, '2x-autosave-recovered.png') });
// saving the project marks the copy clean: no prompt on the next load
const dl = page.waitForEvent('download');
await page.keyboard.press('Control+s'); await dl;
await page.waitForFunction(() => window.tintwork.autosaveSettled);
check(await page.evaluate(async () => (await window.tintwork.readAutosave()).dirty === false), 'saving the project marks the autosave clean');
await page.reload(); await page.waitForTimeout(800);
check(await page.locator('#modal').evaluate((m) => m.classList.contains('hidden')), `no recovery prompt after the project was saved`);
// manual recovery still possible from the File menu
await page.evaluate(() => window.tintwork.run('recoverAutosave'));
await page.waitForSelector('#modal:not(.hidden)');
check(await page.locator('#modalTitle').textContent() === 'Recover autosave', 'File ▸ Recover autosave offers the last copy');
await page.locator('#modalCancel').click();
// discard clears it
await page.evaluate(async () => { const t = window.tintwork; t.newDocument(100, 100, 'white', 'discard-me'); await t.autosaveNow(); });
await page.reload();
await page.waitForSelector('#modal:not(.hidden)');
await page.locator('#modalCancel').click();
await page.waitForTimeout(200);
check(await page.evaluate(async () => !(await window.tintwork.listAutosaves()).some((r) => r.name === 'discard-me')), 'Discard deletes the autosaved copy');
await page.reload(); await page.waitForTimeout(600);
check(await page.locator('#modal').evaluate((m) => m.classList.contains('hidden')), 'no prompt after discarding');

{ // v0.4 section (own scope)
// =====================================================================================
// v0.4: adjustment blend modes, live filters, free transform, recovery slots,
//       color range, refine edge, bundled open-licensed fonts
// =====================================================================================
const px = (x, y) => page.evaluate(([x, y]) => window.tintwork.compositePixel(x, y), [x, y]);
await page.evaluate(() => { window.tintwork.closeModal(); window.tintwork.setTool('move'); });

// --- (1) blend modes on adjustment layers, live and merged down -----------------------
await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(300, 200, 'white', 'blend-test');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d'); x.fillStyle = 'rgb(200,100,50)'; x.fillRect(0, 0, 300, 200); t.touch(l); t.commit('Fill');
  t.newAdjustmentLayer('invert'); t.closeModal();
});
await page.selectOption('#blendMode', 'multiply');
await idle();
const multExpected = [Math.round(200 * 55 / 255), Math.round(100 * 155 / 255), Math.round(50 * 205 / 255), 255];
const liveBlend = await px(100, 100);
check(near(liveBlend, multExpected, 2), `invert adjustment layer in Multiply mode composites as multiply (${liveBlend} ≈ ${multExpected})`);
await page.locator('#layerOpacity').fill('50'); await page.locator('#layerOpacity').dispatchEvent('change');
const halfExpected = [0, 1, 2].map((i) => Math.round(([200, 100, 50][i] + multExpected[i]) / 2));
const liveHalf = await px(100, 100);
check(near(liveHalf, [...halfExpected, 255], 2), `blend mode respects layer opacity (${liveHalf})`);
await page.screenshot({ path: path.join(shots, '3x-adjust-blend.png') });
await page.locator('#layerOpacity').fill('100'); await page.locator('#layerOpacity').dispatchEvent('change');
await page.keyboard.press('Control+e'); await idle();
const merged = await page.evaluate(() => ({ n: window.tintwork.doc.layers.length, kind: window.tintwork.doc.layers[0].kind || 'pixels', p: window.tintwork.compositePixel(100, 100) }));
check(merged.n === 1 && merged.kind === 'pixels' && near(merged.p, multExpected, 2), `merge down bakes the adjustment with its blend mode (${merged.p})`);
// screen + a masked area: only the revealed half changes
await page.evaluate(() => {
  const t = window.tintwork, d = t.doc;
  t.setSelection(t.makeSelection(d.width, d.height, t.rectMask(d.width, d.height, { x: 0, y: 0, w: 150, h: 200 })), 'Left half');
  t.newAdjustmentLayer('invert'); t.closeModal(); t.activeLayer().blend = 'screen'; t.touch(t.activeLayer()); t.commit('Screen');
  t.run('deselect'); t.mergeDown();
});
const screenL = await px(50, 100), screenR = await px(250, 100);
const scr = (a, b) => Math.round(255 - ((255 - a) * (255 - b)) / 255);
const screenExp = multExpected.slice(0, 3).map((v) => scr(v, 255 - v));
check(near(screenL, [...screenExp, 255], 2) && near(screenR, multExpected, 2), `masked Screen adjustment merges only inside its mask (${screenL} / ${screenR})`);

// --- (2) live (non-destructive) filters ------------------------------------------------
await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(300, 200, 'white', 'live-filters');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 150, 200); t.touch(l); t.commit('Half black');
  t.fitToScreen();
});
{ const m = page.locator('.menu', { has: page.locator('> button', { hasText: 'Filter' }) }); await m.locator('> button').click(); await m.locator('.menu-items [data-cmd="convertSmart"]').click(); }
check(await page.evaluate(() => window.tintwork.activeLayer().kind === 'smart'), 'Filter ▸ Convert to live layer makes a live filter layer');
await menuCmd('gaussianBlur');
await page.waitForSelector('#modal:not(.hidden)');
check((await page.locator('#modalTitle').textContent()).startsWith('Live'), 'filters on a live layer open the live filter dialog');
await page.locator('#modalBody input[data-key="radius"]').fill('6'); await page.locator('#modalBody input[data-key="radius"]').dispatchEvent('input');
await page.locator('#modalOk').click(); await idle(); await page.waitForTimeout(100);
const blurred = await page.evaluate(() => { const t = window.tintwork, l = t.activeLayer(); return { edge: t.compositePixel(150, 100), src: [...l.source.getContext('2d').getImageData(149, 100, 1, 1).data], n: l.filters.length }; });
check(blurred.n === 1 && blurred.edge[0] > 60 && blurred.edge[0] < 200 && blurred.src[0] === 0, `live blur renders (edge ${blurred.edge[0]}) while the original pixels stay untouched`);
check(await page.locator('#layerList li.filter-row').count() === 1, 'Layers panel lists the filter under the layer');
// toggle off / on from the panel
await page.locator('#layerList li.filter-row .eye').click(); await idle();
check((await px(148, 100))[0] === 0, 'hiding the filter shows the original pixels');
await page.locator('#layerList li.filter-row .eye').click(); await idle();
check((await px(148, 100))[0] > 20, 'showing it again re-applies the blur');
// re-edit: stronger radius
await page.locator('#layerList li.filter-row .mini').first().click();
await page.waitForSelector('#modal:not(.hidden)');
const r0 = (await px(140, 100))[0];
await page.locator('#modalBody input[data-key="radius"]').fill('20'); await page.locator('#modalBody input[data-key="radius"]').dispatchEvent('input');
await page.locator('#modalOk').click(); await idle(); await page.waitForTimeout(100);
const r1 = (await px(140, 100))[0];
check(r1 > r0 && await page.evaluate(() => window.tintwork.activeLayer().filters[0].params.radius === 20), `re-editing the filter updates the result (${r0} → ${r1})`);
// stack a second filter (vignette) via the live panel, then reorder and delete it
await page.evaluate(() => window.tintwork.editLayer());
await page.waitForSelector('.live-panel');
await page.locator('[data-live-add="vignette"]').click();
await page.waitForSelector('#modal:not(.hidden)');
await page.locator('#modalOk').click(); await idle(); await page.waitForTimeout(100);
const stack = await page.evaluate(() => window.tintwork.activeLayer().filters.map((f) => f.type).join(','));
const corner = await px(298, 2), white = await px(290, 100);
check(stack === 'gaussianBlur,vignette' && corner[0] < 250, `filters stack (${stack}); vignette darkens corners (${corner[0]})`);
// filter mask from a selection: filters only on the right half
await page.evaluate(() => { const t = window.tintwork, d = t.doc; t.setSelection(t.makeSelection(d.width, d.height, t.rectMask(d.width, d.height, { x: 150, y: 0, w: 150, h: 200 })), 'Right'); t.editLayer(); });
await page.waitForSelector('.live-panel');
await page.locator('[data-live="maskSel"]').click(); await idle(); await page.waitForTimeout(100);
await page.locator('#modalOk').click();
await page.evaluate(() => window.tintwork.run('deselect'));
const masked = { left: await px(140, 100), right: await px(160, 100) };
check(masked.left[0] === 0 && masked.right[0] < 250 && await page.locator('#layerList li.fmask-row').count() === 1, `filter mask limits the filters (left ${masked.left[0]}, right ${masked.right[0]})`);
await page.screenshot({ path: path.join(shots, '3x-smart-filters.png') });
// painting the filter mask black hides the filters there
await page.locator('#layerList li.fmask-row canvas').click();
await page.evaluate(() => { const t = window.tintwork; t.setFg('#000000'); t.state.opts.brushSize = 60; t.state.opts.brushHardness = 100; t.state.opts.brushOpacity = 100; t.setTool('brush'); });
await clickDoc(200, 100); await idle();
const painted = await px(200, 100);
check(painted[0] === 255 && await page.evaluate(() => window.tintwork.activeLayer().kind === 'smart'), `painting the filter mask hides the filters without converting the layer (${painted[0]})`);
const fmAt = () => page.evaluate(() => { const l = window.tintwork.activeLayer(); return l.fmask.canvas.getContext('2d').getImageData(200 - l.x, 100 - l.y, 1, 1).data[0]; });
const fmPainted = await fmAt();
await page.evaluate(() => window.tintwork.undo());
const fmUndone = await fmAt();
check(fmPainted < 20 && fmUndone > 235, `undo restores the filter mask (mask value ${fmPainted} → ${fmUndone})`);
// undo back past the filter mask & vignette, then redo
const hist = await page.evaluate(() => { const t = window.tintwork; t.undo(); t.undo(); return t.activeLayer().filters.length; });
check(hist === 2 && await page.evaluate(() => !window.tintwork.activeLayer().fmask), 'undo walks back through live-filter edits');
await page.evaluate(() => { const t = window.tintwork; t.redo(); t.redo(); });
// project round-trip keeps the layer live
const reloaded = await page.evaluate(async () => {
  const t = window.tintwork, data = t.serializeProject(), before = t.compositePixel(160, 100);
  await t.openFile(new File([JSON.stringify(data)], 'live.tintwork.json', { type: 'application/json' }), 'open');
  const l = t.doc.layers[0];
  return { v: data.version, kind: l.kind, filters: l.filters?.length, fmask: !!l.fmask, before, after: t.compositePixel(160, 100) };
});
check(reloaded.v >= 6 && reloaded.kind === 'smart' && reloaded.filters === 2 && reloaded.fmask && near(reloaded.before, reloaded.after, 1), 'project files (v6+) keep the layer live: original pixels, filter stack and filter mask');
await page.evaluate(() => { const t = window.tintwork; t.setTool('move'); t.run('rasterizeLayer'); });
check(await page.evaluate(() => !window.tintwork.activeLayer().kind && window.tintwork.history.entries.at(-1).label === 'Convert live layer to pixels'), 'Layer ▸ Convert to pixels bakes a live layer');

// --- (3) free transform ----------------------------------------------------------------
await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(400, 300, 'white', 'transform'); t.run('layerNew');
  const l = t.activeLayer(), x = l.canvas.getContext('2d'); x.fillStyle = '#ff0000'; x.fillRect(100, 100, 100, 100); t.touch(l); t.commit('Red square');
  t.fitToScreen(); t.setTool('move');
});
await page.locator('#viewport').focus();
await page.keyboard.press('Control+t');
const xf0 = await page.evaluate(() => { const x = window.tintwork.xf; return x && { w: x.w, h: x.h, cx: x.cx, cy: x.cy }; });
check(xf0 && xf0.w === 100 && xf0.h === 100 && xf0.cx === 150 && xf0.cy === 150, 'Ctrl+T starts a free transform around the layer content');
check(await page.locator('#optionsbar [data-xf="rot"]').count() === 1, 'options bar shows W / H / angle / skew fields while transforming');
// drag the bottom-right handle with Shift (keeps aspect)
{
  const a = await docToScreen(200, 200), b = await docToScreen(250, 230);
  await page.mouse.move(a.x, a.y); await page.keyboard.down('Shift'); await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 }); await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.up(); await page.keyboard.up('Shift');
}
const xf1 = await page.evaluate(() => { const x = window.tintwork.xf; return { sx: x.sx, sy: x.sy, cx: x.cx, cy: x.cy }; });
check(Math.abs(xf1.sx - 1.5) < 0.03 && Math.abs(xf1.sy - xf1.sx) < 1e-9 && Math.abs(xf1.cx - 175) < 2, `corner handle scales from the opposite corner; Shift keeps aspect (${xf1.sx.toFixed(3)} × ${xf1.sy.toFixed(3)})`);
await page.screenshot({ path: path.join(shots, '3x-free-transform.png') });
await page.keyboard.press('Enter');
const scaled = { in: await px(240, 240), out: await px(95, 95), tl: await px(103, 103), hist: await page.evaluate(() => window.tintwork.history.entries.at(-1).label) };
check(near(scaled.in, [255, 0, 0, 255], 2) && near(scaled.out, [255, 255, 255, 255], 2) && near(scaled.tl, [255, 0, 0, 255], 2) && scaled.hist === 'Free transform', 'Enter applies the scale (pixels checked) as one history step');
// rotate 45° via the numeric field
await page.keyboard.press('Control+t');
await page.locator('#optionsbar [data-xf="rot"]').fill('45'); await page.locator('#optionsbar [data-xf="rot"]').dispatchEvent('change');
await page.locator('#optionsbar [data-cmd="xfApply"]').click();
const rot = { corner: await px(106, 106), top: await px(175, 78), centre: await px(175, 175) };
check(near(rot.corner, [255, 255, 255, 255], 3) && rot.top[0] > 200 && rot.top[1] < 60 && near(rot.centre, [255, 0, 0, 255], 2), 'rotation by 45° moves the corners (pixel checks)');
// rotate by dragging outside the box with Shift (15° snapping), then cancel with Esc
await page.keyboard.press('Control+t');
{
  const xfs = await page.evaluate(() => { const x = window.tintwork.xf; return { cx: x.cx, cy: x.cy, w: x.w }; });
  const a = await docToScreen(xfs.cx + xfs.w / 2 + 30, xfs.cy), b = await docToScreen(xfs.cx, xfs.cy + xfs.w / 2 + 31);
  await page.mouse.move(a.x, a.y); await page.keyboard.down('Shift'); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Shift');
}
const deg = await page.evaluate(() => Math.round(window.tintwork.xf.rot * 180 / Math.PI));
check(deg === 90, `dragging outside rotates, Shift snaps to 15° steps (${deg}°)`);
await page.keyboard.press('Escape');
check(await page.evaluate(() => !window.tintwork.xf) && near(await px(175, 78), rot.top, 2), 'Esc cancels the transform and restores the pixels');
// skew with Ctrl on an edge handle
await page.keyboard.press('Control+z'); // back to the square (undo the rotation)
await page.keyboard.press('Control+t');
{
  const a = await docToScreen(175, 100), b = await docToScreen(225, 100);
  await page.mouse.move(a.x, a.y); await page.keyboard.down('Control'); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Control');
}
const kx = await page.evaluate(() => window.tintwork.xf.kx);
await page.keyboard.press('Enter');
const sk = { topRight: await px(270, 105), bottomLeft: await px(105, 245), mid: await px(175, 175) };
check(Math.abs(kx + 50 / 75) < 0.03 && near(sk.topRight, [255, 0, 0, 255], 3) && near(sk.bottomLeft, [255, 0, 0, 255], 3), `Ctrl+edge handle skews (kx ${kx.toFixed(3)}; pixels follow)`);
check(await page.evaluate(() => { const t = window.tintwork; t.undo(); return !t.xf && t.history.entries[t.history.index].label === 'Free transform'; }), 'undo removes the skew');
// transform a selection: the selected pixels move/scale and the selection follows
await page.evaluate(() => { const t = window.tintwork, d = t.doc; t.setSelection(t.makeSelection(d.width, d.height, t.rectMask(d.width, d.height, { x: 100, y: 100, w: 75, h: 150 })), 'Left part'); });
await page.keyboard.press('Control+t');
{
  const a = await docToScreen(137, 175), b = await docToScreen(37, 175);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
}
await page.keyboard.press('Enter');
const selXf = await page.evaluate(() => { const t = window.tintwork, s = t.doc.selection; return { s: s && [s.x, s.y, s.w, s.h], moved: t.compositePixel(20, 175), hole: t.compositePixel(120, 175), rest: t.compositePixel(240, 175), label: t.history.entries[t.history.index].label }; });
check(selXf.label === 'Transform selection' && selXf.s && Math.abs(selXf.s[0] - 0) <= 1 && near(selXf.moved, [255, 0, 0, 255], 2) && near(selXf.hole, [255, 255, 255, 255], 2) && near(selXf.rest, [255, 0, 0, 255], 2),
  `transforming a selection moves only the selected pixels; the selection follows (${selXf.s})`);
await page.evaluate(() => window.tintwork.run('deselect'));

// --- (4) autosave with bounded undo history in several recovery slots ---------------------
await page.evaluate(async () => { const t = window.tintwork; await t.autosaveNow(); await t.clearAutosave(); });
await page.evaluate(async () => {
  const t = window.tintwork;
  t.newDocument(200, 120, 'white', 'slot-a');
  const a = t.doc.layers[0]; a.canvas.getContext('2d').fillStyle = '#00aa00'; a.canvas.getContext('2d').fillRect(0, 0, 100, 120); t.touch(a); t.commit('Green');
  await t.autosaveNow();
  t.newDocument(200, 120, 'white', 'slot-b');
  const b = t.doc.layers[0], x = b.canvas.getContext('2d');
  for (let i = 0; i < 25; i++) { x.fillStyle = `rgb(${i * 10},0,${255 - i * 10})`; x.fillRect(i * 8, 0, 8, 120); t.touch(b); t.commit(`Stripe ${i + 1}`); }
  await t.autosaveNow();
});
const slots = await page.evaluate(async () => (await window.tintwork.listAutosaves()).map((r) => ({ name: r.name, steps: r.steps, dirty: r.dirty })));
check(slots.length === 2 && slots[0].name === 'slot-b' && slots[0].steps === 20 && slots[1].name === 'slot-a', `each document gets its own slot; history bounded to the last 20 steps (${JSON.stringify(slots)})`);
const stripe24 = await px(23 * 8 + 4, 60);
await page.reload();
await page.waitForSelector('#modal:not(.hidden)');
const rows = await page.locator('#modalBody li.slot-row').count();
check(rows === 2 && (await page.locator('#modalBody').textContent()).includes('20 undo steps'), `recovery prompt lists both unsaved documents (${rows} slots)`);
await page.screenshot({ path: path.join(shots, '3x-recovery-slots.png') });
await page.locator('#modalBody li.slot-row', { hasText: 'slot-b' }).locator('[data-recover]').click();
await page.waitForFunction(() => window.tintwork.doc?.name === 'slot-b');
const recB = await page.evaluate(() => { const t = window.tintwork; return { n: t.history.entries.length, label: t.history.entries[t.history.index].label, p: t.compositePixel(23 * 8 + 4, 60) }; });
check(recB.n === 20 && recB.label === 'Stripe 25' && near(recB.p, stripe24, 1), `recovered document keeps 20 undo steps (${recB.label})`);
await page.evaluate(() => { window.tintwork.undo(); window.tintwork.undo(); });
check(near(await px(23 * 8 + 4, 60), [255, 255, 255, 255], 1) && await page.evaluate(() => window.tintwork.history.entries[window.tintwork.history.index].label === 'Stripe 23'), 'undo works after recovery (pixels roll back)');
await page.evaluate(() => window.tintwork.run('recoverAutosave'));
await page.waitForSelector('#modalBody li.slot-row');
await page.locator('#modalBody li.slot-row', { hasText: 'slot-a' }).locator('[data-recover]').click();
await page.waitForFunction(() => window.tintwork.doc?.name === 'slot-a');
check(near(await px(50, 60), [0, 170, 0, 255], 1) && await page.evaluate(() => window.tintwork.history.entries.length === 2), 'File ▸ Recover autosave restores another slot with its history');
// old slots are evicted beyond the limit
const evicted = await page.evaluate(async () => {
  const t = window.tintwork;
  for (let i = 0; i < 6; i++) { t.newDocument(50, 50, 'white', `many-${i}`); await t.autosaveNow(); }
  return (await t.listAutosaves()).map((r) => r.name);
});
check(evicted.length === 5 && !evicted.includes('slot-a') && evicted[0] === 'many-5', `only the ${evicted.length} newest slots are kept`);
await page.evaluate(async () => { await window.tintwork.clearAutosave(); });

// --- (5) select by color range ----------------------------------------------------------
await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(300, 150, 'white', 'color-range');
  const l = t.doc.layers[0], x = l.canvas.getContext('2d');
  x.fillStyle = '#e02020'; x.fillRect(0, 0, 100, 150); x.fillStyle = '#2040e0'; x.fillRect(100, 0, 100, 150); x.fillStyle = '#20c040'; x.fillRect(200, 0, 100, 75);
  x.fillStyle = '#b81818'; x.fillRect(20, 20, 30, 30); // a darker red patch
  t.touch(l); t.commit('Swatches'); t.fitToScreen(); t.setTool('select');
});
await page.locator('#optionsbar [data-cmd="colorRange"]').click();
await page.waitForSelector('#crPreview');
await clickDoc(80, 100); // passive dialog: clicking the canvas samples
check(await page.locator('#crColor').inputValue() === '#e02020', 'clicking the canvas samples the color');
await page.locator('#crFuzz').fill('60'); await page.locator('#crFuzz').dispatchEvent('input');
await page.screenshot({ path: path.join(shots, '3x-color-range.png') });
await page.locator('#modalOk').click(); await idle();
const cr = await page.evaluate(() => { const s = window.tintwork.doc.selection, at = (x, y) => s.mask[y * s.W + x]; return { red: at(80, 100), patch: at(30, 30), blue: at(150, 100), green: at(250, 30), white: at(250, 120) }; });
check(cr.red === 255 && cr.patch > 0 && cr.blue === 0 && cr.green === 0 && cr.white === 0, `color range selects the sampled reds only (${JSON.stringify(cr)})`);
await page.evaluate(() => window.tintwork.run('deselect'));
await page.evaluate(() => window.tintwork.openColorRangeDialog());
await page.selectOption('#crMode', 'blues'); await page.locator('#modalOk').click(); await idle();
const crB = await page.evaluate(() => { const s = window.tintwork.doc.selection; return s && [s.x, s.y, s.w, s.h]; });
check(JSON.stringify(crB) === '[100,0,100,150]', `hue preset "Blues" selects the blue block (${crB})`);
await page.evaluate(() => window.tintwork.run('deselect'));
await page.evaluate(() => window.tintwork.openColorRangeDialog());
await page.selectOption('#crMode', 'highlights'); await page.locator('#modalOk').click(); await idle();
const crH = await page.evaluate(() => { const s = window.tintwork.doc.selection, at = (x, y) => s.mask[y * s.W + x]; return { white: at(250, 120), blue: at(150, 50) }; });
check(crH.white === 255 && crH.blue === 0, 'tonal range "Highlights" selects the white area');

// --- (6) refine edge: shift edge, smooth, feather ----------------------------------------
await page.evaluate(() => { const t = window.tintwork, d = t.doc; t.setSelection(t.makeSelection(d.width, d.height, t.rectMask(d.width, d.height, { x: 100, y: 40, w: 100, h: 70 })), 'Rect'); });
await page.keyboard.press('Control+Alt+r');
await page.waitForSelector('#modal:not(.hidden)');
const setRange = async (key, v) => { const i = page.locator(`#modalBody input[data-key="${key}"]`); await i.fill(String(v)); await i.dispatchEvent('input'); };
await setRange('shift', 10); await idle(); await page.waitForTimeout(150);
const prevSel = await page.evaluate(() => { const s = window.tintwork.doc.selection; return [s.x, s.y, s.w, s.h]; });
check(JSON.stringify(prevSel) === '[90,30,120,90]', `refine edge previews live: shift +10 px expands (${prevSel})`);
await setRange('feather', 4); await idle(); await page.waitForTimeout(150);
await page.screenshot({ path: path.join(shots, '3x-refine-edge.png') });
await page.locator('#modalOk').click(); await idle();
const ref = await page.evaluate(() => { const t = window.tintwork, s = t.doc.selection, at = (x, y) => s.mask[y * s.W + x]; return { inside: at(150, 75), edge: at(90, 75), outside: at(80, 75), label: t.history.entries[t.history.index].label, steps: t.history.entries.filter((e) => e.label === 'Refine edge').length }; });
check(ref.inside === 255 && ref.edge > 40 && ref.edge < 215 && ref.outside < 10 && ref.label === 'Refine edge' && ref.steps === 1, `OK applies expand + feather as one step (edge ${ref.edge})`);
await page.keyboard.press('Control+z');
await page.evaluate(() => window.tintwork.openRefineDialog());
await page.waitForSelector('#modal:not(.hidden)');
await setRange('shift', -15); await setRange('feather', 0); await setRange('smooth', 0); await idle();
await page.locator('#modalOk').click(); await idle();
const contracted = await page.evaluate(() => { const s = window.tintwork.doc.selection; return [s.x, s.y, s.w, s.h]; });
check(JSON.stringify(contracted) === '[115,55,70,40]', `negative shift contracts the selection (${contracted})`);
// smoothing rounds a jagged selection
await page.evaluate(() => {
  const t = window.tintwork, d = t.doc, m = new Uint8Array(d.width * d.height);
  for (let y = 30; y < 120; y++) for (let x = 60; x < 240; x++) if (((x >> 2) + (y >> 2)) % 2 === 0 || (x > 90 && x < 210 && y > 50 && y < 100)) m[y * d.width + x] = 255;
  t.setSelection(t.makeSelection(d.width, d.height, m), 'Jagged');
});
const jag = await page.evaluate(() => { const s = window.tintwork.doc.selection; let e = 0; for (let y = 1; y < s.H; y++) for (let x = 1; x < s.W; x++) { const i = y * s.W + x; if ((s.mask[i] >= 128) !== (s.mask[i - 1] >= 128)) e++; } return e; });
await page.evaluate(() => window.tintwork.openRefineDialog());
await page.waitForSelector('#modal:not(.hidden)');
await setRange('shift', 0); await setRange('smooth', 6); await idle();
await page.locator('#modalOk').click(); await idle();
const jag2 = await page.evaluate(() => { const s = window.tintwork.doc.selection; let e = 0; for (let y = 1; y < s.H; y++) for (let x = 1; x < s.W; x++) { const i = y * s.W + x; if ((s.mask[i] >= 128) !== (s.mask[i - 1] >= 128)) e++; } return e; });
check(jag2 < jag / 3, `smooth removes jagged edges (${jag} → ${jag2} edge transitions)`);
await page.evaluate(() => { const t = window.tintwork; t.run('deselect'); t.state.opts.refineSmooth = 0; t.state.opts.refineShift = 0; t.state.opts.refineFeather = 0; });

// --- (7) bundled open-licensed fonts --------------------------------------------------------
const fontFiles = await page.evaluate(async () => {
  const get = async (u) => { const r = await fetch(u); return r.ok ? (await r.arrayBuffer()).byteLength : 0; };
  return { css: await get('fonts/fonts.css'), woff: await get('fonts/bebas-neue/bebas-neue-latin-400-normal.woff2'), lic: await get('fonts/pacifico/OFL.txt') };
});
check(fontFiles.css > 0 && fontFiles.woff > 1000 && fontFiles.lic > 1000, 'fonts, font CSS and OFL license files are served locally');
await page.evaluate(async () => { const t = window.tintwork; t.newDocument(900, 420, 'white', 'fonts'); t.fitToScreen(); await Promise.all(Object.keys(t.BUNDLED_FONTS).map((f) => t.loadFont({ font: f, size: 40 }))); });
check(await page.evaluate(() => Object.keys(window.tintwork.BUNDLED_FONTS).every((f) => document.fonts.check(`40px "${f}"`))), 'all five bundled fonts load (Inter, Lora, Bebas Neue, Pacifico, JetBrains Mono)');
const fontsUsed = ['Inter', 'Lora', 'Bebas Neue', 'Pacifico', 'JetBrains Mono'];
for (let i = 0; i < fontsUsed.length; i++) {
  await page.keyboard.press('t'); await clickDoc(30, 20 + i * 78);
  await page.locator('#tText').fill(`${fontsUsed[i]} — Tintwork 0.4`);
  await page.selectOption('#tFont', fontsUsed[i]);
  await page.locator('#tSize').fill('48'); await page.locator('#tSize').dispatchEvent('input');
  await page.locator('#modalOk').click();
}
await idle(); await page.waitForTimeout(200);
const widths = await page.evaluate(() => window.tintwork.doc.layers.filter((l) => l.kind === 'text').map((l) => ({ f: l.text.font, w: l.canvas.width })));
const fallbackW = await page.evaluate(() => { const c = document.createElement('canvas').getContext('2d'); c.font = '48px sans-serif'; return Math.round(c.measureText('Bebas Neue — Tintwork 0.4').width); });
const bebas = widths.find((w) => w.f === 'Bebas Neue'), mono = widths.find((w) => w.f === 'JetBrains Mono');
check(widths.length === 5 && bebas.w < fallbackW && mono.w > bebas.w, `text renders with the bundled fonts (Bebas Neue ${bebas.w}px wide vs ${fallbackW}px fallback)`);
const inkInk = await page.evaluate(() => { const l = window.tintwork.doc.layers.find((q) => q.text?.font === 'Pacifico'), a = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data; let n = 0; for (let i = 3; i < a.length; i += 4) if (a[i] > 128) n++; return n; });
check(inkInk > 1500, `Pacifico text layer has rendered glyph pixels (${inkInk})`);
await page.screenshot({ path: path.join(shots, '3x-fonts.png') });

} // end v0.4 section

// ===================================================================================================
// v0.5: GPU engine (WebGL2) + 16-bit documents. Screenshots 4x-*.png
// ===================================================================================================
{
const { encodePNG } = await import('../src/png.js');
// a smooth 16-bit test asset (values a 8-bit file can't hold)
const g16 = path.join(root, 'test-assets', 'gradient16.png');
{
  const W = 1024, H = 96, data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, v = Math.round((100 + 40 * x / (W - 1)) * 257); data[i] = v; data[i + 1] = Math.round(v * 0.9); data[i + 2] = 65535 - v; data[i + 3] = 65535; }
  fs.writeFileSync(g16, encodePNG({ width: W, height: H, data, depth: 16 }));
}
// --- engine selection -----------------------------------------------------------------------------
await page.evaluate(() => window.tintwork.engineReady);
const auto = await page.evaluate(() => ({ pref: window.tintwork.gfx.pref, engine: !!window.tintwork.engine, reason: window.tintwork.gfx.reason }));
console.log(`note automatic engine choice in headless Chromium: ${auto.engine ? 'GPU' : `CPU (${auto.reason})`}`);
const forced = await page.evaluate(() => { const t = window.tintwork; t.setEnginePref('gpu'); const e = t.engine; return e ? { renderer: e.info.renderer, software: e.info.software, max: e.info.maxTextureSize, half: e.info.halfFloat, f32: e.info.float32 } : { err: t.gfx.reason }; });
check(!!forced.renderer, `GPU engine starts when forced (WebGL2 renderer: ${forced.renderer || forced.err}${forced.software ? ', software GL' : ''})`);
console.log(`note GPU caps: max texture ${forced.max}, half-float targets ${forced.half}, float32 targets ${forced.f32}`);

// --- composite parity: 16 blend modes (some masked), 7 adjustment-layer types (normal + overlay) -----------
const parity = await page.evaluate(async () => {
  const t = window.tintwork, W = 240, H = 160;
  t.newDocument(W, H, 'transparent', 'parity'); const d = t.doc, base = d.layers[0], bx = base.canvas.getContext('2d');
  const gr = bx.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#203060'); gr.addColorStop(0.5, '#c08040'); gr.addColorStop(1, '#40e0a0'); bx.fillStyle = gr; bx.fillRect(0, 0, W, H - 20); t.touch(base);
  const cmp = () => {
    const a = document.createElement('canvas'), b = document.createElement('canvas');
    t.composite(a, {}); t.composite(b, { cpu: true });
    const A = a.getContext('2d').getImageData(0, 0, W, H).data, B = b.getContext('2d').getImageData(0, 0, W, H).data;
    let max = 0, sum = 0; for (let i = 0; i < A.length; i++) { const e = Math.abs(A[i] - B[i]); sum += e; if (e > max) max = e; }
    return { max, mean: sum / A.length };
  };
  const out = [];
  const blends = ['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
  const before = t.engine.stats.composites;
  for (const [i, bl] of blends.entries()) {
    d.layers.length = 1;
    const l = t.createLayer('L', W - 40, H - 30, { blend: bl, opacity: 0.8, x: 25, y: 10 }), c = l.canvas.getContext('2d');
    const g = c.createRadialGradient(100, 65, 5, 100, 65, 100); g.addColorStop(0, 'rgba(250,40,120,1)'); g.addColorStop(0.6, 'rgba(30,200,240,0.7)'); g.addColorStop(1, 'rgba(255,255,0,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
    if (i % 3 === 1) { const m = document.createElement('canvas'); m.width = W - 40; m.height = H - 30; const mc = m.getContext('2d'), mg = mc.createLinearGradient(0, 0, m.width, 0); mg.addColorStop(0, '#000'); mg.addColorStop(1, 'rgba(0,0,0,0)'); mc.fillStyle = mg; mc.fillRect(0, 0, m.width, m.height); l.mask = { canvas: m, enabled: true, rev: 99000 + i }; }
    d.layers.push(l); t.touch(l); out.push({ what: bl, ...cmp() });
  }
  const cur = t.defaultAdjParams('curves'); cur.rgb = [[0, 0], [64, 110], [190, 200], [255, 255]];
  const adjp = { brightnessContrast: { brightness: 25, contrast: 40 }, hueSaturation: { hue: 40, saturation: 30, lightness: -10 }, exposure: { exposure: 0.7, offset: 0.02, gamma: 1.2 }, levels: { inBlack: 20, gamma: 1.4, inWhite: 230, outBlack: 10, outWhite: 245 }, curves: cur, invert: {}, grayscale: {} };
  for (const [type, params] of Object.entries(adjp)) {
    d.layers.length = 1;
    const m = document.createElement('canvas'); m.width = W; m.height = H; const mc = m.getContext('2d'); mc.fillStyle = '#000'; mc.fillRect(0, 0, W * 0.7, H);
    const a = t.createLayer(type, 1, 1, { kind: 'adjust', adj: { type, params }, editMask: true, opacity: 0.9 }); a.mask = { canvas: m, enabled: true, rev: 98000 };
    d.layers.push(a); t.touch(a); out.push({ what: `${type} layer`, ...cmp() });
    a.blend = 'overlay'; t.touch(a); out.push({ what: `${type} layer (overlay)`, ...cmp() });
  }
  return { out, gpuComposites: t.engine.stats.composites - before };
});
const worstC = parity.out.reduce((a, b) => (b.max > a.max ? b : a));
check(parity.gpuComposites >= parity.out.length && parity.out.every((r) => r.max <= 4 && r.mean < 0.5),
  `GPU vs CPU composite parity: ${parity.out.length} cases (16 blend modes incl. masks, 7 adjustment layers × 2 blends), worst max diff ${worstC.max} (${worstC.what}), mean ≤ ${Math.max(...parity.out.map((r) => r.mean)).toFixed(2)}`);

// --- filter parity (GPU shaders vs CPU / worker) -----------------------------------------------
const fpar = await page.evaluate(async () => {
  const t = window.tintwork, W = 200, H = 140, e = t.engine;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true });
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#102040'); g.addColorStop(0.5, '#e09050'); g.addColorStop(1, '#30f0b0'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(255,255,255,0.8)'; x.fillRect(60, 40, 50, 30); x.clearRect(150, 0, 50, 30);
  const img = () => x.getImageData(0, 0, W, H), info = { docW: W, docH: H, offX: 0, offY: 0 };
  const cur = t.defaultAdjParams('curves'); cur.rgb = [[0, 0], [64, 110], [190, 200], [255, 255]];
  const jobs = { gaussianBlur: { radius: 12 }, sharpen: { amount: 120, radius: 2, threshold: 2 }, vignette: { amount: 50, size: 45, feather: 60 }, hueSaturation: { hue: 30, saturation: 40, lightness: 0 }, curves: cur, levels: { inBlack: 20, gamma: 1.4, inWhite: 230, outBlack: 0, outWhite: 255 }, exposure: { exposure: 0.5, offset: 0, gamma: 1 }, brightnessContrast: { brightness: 20, contrast: 30 }, grayscale: {}, sepia: { amount: 80 }, invert: {}, noise: { amount: 12, monochrome: true, seed: 1234 } };
  const out = {};
  for (const [name, p] of Object.entries(jobs)) {
    t.ops.setAccelerator(e); const a = await t.ops.process(name, img(), p, info, null); const path = t.ops.lastOpPath();
    t.ops.setAccelerator(null); const b = await t.ops.process(name, img(), p, info, null);
    let max = 0, sum = 0, ma = 0, mb = 0;
    for (let i = 0; i < a.data.length; i++) { if (a.data[i | 3] === 0 && b.data[i | 3] === 0) continue; /* colour of fully transparent pixels is undefined */ const dd = Math.abs(a.data[i] - b.data[i]); sum += dd; ma += a.data[i]; mb += b.data[i]; if (dd > max) max = dd; }
    out[name] = { path, max, mean: sum / a.data.length, meanShift: Math.abs(ma - mb) / a.data.length };
  }
  for (const name of ['gaussianBlur', 'curves', 'hueSaturation', 'levels']) {
    t.ops.setAccelerator(e); const a = await t.ops.processDeep(name, t.deepFromImageData(img()), jobs[name], info, null); const path = t.ops.lastOpPath();
    t.ops.setAccelerator(null); const b = await t.ops.processDeep(name, t.deepFromImageData(img()), jobs[name], info, null);
    let max = 0, sum = 0; for (let i = 0; i < a.data.length; i++) { const dd = Math.abs(a.data[i] - b.data[i]) / 257; sum += dd; if (dd > max) max = dd; }
    out[`16-bit ${name}`] = { path, max: +max.toFixed(2), mean: sum / a.data.length };
  }
  t.ops.setAccelerator(e);
  return out;
});
const pointOps = ['vignette', 'hueSaturation', 'curves', 'levels', 'exposure', 'brightnessContrast', 'grayscale', 'sepia', 'invert', '16-bit curves', '16-bit hueSaturation', '16-bit levels'];
check(Object.values(fpar).every((r) => r.path === 'gpu'), 'all filters ran on the GPU when it is selected');
const worstP = pointOps.reduce((a, n) => (fpar[n].max > fpar[a].max ? n : a));
check(pointOps.every((n) => fpar[n].max <= 2), `GPU point ops / HSL / vignette match the CPU within 2 levels (worst ${fpar[worstP].max}, ${worstP})`);
check(['gaussianBlur', 'sharpen', '16-bit gaussianBlur'].every((n) => fpar[n].mean < 1.5 && fpar[n].max <= 14),
  `GPU blur/sharpen ≈ CPU (true Gaussian vs 3-box approximation): mean diff ${fpar.gaussianBlur.mean.toFixed(2)} / ${fpar.sharpen.mean.toFixed(2)} / 16-bit ${fpar['16-bit gaussianBlur'].mean.toFixed(2)} levels`);
check(fpar.noise.meanShift < 1, `GPU noise is statistically equivalent (mean shift ${fpar.noise.meanShift.toFixed(2)})`);

// --- live (smart) filters render on the GPU -------------------------------------------------------
const live = await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(300, 200, 'white', 'live');
  const l = t.doc.layers[0], c = l.canvas.getContext('2d'); c.fillStyle = '#e04020'; c.fillRect(60, 50, 180, 100); t.touch(l);
  t.convertToSmart(); const s = t.activeLayer();
  const ops0 = t.engine.stats.ops;
  t.setSmartFilters(s, [{ type: 'gaussianBlur', params: { radius: 6 }, enabled: true }, { type: 'hueSaturation', params: { hue: 60, saturation: 0, lightness: 0 }, enabled: true }]);
  await t.idle(); const gpu = t.compositePixel(64, 100);
  t.setEnginePref('cpu'); t.setSmartFilters(s, [...s.filters]); await t.idle(); await new Promise((r) => setTimeout(r, 100)); await t.idle();
  const cpu = t.compositePixel(64, 100); t.setEnginePref('gpu');
  return { gpuOps: t.engine ? 1 : 0, ops: ops0, gpu, cpu };
});
check(live.gpu.every((v, i) => Math.abs(v - live.cpu[i]) <= 8), `live filter stack (blur + hue) renders on the GPU like the CPU (${live.gpu} vs ${live.cpu})`);

// --- 16-bit documents ---------------------------------------------------------------------------------
const okModal = async () => { await page.waitForTimeout(60); await page.click('#modalOk'); await idle(); await page.waitForTimeout(60); await idle(); };
const band = {};
for (const depth of [8, 16]) {
  await page.evaluate(() => {
    const t = window.tintwork, W = 1024, H = 200; t.newDocument(W, H, 'white', 'banding');
    const c = t.activeLayer().canvas.getContext('2d'), g = c.createLinearGradient(0, 0, W, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); c.fillStyle = g; c.fillRect(0, 0, W, H); t.touch(t.activeLayer()); t.commit('gradient'); t.fitToScreen();
  });
  if (depth === 16) await menuCmd('mode16');
  await page.evaluate(() => window.tintwork.openAdjust(window.tintwork.ADJ.levels, { outBlack: 100, outWhite: 140 })); await okModal();
  await page.evaluate(() => window.tintwork.openAdjust(window.tintwork.ADJ.levels, { inBlack: 100, inWhite: 140 })); await okModal();
  band[depth] = await page.evaluate(() => { const t = window.tintwork, px = t.activeLayer().canvas.getContext('2d').getImageData(0, 10, 1024, 1).data, s = new Set(); for (let i = 0; i < px.length; i += 4) s.add(px[i]); return { levels: s.size, depth: t.doc.depth || 8, info: document.querySelector('#docinfo').textContent }; });
  await page.screenshot({ path: path.join(shots, `4x-banding-${depth}bit.png`) });
}
check(band[16].depth === 16 && /16-bit/.test(band[16].info), `Image ▸ Mode ▸ 16 bits/channel switches the document (${band[16].info})`);
check(band[8].levels <= 45 && band[16].levels >= 150, `levels squeeze + stretch: ${band[8].levels} grey levels survive in 8-bit vs ${band[16].levels} in 16-bit`);
const undo16 = await page.evaluate(() => { const t = window.tintwork; t.undo(); const l = t.activeLayer(), ok = !!l.deep && l.deepRev === l.rev; t.redo(); return ok; });
check(undo16, 'undo/redo keeps 16-bit layer data in step');
// 16-bit PNG export round trip
const rt16 = await page.evaluate(async () => {
  const t = window.tintwork, blob = await t.renderExport('image/png16'), buf = new Uint8Array(await blob.arrayBuffer()), info = t.pngInfo(buf), dec = t.decodePNG(buf), dd = t.activeLayer().deep;
  let max = 0; for (let i = 0; i < dd.data.length; i++) max = Math.max(max, Math.abs(dd.data[i] - dec.data[i]));
  const b8 = await t.renderExport('image/png'), d8 = t.decodePNG(new Uint8Array(await b8.arrayBuffer())); let err = 0; for (let i = 0; i < dd.data.length; i += 4) err += Math.abs(d8.data[i] / 257 - dd.data[i] / 257);
  return { depth: info.bitDepth, max, dither: err / (dd.data.length / 4) };
});
check(rt16.depth === 16 && rt16.max === 0, `PNG 16-bit export decodes back bit-exact (bit depth ${rt16.depth}, max diff ${rt16.max})`);
check(rt16.dither < 0.6, `8-bit export of a 16-bit document is dithered (mean error ${rt16.dither.toFixed(3)} levels)`);
// project v6 round trip
const prj = await page.evaluate(async () => {
  const t = window.tintwork, before = t.activeLayer().deep, data = t.serializeProject();
  await t.openFile(new File([JSON.stringify(data)], 'deep.tintwork.json', { type: 'application/json' }), 'open');
  const after = t.activeLayer().deep; let max = after ? 0 : 1e9; if (after) for (let i = 0; i < after.data.length; i++) max = Math.max(max, Math.abs(after.data[i] - before.data[i]));
  return { v: data.version, depth: t.doc.depth, max };
});
check(prj.v >= 6 && prj.depth === 16 && prj.max === 0, `project v6+ keeps 16-bit layer data (max diff ${prj.max})`);
// open a 16-bit PNG
await page.setInputFiles('#fileInput', g16);
await page.waitForFunction(() => window.tintwork.doc?.name === 'gradient16.png'); await idle();
const op16 = await page.evaluate(() => { const t = window.tintwork, d = t.activeLayer().deep, s = new Set(); for (let x = 0; x < 1024; x++) s.add(d.data[(10 * 1024 + x) * 4]); return { depth: t.doc.depth, distinct: s.size }; });
check(op16.depth === 16 && op16.distinct > 900, `opening a 16-bit PNG keeps 16 bits (${op16.distinct} distinct red values in a row vs ≤ 41 in 8-bit)`);
// merge down / flatten / bake keep 16 bits
const merged = await page.evaluate(async () => {
  const t = window.tintwork, d = t.doc;
  const top = t.createLayer('top', d.width, d.height, { opacity: 0.5, blend: 'multiply' }); const c = top.canvas.getContext('2d'); c.fillStyle = '#808080'; c.fillRect(0, 0, d.width, d.height);
  d.layers.push(top); d.activeId = top.id; t.touch(top); t.commit('top');
  t.mergeDown(); const l = t.activeLayer(); const s = new Set(); for (let x = 0; x < 1024; x++) s.add(l.deep.data[(10 * 1024 + x) * 4]);
  return { layers: d.layers.length, distinct: s.size };
});
check(merged.layers === 1 && merged.distinct > 900, `merge down in a 16-bit document keeps 16-bit precision (${merged.distinct} distinct values)`);
await page.screenshot({ path: path.join(shots, '4x-16bit-png-open.png') });

// --- engine dialog + fallbacks ---------------------------------------------------------------------
await menuCmd('engine'); await page.waitForTimeout(150);
check(await page.locator('#modalTitle').textContent() === 'Rendering engine' && /Active: (WebGL2|WebGPU)/.test(await page.locator('#engInfo').textContent()), 'View ▸ Rendering engine… shows the active GPU, its limits and the memory budget');
await page.screenshot({ path: path.join(shots, '4x-engine-dialog.png') });
await page.check('input[name=engine][value=cpu]'); await page.click('#modalOk');
const cpuMode = await page.evaluate(async () => { const t = window.tintwork; t.composite(); const info = document.querySelector('#docinfo').textContent; const img = new ImageData(64, 64); await t.ops.process('gaussianBlur', img, { radius: 4 }, { docW: 64, docH: 64, offX: 0, offY: 0 }); return { engine: !!t.engine, path: t.ops.lastOpPath(), info, pref: localStorage.getItem('tintwork.engine') }; });
check(!cpuMode.engine && cpuMode.path === 'cpu' && /CPU/.test(cpuMode.info) && cpuMode.pref === 'cpu', `forcing the CPU engine uses the Canvas 2D / worker path (${cpuMode.info})`);
// GPU memory budget exceeded → CPU composite with a notice
const mem = await page.evaluate(async () => {
  const t = window.tintwork; t.setEnginePref('gpu'); t.newDocument(2000, 1500, 'white', 'budget'); t.engine.setBudget(8);
  const c = document.createElement('canvas'); t.composite(c); const px = c.getContext('2d').getImageData(5, 5, 1, 1).data;
  const msg = document.querySelector('#toast')?.textContent || ''; t.engine.setBudget(1536); return { msg, px: [...px] };
});
check(/memory|budget/i.test(mem.msg) && mem.px[0] === 255, `over the GPU memory budget the canvas is composited on the CPU with a notice ("${mem.msg.slice(0, 80)}…")`);
// a browser without WebGL2 → automatic CPU fallback
const noGl = await browser.newPage({ viewport: { width: 1200, height: 800 } });
noGl.on('pageerror', (e) => errors.push(`pageerror (no WebGL2): ${e.message}`));
await noGl.addInitScript(() => { const orig = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...a) { return type === 'webgl2' ? null : orig.call(this, type, ...a); }; localStorage.setItem('tintwork.engine', 'gpu'); });
await noGl.goto(url); await noGl.waitForFunction(() => !!window.tintwork);
const ng = await noGl.evaluate(async () => {
  const t = window.tintwork; t.newDocument(200, 100, 'white', 'nogl'); t.setDepth(16);
  t.openAdjust(t.ADJ.levels, { outWhite: 200 }); await new Promise((r) => setTimeout(r, 80)); document.querySelector('#modalOk').click(); await t.idle();
  return { engine: !!t.engine, reason: t.gfx.reason, toast: document.querySelector('#toast')?.textContent || '', px: t.compositePixel(10, 10), path: t.ops.lastOpPath() };
});
check(!ng.engine && /WebGL2/i.test(ng.reason) && ng.px[0] > 195 && ng.px[0] < 205 && ng.path === 'cpu', `without WebGL2 the app falls back to the CPU engine and still edits 16-bit (${ng.reason}; pixel ${ng.px[0]})`);
await noGl.close();
// leave the main page in automatic mode for later runs
await page.evaluate(() => window.tintwork.setEnginePref('auto'));
// blend-mode showcase screenshot on the GPU
await page.evaluate(async () => {
  const t = window.tintwork; t.setEnginePref('gpu'); t.newDocument(960, 540, 'white', 'GPU blend modes'); const d = t.doc, b = d.layers[0].canvas.getContext('2d');
  const g = b.createLinearGradient(0, 0, 960, 540); g.addColorStop(0, '#1d2b53'); g.addColorStop(0.5, '#7e2553'); g.addColorStop(1, '#ffa300'); b.fillStyle = g; b.fillRect(0, 0, 960, 540); t.touch(d.layers[0]);
  const names = ['multiply', 'screen', 'overlay', 'soft-light', 'difference', 'color', 'luminosity', 'color-dodge'];
  names.forEach((bl, i) => { const l = t.createLayer(bl, 200, 200, { blend: bl, x: 30 + (i % 4) * 230, y: 40 + Math.floor(i / 4) * 250 }); const c = l.canvas.getContext('2d'); const r = c.createRadialGradient(100, 100, 10, 100, 100, 100); r.addColorStop(0, '#29adff'); r.addColorStop(1, 'rgba(0,228,54,0)'); c.fillStyle = r; c.fillRect(0, 0, 200, 200); d.layers.push(l); t.touch(l); });
  t.commit('blend modes'); t.fitToScreen(); t.updateLayersPanel();
});
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shots, '4x-gpu-blend-modes.png') });
await page.evaluate(() => window.tintwork.setEnginePref('auto'));
} // end v0.5 section
await browser.close();
server.close();
if (errors.length) { console.error(`\n${errors.length} problem(s):\n` + errors.join('\n')); process.exit(1); }
console.log('\nAll smoke checks passed. Screenshots in', shots);
