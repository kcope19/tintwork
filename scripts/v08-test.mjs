// v0.8 test: pass-through groups with opacity / mask on every engine (vs CPU), 16-bit groups / styles / warp,
// multi-layer selection (move, align, distribute, group, delete, transform), white balance (op, auto, eyedropper,
// adjustment layer on GPU), auto enhance, auto straighten (Hough), looks (apply, intensity, save, import/export),
// .cube 3D LUTs, and project round-trip of the new layer data. Screenshots are written as screenshots/8x-*.png.
import { chromium } from 'playwright';
import { createStaticServer } from './serve.mjs';
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const near = (a, b, tol = 3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

// --- pass-through groups with opacity / mask, and white balance, on every engine -------------------------
const ref = {};
for (const eng of ['cpu', 'gpu', 'webgpu']) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript((e) => localStorage.setItem('tintwork.engine', e), eng);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  const r = await page.evaluate(async () => {
    const t = window.tintwork; await t.gfx.ready;
    const out = { engine: t.gfx.engine ? (t.gfx.engine.kind || 'webgl') : 'cpu' };
    const px = async (x, y) => [...(await t.compositePixelAsync(x, y))].slice(0, 3);
    t.newDocument(200, 100, 'white'); const d = t.state.doc;
    const bg = t.activeLayer(), c = bg.canvas.getContext('2d'); c.fillStyle = '#c86432'; c.fillRect(0, 0, 200, 100); t.touch(bg);
    // pass-through group: an invert adjustment + a half-transparent blue square inside it
    const g = t.applyLook({ id: 'x', name: 'Test', layers: [{ type: 'invert', params: {} }] }, 100);
    t.run('layerNew'); const sq = t.activeLayer(); sq.parent = g.id; t.normalizeTree(d);
    const sc = sq.canvas.getContext('2d'); sc.fillStyle = '#0000ff'; sc.fillRect(100, 0, 100, 100); sq.opacity = 0.5; t.touch(sq);
    out.full = [await px(50, 50), await px(150, 50)];
    g.opacity = 0.4; t.touch(g); out.half = [await px(50, 50), await px(150, 50)];
    d.activeId = g.id; t.run('addMask'); const m = g.mask.canvas.getContext('2d'); m.clearRect(0, 0, 50, 100); t.touch(g); g.mask.rev = (g.mask.rev || 0) + 1000;
    out.masked = [await px(25, 50), await px(75, 50), await px(150, 50)];
    out.items = t.gpuLayerList ? t.gpuLayerList(d).filter((i) => i.marker || i.type).length : 0;
    g.mask = null; g.visible = false; t.touch(g); d.activeId = bg.id;
    // white balance adjustment layer
    const wb = t.addAdj('whiteBalance', { temperature: 40, tint: -20 }, 'WB'); out.wb = await px(50, 50);
    return out;
  });
  ref[eng] = r;
  if (eng === 'cpu') {
    const [a, b] = r.full;
    check(near(a, [55, 155, 205]) , `pass-through group at 100% inverts the backdrop (${a})`);
    check(Math.abs(r.half[0][0] - Math.round(200 * 0.6 + 55 * 0.4)) <= 3, `pass-through at 40% opacity blends with the backdrop (${r.half[0]})`);
    check(near(r.masked[0], [200, 100, 50]) && near(r.masked[1], r.half[0]), `pass-through mask hides the group where black (${r.masked[0]} / ${r.masked[1]})`);
    check(r.wb[0] > 200 && r.wb[2] < 50 && r.wb.join() !== '200,100,50', `white balance warms the picture (${r.wb})`);
  } else {
    const c = ref.cpu, ok = ['full', 'half', 'masked'].every((k) => c[k].every((p, i) => near(p, r[k][i], 4)));
    check(ok, `[${eng} → ${r.engine}] pass-through opacity / mask match the CPU reference (${JSON.stringify(r.masked)})`);
    check(near(c.wb, r.wb, 3), `[${eng} → ${r.engine}] white balance matches the CPU (${r.wb} vs ${c.wb})`);
  }
  check(!errors.length, `[${eng}] no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// --- everything else on the default (CPU in headless) engine --------------------------------------------
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => { localStorage.setItem('tintwork.engine', 'cpu'); localStorage.setItem('tintwork.looksOpen', '1'); });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');

// 16-bit: groups, styles, warp keep 16-bit values
const deep = await page.evaluate(async () => {
  const t = window.tintwork, out = {};
  t.newDocument(200, 100, 'white'); t.setDepth(16);
  const D = t.createDeep(200, 100);
  for (let i = 0; i < D.data.length; i += 4) { const x = (i / 4) % 200; D.data[i] = D.data[i + 1] = D.data[i + 2] = 20000 + x * 3; D.data[i + 3] = 65535; }
  t.setDeep(t.activeLayer(), D); t.commit('deep');
  const row = (acc) => Array.from({ length: 100 }, (_, k) => acc.data[(50 * 200 + 50 + k) * 4]);
  const stats = (r) => ({ distinct: new Set(r).size, off257: r.filter((v) => v % 257).length });
  const L = t.activeLayer();
  t.run('groupLayers'); const g = t.activeLayer(); g.blend = 'normal'; g.opacity = 0.9; t.touch(g); t.commit('g');
  out.group = stats(row(t.compositeDeepDoc()));
  L.styles = [t.defaultEffect('stroke')]; L.styles[0].size = 2; t.touch(L);
  out.style = stats(row(t.compositeDeepDoc()));
  g.opacity = 1; t.touch(g); L.styles = null; t.touch(L);
  t.state.doc.activeId = L.id; t.startMeshXf('warp'); const x = t.state.mxf; if (x && x.pts) { x.pts[5][0] += 6; x.pts[6][0] += 6; } t.applyMeshXf();
  const L2 = t.activeLayer(); out.warp = { ...stats(row(t.deepOf(L2))), synced: L2.deepRev === L2.rev };
  return out;
});
check(deep.group.off257 > 80, `16-bit group with opacity composites in float (${deep.group.off257}/100 values between 8-bit levels)`);
check(deep.style.off257 > 80, `16-bit styled layer keeps 16-bit body (${deep.style.off257}/100)`);
check(deep.warp.synced && deep.warp.off257 > 60, `16-bit warp keeps 16-bit values (${deep.warp.off257}/100, ${deep.warp.distinct} distinct)`);

// multi-layer selection
const multi = await page.evaluate(() => {
  const t = window.tintwork, out = {};
  t.newDocument(400, 200, 'white'); const d = t.state.doc, ids = [];
  for (const [x, w, col] of [[10, 40, '#f00'], [120, 60, '#0f0'], [300, 30, '#00f']]) {
    t.run('layerNew'); const l = t.activeLayer(); const c = l.canvas.getContext('2d'); c.fillStyle = col; c.fillRect(x, 20 + ids.length * 40, w, 30); t.touch(l); ids.push(l.id);
  }
  t.pickLayer(ids); out.picked = t.pickedLayers().length;
  t.alignLayers('top'); out.tops = ids.map((id) => t.layerBounds(id).y);
  t.alignLayers('distH'); const b = ids.map((id) => t.layerBounds(id)); const cx = b.map((q) => q.x + q.w / 2); out.gaps = [cx[1] - cx[0], cx[2] - cx[1]];
  t.pickLayer(ids); t.startTransform(); out.multiXf = !!(t.state.xf && t.state.xf.parts && t.state.xf.parts.length === 3);
  if (out.multiXf) { const x = t.state.xf; x.tx = (x.tx || 0) + 10; t.previewTransform && t.previewTransform(); t.applyTransform(); }
  out.afterXf = ids.map((id) => t.layerBounds(id).x);
  t.pickLayer(ids.slice(0, 2)); t.run('groupLayers'); const g = t.activeLayer(); out.grouped = t.isGroup(g) && ids.slice(0, 2).every((id) => t.layerById(d, id).parent === g.id);
  d.activeId = g.id; t.startTransform(); out.groupXf = !!(t.state.xf && t.state.xf.parts); t.cancelTransform();
  t.pickLayer([g.id, ids[2]]); const n0 = d.layers.length; t.run('layerDelete'); out.deleted = n0 - d.layers.length;
  t.undo(); out.undone = d.layers.length === n0 || t.state.doc.layers.length === n0;
  return out;
});
check(multi.picked === 3, 'Ctrl/Shift-click picks several layers');
check(multi.tops.every((y) => y === multi.tops[0]), `align top edges (${multi.tops})`);
check(Math.abs(multi.gaps[0] - multi.gaps[1]) <= 1, `distribute horizontally evens the centre spacing (${multi.gaps})`);
check(multi.multiXf, `free transform on several layers (x after: ${multi.afterXf})`);
check(multi.grouped && multi.groupXf, 'group the picked layers; free transform on a group');
check(multi.deleted >= 4 && multi.undone, `delete several layers at once (${multi.deleted} removed) and undo`);

// auto tools
const autos = await page.evaluate(() => {
  const t = window.tintwork, out = {};
  // blue-tinted, low-contrast scene
  t.newDocument(300, 200, 'white'); const l = t.activeLayer(), c = l.canvas.getContext('2d');
  const gr = c.createLinearGradient(0, 0, 300, 0); gr.addColorStop(0, '#5a6a8c'); gr.addColorStop(1, '#a0b0d0'); c.fillStyle = gr; c.fillRect(0, 0, 300, 200); t.touch(l); t.commit('scene');
  const mean = () => { const { img } = t.analysisImage(100); let r = 0, b = 0, n = 0; for (let i = 0; i < img.data.length; i += 4) { r += img.data[i]; b += img.data[i + 2]; n++; } return [r / n, b / n]; };
  out.before = mean(); out.wb = t.autoWhiteBalanceCmd(); out.after = mean();
  const wbLayer = t.activeLayer(); out.wbLayer = wbLayer.kind === 'adjust' && wbLayer.adj.type === 'whiteBalance';
  t.undo(); const e = t.autoEnhanceCmd(); out.enhance = e; const g = t.activeLayer(); out.enhGroup = t.isGroup(g) && t.childrenOf(t.state.doc, g.id).length;
  t.undo();
  out.pick = t.wbPickAt({ x: 150, y: 100 }); out.pickAfter = (() => { const { img } = t.analysisImage(300); const i = (100 * img.width + 150) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; })();
  // tilted horizon → auto straighten
  t.newDocument(600, 400, 'white'); const h = t.activeLayer(), hc = h.canvas.getContext('2d');
  hc.fillStyle = '#7ab'; hc.fillRect(0, 0, 600, 400); hc.save(); hc.translate(300, 200); hc.rotate(5 * Math.PI / 180); hc.fillStyle = '#354'; hc.fillRect(-500, 0, 1000, 400); hc.restore(); t.touch(h); t.commit('tilted');
  out.tilt = t.detectTilt(); const r = t.autoStraightenCmd(); out.after2 = t.detectTilt(); out.size = [t.state.doc.width, t.state.doc.height];
  return out;
});
check(autos.wb && autos.wb.temperature > 5 && autos.wbLayer, `auto white balance adds a warming layer (temp ${autos.wb?.temperature}, tint ${autos.wb?.tint})`);
check(Math.abs(autos.after[0] - autos.after[1]) < Math.abs(autos.before[0] - autos.before[1]) / 2, `auto white balance neutralises the cast (R−B ${Math.round(autos.before[0] - autos.before[1])} → ${Math.round(autos.after[0] - autos.after[1])})`);
check(autos.enhance && autos.enhGroup >= 2, `auto enhance adds an editable group (${autos.enhance?.steps})`);
check(autos.pick && Math.max(...autos.pickAfter) - Math.min(...autos.pickAfter) <= 6, `white balance eyedropper makes the clicked spot neutral (${autos.pickAfter})`);
check(Math.abs(autos.tilt.angle - 5) < 0.5, `Hough detects a 5° tilt (${autos.tilt.angle}°, confidence ${autos.tilt.confidence})`);
check(Math.abs(autos.after2.angle) < 0.5 && autos.size[0] < 600 && autos.size[0] / autos.size[1] > 1.45, `auto straighten levels and crops (${autos.after2.angle}° left, ${autos.size})`);

// looks + LUT + round-trip
const looks = await page.evaluate(async () => {
  const t = window.tintwork, out = {};
  t.newDocument(300, 200, 'white'); const l = t.activeLayer(), c = l.canvas.getContext('2d');
  const gr = c.createLinearGradient(0, 0, 300, 0); gr.addColorStop(0, '#203040'); gr.addColorStop(0.5, '#c08060'); gr.addColorStop(1, '#f0f0e0'); c.fillStyle = gr; c.fillRect(0, 0, 300, 200); t.touch(l); t.commit('img');
  out.count = t.allLooks().filter((x) => !x.user).length;
  const px = async () => [...(await t.compositePixelAsync(150, 100))].slice(0, 3);
  const base = await px(); const changed = [];
  for (const look of t.allLooks().filter((x) => !x.user)) { const g = t.applyLook(look.id, 100); const p = await px(); changed.push(p.some((v, i) => Math.abs(v - base[i]) > 3)); t.undo(); }
  out.allChange = changed.every(Boolean);
  const g = t.applyLook('teal-amber', 100); const full = await px();
  t.state.doc.activeId = g.id; t.setLookIntensity(30, true); const p30 = await px();
  out.intensity = { opacity: g.opacity, between: p30.every((v, i) => Math.abs(v - base[i]) <= Math.abs(full[i] - base[i]) + 1) && p30.join() !== full.join() };
  t.state.doc.activeId = g.id; const saved = t.saveLookFromSelection('Mine'); out.saved = !!saved;
  const json = t.exportLooksJSON(); localStorage.removeItem('tintwork.looks'); out.imported = t.importLooksJSON(json); out.userCount = t.allLooks().filter((x) => x.user).length;
  // 3D LUT: an "invert" cube, size 2
  const cube = 'TITLE "Invert"\nLUT_3D_SIZE 2\n' + [[1, 1, 1], [0, 1, 1], [1, 0, 1], [0, 0, 1], [1, 1, 0], [0, 1, 0], [1, 0, 0], [0, 0, 0]].map((v) => v.join(' ')).join('\n');
  t.state.doc.layers.filter((x) => x.kind === 'group' || x.parent).forEach((x) => { x.visible = false; t.touch(x); });
  t.state.doc.activeId = t.state.doc.layers[0].id; const before = await px(); const lut = await t.importCubeText(cube, 'invert.cube'); const after = await px();
  out.lut = { before, after, ok: after.every((v, i) => Math.abs(v - (255 - before[i])) <= 2) };
  const proj = JSON.parse(JSON.stringify(t.serializeProject()));
  await t.loadProject(proj, 'looks.tintwork'); out.reload = await px();
  out.lookKept = t.state.doc.layers.some((x) => x.look === 'teal-amber');
  return out;
});
check(looks.count >= 12, `${looks.count} built-in looks`);
check(looks.allChange, 'every built-in look changes the picture');
check(Math.abs(looks.intensity.opacity - 0.3) < 0.01 && looks.intensity.between, 'look intensity scales the effect (group opacity)');
check(looks.saved && looks.imported === 1 && looks.userCount === 1, 'save a look, export and import it');
check(looks.lut.ok, `.cube 3D LUT adjustment layer (${looks.lut.before} → ${looks.lut.after})`);
check(near(looks.reload, looks.lut.after, 2) && looks.lookKept, 'project round-trip keeps the LUT and look groups');

// screenshots
await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(900, 600, 'white'); const l = t.activeLayer(), c = l.canvas.getContext('2d');
  const sky = c.createLinearGradient(0, 0, 0, 330); sky.addColorStop(0, '#6d8fb8'); sky.addColorStop(1, '#d9c7a8'); c.fillStyle = sky; c.fillRect(0, 0, 900, 600);
  c.save(); c.translate(450, 330); c.rotate(-3 * Math.PI / 180); c.fillStyle = '#3d5a6e'; c.fillRect(-700, 0, 1400, 500);
  c.fillStyle = '#e8b56a'; c.beginPath(); c.arc(120, -60, 38, 0, Math.PI * 2); c.fill(); c.fillStyle = '#2a3b2c'; c.beginPath(); c.moveTo(-500, 10); c.lineTo(-250, -120); c.lineTo(-60, 10); c.fill(); c.restore();
  t.touch(l); t.commit('scene'); t.fitToScreen(); t.applyLook('golden-hour', 80); t.updateLayersPanel();
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'screenshots/8x-looks-panel.png' });
await page.evaluate(() => { const t = window.tintwork; t.undo(); t.setTool('straighten'); });
const box = await page.locator('#viewport').boundingBox();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6); await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.6 - box.width * 0.55 * Math.tan(3 * Math.PI / 180), { steps: 8 });
await page.screenshot({ path: 'screenshots/8x-straighten-tool.png' });
await page.mouse.up(); await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/8x-straightened.png' });
await page.evaluate(() => { const t = window.tintwork, d = t.state.doc; t.run('layerNew'); const ids = d.layers.map((l) => l.id); t.pickLayer(ids); t.updateLayersPanel(); });
await page.locator('#menubar > * >> text="Layer"').first().click(); await page.waitForTimeout(200);
await page.screenshot({ path: 'screenshots/8x-multi-select-align.png' }); await page.keyboard.press('Escape');
check(!errors.length, `no page errors ${errors.join(' | ')}`);

await browser.close(); server.close();
console.log(fails ? `\n${fails} v0.8 check(s) FAILED` : '\nAll v0.8 checks passed.');
process.exit(fails ? 1 : 0);
