// Windows-first desktop test (Chromium = Chrome / Edge engine): WebGPU engine in the app, File System Access
// Save / Save As / recent files / export, installable-PWA manifest, and the essential mouse items
// (stroke smoothing, [ ] size, Shift+[ ] hardness, wheel zoom, right-click menus).
// Headless Chromium only has SwiftShader (software WebGPU), whose canvas presentation is unusable, so the
// engine runs in its 'readback' output mode here; real GPUs present directly (mode 'canvas').
import { chromium } from 'playwright';
import { createStaticServer } from './serve.mjs';
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
// File pickers can't be driven headless: stand them in with origin-private file system handles (real
// FileSystemFileHandle objects: writable, clonable into IndexedDB, isSameEntry works).
await ctx.addInitScript(() => {
  window.__pick = { save: 0, open: 0, nextOpen: null, lastSave: null };
  window.showSaveFilePicker = async (o) => { __pick.save++; __pick.lastSave = o; const root = await navigator.storage.getDirectory(); return root.getFileHandle(o.suggestedName, { create: true }); };
  window.showOpenFilePicker = async () => { __pick.open++; const root = await navigator.storage.getDirectory(); return [await root.getFileHandle(__pick.nextOpen)]; };
});
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);

// --- WebGPU engine ------------------------------------------------------------------------------------------
const eng = await page.evaluate(async () => {
  const t = window.tintwork, r = { auto: t.engine?.kind || 'cpu', reason: t.gfx.webgpuReason || '' };
  const e = await t.setEnginePref('webgpu'); r.kind = e?.kind; r.present = e?.present; r.renderer = e?.info?.renderer;
  t.newDocument(320, 220, 'white', 'gpu-doc'); await t.compositeSettled(); r.docinfo = document.querySelector('#docinfo').textContent;
  return r;
});
check(eng.auto === 'cpu' && /software|slow/.test(eng.reason), `auto engine skips the software WebGPU adapter here (${eng.auto}: ${eng.reason})`);
check(eng.kind === 'webgpu' && ['canvas', 'readback'].includes(eng.present), `forced WebGPU engine starts (${eng.renderer}, output ${eng.present})`);
check(/WebGPU/.test(eng.docinfo), `status bar names the engine ("${eng.docinfo.trim().slice(0, 80)}")`);

