// v0.9 test: GPU 3D LUT vs CPU on every engine, multi-document tabs (separate history, closing prompt,
// layer copy by drag), crop / resize presets, actions (record + replay), multi-size export, batch processing
// with progress / cancel, 16-bit layer-effect pixels and auto-fix options. Screenshots: screenshots/9x-*.png.
import { chromium } from 'playwright';
import { createStaticServer } from './serve.mjs';
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const near = (a, b, tol = 3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

// --- 3D LUT on every engine (a size-5 non-linear cube, so trilinear interpolation is exercised) ----------
const N = 5, rows = [];
for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) { const R = r / (N - 1), G = g / (N - 1), B = b / (N - 1); rows.push([Math.sqrt(R), G * G, (B + R) / 2].map((v) => v.toFixed(5)).join(' ')); }
const cube = `TITLE "Curvy"\nLUT_3D_SIZE ${N}\n${rows.join('\n')}`;
const lutRef = {};
for (const eng of ['cpu', 'gpu', 'webgpu']) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript((e) => localStorage.setItem('tintwork.engine', e), eng);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  const r = await page.evaluate(async (cube) => {
    const t = window.tintwork; await t.gfx.ready;
    t.newDocument(64, 16, 'white'); const l = t.activeLayer(), c = l.canvas.getContext('2d');
    const gr = c.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, '#102030'); gr.addColorStop(0.5, '#c87a3c'); gr.addColorStop(1, '#30e0a0'); c.fillStyle = gr; c.fillRect(0, 0, 64, 16); t.touch(l);
    const lut = await t.importCubeText(cube, 'curvy.cube'); lut.adj.params.amount = 80; t.touch(lut);
    const px = []; for (const x of [2, 20, 33, 47, 61]) px.push([...(await t.compositePixelAsync(x, 8))].slice(0, 3));
    return { engine: t.gfx.engine ? (t.gfx.engine.kind || 'webgl') : 'cpu', px, list: t.gpuLayerList ? JSON.stringify(t.gpuLayerList(t.state.doc).map((i) => i.type || i.kind)) : '', notice: document.body.innerText.includes('3D LUT') && /on the CPU/i.test(document.body.innerText) };
  }, cube);
  if (eng === 'cpu') { lutRef.px = r.px; check(r.px.length === 5, `CPU 3D LUT reference (${JSON.stringify(r.px)})`); }
  else {
    check(r.engine !== 'cpu', `[${eng}] engine active (${r.engine})`);
    check(r.px.every((p, i) => near(p, lutRef.px[i], 3)), `[${eng} → ${r.engine}] 3D LUT on the GPU matches the CPU (${JSON.stringify(r.px)})`);
    check(!r.notice, `[${eng}] no "LUT runs on the CPU" fallback notice`);
  }
  check(!errors.length, `[${eng}] no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// --- everything else on the CPU engine --------------------------------------------------------------------
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem('tintwork.engine', 'cpu'));
const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');

// tabs
const tabs = await page.evaluate(async () => {
  const t = window.tintwork, out = {};
  t.newDocument(200, 100, 'white', 'Alpha'); const A = t.state.doc;
  await t.run('invert'); await t.run('flipH');
  t.newDocument(120, 80, 'white', 'Beta'); const B = t.state.doc;
  out.count = t.tabs.length; out.domTabs = document.querySelectorAll('#tabbar .doc-tab').length;
  out.bHist = t.history.index; await t.run('invert'); out.bHist2 = t.history.index;
  t.switchTab(t.tabs.findIndex((x) => x.doc === A)); out.backToA = t.state.doc === A; out.aHist = t.history.index; out.aPix = [...A.layers[0].canvas.getContext('2d').getImageData(5, 5, 1, 1).data].slice(0, 3);
  t.undo(); t.undo(); out.aUndone = [...A.layers[0].canvas.getContext('2d').getImageData(5, 5, 1, 1).data].slice(0, 3);
  out.bUntouched = [...B.layers[0].canvas.getContext('2d').getImageData(5, 5, 1, 1).data].slice(0, 3);
  t.redo(); t.redo();
  out.slotsDiffer = A.slot && B.slot && A.slot !== B.slot;
  return out;
});
check(tabs.count >= 2 && tabs.domTabs === tabs.count, `two documents open as tabs (${tabs.count} tabs, ${tabs.domTabs} in the tab bar)`);
check(tabs.bHist2 === tabs.bHist + 1 && tabs.backToA, 'each document keeps its own undo history');
check(near(tabs.aPix, [0, 0, 0]) && near(tabs.aUndone, [255, 255, 255]) && near(tabs.bUntouched, [0, 0, 0]), `undo in one tab leaves the other alone (A ${tabs.aPix}→${tabs.aUndone}, B ${tabs.bUntouched})`);
check(tabs.slotsDiffer, 'each document has its own autosave slot');
await page.keyboard.press('Control+F6'); await page.waitForTimeout(100);
check(await page.evaluate(() => window.tintwork.state.doc.name === 'Beta'), 'Ctrl+F6 switches to the next document');
await page.keyboard.press('Control+Tab'); await page.waitForTimeout(100);
const afterCtrlTab = await page.evaluate(() => window.tintwork.state.doc.name);
check(afterCtrlTab !== 'Beta', `Ctrl+Tab cycles documents (now ${afterCtrlTab})`);
await page.waitForFunction(() => window.tintwork.autosaveSettled, null, { timeout: 10000 }).catch(() => {});
const saves = await page.evaluate(async () => (await window.tintwork.listAutosaves()).map((r) => r.name));
check(saves.includes('Alpha') && saves.includes('Beta'), `both documents are autosaved (${saves.join(', ')})`);

// drag a layer onto another tab (HTML5 drag and drop in the real UI)
await page.evaluate(() => { const t = window.tintwork; t.switchTab(t.tabs.findIndex((x) => x.doc.name === 'Beta')); t.run('layerNew'); const l = t.activeLayer(); l.name = 'Dragged'; const c = l.canvas.getContext('2d'); c.fillStyle = '#ff0000'; c.fillRect(0, 0, 120, 80); t.touch(l); t.updateLayersPanel(); });
const alphaLayers0 = await page.evaluate(() => window.tintwork.tabs.find((x) => x.doc.name === 'Alpha').doc.layers.length);
await page.locator('#layerList li', { hasText: 'Dragged' }).first().dragTo(page.locator('#tabbar .doc-tab', { hasText: 'Alpha' }).first());
await page.waitForTimeout(200);
const drag = await page.evaluate(async () => { const t = window.tintwork, d = t.state.doc; return { name: d.name, n: d.layers.length, top: d.layers[d.layers.length - 1].name, x: d.layers[d.layers.length - 1].x, px: [...(await t.compositePixelAsync(100, 50))].slice(0, 3) }; });
check(drag.name === 'Alpha' && drag.n === alphaLayers0 + 1 && /Dragged/.test(drag.top) && near(drag.px, [255, 0, 0]), `dragging a layer onto a tab copies it there, centred (${JSON.stringify(drag)})`);

// closing a dirty document asks first
await page.evaluate(() => { window.tintwork.closeTab(); });
await page.waitForTimeout(100);
const ask = await page.evaluate(() => ({ open: !document.querySelector('#modal').classList.contains('hidden'), title: document.querySelector('#modalTitle').textContent }));
check(ask.open && /unsaved|close/i.test(ask.title), `closing a document with unsaved changes asks first ("${ask.title}")`);
await page.locator('#modal button', { hasText: /Cancel/ }).first().click();
check(await page.evaluate(() => window.tintwork.tabs.length === 2 && window.tintwork.state.doc.name === 'Alpha'), 'Cancel keeps the document open');
await page.evaluate(() => { window.tintwork.closeTab(); }); await page.waitForTimeout(100);
await page.locator('#modal button', { hasText: /Close|Discard|Don/ }).first().click(); await page.waitForTimeout(200);
check(await page.evaluate(() => window.tintwork.tabs.length === 1 && window.tintwork.state.doc.name === 'Beta'), 'confirming closes it and shows the other tab');

// presets
const pre = await page.evaluate(async () => {
  const t = window.tintwork, P = t.presets, out = {};
  out.p4x6 = P.presetPixels(P.presetById('p4x6'), 300, 'auto', 400, 300); out.p4x6p = P.presetPixels(P.presetById('p4x6'), 300, 'auto', 300, 400);
  out.custom = !!P.saveCustomPreset({ name: 'Thumb', w: 320, h: 240 }); out.customFound = P.allPresets().some((p) => p.name === 'Thumb');
  t.newDocument(400, 300, 'white', 'Presets'); t.resizeToPreset('sq'); out.sq = [t.state.doc.width, t.state.doc.height]; t.undo(); out.sqUndo = [t.state.doc.width, t.state.doc.height];
  t.newDocument(400, 300, 'white', 'Presets'); t.resizeToPreset('p5x7', { dpi: 200 }); out.p5x7 = [t.state.doc.width, t.state.doc.height, t.state.doc.dpi];
  t.newDocument(400, 300, 'white', 'Presets'); t.resizeToPreset('land169', { mode: 'fit' }); out.fit = [t.state.doc.width, t.state.doc.height];
  t.newDocument(400, 300, 'white', 'Presets'); t.setTool('crop'); t.setCropPreset('r45'); out.cropRect = { ...t.state.crop };
  t.state.opts.cropResize = false; t.applyCropTool(); out.ratioCrop = [t.state.doc.width, t.state.doc.height];
  t.newDocument(400, 300, 'white', 'Presets'); t.setTool('crop'); t.setCropPreset('portrait45'); t.state.opts.cropResize = true; t.applyCropTool(); out.fixedCrop = [t.state.doc.width, t.state.doc.height];
  out.cb = P.constrainRect({ x: 300, y: 50 }, { x: 420, y: 400 }, 4, 5, { w: 400, h: 300 });
  out.bar = !!document.querySelector('[data-croppreset]');
  return out;
});
check(pre.p4x6.w === 1800 && pre.p4x6.h === 1200 && pre.p4x6p.w === 1200 && pre.p4x6p.h === 1800, `4×6 in at 300 DPI = 1800×1200 and follows the picture orientation (${JSON.stringify([pre.p4x6, pre.p4x6p])})`);
check(pre.customFound, 'custom size preset saved');
check(pre.sq.join() === '1080,1080' && pre.sqUndo.join() === '400,300', `Image ▸ Resize preset 1:1 → ${pre.sq}, one undo step back to ${pre.sqUndo}`);
check(pre.p5x7[2] === 200 && Math.max(pre.p5x7[0], pre.p5x7[1]) === 1400 && Math.min(pre.p5x7[0], pre.p5x7[1]) === 1000, `5×7 in at 200 DPI → ${pre.p5x7}`);
check(pre.fit.join() === '1440,1080', `fit mode keeps the whole picture inside 16:9 (${pre.fit})`);
check(Math.abs(pre.cropRect.w / pre.cropRect.h - 0.8) < 0.01 && pre.ratioCrop[0] / pre.ratioCrop[1] > 0.79 && pre.ratioCrop[0] / pre.ratioCrop[1] < 0.81, `crop tool 4:5 ratio (${pre.ratioCrop})`);
check(pre.fixedCrop.join() === '1080,1350', `crop to a social preset resizes to its pixels (${pre.fixedCrop})`);
check(pre.cb.x + pre.cb.w <= 400 && pre.cb.y + pre.cb.h <= 300 && Math.abs(pre.cb.w / pre.cb.h - 0.8) < 0.02, `ratio-locked rect stays inside the image (${JSON.stringify(pre.cb)})`);
check(pre.bar, 'crop options bar has the preset picker');

// actions: record + replay gives identical pixels
const act = await page.evaluate(async () => {
  const t = window.tintwork, out = {};
  const paint = (name) => { t.newDocument(300, 200, 'white', name); const l = t.activeLayer(), c = l.canvas.getContext('2d'); const g = c.createLinearGradient(0, 0, 300, 200); g.addColorStop(0, '#203040'); g.addColorStop(1, '#e0b070'); c.fillStyle = g; c.fillRect(0, 0, 300, 200); c.fillStyle = '#7a2'; c.fillRect(20, 20, 60, 40); t.touch(l); t.commit('paint'); };
  paint('Rec'); t.startRecording(); out.badge = !document.querySelector('#recBadge')?.classList.contains('hidden');
  await t.run('flipH'); await t.applyAdjustDirect('brightnessContrast', { brightness: 20, contrast: 10 }); t.resizeToPreset('sq', { mode: 'fill' }); t.autoEnhanceCmd({ strength: 60 });
  const a = t.stopRecording('Test action'); out.steps = a?.steps.map((s) => t.describeStep(s));
  const p1 = []; for (const [x, y] of [[100, 100], [540, 540], [1000, 900]]) p1.push([...(await t.compositePixelAsync(x, y))].slice(0, 3));
  out.size1 = [t.state.doc.width, t.state.doc.height];
  paint('Replay'); const r = await t.playAction(a.id); out.ok = r.ok; out.size2 = [t.state.doc.width, t.state.doc.height];
  const p2 = []; for (const [x, y] of [[100, 100], [540, 540], [1000, 900]]) p2.push([...(await t.compositePixelAsync(x, y))].slice(0, 3));
  out.p1 = p1; out.p2 = p2; out.saved = t.userActions().some((x) => x.name === 'Test action');
  const json = JSON.stringify({ format: 'tintwork-actions', actions: [{ ...a, id: 'imp', name: 'Imported' }] }); out.imported = (t.importActionsJSON(json), t.allActions().some((x) => x.name === 'Imported'));
  out.builtins = t.allActions().filter((x) => !x.id.startsWith('u-') && x.id !== 'imp').length;
  return out;
});
check(act.badge && act.steps?.length === 4, `recorded 4 steps with the REC badge shown (${act.steps?.join(' → ')})`);
check(act.ok && act.size1.join() === act.size2.join() && act.p1.every((p, i) => near(p, act.p2[i], 2)), `replaying the action reproduces the edit (${JSON.stringify(act.p1)} vs ${JSON.stringify(act.p2)})`);
check(act.saved && act.imported && act.builtins >= 3, `actions saved, imported, ${act.builtins} built-in`);

// multi-size export
const ex = await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(400, 300, 'white', 'Holiday.jpg');
  const s = t.memorySink(), prog = [];
  const out = await t.exportVariants([{ mode: 'original', type: 'image/jpeg', quality: 90 }, { mode: 'long', long: 200, type: 'image/png' }, { mode: 'preset', preset: 'sq', type: 'image/webp' }, { mode: 'preset', preset: 'p4x6', dpi: 300, type: 'image/png' }],
    { pattern: '{name}_{w}x{h}', sink: s, onProgress: (i, n) => prog.push(`${i}/${n}`) });
  const dims = {}; for (const [k, v] of Object.entries(s.files)) { const bm = await createImageBitmap(v.blob); dims[k] = [bm.width, bm.height, v.type]; }
  const png = new Uint8Array(await s.files['Holiday_1800x1200.png'].blob.arrayBuffer()); let phys = null;
  for (let i = 8; i < png.length - 12;) { const len = (png[i] << 24 | png[i + 1] << 16 | png[i + 2] << 8 | png[i + 3]) >>> 0, type = String.fromCharCode(...png.slice(i + 4, i + 8)); if (type === 'pHYs') { const dv = new DataView(png.buffer, i + 8, 9); phys = Math.round(dv.getUint32(0) * 0.0254); } i += 12 + len; if (type === 'IEND') break; }
  const zip = t.zipSink ? await (async () => { const z = t.zipSink('x.zip'); await z.write('a.txt', new Blob(['hello'])); return z.bytes ? String.fromCharCode(...(await z.bytes()).slice(0, 2)) : 'n/a'; })() : 'n/a';
  return { names: Object.keys(s.files), dims, phys, n: out.length, prog, zip };
});
check(ex.n === 4 && ex.dims['Holiday_400x300.jpg']?.[2] === 'image/jpeg' && ex.dims['Holiday_200x150.png'] && ex.dims['Holiday_1080x1080.webp'], `exports four sizes / formats at once (${ex.names.join(', ')})`);
check(ex.phys === 300, `print preset export carries 300 DPI in the PNG (${ex.phys})`);
check(ex.prog.length >= 4, `progress reported (${ex.prog.join(' ')})`);

// batch
const batch = await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(100, 100, 'white', 'Home'); const home = t.state.doc, tabs0 = t.tabs.length; window.__before = t.tabs.map((x) => x.doc.name).join(',');
  const mk = (w, h, col, name) => new Promise((r) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = col; x.fillRect(0, 0, w, h); c.toBlob((b) => r(new File([b], name, { type: 'image/png' })), 'image/png'); });
  const files = [await mk(640, 480, '#336699', 'one.png'), await mk(480, 640, '#996633', 'two.png'), new File([new Uint8Array([1, 2, 3, 4])], 'broken.png', { type: 'image/png' }), await mk(300, 300, '#fff', 'four.png')];
  const s = t.memorySink(), prog = [];
  const r = await t.runBatch(files, { actionId: 'a-social-sq', variants: [{ mode: 'original', type: 'image/jpeg' }, { mode: 'long', long: 256, type: 'image/png' }], pattern: '{n:3}_{name}', sink: s, onProgress: (i, n, m) => prog.push(m) });
  const out = { done: r.done, failed: r.failed.map((f) => f.name), names: Object.keys(s.files).sort(), tabsBack: t.tabs.length === tabs0 && t.state.doc === home, prog: prog.length };
  const first = s.files[out.names.find((n) => /one.*jpg/.test(n))]; if (first) { const bm = await createImageBitmap(first.blob); out.oneSize = [bm.width, bm.height]; }
  const ac = new AbortController(), s2 = t.memorySink();
  const r2 = await t.runBatch(files, { variants: [{ mode: 'original', type: 'image/png' }], sink: s2, signal: ac.signal, onProgress: (i) => { if (i >= 1) ac.abort(); } });
  out.cancel = { cancelled: r2.cancelled, done: r2.done }; out.tabsBack2 = t.tabs.length === tabs0;
  return out;
});
check(batch.done === 3 && batch.failed.join() === 'broken.png', `batch processed 3 images, skipped the broken one (${batch.done} done, failed: ${batch.failed})`);
check(batch.names.length === 6 && batch.names.some((n) => /^\d{3}_one/.test(n)), `naming pattern applied (${batch.names.join(', ')})`);
check(batch.oneSize?.join() === '1080,1080', `the batch ran the action on each image (${batch.oneSize})`);
check(batch.tabsBack && batch.tabsBack2, 'batch closes its temporary tabs and returns to the original document');
check(batch.cancel.cancelled && batch.cancel.done < 4, `cancel stops the batch (${JSON.stringify(batch.cancel)})`);

// 16-bit effects
const fx = await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(120, 120, 'white', 'Deep'); t.setDepth(16);
  t.run('layerNew'); const l = t.activeLayer(), c = l.canvas.getContext('2d'); c.fillStyle = '#4080c0'; c.fillRect(40, 40, 40, 40); t.touch(l);
  const sh = t.defaultEffect('dropShadow'); sh.distance = 6; sh.size = 8; const st = t.defaultEffect('stroke'); st.size = 3; st.position = 'outside';
  l.styles = [sh, st]; t.touch(l);
  const deep = t.compositeDeepDoc(t.state.doc), W = t.state.doc.width; let fine = 0, max = 0;
  const p8 = []; for (const [x, y] of [[90, 90], [84, 60], [60, 60]]) { const i = (y * W + x) * 4; p8.push([...(await t.compositePixelAsync(x, y))].slice(0, 3).map((v, k) => Math.abs(v - deep.data[i + k] / 257))); }
  for (let y = 80; y < 100; y++) for (let x = 40; x < 100; x++) { const v = deep.data[(y * W + x) * 4]; if (v % 257) fine++; }
  for (const d of p8) max = Math.max(max, ...d);
  return { fine, max, deepFx: t.lastDeepFx ?? null };
});
check(fx.fine > 50, `drop shadow / stroke pixels carry 16-bit values (${fx.fine} non-8-bit samples)`);
check(fx.max <= 3, `16-bit effects match the 8-bit look (max diff ${fx.max.toFixed(2)})`);

// auto options
const ao = await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(200, 100, 'white', 'Auto'); const l = t.activeLayer(), c = l.canvas.getContext('2d');
  c.fillStyle = '#806040'; c.fillRect(0, 0, 200, 100); c.fillStyle = '#a08050'; c.fillRect(0, 50, 200, 50); t.touch(l); t.commit('p');
  const n0 = t.state.doc.layers.length;
  const g1 = t.autoEnhanceCmd({ wb: true, tone: true, contrast: true, color: true, strength: 100 }); const k1 = g1 ? g1.steps.length : 0; t.undo();
  const g2 = t.autoEnhanceCmd({ wb: false, tone: true, contrast: false, color: false, strength: 100 }); const k2 = g2 ? g2.steps.length : 0; t.undo();
  const w1 = t.autoWhiteBalanceCmd({ strength: 100, warmth: 0 }); const T1 = w1?.temperature; t.undo();
  const w2 = t.autoWhiteBalanceCmd({ strength: 50, warmth: 0 }); const T2 = w2?.temperature; t.undo();
  const w3 = t.autoWhiteBalanceCmd({ strength: 100, warmth: 10 }); const T3 = w3?.temperature; t.undo();
  t.openAutoOptionsDialog('enhance'); const dlg = document.querySelector('#modalTitle').textContent; document.querySelector('#modal button')?.click();
  return { k1, k2, T1, T2, T3, back: t.state.doc.layers.length === n0, dlg };
});
check(ao.k1 > ao.k2 && ao.k2 >= 1, `auto enhance options pick which fixes run (${ao.k1} vs ${ao.k2} adjustments)`);
check(ao.T1 != null && Math.abs(ao.T2 - Math.round(ao.T1 / 2)) <= 1 && ao.T3 === Math.min(100, ao.T1 + 10), `white balance strength / warmth (${ao.T1}, ${ao.T2}, ${ao.T3})`);
check(/auto/i.test(ao.dlg), `options dialog opens ("${ao.dlg}")`);
await page.keyboard.press('Escape');

// menus
const menus = await page.evaluate(() => [...document.querySelectorAll('#menubar .menu-title, #menubar > *')].map((e) => e.textContent.trim().split('\n')[0]).join('|'));
check(/Actions/.test(menus), 'Actions menu present');

// screenshots
await page.evaluate(async () => {
  const t = window.tintwork; while (t.tabs.length > 1) await t.closeTab(0, { force: true });
  const scene = (name, hue) => { t.newDocument(1200, 800, 'white', name); const l = t.activeLayer(), c = l.canvas.getContext('2d');
    const sky = c.createLinearGradient(0, 0, 0, 450); sky.addColorStop(0, `hsl(${hue},45%,55%)`); sky.addColorStop(1, '#e8d2b0'); c.fillStyle = sky; c.fillRect(0, 0, 1200, 800);
    c.fillStyle = '#34505f'; c.fillRect(0, 450, 1200, 350); c.fillStyle = '#f0b860'; c.beginPath(); c.arc(820, 330, 60, 0, 7); c.fill();
    c.fillStyle = '#26382a'; c.beginPath(); c.moveTo(0, 460); c.lineTo(300, 250); c.lineTo(560, 460); c.fill(); t.touch(l); t.commit('scene'); };
  scene('Harbour.jpg', 210); scene('Ridge.jpg', 260); scene('Dunes.jpg', 30); t.closeTab(0, { force: true });
  t.switchTab(1); t.setTool('crop'); t.setCropPreset('portrait45'); t.fitToScreen();
});
await page.waitForTimeout(600);
await page.screenshot({ path: 'screenshots/9x-tabs-crop-presets.png' });
await page.evaluate(() => { const t = window.tintwork; t.setTool('move'); t.run('batch'); });
await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/9x-batch-dialog.png' });
await page.keyboard.press('Escape');
await page.evaluate(() => window.tintwork.run('exportMulti')); await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/9x-export-sizes.png' }); await page.keyboard.press('Escape');
await page.evaluate(() => window.tintwork.run('actions')); await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/9x-actions.png' }); await page.keyboard.press('Escape');
await page.evaluate(() => window.tintwork.run('resizePresets')); await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/9x-resize-presets.png' }); await page.keyboard.press('Escape');
check(!errors.length, `no page errors ${errors.join(' | ')}`);

await browser.close(); server.close();
console.log(fails ? `\n${fails} v0.9 check(s) FAILED` : '\nAll v0.9 checks passed.');
process.exit(fails ? 1 : 0);
