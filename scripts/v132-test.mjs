// v1.32: Safe Auto upright (kept-% shown; below 60% a choice: Apply crop / Fill edges / Cancel; upright + crop
// is one undo step; Auto / Level / Vertical / Full are recordable in Actions and replay in batch) and first-run
// fixes (start on Hand, Ctrl+S asks photo vs project for a single opened image, Export defaults to the source
// format and name, HEIC gets a specific message). The upright math is unchanged: kept % equals v1.31's crop.
// v131-canyon / v131-white are held-out: observed only (no threshold was set from them; 60% came from the brief).
// TW_ROOT / TW_URL supported. SHOTS=<prefix> saves screenshots (e.g. SHOTS=132-live).
import { chromium, webkit } from 'playwright';
import path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const SHOTS = process.env.SHOTS || '', shotDir = path.join(HERE, 'screenshots'); mkdirSync(shotDir, { recursive: true });
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;

{
  try { const b = await webkit.launch(); const p = await b.newPage(); await p.goto('about:blank'); const ua = await p.evaluate(() => navigator.userAgent); check(/WebKit/i.test(ua), `WebKit launches (${ua.slice(0, 60)}…)`); await b.close(); }
  catch (e) { check(false, `WebKit launches (${e.message.slice(0, 80)})`); }
}