const comp = await page.evaluate(async () => {
  const t = window.tintwork, d = t.doc, W = d.width, H = d.height;
  const paint = (l, f) => { const x = l.canvas.getContext('2d'); f(x); t.touch(l); };
  paint(d.layers[0], (x) => { const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#203060'); g.addColorStop(1, '#f0c080'); x.fillStyle = g; x.fillRect(0, 0, W, H); });
  const modes = ['multiply', 'screen', 'overlay', 'difference', 'color-dodge', 'hue'];
  modes.forEach((m, i) => { const l = t.createLayer(m, W, H, { blend: m, opacity: 0.8 }); paint(l, (x) => { x.fillStyle = `hsl(${i * 60},80%,55%)`; x.beginPath(); x.arc(40 + i * 45, 60 + (i % 2) * 70, 70, 0, 7); x.fill(); }); d.layers.push(l); });
  t.commit('layers'); t.updateLayersPanel();
  const pts = []; for (let y = 5; y < H; y += 23) for (let x = 7; x < W; x += 29) pts.push([x, y]);
  const gpu = []; for (const [x, y] of pts) gpu.push(await t.compositePixelAsync(x, y));
  const c = document.createElement('canvas'); t.composite(c, { cpu: true }); const cd = c.getContext('2d').getImageData(0, 0, W, H).data;
  let max = 0; pts.forEach(([x, y], i) => { for (let k = 0; k < 4; k++) max = Math.max(max, Math.abs(gpu[i][k] - cd[(y * W + x) * 4 + k])); });
  return { max, n: pts.length, path: t.gfx.path, frames: t.gfx.asyncFrames };
});
check(comp.path === 'gpu' && comp.max <= 3, `in-app WebGPU composite of 7 layers / 6 blend modes matches the CPU at ${comp.n} points (max diff ${comp.max}, async frames ${comp.frames})`);

const filt = await page.evaluate(async () => {
  const t = window.tintwork, W = 300, H = 200, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true });
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#102040'); g.addColorStop(0.5, '#e09050'); g.addColorStop(1, '#30f0b0'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  const img = () => x.getImageData(0, 0, W, H), info = { docW: W, docH: H, offX: 0, offY: 0 }, out = {};
  const cur = t.defaultAdjParams('curves'); cur.rgb = [[0, 0], [64, 110], [190, 200], [255, 255]];
  for (const [name, pr] of [['gaussianBlur', { radius: 25 }], ['curves', cur], ['hueSaturation', { hue: 30, saturation: 40, lightness: 0 }]]) {
    const a = await t.ops.process(name, img(), pr, info, null); const kind = t.ops.lastOpKind();
    out[name] = { kind, a };
  }
  // CPU reference: drop the accelerator for one call
  const acc = t.gfx.engine; t.ops.setAccelerator(null);
  const res = {};
  for (const name of Object.keys(out)) {
    const pr = name === 'gaussianBlur' ? { radius: 25 } : name === 'curves' ? cur : { hue: 30, saturation: 40, lightness: 0 };
    const b = await t.ops.process(name, img(), pr, info, null); const a = out[name].a.data;
    // blur: the CPU and GPU treat the image border slightly differently (clamped taps); compare the interior
    const m = name === 'gaussianBlur' ? 75 : 0; let max = 0, edge = 0;
    for (let i = 0; i < a.length; i++) { const px = (i >> 2) % W, py = Math.floor((i >> 2) / W), d = Math.abs(a[i] - b.data[i]); if (px < m || py < m || px >= W - m || py >= H - m) edge = Math.max(edge, d); else max = Math.max(max, d); }
    res[name] = `${out[name].kind} max ${max}${m ? ` (border ${edge})` : ''}`;
  }
  t.ops.setAccelerator(acc);
  return res;
});
for (const [k, v] of Object.entries(filt)) check(/^webgpu max [0-3]( \(border [0-9]\))?$/.test(v), `ops.process ${k} runs on WebGPU and matches the CPU (${v})`);

const dabs = await page.evaluate(async () => {
  const e = window.tintwork.engine, tc = document.createElement('canvas'); tc.width = 300; tc.height = 200; const x = tc.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 200);
  const n = 20, d = new Float32Array(n * 4), al = new Float32Array(n).fill(0.5); for (let i = 0; i < n; i++) d.set([50 + i * 10, 100, 40, 0.8], i * 4);
  await e.stampDabsAsync(tc, { x: 0, y: 0, w: 300, h: 200 }, d, al, { color: [255, 0, 0] });
  return { c: [...x.getImageData(150, 100, 1, 1).data], o: [...x.getImageData(150, 20, 1, 1).data] };
});
check(dabs.c[0] === 255 && dabs.c[1] < 30 && dabs.o.join() === '255,255,255,255', `WebGPU brush dabs: centre ${dabs.c.join(',')}, outside untouched`);

await page.evaluate(() => window.tintwork.openEngineDialog());
const engDlg = await page.evaluate(() => ({ opts: [...document.querySelectorAll('#modalBody input[type=radio]')].map((r) => r.value), info: document.querySelector('#engInfo')?.textContent || '' }));
check(engDlg.opts.includes('webgpu') && engDlg.opts.includes('auto') && /Active: WebGPU/.test(engDlg.info), `engine dialog offers ${engDlg.opts.join('/')} and reports "${engDlg.info.slice(0, 60)}…"`);
await page.screenshot({ path: 'screenshots/6x-engine-webgpu.png' });
await page.evaluate(() => window.tintwork.closeModal());

