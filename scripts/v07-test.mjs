// v0.7 test: layer groups (nesting, collapse, group opacity / blend / mask, pass-through), clipping masks,
// layer styles (render, toggle, project round-trip), perspective / warp / liquify (GPU result vs the CPU
// reference on every engine), the in-app benchmark, and 16-bit dodge / burn and red eye.
// Headless Chromium has SwiftShader only (software WebGL2 / WebGPU), which is enough to check correctness.
import { chromium } from 'playwright';
import { createStaticServer } from './serve.mjs';
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const same = (a, b, tol = 2) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

// --- per engine: groups / clipping / styles composite + mesh warps ---------------------------------------
for (const eng of ['cpu', 'gpu', 'webgpu']) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript((e) => localStorage.setItem('tintwork.engine', e), eng);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  const r = await page.evaluate(async () => {
    const t = window.tintwork; await t.gfx.ready;
    const out = { engine: t.gfx.engine ? (t.gfx.engine.kind || 'webgl') : 'cpu' };
    t.newDocument(200, 100, 'white');
    const d = t.state.doc;
    // composite through the active engine (GPU when there is one) and read a pixel
    const px = async (x, y) => [...(await t.compositePixelAsync(x, y))];
    const L = t.createLayer('red', 200, 100); L.canvas.getContext('2d').fillStyle = '#f00'; L.canvas.getContext('2d').fillRect(20, 20, 60, 60);
    t.run('layerNew'); const a = t.activeLayer(); a.canvas.getContext('2d').fillStyle = '#00f'; a.canvas.getContext('2d').fillRect(0, 0, 200, 100); t.touch(a);
    d.layers.splice(1, 0, L); t.normalizeTree(d); t.touch(L);
    a.clip = true; t.touch(a); out.clipIn = await px(50, 50); out.clipOut = await px(150, 50);
    d.activeId = L.id; t.run('groupLayers'); const g = t.activeLayer(); out.isGroup = t.isGroup(g); out.groupParent = L.parent === g.id;
    t.placeLayer(d, a, L, 'above'); out.blueInGroup = a.parent === g.id && a.clip;
    out.inGroupClip = await px(50, 50); out.inGroupOut = await px(150, 50);
    g.opacity = 0.5; t.touch(g); out.half = await px(50, 50);
    g.opacity = 1; g.blend = 'multiply'; t.touch(g); out.mult = await px(50, 50);
    g.blend = 'pass-through'; g.visible = false; t.touch(g); out.hidden = await px(50, 50); g.visible = true; t.touch(g);
    // group mask hides the whole group
    d.activeId = g.id; t.run('addMask'); const m = g.mask.canvas.getContext('2d'); m.clearRect(0, 0, 100, 100); t.touch(g); g.mask.rev = (g.mask.rev || 0) + 1000;
    out.groupMask = [await px(50, 50), g.mask.canvas.width];
    g.mask = null; t.touch(g);
    // styles on the red layer (blue hidden)
    a.visible = false; a.clip = false; t.touch(a);
    L.styles = [t.defaultEffect('stroke')]; L.styles[0].size = 4; L.styles[0].color = '#00ff00'; t.touch(L);
    out.stroke = await px(18, 50); out.strokeIn = await px(30, 50);
    L.styles[0] = { ...L.styles[0], enabled: false }; L.styles = [...L.styles]; t.touch(L); out.strokeOff = await px(18, 50);
    L.styles = [t.defaultEffect('dropShadow')]; Object.assign(L.styles[0], { distance: 10, size: 0, angle: 90, opacity: 100 }); t.touch(L);
    out.shadow = await px(50, 85);
    L.styles = [t.defaultEffect('colorOverlay')]; Object.assign(L.styles[0], { color: '#00ffff', opacity: 100 }); t.touch(L);
    out.overlay = await px(50, 50);
    L.styles.push(t.defaultEffect('outerGlow')); t.touch(L);
    t.commit('styles');
    const proj = JSON.parse(JSON.stringify(t.serializeProject()));
    out.projVersion = proj.version; out.projLayers = proj.layers.map((l) => [l.name, l.kind || null, l.parent, (l.styles || []).map((s) => s.type).join('+')]);
    await t.loadProject(proj, 'x.tintwork');
    const d2 = t.state.doc; out.reloaded = d2.layers.map((l) => [l.name, l.kind || null, l.parent ? d2.layers.find((q) => q.id === l.parent).name : null, (l.styles || []).map((s) => s.type).join('+')]);
    out.overlay2 = await px(50, 50);
    t.undo(); t.redo(); out.undoRedo = t.state.doc.layers.length;
    // --- perspective / warp / liquify: active-engine result vs the CPU reference
    t.newDocument(400, 300, 'white');
    t.run('layerNew'); const l = t.activeLayer(), c = l.canvas.getContext('2d');
    const gr = c.createLinearGradient(0, 0, 400, 300); gr.addColorStop(0, '#f00'); gr.addColorStop(1, '#00f'); c.fillStyle = gr; c.fillRect(100, 80, 200, 140);
    c.fillStyle = '#fff'; for (let i = 0; i < 10; i++) c.fillRect(110 + i * 18, 90, 6, 120);
    t.touch(l); t.commit('paint');
    const src = c.getImageData(100, 80, 200, 140);
    const diff = (ref, got) => { let s = 0, w = 0, as = 0; for (let i = 0; i < ref.data.length; i += 4) { const k = ref.data[i + 3] / 255; for (let j = 0; j < 3; j++) s += k * Math.abs(ref.data[i + j] - got.data[i + j]); w += 3 * k; as += Math.abs(ref.data[i + 3] - got.data[i + 3]); } return { color: +(s / w).toFixed(3), alpha: +(as / (ref.data.length / 4)).toFixed(3) }; };
    t.startMeshXf('perspective'); const x = t.mxf; x.pts = [[110, 60], [320, 90], [300, 230], [90, 250]];
    await t.applyMeshXf(); out.persPath = t.gfx.lastWarpPath; out.persLabel = t.history.entries[t.history.index].label;
    { const mm = t.mesh.perspectiveMesh(200, 140, x.pts), bb = t.mesh.meshBounds(mm), q = t.activeLayer();
      out.persBounds = [q.x, q.y, q.canvas.width, q.canvas.height].join() === [bb.x, bb.y, bb.w, bb.h].join();
      out.persDiff = diff(t.mesh.renderMeshCPU(src, bb.w, bb.h, mm, bb.x, bb.y), q.canvas.getContext('2d').getImageData(0, 0, bb.w, bb.h)); }
    t.undo(); { const q = t.activeLayer(); out.persUndo = [q.x, q.y, q.canvas.width, q.canvas.height].join(); }
    t.startMeshXf('warp'); const w = t.mxf; w.pts[5] = [w.pts[5][0] + 30, w.pts[5][1] + 25]; const ctrl = w.pts.map((p) => [...p]);
    await t.applyMeshXf(); out.warpPath = t.gfx.lastWarpPath; out.warpLabel = t.history.entries[t.history.index].label;
    { const mm = t.mesh.warpMesh(ctrl, 4, 200, 140, 32), bb = t.mesh.meshBounds(mm), q = t.activeLayer();
      out.warpDiff = diff(t.mesh.renderMeshCPU(src, bb.w, bb.h, mm, bb.x, bb.y), q.canvas.getContext('2d').getImageData(0, 0, bb.w, bb.h)); }
    t.undo();
    t.startMeshXf('warp'); t.mxf.pts[0] = [0, 0]; await t.mxfRender(); t.cancelMeshXf(); { const q = t.activeLayer(); out.cancel = [q.x, q.y, q.canvas.width, !!t.mxf].join(); }
    t.setTool('liquify'); t.state.opts.liquifyMode = 'push';
    out.liqPath = await t.liquifyStroke([{ x: 150, y: 150 }, { x: 170, y: 150 }, { x: 190, y: 152 }, { x: 210, y: 155 }]);
    { const Q = t.gfx.lastLiquify, b = Q.bb, ww = b.x1 - b.x, hh = b.y1 - b.y, ref = t.mesh.renderMeshCPU(Q.src, ww, hh, t.mesh.fieldMesh(Q.field, b), b.x, b.y);
      const now = t.activeLayer().canvas.getContext('2d').getImageData(b.x, b.y, ww, hh); let mx = 0, ch = 0;
      for (let i = 0; i < now.data.length; i++) { mx = Math.max(mx, Math.abs(now.data[i] - ref.data[i])); if (ref.data[i] !== Q.src.data[((b.y + Math.floor(i / 4 / ww)) * Q.src.width + b.x + (i / 4) % ww) * 4 + (i % 4)]) ch++; }
      out.liq = { max: mx, changed: ch, label: t.history.entries[t.history.index].label }; }
    t.state.opts.liquifyMode = 'bloat'; await t.liquifyStroke([{ x: 250, y: 150 }]); out.bloat = t.history.entries[t.history.index].label;
    return out;
  });
  const tag = `[${eng} → ${r.engine}]`;
  check(r.engine === { cpu: 'cpu', gpu: 'webgl', webgpu: 'webgpu' }[eng], `${tag} engine started`);
  check(same(r.clipIn, [0, 0, 255, 255]) && same(r.clipOut, [255, 255, 255, 255]), `${tag} clipping mask: blue shows only over the red base (${r.clipIn} / ${r.clipOut})`);
  check(r.isGroup && r.groupParent && r.blueInGroup, `${tag} Ctrl+G groups the layer; clipped layer moved into the group`);
  check(same(r.inGroupClip, [0, 0, 255, 255]) && same(r.inGroupOut, [255, 255, 255, 255]), `${tag} clipping works inside a group`);
  check(same(r.half, [127, 127, 255, 255], 2), `${tag} group opacity 50% (${r.half})`);
  check(same(r.mult, [0, 0, 255, 255]) && same(r.hidden, [255, 255, 255, 255]), `${tag} group blend multiply / hidden group (${r.mult} / ${r.hidden})`);
  check(same(r.groupMask[0], [255, 255, 255, 255]) && r.groupMask[1] === 200, `${tag} group mask hides its contents (${r.groupMask})`);
  check(same(r.stroke, [0, 255, 0, 255]) && same(r.strokeIn, [255, 0, 0, 255]) && same(r.strokeOff, [255, 255, 255, 255]), `${tag} stroke style outside the edge; toggling it off removes it`);
  check(same(r.shadow, [0, 0, 0, 255]), `${tag} drop shadow below the layer (${r.shadow})`);
  check(same(r.overlay, [0, 255, 255, 255]) && same(r.overlay2, [0, 255, 255, 255]), `${tag} color overlay, kept after a project round-trip`);
  check(r.projVersion >= 6 && JSON.stringify(r.reloaded) === JSON.stringify([['Background', null, null, ''], ['red', null, 'Group 1', 'colorOverlay+outerGlow'], ['Layer 3', null, 'Group 1', ''], ['Group 1', 'group', null, '']]), `${tag} project v${r.projVersion} keeps groups, parents and styles ${JSON.stringify(r.reloaded)}`);
  const want = eng === 'cpu' ? 'cpu' : r.engine;
  check(r.persPath === want && r.persLabel === 'Perspective' && r.persBounds && r.persDiff.color < 1 && r.persDiff.alpha < 1, `${tag} perspective on ${r.persPath}: matches the CPU reference (color Δ ${r.persDiff.color}, alpha Δ ${r.persDiff.alpha})`);
  check(r.persUndo === '0,0,400,300', `${tag} undo restores the layer before the perspective`);
  check(r.warpPath === want && r.warpLabel === 'Warp' && r.warpDiff.color < 1 && r.warpDiff.alpha < 1, `${tag} warp on ${r.warpPath}: matches the CPU reference (color Δ ${r.warpDiff.color}, alpha Δ ${r.warpDiff.alpha})`);
  check(r.cancel === '0,0,400,false', `${tag} Esc / cancel restores the layer`);
  check(r.liqPath === want && r.liq.max <= 1 && r.liq.changed > 1000 && r.liq.label === 'Liquify' && r.bloat === 'Liquify', `${tag} liquify push on ${r.liqPath}: ${r.liq.changed} values moved, max Δ vs CPU ${r.liq.max}; bloat commits`);
  check(!errors.length, `${tag} no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// --- UI: panel, menus, warp handles with the mouse, benchmark dialog, 16-bit tools ---------------------
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem('tintwork.engine', 'webgpu'));
const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const ui = await page.evaluate(async () => {
  const t = window.tintwork, out = {};
  t.newDocument(1200, 800, 'white', 'Poster');
  const d = t.state.doc, paint = (l, f) => { f(l.canvas.getContext('2d')); t.touch(l); };
  paint(d.layers[0], (x) => { const g = x.createLinearGradient(0, 0, 1200, 800); g.addColorStop(0, '#1d2b53'); g.addColorStop(1, '#f2b880'); x.fillStyle = g; x.fillRect(0, 0, 1200, 800); });
  t.run('layerNew'); const card = t.activeLayer(); card.name = 'Card'; paint(card, (x) => { x.fillStyle = '#f4efe6'; x.beginPath(); x.roundRect(300, 200, 600, 400, 30); x.fill(); });
  card.styles = [Object.assign(t.defaultEffect('dropShadow'), { distance: 18, size: 24, opacity: 55 }), Object.assign(t.defaultEffect('stroke'), { size: 4, color: '#c8553d', position: 'inside' })]; t.touch(card);
  t.run('layerNew'); const photo = t.activeLayer(); photo.name = 'Photo'; paint(photo, (x) => { const g = x.createRadialGradient(600, 380, 10, 600, 380, 320); g.addColorStop(0, '#ffd166'); g.addColorStop(1, '#06d6a0'); x.fillStyle = g; x.fillRect(0, 0, 1200, 800); });
  t.run('clipToggle'); out.clipped = photo.clip;
  d.activeId = card.id; t.run('groupLayers'); const grp = t.activeLayer(); grp.name = 'Card group';
  t.placeLayer(d, photo, card, 'above');
  t.run('layerNew'); const title = t.activeLayer(); title.name = 'Title'; paint(title, (x) => { x.fillStyle = '#ffffff'; x.font = 'bold 72px sans-serif'; x.fillText('Summer', 470, 150); });
  title.styles = [Object.assign(t.defaultEffect('outerGlow'), { size: 20, color: '#ffd166' })]; t.touch(title);
  t.commit('Poster'); t.updateLayersPanel(); t.run('zoomFit');
  const rows = [...document.querySelectorAll('#layerList li')];
  out.rows = rows.length; out.groupRow = !!document.querySelector('#layerList li.group-row'); out.fxBadges = document.querySelectorAll('#layerList .fx-badge').length;
  out.fxRows = document.querySelectorAll('#layerList .fx-row').length; out.clipArrow = !!document.querySelector('#layerList .clip-arrow');
  const tw = document.querySelector('#layerList .twisty'); tw.click(); out.collapsedRows = document.querySelectorAll('#layerList li').length; out.collapsed = grp.collapsed;
  document.querySelector('#layerList .twisty').click(); out.expandedRows = document.querySelectorAll('#layerList li').length;
  const menus = [...document.querySelectorAll('[data-cmd]')].map((b) => b.dataset.cmd);
  out.menu = ['groupLayers', 'ungroup', 'clipToggle', 'layerStyles', 'perspective', 'warp', 'benchmark'].filter((c) => !menus.includes(c));
  out.liquifyButton = !!document.querySelector('[data-tool="liquify"], #toolbar [title^="Liquify"]');
  return out;
});
check(ui.clipped && ui.groupRow && ui.clipArrow, 'layers panel shows the group row and the clipping arrow');
check(ui.fxBadges >= 2 && ui.fxRows >= 3, `fx badges (${ui.fxBadges}) and effect rows (${ui.fxRows}) are listed`);
check(ui.collapsed && ui.collapsedRows < ui.rows && ui.expandedRows === ui.rows, `group collapses / expands (${ui.rows} → ${ui.collapsedRows} → ${ui.expandedRows} rows)`);
check(!ui.menu.length, `menus have the new commands ${ui.menu.join(',')}`);
check(ui.liquifyButton, 'liquify tool in the toolbox');
await page.evaluate(() => { const t = window.tintwork, d = t.state.doc; d.activeId = d.layers.find((l) => l.name === 'Card').id; t.updateLayersPanel(); t.openStylesDialog(); });
await page.waitForTimeout(300);
const dlg = await page.evaluate(() => ({ sets: document.querySelectorAll('#modalBody fieldset').length, title: document.querySelector('#modalTitle').textContent }));
check(dlg.sets >= 6, `layer style dialog lists ${dlg.sets} effects ("${dlg.title}")`);
await page.screenshot({ path: 'screenshots/7x-layer-styles-dialog.png' });
await page.evaluate(() => document.querySelector('#modalCancel').click());
await page.evaluate(() => window.tintwork.compositeSettled());
await page.screenshot({ path: 'screenshots/7x-groups-clipping-styles.png' });
await page.keyboard.press('k');
check(await page.evaluate(() => window.tintwork.state.tool === 'liquify'), 'K selects the liquify tool');
await page.keyboard.press('v');

// warp with the mouse: drag the centre-left control point
await page.evaluate(() => { const t = window.tintwork, d = t.state.doc; d.activeId = d.layers.find((l) => l.name === 'Card').id; t.updateLayersPanel(); t.run('warp'); });
const h = await page.evaluate(() => { const t = window.tintwork, s = t.state, r = document.querySelector('#view').getBoundingClientRect(), p = t.mxf.pts[6]; return { x: r.left + s.panX + p[0] * s.zoom, y: r.top + s.panY + p[1] * s.zoom, n: t.mxf.pts.length, bar: document.querySelector('#optionsbar').textContent }; });
check(h.n === 16 && /Warp/.test(h.bar) && /Apply/.test(h.bar), `Edit ▸ Warp opens a 4×4 grid session (options: "${h.bar.trim().slice(0, 60)}…")`);
await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(h.x + 40, h.y - 45, { steps: 6 }); await page.mouse.up();
{ const h2 = await page.evaluate(() => { const t = window.tintwork, s = t.state, r = document.querySelector('#view').getBoundingClientRect(), p = t.mxf.pts[9]; return { x: r.left + s.panX + p[0] * s.zoom, y: r.top + s.panY + p[1] * s.zoom }; });
  await page.mouse.move(h2.x, h2.y); await page.mouse.down(); await page.mouse.move(h2.x - 30, h2.y + 40, { steps: 6 }); await page.mouse.up(); }
await page.waitForTimeout(400);
for (const [i, dx, dy] of [[1, 0, -40], [11, 45, 0]]) { // bend two edges too, so the warp is visible in the screenshot
  const e = await page.evaluate((i) => { const t = window.tintwork, s = t.state, r = document.querySelector('#view').getBoundingClientRect(), p = t.mxf.pts[i]; return { x: r.left + s.panX + p[0] * s.zoom, y: r.top + s.panY + p[1] * s.zoom }; }, i);
  await page.mouse.move(e.x, e.y); await page.mouse.down(); await page.mouse.move(e.x + dx, e.y + dy, { steps: 6 }); await page.mouse.up();
}
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/7x-warp.png' });
const moved = await page.evaluate(() => window.tintwork.mxf.pts[6][1] < 300);
await page.keyboard.press('Enter');
await page.waitForFunction(() => !window.tintwork.mxf);
const wr = await page.evaluate(() => ({ label: window.tintwork.history.entries[window.tintwork.history.index].label, path: window.tintwork.gfx.lastWarpPath }));
check(moved && wr.label === 'Warp' && wr.path === 'webgpu', `dragging a handle bends the layer; Enter applies (${wr.label}, ${wr.path})`);
await page.evaluate(() => window.tintwork.run('perspective'));
await page.keyboard.press('Escape');
check(await page.evaluate(() => !window.tintwork.mxf && window.tintwork.history.entries[window.tintwork.history.index].label === 'Warp'), 'Esc cancels a perspective session without a history step');

// benchmark dialog (1 MP quick size)
const docBefore = await page.evaluate(() => { const d = window.tintwork.state.doc; return d.layers.map((l) => [...l.canvas.getContext('2d').getImageData(Math.floor(l.canvas.width / 2), Math.floor(l.canvas.height / 2), 1, 1).data].join()).join('|'); });
await page.evaluate(() => window.tintwork.run('benchmark'));
await page.evaluate(() => { document.querySelector('#bench1').checked = true; document.querySelector('#bench12').checked = false; document.querySelector('#bench24').checked = false; document.querySelector('#benchRun').click(); });
await page.waitForFunction(() => /Done in/.test(document.querySelector('#benchProgress')?.textContent || ''), null, { timeout: 180000 });
const bench = await page.evaluate(async () => {
  const t = window.tintwork; await t.gfx.ready;
  const rows = [...document.querySelectorAll('.bench-table tbody tr')].map((r) => [...r.cells].map((c) => c.textContent));
  const text = t.benchText(t.gfx.lastBench, '0.7.0');
  const docAfter = t.state.doc.layers.map((l) => [...l.canvas.getContext('2d').getImageData(Math.floor(l.canvas.width / 2), Math.floor(l.canvas.height / 2), 1, 1).data].join()).join('|');
  return { docAfter, rows, heads: [...document.querySelectorAll('.bench-table th')].map((x) => x.textContent), info: document.querySelector('.bench-info').textContent, text, engine: t.gfx.engine?.kind };
});
check(bench.heads.join() === 'Operation,MP,CPU,WebGL2,WebGPU' && bench.rows.length === 5, `results table: ${bench.rows.length} operations × ${bench.heads.slice(2).join('/')}`);
check(bench.rows.every((r) => r.slice(2).every((c) => / ms$/.test(c))), `every cell is a time (${bench.rows.map((r) => r.slice(2).join('|')).join('; ')})`);
check(/software adapter/.test(bench.info) && /swiftshader/i.test(bench.text) && /SOFTWARE adapter/.test(bench.text), 'adapter name / vendor shown and flagged as a software adapter');
check(/Operation\s+MP\s+CPU\s+WebGL2\s+WebGPU/.test(bench.text) && /Perspective warp/.test(bench.text), 'copy-as-text report has the table');
check(bench.engine === 'webgpu', 'the app engine is restarted after the benchmark');
check(bench.docAfter === docBefore && /[1-9]/.test(docBefore), `open document pixels are untouched by the benchmark (${docBefore} -> ${bench.docAfter})`);
await page.screenshot({ path: 'screenshots/7x-benchmark.png' });
await page.evaluate(() => document.querySelector('#modalOk').click());

// 16-bit dodge / burn and red eye keep 16-bit precision
const deep = await page.evaluate(() => {
  const t = window.tintwork, out = {};
  t.newDocument(200, 100, 'white'); t.setDepth(16);
  const D = t.createDeep(200, 100);
  for (let i = 0; i < D.data.length; i += 4) { const x = (i / 4) % 200; D.data[i] = D.data[i + 1] = D.data[i + 2] = 20000 + x * 3; D.data[i + 3] = 65535; }
  t.setDeep(t.activeLayer(), D); t.commit('deep');
  t.setTool('tone'); Object.assign(t.state.opts, { toneMode: 'dodge', toneRange: 'midtones', smoothing: 0 });
  t.paintStroke([{ x: 40, y: 50 }, { x: 160, y: 50 }], { tool: 'tone' });
  let L = t.activeLayer(); const row = Array.from({ length: 80 }, (_, k) => L.deep.data[(50 * 200 + 60 + k) * 4]);
  out.tone = { synced: L.deepRev === L.rev, distinct: new Set(row).size, proxyLevels: new Set(row.map((v) => Math.round(v / 257))).size, lighter: row.every((v, k) => v > 20000 + (60 + k) * 3), off257: row.filter((v) => v % 257).length };
  t.setTool('tone'); t.state.opts.toneMode = 'burn'; t.paintStroke([{ x: 40, y: 20 }, { x: 160, y: 20 }], { tool: 'tone' });
  L = t.activeLayer(); out.burn = L.deep.data[(20 * 200 + 100) * 4] < 20000 + 100 * 3 && L.deepRev === L.rev;
  const E = t.createDeep(200, 100);
  for (let i = 0; i < E.data.length; i += 4) { const x = (i / 4) % 200; E.data[i] = 50000 + x * 2; E.data[i + 1] = 9000 + x; E.data[i + 2] = 8000; E.data[i + 3] = 65535; }
  t.setDeep(t.activeLayer(), E); t.commit('red');
  t.state.opts.redeyeSize = 40; const n = t.redEyeAt({ x: 100, y: 50 });
  L = t.activeLayer(); const reds = Array.from({ length: 10 }, (_, k) => L.deep.data[(50 * 200 + 95 + k) * 4]);
  out.redeye = { n, synced: L.deepRev === L.rev, darker: reds.every((v) => v < 20000), distinct: new Set(reds).size, off257: reds.filter((v) => v % 257).length };
  return out;
});
check(deep.tone.synced && deep.tone.lighter && deep.tone.distinct > deep.tone.proxyLevels && deep.tone.off257 > 60, `16-bit dodge keeps 16-bit levels (${deep.tone.distinct} distinct values over ${deep.tone.proxyLevels} 8-bit levels)`);
check(deep.burn, '16-bit burn darkens and stays in sync');
check(deep.redeye.n > 0 && deep.redeye.synced && deep.redeye.darker && deep.redeye.off257 > 5, `16-bit red eye keeps 16-bit values (${deep.redeye.distinct} distinct in 10 px, ${deep.redeye.n} px fixed)`);
check(!errors.length, `no page errors ${errors.join(' | ')}`);

await browser.close(); server.close();
console.log(fails ? `\n${fails} v0.7 check(s) FAILED` : '\nAll v0.7 checks passed.');
process.exit(fails ? 1 : 0);