const browser = await chromium.launch();
const errors = [];
async function freshPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  // like smoke-test: no File System Access pickers, so saves and exports are downloads the test can read
  await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; delete window.showDirectoryPicker; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}?platform=win`);
  await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  await page.evaluate(() => window.tintwork.engineReady);
  return page;
}
const T = (page, f, a) => page.evaluate(f, a);
async function open(page, file, as = file, type = 'image/jpeg') {
  await page.setInputFiles('#fileInput', { name: as, mimeType: type, buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name === n, as);
  await T(page, () => window.tintwork.idle());
}
async function menu(page, title, item) {
  await page.locator('#menus .menu > button', { hasText: new RegExp(`^${title}$`) }).click();
  await page.locator('#menus .menu.open .menu-items button', { hasText: item }).first().click();
}
const modalOpen = (page) => T(page, () => !document.querySelector('#modal').classList.contains('hidden'));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(shotDir, `${SHOTS}-${name}.png`) }); };
const waitUprightDone = (page) => page.waitForFunction(() => { const u = window.tintwork.lastUpright; return !window.tintwork.mxf && u && (u.mode === 'none' || u.cancelled || u.crop || u.filled || u.kept != null) && !window.tintwork.state.busy; }, null, { timeout: 60000 });

let page = await freshPage();
const ver = await T(page, () => window.tintwork.APP_VERSION);
check((ver === '1.32.0' || ver === '1.33.0'), `APP_VERSION is 1.32.0 (${ver})`);
if (!process.env.TW_URL) { const m = readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/tintwork-shell-v([\d.]+)/); check((m?.[1] === '1.32.0' || m?.[1] === '1.33.0'), `SW CACHE is 1.32.0 (${m?.[1]})`); }
else { const r = await page.request.get(`${BASE}sw.js`); const m = (await r.text()).match(/tintwork-shell-v([\d.]+)/); check((m?.[1] === '1.32.0' || m?.[1] === '1.33.0'), `live SW CACHE is 1.32.0 (${m?.[1]})`); }

// ---- B1: the starting tool does not paint ----------------------------------------------------------
check(await T(page, () => window.tintwork.state.tool) === 'hand', `starting tool is Hand (${await T(page, () => window.tintwork.state.tool)})`);
check(await T(page, () => document.querySelector('#toolbar button[data-tool="hand"]')?.classList.contains('active') || document.querySelector('#toolbar button[data-tool="hand"]')?.getAttribute('aria-pressed') === 'true'), 'Hand is highlighted in the toolbar');
await open(page, 'v131-white.jpg');
const px0 = await T(page, async () => { const t = window.tintwork; return { h: t.history.entries.length, p: await t.compositePixelAsync(640, 480) }; });
const vb = await page.locator('#viewport').boundingBox();
await page.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2);
await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2); await page.mouse.down(); await page.mouse.move(vb.x + vb.width / 2 + 60, vb.y + vb.height / 2 + 40, { steps: 5 }); await page.mouse.up();
const px1 = await T(page, async () => { const t = window.tintwork; return { h: t.history.entries.length, p: await t.compositePixelAsync(640, 480), tool: t.state.tool }; });
check(px1.h === px0.h && px1.p.join() === px0.p.join(), `clicking and dragging the opened photo changes nothing (history ${px0.h}→${px1.h}, pixel ${px0.p}→${px1.p})`);

// ---- B2: Export defaults to the source format and file name ----------------------------------------
await page.keyboard.press('Control+Shift+E'); await page.waitForSelector('#modal:not(.hidden) #eFmt');
const ex = await T(page, () => ({ fmt: document.querySelector('#eFmt').value, name: document.querySelector('#eName').value }));
check(ex.fmt === 'image/jpeg' && ex.name === 'v131-white', `JPEG in → Export defaults to JPEG with the source name (${ex.fmt}, ${ex.name})`);
await T(page, () => window.tintwork.closeModal());

// ---- B3: Ctrl+S on a single opened image asks photo vs project ----------------------------------------
await page.locator('#viewport').click({ position: { x: 20, y: 20 } });
await page.keyboard.press('Control+s');
await page.waitForSelector('#modal:not(.hidden) #saveChoice', { timeout: 5000 }).catch(() => {});
const sc = await T(page, () => ({ title: document.querySelector('#modalTitle').textContent, ok: document.querySelector('#modalOk').textContent, proj: !!document.querySelector('#saveChoiceProject'), body: document.querySelector('#modalBody').innerText }));
check(/photo or project/i.test(sc.title) && /Export as image \(JPEG\)/.test(sc.ok) && sc.proj, `Ctrl+S on one opened JPEG offers Export as image (JPEG) or Save project (${sc.title} | ${sc.ok})`);
await shot(page, 'ctrl-s-choice');
await page.click('#modalOk');
await page.waitForSelector('#modal:not(.hidden) #eFmt', { timeout: 5000 });
const ex2 = await T(page, () => ({ fmt: document.querySelector('#eFmt').value, name: document.querySelector('#eName').value }));
check(ex2.fmt === 'image/jpeg' && ex2.name === 'v131-white', `Export as image opens Export with JPEG + source name (${ex2.fmt}, ${ex2.name})`);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#modalOk')]);
check(/^v131-white\.jpe?g$/.test(dl.suggestedFilename()), `…and downloads a JPEG named after the source (${dl.suggestedFilename()})`);
// Save project from the same choice
await page.keyboard.press('Control+s'); await page.waitForSelector('#modal:not(.hidden) #saveChoiceProject');
const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#saveChoiceProject')]);
check(/\.tintwork$/.test(dl2.suggestedFilename()), `Save project from the choice saves ${dl2.suggestedFilename()}`);
const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.keyboard.press('Control+s')]).catch(() => [null]);
check(dl3 && /\.tintwork$/.test(dl3.suggestedFilename()) && !(await modalOpen(page)), 'after saving a project once, Ctrl+S saves the project directly');
// a layered document: Ctrl+S is Save project straight away
await T(page, () => { const t = window.tintwork; t.newDocument(300, 200, 'white', 'layers'); t.run('layerNew'); });
const [dl4] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.keyboard.press('Control+s')]).catch(() => [null]);
check(dl4 && /\.tintwork$/.test(dl4.suggestedFilename()) && !(await modalOpen(page)), `a 2-layer document: Ctrl+S saves the project without asking (${dl4?.suggestedFilename()})`);
const fileMenu = await T(page, () => { const t = window.tintwork; return [t.hasProjectFeatures(), typeof t.cmds.save, typeof t.cmds.saveProject]; });
check(fileMenu.join() === 'true,function,function', `File ▸ Save… (Ctrl+S) and Save project both exist (${fileMenu})`);
// PNG in → PNG out
await page.setInputFiles('#fileInput', { name: 'flat.png', mimeType: 'image/png', buffer: Buffer.from(await T(page, () => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; c.getContext('2d').fillRect(0, 0, 10, 10); return Array.from(atob(c.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0)); })) });
await page.waitForFunction(() => window.tintwork.doc?.name === 'flat.png');
await page.keyboard.press('Control+Shift+E'); await page.waitForSelector('#modal:not(.hidden) #eFmt');
check(await T(page, () => document.querySelector('#eFmt').value) === 'image/png', 'PNG in → Export defaults to PNG');
await T(page, () => window.tintwork.closeModal());

// ---- B4: HEIC ---------------------------------------------------------------------------------------
for (const [name, type] of [['IMG_0001.HEIC', 'image/heic'], ['photo.heic', '']]) {
  const before = await T(page, () => window.tintwork.doc?.name);
  await page.setInputFiles('#fileInput', { name, mimeType: type || 'application/octet-stream', buffer: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0, 109, 105, 102, 49, 104, 101, 105, 99]) });
  await page.waitForSelector('#modal:not(.hidden) #heicMsg', { timeout: 8000 }).catch(() => {});
  const h = await T(page, () => ({ msg: document.querySelector('#modalBody')?.innerText || '', st: document.querySelector('#status').textContent, name: window.tintwork.doc?.name }));
  check(/HEIC isn’t supported in this browser/.test(h.msg) && /Most Compatible/.test(h.msg) && /JPEG/.test(h.msg) && h.name === before, `${name} (${type || 'no type'}): specific HEIC message with the Most Compatible / JPEG steps; open document unchanged`);
  if (name === 'IMG_0001.HEIC') await shot(page, 'heic');
  await T(page, () => window.tintwork.closeModal());
}
await page.context().close();

// ---- A: safe Auto upright ----------------------------------------------------------------------------
const kept = {};
page = await freshPage();
await open(page, 'v128-towers.jpg');
await menu(page, 'Image', 'Auto upright');
await page.waitForSelector('#modal:not(.hidden) #uprightKeepAsk', { timeout: 60000 });
const ask = await T(page, () => ({ pct: document.querySelector('#uprightKeptPct').textContent, ok: document.querySelector('#modalOk').textContent, cancel: document.querySelector('#modalCancel').textContent, fill: !!document.querySelector('#uprightFillBtn'), title: document.querySelector('#modalTitle').textContent }));
check(ask.pct === '27%' && /Apply \(crop to 27%\)/.test(ask.ok) && ask.cancel === 'Cancel' && ask.fill, `towers: Auto upright stops at a choice: kept ${ask.pct}; ${ask.ok} / Fill edges / ${ask.cancel}`);
await shot(page, 'upright-low-kept');
await page.click('#modalCancel'); await waitUprightDone(page);
const c0 = await T(page, () => { const t = window.tintwork; return { w: t.doc.width, h: t.doc.height, hist: t.history.entries.map((e) => e.label), idx: t.history.index, lw: t.doc.layers[0].canvas.width }; });
check(c0.w === 853 && c0.h === 1280 && c0.hist.join('|') === 'Open' && c0.idx === 0 && c0.lw === 853, `Cancel leaves the photo as it was, no history or redo entry (${c0.w}×${c0.h}, ${c0.hist.join('|')})`);
// Apply crop → one undo step
await menu(page, 'Image', 'Auto upright'); await page.waitForSelector('#modal:not(.hidden) #uprightKeepAsk', { timeout: 60000 });
await page.click('#modalOk'); await waitUprightDone(page);
const c1 = await T(page, () => { const t = window.tintwork; return { w: t.doc.width, h: t.doc.height, hist: t.history.entries.map((e) => e.label), st: document.querySelector('#status').textContent, kept: t.lastUpright.kept }; });
kept['v128-towers'] = c1.kept;
check(c1.w === 441 && c1.h === 662 && c1.hist.length === 2 && /^Upright/.test(c1.hist[1]), `Apply crops to ${c1.w}×${c1.h} as ONE undo step (${c1.hist.join(' | ')})`);
check(/27% of the photo kept/.test(c1.st), `status shows the kept share (${c1.st.slice(0, 110)})`);
await page.keyboard.press('Control+z'); await T(page, () => window.tintwork.idle());
const c2 = await T(page, () => { const t = window.tintwork; return { w: t.doc.width, h: t.doc.height, idx: t.history.index, lw: t.doc.layers[0].canvas.width, lx: t.doc.layers[0].x }; });
check(c2.w === 853 && c2.h === 1280 && c2.idx === 0 && c2.lw === 853 && c2.lx === 0, `one Ctrl+Z undoes upright and crop together (${c2.w}×${c2.h}, layer ${c2.lw})`);
// Fill edges → full canvas, opaque corners, one undo
await menu(page, 'Image', 'Auto upright'); await page.waitForSelector('#modal:not(.hidden) #uprightKeepAsk', { timeout: 60000 });
await page.click('#uprightFillBtn'); await waitUprightDone(page);
const c3 = await T(page, async () => { const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), x = c.getContext('2d'); const a = (X, Y) => x.getImageData(X, Y, 1, 1).data[3]; return { w: t.doc.width, h: t.doc.height, hist: t.history.entries.map((e) => e.label), corners: [a(1, 1), a(c.width - 2, 1), a(1, c.height - 2), a(c.width - 2, c.height - 2)], filled: t.lastUpright.filled }; });
check(c3.w === 853 && c3.h === 1280 && c3.filled && c3.corners.every((v) => v === 255) && c3.hist.length === 2 && /edges filled/.test(c3.hist[1]), `Fill edges keeps 853×1280 with opaque corners, one undo step (${c3.corners}; ${c3.hist.join(' | ')})`);
await shot(page, 'upright-filled');
await page.context().close();

// kept % per photo (keyboard/menu path with the dialog answered "Apply"); geometry unchanged from v1.31
const BASELINE_V131 = { 'v128-towers': [441, 662, 26.7], 'v130-below': [963, 639, 56.6], 'v131-canyon': [642, 428, 25.2], 'v131-white': [1259, 946, 96.7], c4: [1101, 1528, 74.0] };
for (const p of ['v130-below', 'v131-canyon', 'v131-white', 'c4']) {
  page = await freshPage(); await open(page, `${p}.jpg`);
  await T(page, () => { window.tintwork.run('autoUpright'); });
  const asked = await page.waitForSelector('#modal:not(.hidden) #uprightKeepAsk', { timeout: 60000 }).then(() => true).catch(() => false);
  if (asked) await page.click('#modalOk');
  await waitUprightDone(page);
  const r = await T(page, () => { const t = window.tintwork; return { w: t.doc.width, h: t.doc.height, kept: t.lastUpright.kept, n: t.history.entries.length, st: document.querySelector('#status').textContent }; });
  kept[p] = r.kept; const b = BASELINE_V131[p];
  const shouldAsk = b[2] < 60;
  check(r.w === b[0] && r.h === b[1] && Math.abs(r.kept * 100 - b[2]) < 0.15 && r.n === 2 && asked === shouldAsk, `${p}${/v131-(canyon|white)/.test(p) ? ' (held-out, observed)' : ''}: kept ${(r.kept * 100).toFixed(1)}% (v1.31 ${b[2]}%), ${r.w}×${r.h}, ${asked ? 'asked first' : 'applied directly'}, one undo`);
  await page.context().close();
}
console.log('KEPT', JSON.stringify(kept));

// ---- A: record Auto upright in an action, replay, batch ---------------------------------------------
page = await freshPage();
await open(page, 'v128-towers.jpg');
await menu(page, 'Actions', 'Start recording');
await menu(page, 'Image', 'Auto upright'); await page.waitForSelector('#modal:not(.hidden) #uprightKeepAsk', { timeout: 60000 });
await page.click('#uprightFillBtn'); await waitUprightDone(page);
await T(page, () => window.tintwork.run('uprightLevel')); await page.waitForTimeout(200); await waitUprightDone(page);
const rec = await T(page, () => { const t = window.tintwork; const steps = JSON.parse(JSON.stringify(t.recorder.steps)); const a = t.stopRecording('Upright test'); return { steps, desc: steps.map(t.describeStep), id: a?.id, badge: document.querySelector('#recBadge')?.textContent }; });
check(rec.steps[0]?.t === 'upright' && rec.steps[0].req === 'auto' && rec.steps[0].edges === 'crop' && rec.steps[0].low === 'fill', `Auto upright is recorded with its edge choice (${rec.desc.join(' ; ')})`);
check(rec.steps.length >= 1 && rec.steps.every((s) => s.t === 'upright'), `recorded ${rec.steps.length} upright step(s); Level is recordable too when it applies (${rec.steps.map((s) => s.req).join(',')})`);
// replay on a fresh copy of another photo (below: 57% kept → recorded "fill" is used, no dialog)
await open(page, 'v130-below.jpg');
const rp = await T(page, async (id) => { const t = window.tintwork; const r = await t.playAction(id); return { r, w: t.doc.width, h: t.doc.height, filled: t.lastUpright?.filled, modal: !document.querySelector('#modal').classList.contains('hidden'), hist: t.history.entries.map((e) => e.label) }; }, rec.id);
check(rp.r.ok && !rp.modal && rp.hist.some((h) => /^Upright \(edges filled\)/.test(h)) && rp.w === 1280 && rp.h === 850, `replay on v130-below: no dialog, recorded Fill edges used for the 57%-kept Auto step (${rp.w}×${rp.h}; ${rp.hist.join(' | ')}; ${rp.r.steps} steps, Level refused or applied as the photo needs)`);
// batch: Auto upright action (crop) on white (97%) and towers (27%, recorded low choice = crop)
const batch = await T(page, async (bufs) => {
  const t = window.tintwork;
  const act = { id: 'u-test-crop', name: 'Upright crop', steps: [{ t: 'upright', req: 'auto', edges: 'crop' }] };
  localStorage.setItem('tintwork.actions', JSON.stringify([...t.userActions(), act]));
  const files = bufs.map(([n, b]) => new File([new Uint8Array(b)], n, { type: 'image/jpeg' }));
  const s = t.memorySink();
  const r = await t.runBatch(files, { actionId: 'u-test-crop', variants: [{ mode: 'original', type: 'image/jpeg' }], pattern: '{name}', sink: s });
  const out = {}; for (const [n, f] of Object.entries(s.files)) { const bm = await createImageBitmap(f.blob); out[n] = [bm.width, bm.height]; }
  return { done: r.done, failed: r.failed.map((f) => f.name), out, modal: !document.querySelector('#modal').classList.contains('hidden') };
}, [['white.jpg', [...REAL('v131-white.jpg')]], ['towers.jpg', [...REAL('v128-towers.jpg')]]]);
const dims = Object.values(batch.out).map((d) => d.join('×')).sort();
check(batch.done === 2 && !batch.failed.length && !batch.modal && dims.includes('1259×946') && dims.includes('441×662'), `batch replays Auto upright on 2 photos without a dialog (${JSON.stringify(batch.out)})`);
await page.context().close();

check(!errors.length, `no page errors (${errors.slice(0, 2).join(' | ')})`);
await browser.close(); server.close();
console.log(`\nv132: ${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