// --- mouse essentials -------------------------------------------------------------------------------------
const smooth = await page.evaluate(async () => {
  const t = window.tintwork, res = {};
  for (const sm of [0, 80]) {
    t.newDocument(320, 200, 'white', 'sm'); t.setTool('brush'); Object.assign(t.state.opts, { brushSize: 6, brushHardness: 100, brushOpacity: 100, smoothing: sm }); t.setFg('#000000');
    const pts = []; for (let i = 0; i <= 93; i++) pts.push({ x: 20 + i * 3, y: 100 + (i % 2 ? 9 : -9) });
    t.paintStroke(pts);
    const data = t.activeLayer().canvas.getContext('2d').getImageData(0, 0, 320, 200).data; let off = 0, on = 0;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) { const a = data[(y * 320 + x) * 4]; if (a < 128) { on++; if (Math.abs(y - 100) > 6) off++; } }
    res[sm] = { off, on };
  }
  t.state.opts.smoothing = 0; return res;
});
check(smooth[0].off > 200 && smooth[80].off < smooth[0].off / 5 && smooth[80].on > 300, `stroke smoothing removes mouse jitter (pixels >6px off the line: ${smooth[0].off} → ${smooth[80].off})`);

await page.evaluate(() => { const t = window.tintwork; t.newDocument(400, 300, 'white', 'keys'); t.setTool('brush'); t.state.opts.brushSize = 24; t.state.opts.brushHardness = 70; document.activeElement?.blur(); });
await page.mouse.move(700, 450);
await page.keyboard.press('BracketRight'); const s1 = await page.evaluate(() => window.tintwork.state.opts.brushSize);
await page.keyboard.press('BracketLeft'); await page.keyboard.press('BracketLeft'); const s2 = await page.evaluate(() => window.tintwork.state.opts.brushSize);
await page.keyboard.press('Shift+BracketLeft'); const h1 = await page.evaluate(() => window.tintwork.state.opts.brushHardness);
await page.keyboard.press('Shift+BracketRight'); await page.keyboard.press('Shift+BracketRight'); const h2 = await page.evaluate(() => window.tintwork.state.opts.brushHardness);
check(s1 > 24 && s2 < s1 && s2 < 24, `[ / ] change brush size (24 → ${s1} → ${s2})`);
check(h1 === 60 && h2 === 80, `Shift+[ / Shift+] change hardness by 10 (70 → ${h1} → ${h2})`);

const z0 = await page.evaluate(() => window.tintwork.zoom);
const vb = await page.locator('#view').boundingBox();
await page.mouse.move(vb.x + vb.width / 2 + 40, vb.y + vb.height / 2 + 30); await page.mouse.wheel(0, -240); await page.waitForTimeout(100);
const z1 = await page.evaluate(() => window.tintwork.zoom);
check(z1 > z0, `mouse wheel zooms at the cursor (${z0.toFixed(2)} → ${z1.toFixed(2)})`);
await page.evaluate(() => window.tintwork.run('zoomFit'));

// right-click menus
const n0 = await page.evaluate(() => window.tintwork.doc.layers.length);

await page.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2, { button: 'right' });
const cm = await page.evaluate(() => { const m = document.querySelector('#ctxMenu'); return m && { items: [...m.querySelectorAll('button')].map((b) => b.textContent), focus: document.activeElement?.closest('#ctxMenu') != null }; });
check(!!cm && cm.items.some((s) => s.startsWith('Undo') && s.includes('Ctrl+Z')) && cm.items.some((s) => s.startsWith('New layer')), `right-click on the canvas opens a context menu (${cm ? cm.items.length : 0} items, "${cm?.items[0]}")`);
const docN = await page.evaluate(() => window.tintwork.doc.layers.length);
check(docN === n0, 'right-click does not paint or change the document');
await page.screenshot({ path: 'screenshots/6x-context-menu.png' });
await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
check(await page.evaluate(() => !document.querySelector('#ctxMenu')), 'Escape closes the context menu');
await page.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2, { button: 'right' });
await page.click('#ctxMenu button[data-item="layerNew"]');
check(await page.evaluate(() => window.tintwork.doc.layers.length) === n0 + 1, 'context menu "New layer" adds a layer');
await page.click('#layerList li[data-id]', { button: 'right' });
const lm = await page.evaluate(() => [...document.querySelectorAll('#ctxMenu button')].map((b) => b.textContent));
check(lm.some((s) => s.startsWith('Duplicate layer')) && lm.includes('Rename…'), `right-click on a layer opens the layer menu (${lm.length} items)`);
await page.click('#ctxMenu button[data-item="Rename…"]'); await page.fill('#renameInput', 'Renamed via menu'); await page.click('#modalOk');
check(await page.evaluate(() => window.tintwork.activeLayer().name) === 'Renamed via menu', 'layer menu Rename… renames the layer');
await page.mouse.click(vb.x + 10, vb.y + 10, { button: 'right' }); await page.mouse.click(vb.x + 300, vb.y + 300);
check(await page.evaluate(() => !document.querySelector('#ctxMenu')), 'clicking elsewhere closes the menu');

// --- File System Access: Save / Save As / recent / export --------------------------------------------------
await page.evaluate(() => { const t = window.tintwork; t.newDocument(200, 150, 'white', 'Holiday'); });
const P = () => page.evaluate(() => ({ ...window.__pick, kind: window.tintwork.doc.fileKind, name: window.tintwork.doc.name, title: document.title }));
await page.keyboard.press('Control+KeyS'); await page.waitForFunction(() => window.tintwork.doc.fileKind === 'project', null, { timeout: 5000 }).catch(() => {});
let p = await P();
check(p.save === 1 && p.lastSave?.suggestedName === 'Holiday.tintwork' && p.kind === 'project', `Ctrl+S on a new document goes through Save As (suggested "${p.lastSave?.suggestedName}")`);
const readOPFS = (name) => page.evaluate(async (n) => { const root = await navigator.storage.getDirectory(); const f = await (await root.getFileHandle(n)).getFile(); return { size: f.size, text: (await f.text()).slice(0, 2000) }; }, name);
let f = await readOPFS('Holiday.tintwork');
check(f.size > 100 && /"layers"/.test(f.text), `project written to the chosen file (${f.size} bytes)`);
check(!/•/.test(p.title) && /Holiday/.test(p.title), `window title after save: "${p.title}"`);
await page.evaluate(() => window.tintwork.run('layerNew'));
check(/•/.test(await page.evaluate(() => document.title)), 'title marks unsaved changes with •');
await page.keyboard.press('Control+KeyS'); await page.waitForTimeout(400);
p = await P(); const f2 = await readOPFS('Holiday.tintwork');
check(p.save === 1 && f2.size !== f.size && !/•/.test(p.title), `second Ctrl+S writes in place without a picker (pickers ${p.save}, ${f.size} → ${f2.size} bytes)`);
await page.keyboard.press('Control+Shift+KeyS'); await page.waitForTimeout(400);
p = await P(); check(p.save === 2, 'Ctrl+Shift+S always asks where to save');
// export via the save picker
await page.evaluate(() => window.tintwork.exportImage('image/png', 1, 'Holiday'));
p = await P(); const png = await readOPFS('Holiday.png');
check(p.save === 3 && png.size > 100 && png.text.startsWith('\u0089PNG') || png.text.slice(1, 4) === 'PNG', `export writes Holiday.png through the save picker (${png.size} bytes)`);
// open an image from disk, then Save must not overwrite it
await page.evaluate(() => { window.__pick.nextOpen = 'Holiday.png'; return window.tintwork.run('open'); });
await page.waitForFunction(() => window.tintwork.doc?.fileKind === 'image', null, { timeout: 5000 }).catch(() => {});
p = await P(); check(p.open === 1 && p.kind === 'image' && /Holiday/.test(p.name), `File ▸ Open uses the open picker (${p.name}, ${p.kind})`);
await page.keyboard.press('Control+KeyS'); await page.waitForTimeout(400);
p = await P(); check(p.save === 4 && /\.tintwork$/.test(p.lastSave.suggestedName), `Ctrl+S on an opened image asks for a project name ("${p.lastSave.suggestedName}") instead of overwriting the PNG`);
// recent files
await page.evaluate(() => window.tintwork.newDocument(64, 64, 'white', 'Scratch'));
await page.evaluate(() => window.tintwork.run('openRecent')); await page.waitForSelector('#recentList');
const rec = await page.evaluate(() => [...document.querySelectorAll('#recentList .recent-open b')].map((b) => b.textContent));
check(rec.length >= 2 && rec.includes('Holiday.tintwork') && rec.includes('Holiday.png') && new Set(rec).size === rec.length, `Open recent lists ${rec.join(', ')} (no duplicates)`);
await page.screenshot({ path: 'screenshots/6x-open-recent.png' });
await page.click('#recentList .recent-open:has(b:text-is("Holiday.tintwork"))');
await page.waitForFunction(() => window.tintwork.doc?.name === 'Holiday.tintwork' && window.tintwork.doc.fileKind === 'project', null, { timeout: 5000 }).catch(() => {});
p = await P(); check(p.kind === 'project' && p.name === 'Holiday.tintwork', `opening from the recent list restores the project (${p.name})`);

// --- v0.6 core tools: gradient, shapes, dodge / burn, red eye ------------------------------------------------
await page.evaluate(() => window.tintwork.setEnginePref('cpu'));
const grad = await page.evaluate(() => {
  const t = window.tintwork, r = {};
  t.newDocument(256, 20, 'white', 'grad'); t.setFg('#000000'); t.state.bg = '#ffffff'; Object.assign(t.state.opts, { gradType: 'linear', gradColors: 'fg-bg', gradReverse: false, gradOpacity: 100 });
  t.applyGradient({ x: 0, y: 10 }, { x: 256, y: 10 });
  const row = t.activeLayer().canvas.getContext('2d').getImageData(0, 10, 256, 1).data; r.mid = row[128 * 4]; r.ends = [row[0], row[255 * 4]];
  let mono = 0; for (let x = 8; x < 256; x += 8) if (row[x * 4] < row[(x - 8) * 4]) mono++; r.nonMono = mono;
  // radial
  t.newDocument(200, 200, 'white', 'radial'); t.state.opts.gradType = 'radial'; t.setFg('#ff0000'); t.state.bg = '#0000ff';
  t.applyGradient({ x: 100, y: 100 }, { x: 200, y: 100 });
  const px = (x, y) => [...t.activeLayer().canvas.getContext('2d').getImageData(x, y, 1, 1).data];
  r.centre = px(100, 100); r.corner = px(2, 2);
  // selection limits the gradient
  t.newDocument(200, 100, 'white', 'sel'); t.state.opts.gradType = 'linear'; t.setFg('#000000'); t.state.bg = '#000000';
  t.setSelection(t.makeSelection(200, 100, t.rectMask(200, 100, { x: 0, y: 0, w: 100, h: 100 })), 'sel');
  t.applyGradient({ x: 0, y: 0 }, { x: 200, y: 0 }); r.inSel = px(50, 50)[0]; r.outSel = px(150, 50)[0];
  // gradient on a layer mask
  t.newDocument(200, 50, 'white', 'mask'); t.run('layerNew'); const l = t.activeLayer(); l.canvas.getContext('2d').fillRect(0, 0, 200, 50); t.touch(l);
  t.run('addMask'); l.editMask = true; t.setFg('#000000'); t.state.bg = '#ffffff';
  t.applyGradient({ x: 0, y: 0 }, { x: 200, y: 0 });
  const m = l.mask.canvas.getContext('2d').getImageData(0, 25, 200, 1).data; r.mask = [m[3], m[100 * 4 + 3], m[199 * 4 + 3]];
  return r;
});
check(Math.abs(grad.mid - 128) <= 2 && grad.ends[0] <= 2 && grad.ends[1] >= 253 && grad.nonMono === 0, `linear gradient black → white (ends ${grad.ends.join('/')}, middle ${grad.mid}, monotonic)`);
check(grad.centre[0] > 250 && grad.centre[2] < 5 && grad.corner[2] > 250 && grad.corner[0] < 5, `radial gradient: centre ${grad.centre.slice(0, 3)}, corner ${grad.corner.slice(0, 3)}`);
check(grad.inSel < 10 && grad.outSel === 255, `gradient stays inside the selection (inside ${grad.inSel}, outside ${grad.outSel})`);
check(grad.mask[0] < 5 && Math.abs(grad.mask[1] - 128) < 4 && grad.mask[2] > 250, `gradient on a layer mask ramps hide → reveal (${grad.mask.join(', ')})`);

const deepGrad = await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(4000, 4, 'white', 'deep'); t.setDepth(16);
  t.setFg('#404040'); t.state.bg = '#505050'; Object.assign(t.state.opts, { gradType: 'linear', gradColors: 'fg-bg' });
  t.applyGradient({ x: 0, y: 0 }, { x: 4000, y: 0 });
  const l = t.activeLayer(), d = t.deepOf(l), v16 = new Set(), v8 = new Set(), c8 = l.canvas.getContext('2d').getImageData(0, 1, 4000, 1).data;
  for (let x = 0; x < 4000; x++) { v16.add(d.data[(1 * 4000 + x) * 4]); v8.add(c8[x * 4]); }
  return { depth: t.doc.depth, v16: v16.size, v8: v8.size };
});
check(deepGrad.depth === 16 && deepGrad.v16 > 1000, `16-bit gradient keeps ${deepGrad.v16} distinct levels across a 16-step 8-bit range (8-bit proxy: ${deepGrad.v8})`);

await page.evaluate(() => { const t = window.tintwork; t.newDocument(600, 400, 'white', 'Shapes'); t.setFg('#2a7de1'); t.state.bg = '#ffffff'; t.run('zoomFit'); });
await page.keyboard.press('KeyU');
const sb = await page.locator('#view').boundingBox();
const toScreen = (x, y) => page.evaluate(([x, y]) => { const t = window.tintwork, v = document.querySelector('#view').getBoundingClientRect(); return [v.left + t.state.panX + x * t.zoom, v.top + t.state.panY + y * t.zoom]; }, [x, y]);
const n1 = await page.evaluate(() => window.tintwork.doc.layers.length);
let [sx, sy] = await toScreen(50, 50); let [ex, ey] = await toScreen(250, 200);
await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 3 }); await page.mouse.move(ex, ey, { steps: 3 }); await page.mouse.up();
const shp = await page.evaluate(() => { const t = window.tintwork, l = t.activeLayer(), x = l.canvas.getContext('2d'); return { dims: [t.doc.width, t.doc.height, l.canvas.width, t.history.entries.map((e) => e.label).join('|')], tool: t.state.tool, n: t.doc.layers.length, name: l.name, inside: [...x.getImageData(150, 125, 1, 1).data], outside: [...x.getImageData(400, 300, 1, 1).data] }; });
check(shp.tool === 'shape' && shp.n === n1 + 1 && shp.name === 'Rectangle' && shp.inside.join() === '42,125,225,255' && shp.outside[3] === 0, `U + drag draws a rectangle on a new layer (${shp.dims}, ${shp.name}, inside ${shp.inside}, outside alpha ${shp.outside[3]})`);
await page.evaluate(() => { const t = window.tintwork; t.state.opts.shapeKind = 'ellipse'; t.state.opts.shapeStyle = 'both'; t.state.opts.shapeStroke = 10; t.setFg('#e8553a'); t.state.bg = '#222222'; t.setTool('shape'); });
[sx, sy] = await toScreen(420, 200); [ex, ey] = await toScreen(520, 260);
await page.keyboard.down('Shift'); await page.keyboard.down('Control');
await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(ex, ey, { steps: 4 });
await page.screenshot({ path: 'screenshots/6x-shape-preview.png' });
await page.mouse.up(); await page.keyboard.up('Control'); await page.keyboard.up('Shift');
const ell = await page.evaluate(() => { const t = window.tintwork, x = t.activeLayer().canvas.getContext('2d'), g = (a, b) => [...x.getImageData(a, b, 1, 1).data]; return { dims: [t.doc.width, t.doc.height, t.history.entries.map((e) => e.label).join('|')], n: t.doc.layers.length, tool: t.state.tool, name: t.activeLayer().name, c: g(420, 200), top: g(420, 200 - 100), left: g(320, 200), side: g(420 + 98, 200), corner: g(420 + 90, 200 + 90) }; });
check(ell.name === 'Ellipse' && ell.c.join() === '232,85,58,255' && ell.top[0] === 34 && ell.left[0] === 34 && ell.corner[3] === 0, `Shift+Ctrl drag: circle from the centre with fill + stroke (${ell.dims} ${ell.name}, ${ell.n}, ${ell.tool}; centre ${ell.c.slice(0, 3)}, rim ${ell.top.slice(0, 3)}, outside alpha ${ell.corner[3]})`);
await page.evaluate(() => { const t = window.tintwork; t.state.opts.shapeKind = 'line'; t.state.opts.shapeStroke = 6; t.setFg('#000000'); t.addShapeLayer(t.shapeGeom({ a: { x: 20, y: 380 }, b: { x: 580, y: 300 }, mods: { square: true } })); });
const ln = await page.evaluate(() => { const t = window.tintwork, x = t.activeLayer().canvas.getContext('2d'); const dd = x.getImageData(0, 0, 600, 400).data; let n = 0; for (let i = 3; i < dd.length; i += 4) if (dd[i]) n++; return { n, w: t.activeLayer().canvas.width, cls: t.activeLayer().canvas.constructor.name, layers: t.doc.layers.map((q) => q.name + ':' + q.id).join(','), act: t.doc.activeId, name: t.activeLayer().name, on: x.getImageData(300, 380, 1, 1).data[3], off: x.getImageData(300, 340, 1, 1).data[3] }; });
check(ln.name === 'Line' && ln.on === 255 && ln.off === 0, `Shift snaps a line to 0/45/90° (${JSON.stringify(ln)})`);

// gradient through the UI (G, drag) for the screenshot
await page.evaluate(() => { const t = window.tintwork; t.doc.activeId = t.doc.layers[0].id; t.updateLayersPanel(); t.setFg('#1d2b53'); t.state.bg = '#ffd27a'; t.state.opts.gradType = 'linear'; t.state.opts.shapeKind = 'rect'; t.state.opts.shapeStyle = 'fill'; });
await page.keyboard.press('KeyG');
[sx, sy] = await toScreen(0, 0); [ex, ey] = await toScreen(0, 400);
await page.mouse.move(sx + 5, sy + 2); await page.mouse.down(); await page.mouse.move(ex + 5, ey - 2, { steps: 5 }); await page.mouse.up();
const gUI = await page.evaluate(() => { const t = window.tintwork, x = t.doc.layers[0].canvas.getContext('2d'); return { tool: t.state.tool, top: [...x.getImageData(300, 2, 1, 1).data], bottom: [...x.getImageData(300, 397, 1, 1).data], hist: t.history.entries[t.history.index].label }; });
check(gUI.tool === 'gradient' && gUI.top[2] > 70 && gUI.bottom[0] > 240 && gUI.hist === 'Gradient', `G + drag fills the background with a gradient (top ${gUI.top.slice(0, 3)}, bottom ${gUI.bottom.slice(0, 3)})`);
await page.evaluate(() => window.tintwork.compositeSettled());
await page.screenshot({ path: 'screenshots/6x-gradient-shapes.png' });
await page.keyboard.press('KeyG'); const gk = await page.evaluate(() => window.tintwork.state.tool);
await page.keyboard.press('KeyG'); const gk2 = await page.evaluate(() => window.tintwork.state.tool);
await page.keyboard.press('KeyM'); await page.keyboard.press('KeyO'); const ok1 = await page.evaluate(() => window.tintwork.state.tool);
await page.keyboard.press('KeyO'); const ok2 = await page.evaluate(() => window.tintwork.state.tool);
check(gk === 'fill' && gk2 === 'gradient' && ok1 === 'ellipse' && ok2 === 'tone', `shared tool keys cycle (G: gradient → ${gk} → ${gk2}; O: ${ok1} → ${ok2})`);

const tone = await page.evaluate(() => {
  const t = window.tintwork, r = {};
  for (const [mode, range] of [['dodge', 'midtones'], ['burn', 'midtones'], ['dodge', 'highlights']]) {
    t.newDocument(300, 100, 'white', 'tone'); const x = t.activeLayer().canvas.getContext('2d'); x.fillStyle = '#404040'; x.fillRect(0, 0, 300, 100); t.touch(t.activeLayer());
    t.setTool('tone'); Object.assign(t.state.opts, { toneMode: mode, toneRange: range, toneSize: 40, toneHardness: 100, toneOpacity: 50, smoothing: 0 });
    t.paintStroke([{ x: 20, y: 50 }, { x: 150, y: 50 }, { x: 280, y: 50 }], { tool: 'tone' });
    r[mode + '-' + range] = { on: x.getImageData(150, 50, 1, 1).data[0], off: x.getImageData(150, 5, 1, 1).data[0], label: t.history.entries[t.history.index].label };
  }
  return r;
});
const dm = tone['dodge-midtones'], bm = tone['burn-midtones'], dh = tone['dodge-highlights'];
check(dm.on > 80 && dm.off === 64 && dm.label === 'Dodge', `dodge lightens under the stroke only (64 → ${dm.on}; outside ${dm.off})`);
check(bm.on < 50 && bm.label === 'Burn', `burn darkens (64 → ${bm.on})`);
check(dh.on > 64 && dh.on < dm.on, `dodge on highlights barely touches dark tones (64 → ${dh.on}, midtones ${dm.on})`);

const red = await page.evaluate(() => {
  const t = window.tintwork; t.newDocument(200, 200, 'white', 'eye');
  const x = t.activeLayer().canvas.getContext('2d'); x.fillStyle = 'rgb(220,170,140)'; x.fillRect(0, 0, 200, 200);
  x.fillStyle = 'rgb(200,30,30)'; x.beginPath(); x.arc(100, 100, 12, 0, 7); x.fill(); t.touch(t.activeLayer());
  t.state.opts.redeyeSize = 40; const n = t.redEyeAt({ x: 101, y: 99 });
  const g = (a, b) => [...x.getImageData(a, b, 1, 1).data];
  return { n, pupil: g(100, 100), skin: g(100, 85), far: g(20, 20), label: t.history.entries[t.history.index].label };
});
check(red.n > 300 && red.pupil[0] < 40 && red.skin.join() === '220,170,140,255' && red.label === 'Red eye', `red eye: pupil ${red.pupil.slice(0, 3)} (was 200,30,30), skin next to it unchanged, ${red.n} px fixed`);
await page.evaluate(() => window.tintwork.setEnginePref('webgpu'));

// --- installable app ------------------------------------------------------------------------------------
const man = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
const acc = (man.file_handlers || []).flatMap((h) => Object.values(h.accept).flat());
check((man.display_override || [])[0] === 'window-controls-overlay', `manifest display_override: ${JSON.stringify(man.display_override)}`);
check(['.png', '.jpg', '.tintwork'].every((x) => acc.includes(x)), `manifest file_handlers accept ${acc.join(' ')}`);
check((man.shortcuts || []).length >= 3, `manifest shortcuts: ${(man.shortcuts || []).map((s) => s.name).join(', ')}`);
const sw = await page.evaluate(async () => (await fetch('sw.js')).text());
check(sw.includes('./src/webgpu.js') && sw.includes('./src/files.js'), 'service worker caches the WebGPU engine and file modules');
const p2 = await ctx.newPage(); await p2.goto(`${base}?platform=win&action=new`); await p2.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await p2.waitForTimeout(300);
check(await p2.evaluate(() => !document.querySelector('#modal').classList.contains('hidden') && /new/i.test(document.querySelector('#modalTitle').textContent)), 'app shortcut ?action=new opens the New dialog');
await p2.close();

const fin = await page.evaluate(async () => { const t = window.tintwork; await t.compositeSettled(); return { kind: t.engine?.kind, failed: !!t.gfx.asyncFailed, err: t.engine?.lastError?.message || '' }; });
check(fin.kind === 'webgpu' && !fin.failed, `WebGPU composite path still healthy after the file round-trips (${fin.kind}${fin.err ? ', ' + fin.err : ''})`);
check(!errors.length, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
await browser.close(); server.close();
console.log(fails ? `\n${fails} Windows/Chromium check(s) FAILED` : '\nAll Windows/Chromium checks passed.');
process.exit(fails ? 1 : 0);
