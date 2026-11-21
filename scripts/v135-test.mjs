// v1.35: the rest of persona-test-v131 finding 10.
// A) History snapshots: one is made of the opened state; ＋ Snapshot, the context menus (snapshot rows and history
//    rows: "New snapshot from this step"), rename, restore (an undoable step) and delete, all with the mouse.
// B) History brush (Y): paints the chosen snapshot's pixels of the active layer back, with size / hardness /
//    opacity / smoothing; picks its source from the options bar or the brush icon on a snapshot row; explains
//    itself when the layer did not exist in the snapshot or the canvas size changed; 16-bit documents too.
// C) Keyboard: Tab reaches the snapshot list (roving rows like v1.33): ↑ ↓, Enter restores, B sets the brush
//    source, F2 renames, Delete removes, Shift+F10 opens the row's menu.
// D) Snapshots survive the autosave (close the tab, reopen, recover) and the project file (save, reopen), and the
//    History brush still pairs their layers with the document's; a v8 project without snapshots still opens.
// E) Smooth skin: Filter ▸ Smooth skin layer adds an edge-preserving smoothing layer with a black mask and readies
//    the Brush (white, on the mask), so smoothing a cheek is one command + painting (the persona test needed 6
//    steps). Its arithmetic is checked on a synthetic edge + noise image (noise down, edge kept, Detail keeps
//    texture), the strip-wise processing equals one pass, 16-bit works, and the direct command respects a selection.
// F) Actions / Batch: Vibrance, Shadows / highlights, Color balance and Smooth skin, as direct adjustments and as
//    adjustment layers, record into an action and replay to the same pixels with playAction and in Batch (PNG out).
// G) axe-core: 0 serious / critical with the snapshot list, its menu and the Smooth skin dialog open.
// Not covered: real Windows hardware, a real screen reader, GPU shaders for Smooth skin (it composites on the
// CPU, like the v1.34 adjustments). TW_ROOT / TW_URL supported. SHOTS=<prefix> saves screenshots.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const SHOTS = process.env.SHOTS || '', shotDir = path.join(HERE, 'screenshots'); mkdirSync(shotDir, { recursive: true });
const axeSrc = readFileSync(path.join(HERE, 'node_modules/axe-core/axe.min.js'), 'utf8');
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;
const errors = [];
const T = (page, f, a) => page.evaluate(f, a);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(shotDir, `${SHOTS}-${name}.png`) }); };
async function newPage(ctx, tag) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  await page.goto(`${BASE}?platform=win`);
  await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  await page.evaluate(() => window.tintwork.engineReady);
  return page;
}
async function freshContext(browser, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, bypassCSP: true, viewport: { width: 1366, height: 768 }, ...opts }); // bypassCSP: only so axe-core can be injected
  await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; delete window.showDirectoryPicker; });
  return ctx;
}
async function open(page, file, as = file) {
  await page.setInputFiles('#fileInput', { name: as, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name === n, as);
  await T(page, () => window.tintwork.idle()); await page.waitForTimeout(150);
}
async function axe(page) {
  if (!(await T(page, () => !!window.axe))) await page.addScriptTag({ content: axeSrc });
  return T(page, async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, where: v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ') })));
}
const sev = (vs) => vs.filter((v) => v.impact === 'serious' || v.impact === 'critical');
const fmt = (vs) => vs.map((v) => `${v.id}:${v.impact} at ${v.where}`).join(', ') || 'none';
async function menu(page, title, item) {
  await page.locator('#menus .menu > button', { hasText: new RegExp(`^${title}$`) }).click();
  await page.locator('#menus .menu.open .menu-items button', { hasText: item }).first().click();
}
async function setParam(page, key, v) {
  if (/^[smh](CR|MG|YB)$/.test(key)) await page.click(`#modalBody .cb-tones button[data-cbtone="${key[0]}"]`); // Color balance: pick the tone range tab first
  const n = page.locator(`#modalBody input.pf-num[data-num-key="${key}"]`);
  await n.fill(String(v)); await n.press('Tab');
}
const active = (page) => T(page, () => { const a = document.activeElement; return { tag: a?.tagName, rove: a?.dataset?.rove || '', snap: a?.dataset?.snap || '', text: (a?.textContent || '').trim().slice(0, 40), fv: (() => { try { return a.matches(':focus-visible'); } catch { return false; } })() }; });
async function tabUntil(page, pred, max = 90) { for (let i = 1; i <= max; i++) { await page.keyboard.press('Tab'); const a = await active(page); if (pred(a)) return { n: i, a }; } return { n: -1, a: await active(page) }; }
/** Composite pixel (RGBA) at document coordinates. */
const px = (page, x, y) => T(page, ([x, y]) => [...window.tintwork.compositeCanvas().getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
/** Mean |difference| and max over a document rectangle between the composite now and a saved copy. */
const grab = (page, key) => T(page, (k) => { const c = window.tintwork.compositeCanvas(); (window.__g ||= {})[k] = c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(); }, key);
const diff = (page, key, rect = null) => T(page, ([k, r]) => {
  const c = window.tintwork.compositeCanvas(), W = c.width, H = c.height, a = c.getContext('2d').getImageData(0, 0, W, H).data, b = window.__g[k];
  if (!b || b.length !== a.length) return { mean: 999, max: 999, n: 0 };
  const R = r || { x: 0, y: 0, w: W, h: H }; let s = 0, m = 0, n = 0;
  for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) { const i = (y * W + x) * 4; for (let ch = 0; ch < 3; ch++) { const d = Math.abs(a[i + ch] - b[i + ch]); s += d; if (d > m) m = d; } n++; }
  return { mean: s / (n * 3), max: m, n };
}, [key, rect]);
const toScreen = (page, x, y) => T(page, ([x, y]) => { const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state; return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom }; }, [x, y]);
/** A mouse drag along document points. */
async function stroke(page, pts) {
  const p0 = await toScreen(page, ...pts[0]); await page.mouse.move(p0.x, p0.y); await page.mouse.down();
  for (const q of pts.slice(1)) { const s = await toScreen(page, ...q); await page.mouse.move(s.x, s.y, { steps: 6 }); }
  await page.mouse.up(); await T(page, () => window.tintwork.idle()); await page.waitForTimeout(80);
}
const snaps = (page) => T(page, () => ({ names: window.tintwork.snapshots.map((s) => s.name), src: window.tintwork.snapById(window.tintwork.histSrc)?.name || null, rows: [...document.querySelectorAll('#snapshotList li')].map((li) => li.querySelector('.snap-name').textContent) }));
const lastLabel = (page) => T(page, () => window.tintwork.history.entries[window.tintwork.history.index]?.label);
const axeCounts = {};

const browser = await chromium.launch();
// ================================ version ======================================================================
{
  const ctx = await freshContext(browser); const page = await newPage(ctx, 'version');
  const ver = await T(page, () => window.tintwork.APP_VERSION);
  check(ver === '1.35.0', `APP_VERSION is 1.35.0 (${ver})`);
  if (!process.env.TW_URL) { const m = readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/tintwork-shell-v([\d.]+)/); check(m?.[1] === '1.35.0', `SW CACHE is 1.35.0 (${m?.[1]})`); }
  else { const r = await page.request.get(`${BASE}sw.js`); const t = await r.text(); const m = t.match(/tintwork-shell-v([\d.]+)/); check(m?.[1] === '1.35.0', `live SW CACHE is 1.35.0 (${m?.[1]})`); }
  await ctx.close();
}
const ctx = await freshContext(browser); let page = await newPage(ctx, 'main');
// ================================ A: snapshots with the mouse ==================================================
await open(page, 'portrait-usda.jpg', 'portrait.jpg');
await grab(page, 'orig');
{
  const s0 = await snaps(page);
  check(s0.names.length === 1 && s0.names[0] === 'Original' && s0.src === 'Original' && s0.rows[0] === 'Original', `opening makes snapshot "Original" and it is the History brush source (${JSON.stringify(s0)})`);
  await page.click('#toolbar button[data-tool="brush"]'); await T(page, () => { window.tintwork.setFg('#ff0000'); Object.assign(window.tintwork.state.opts, { brushSize: 60, brushHardness: 100, brushOpacity: 100 }); });
  await stroke(page, [[300, 660], [420, 660]]);
  const red = await px(page, 360, 660);
  check(red[0] > 240 && red[1] < 20, `a red brush stroke on the cheek (pixel ${red.slice(0, 3)})`);
  await page.click('#historyPanel [data-cmd="snapshotNew"]'); await page.waitForTimeout(80);
  const s1 = await snaps(page);
  check(s1.names.length === 2 && s1.rows[1] === s1.names[1] && /^Snapshot 2$/.test(s1.names[1]), `＋ Snapshot adds "${s1.names[1]}" to the History panel (${s1.rows.join(', ')})`);
  await stroke(page, [[560, 480], [680, 480]]); // second stroke on the forehead
  await grab(page, 'two');
  await page.locator('#snapshotList li', { hasText: 'Original' }).click(); await page.waitForTimeout(120);
  const d0 = await diff(page, 'orig'), l0 = await lastLabel(page);
  check(d0.max === 0 && l0 === 'Restore snapshot “Original”', `clicking "Original" brings the opened state back exactly (max diff ${d0.max}); history step "${l0}"`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(120);
  const d1 = await diff(page, 'two');
  check(d1.max === 0, `Ctrl+Z undoes the restore (both strokes back, max diff ${d1.max})`);
  await shot(page, 'snapshots-panel');
  // rename through the row's context menu
  const row = page.locator('#snapshotList li', { hasText: 'Snapshot 2' });
  await row.click({ button: 'right' }); await page.waitForSelector('#ctxMenu');
  const items = await T(page, () => [...document.querySelectorAll('#ctxMenu button')].map((b) => b.textContent));
  check(['Restore this snapshot', 'Use as History brush source', 'Rename snapshot…', 'Delete snapshot', 'New snapshot (current state)'].every((x) => items.includes(x)), `right-click on a snapshot: ${items.join(' · ')}`);
  await shot(page, 'snapshot-menu');
  axeCounts.menu = sev(await axe(page));
  await page.locator('#ctxMenu button', { hasText: 'Rename snapshot…' }).click();
  await page.fill('#snapRenameInput', 'Red cheek'); await page.keyboard.press('Enter'); await page.waitForTimeout(80);
  const s2 = await snaps(page);
  check(s2.names[1] === 'Red cheek' && s2.rows[1] === 'Red cheek', `Rename snapshot… renames it (${s2.rows.join(', ')})`);
  // a snapshot of an older history step, from the history row's context menu
  await page.locator('#historyList li').first().click({ button: 'right' }); await page.waitForSelector('#ctxMenu');
  await page.locator('#ctxMenu button', { hasText: 'New snapshot from this step' }).click(); await page.waitForTimeout(80);
  const s3 = await snaps(page), hi = await T(page, () => window.tintwork.history.index);
  check(s3.names.length === 3, `right-click a history row ▸ New snapshot from this step adds "${s3.names[2]}" without moving the current step (index ${hi})`);
  await page.locator('#snapshotList li').nth(2).click(); await page.waitForTimeout(100);
  const d2 = await diff(page, 'orig');
  check(d2.max === 0, `that snapshot holds the opened state (max diff ${d2.max} vs the original)`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(100);
  // delete with the panel's trash button (the selected snapshot = the one last used)
  await page.click('#historyPanel [data-cmd="snapshotDelete"]'); await page.waitForTimeout(80);
  const s4 = await snaps(page);
  check(s4.names.length === 2 && !s4.names.includes(s3.names[2]), `🗑 deletes the selected snapshot (${s4.rows.join(', ')})`);
  const hb = await T(page, () => { const p = document.querySelector('#historyPanel').getBoundingClientRect(), l = document.querySelector('#historyList').getBoundingClientRect(); return { bottom: Math.round(p.bottom), h: Math.round(l.height), vh: innerHeight }; });
  check(hb.bottom <= hb.vh && hb.h >= 60, `1366×768: the History panel with snapshots fits on screen and still shows history rows (${JSON.stringify(hb)})`);
}
// ================================ B: History brush ============================================================
{
  await page.keyboard.press('y'); await page.waitForTimeout(60);
  const tool = await T(page, () => window.tintwork.state.tool);
  check(tool === 'histbrush', `Y picks the History brush (${tool})`);
  const bar = await T(page, () => ({ opts: [...document.querySelectorAll('#histSrcSel option')].map((o) => o.textContent), sel: document.querySelector('#histSrcSel')?.selectedOptions[0]?.textContent, title: document.querySelector('#optionsbar .tool-title')?.textContent }));
  check(bar.sel === 'Original' && bar.opts.includes('Red cheek'), `options bar: Source ${JSON.stringify(bar.opts)}, chosen "${bar.sel}"`);
  await T(page, () => Object.assign(window.tintwork.state.opts, { histbrushSize: 80, histbrushHardness: 100, histbrushOpacity: 100, smoothing: 0 }));
  await stroke(page, [[300, 660], [420, 660]]);
  const back = await diff(page, 'orig', { x: 330, y: 650, w: 60, h: 20 }), keep = await diff(page, 'two', { x: 590, y: 470, w: 60, h: 20 });
  const lab = await lastLabel(page);
  check(back.max <= 1 && keep.max === 0 && lab === 'History brush (from “Original”)', `painting over the red stroke brings the original skin back (max diff ${back.max}); the forehead stroke is untouched (${keep.max}); step "${lab}"`);
  // 50 % opacity: half way between now and the snapshot
  await T(page, () => { window.tintwork.state.opts.histbrushOpacity = 50; });
  const before = await px(page, 620, 480), orig = await T(page, () => [...window.__g.orig.slice((480 * window.tintwork.doc.width + 620) * 4, (480 * window.tintwork.doc.width + 620) * 4 + 3)]);
  await stroke(page, [[560, 480], [680, 480]]);
  const half = await px(page, 620, 480), want = before.slice(0, 3).map((v, i) => (v + orig[i]) / 2);
  check(half.slice(0, 3).every((v, i) => Math.abs(v - want[i]) <= 2), `at 50% opacity the forehead goes half way back (${half.slice(0, 3)} vs expected ${want.map(Math.round)})`);
  await shot(page, 'history-brush');
  // pick another source with the brush icon on its row
  await page.locator('#snapshotList li', { hasText: 'Red cheek' }).locator('.snap-src').click(); await page.waitForTimeout(60);
  const src = await T(page, () => ({ src: window.tintwork.snapById(window.tintwork.histSrc)?.name, sel: document.querySelector('#histSrcSel')?.selectedOptions[0]?.textContent, pressed: document.querySelector('#snapshotList li.src .snap-src')?.getAttribute('aria-pressed') }));
  check(src.src === 'Red cheek' && src.sel === 'Red cheek' && src.pressed === 'true', `the brush icon on "Red cheek" makes it the source (options bar follows: ${JSON.stringify(src)})`);
  await T(page, () => { window.tintwork.state.opts.histbrushOpacity = 100; });
  await stroke(page, [[300, 660], [420, 660]]);
  const red2 = await px(page, 360, 660);
  check(red2[0] > 240 && red2[1] < 20, `painting from "Red cheek" brings the red stroke back (${red2.slice(0, 3)})`);
  // the options bar select changes the source too
  await page.selectOption('#histSrcSel', { label: 'Original' }); await page.waitForTimeout(40);
  check((await T(page, () => window.tintwork.snapById(window.tintwork.histSrc)?.name)) === 'Original', 'the options bar Source list sets the source back to "Original"');
  // a layer that did not exist in the snapshot: a clear message, nothing painted
  await T(page, () => window.tintwork.run('layerNew')); await page.waitForTimeout(60);
  const h0 = await T(page, () => window.tintwork.history.entries.length);
  await stroke(page, [[300, 700], [360, 700]]);
  const msg = await T(page, () => document.querySelector('#status').textContent), h1 = await T(page, () => window.tintwork.history.entries.length);
  check(/did not exist in snapshot “Original”/.test(msg) && h1 === h0, `on a layer added after the snapshot: "${msg.slice(0, 90)}…" and no step added`);
  await T(page, () => window.tintwork.run('layerDelete')); await page.waitForTimeout(60);
  // cropped since the snapshot: refused with the reason
  await T(page, () => { const t = window.tintwork; t.cropTo({ x: 0, y: 0, w: 1000, h: 1200 }, 'Crop'); }); await page.waitForTimeout(80);
  await stroke(page, [[300, 700], [360, 700]]);
  const msg2 = await T(page, () => document.querySelector('#status').textContent);
  check(/different canvas size/.test(msg2), `after a crop: "${msg2.slice(0, 80)}…"`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(80);
}
// ================================ C: keyboard =================================================================
{
  await page.locator('#viewport').focus();
  const r = await tabUntil(page, (a) => a.rove === 'snapshot');
  check(r.n > 0 && r.a.fv, `Tab reaches the snapshot list (${r.n} Tabs from the canvas, on "${r.a.text}")`);
  await page.keyboard.press('Home'); const a0 = await active(page);
  await page.keyboard.press('ArrowDown'); const a1 = await active(page);
  check(a0.text === 'Original' && a1.text === 'Red cheek', `Home / ↓ move between snapshot rows (${a0.text} → ${a1.text})`);
  await page.keyboard.press('F2'); await page.waitForFunction(() => document.activeElement?.id === 'snapRenameInput');
  await page.keyboard.type('Cheek red'); await page.keyboard.press('Enter'); await page.waitForTimeout(80);
  check((await snaps(page)).names[1] === 'Cheek red', 'F2 renames the focused snapshot');
  await page.locator('#snapshotList li[data-rove][tabindex="0"]').focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('b'); await page.waitForTimeout(40);
  check((await T(page, () => window.tintwork.snapById(window.tintwork.histSrc)?.name)) === 'Cheek red', 'B makes the focused snapshot the History brush source');
  await page.keyboard.press('Enter'); await page.waitForTimeout(120);
  check((await lastLabel(page)) === 'Restore snapshot “Cheek red”', `Enter restores it (${await lastLabel(page)})`);
  await page.keyboard.press('Shift+F10'); await page.waitForSelector('#ctxMenu').catch(() => {});
  const m = await T(page, () => ({ open: !!document.querySelector('#ctxMenu'), focus: document.activeElement?.closest('#ctxMenu') ? document.activeElement.textContent : null }));
  check(m.open && m.focus === 'Restore this snapshot', `Shift+F10 opens the row's menu with focus on its first item (${JSON.stringify(m)})`);
  await page.keyboard.press('Escape');
  await page.locator('#snapshotList li[data-rove][tabindex="0"]').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
  await T(page, () => window.tintwork.addSnapshot('Temp')); await page.locator('#snapshotList li', { hasText: 'Temp' }).focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Delete'); await page.waitForTimeout(80);
  const s = await snaps(page), a2 = await active(page);
  check(!s.names.includes('Temp') && s.names.length === 2 && (a2.rove === 'snapshot' || a2.rove === 'history'), `Delete removes the focused snapshot and focus stays in the panel (${s.names.join(', ')}; focus ${a2.rove} "${a2.text}")`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(80);
  axeCounts.panel = sev(await axe(page));
}
// ================================ D: project file ============================================================
{
  const res = await T(page, async () => {
    const t = window.tintwork, data = await t.projectData(), json = JSON.stringify(data);
    const refs = data.snapshots.flatMap((s) => s.layers.map((l) => l.data)).filter((v) => /^@/.test(v)).length;
    const names = data.snapshots.map((s) => s.name), src = data.snapshots.find((s) => s.source)?.name;
    await t.loadProject(JSON.parse(json), 'portrait.tintwork'); await t.idle();
    return { v: data.version, names, src, refs, mb: +(json.length / 1048576).toFixed(2), after: t.snapshots.map((s) => s.name), afterSrc: t.snapById(t.histSrc)?.name, tabs: t.tabs.length };
  });
  check(res.v === 9 && res.after.join() === res.names.join() && res.afterSrc === res.src, `project file v${res.v}: snapshots ${JSON.stringify(res.names)} and source "${res.src}" come back after reopening (${res.mb} MB; ${res.refs} snapshot image(s) written as a reference to a document layer)`);
  // the History brush pairs the reopened snapshot layers with the reopened document layers
  await page.waitForTimeout(100); await page.click('#toolbar button[data-tool="histbrush"]');
  await page.selectOption('#histSrcSel', { label: 'Original' });
  await T(page, () => Object.assign(window.tintwork.state.opts, { histbrushSize: 80, histbrushHardness: 100, histbrushOpacity: 100 }));
  await stroke(page, [[300, 660], [420, 660]]);
  const back = await diff(page, 'orig', { x: 330, y: 650, w: 60, h: 20 });
  check(back.max <= 1, `after reopening the project the History brush still paints from "Original" (max diff ${back.max})`);
  // a v8 project (no snapshots) still opens and gets an "Original" snapshot
  const old = await T(page, async () => { const t = window.tintwork, data = await t.projectData(); delete data.snapshots; data.version = 8; for (const l of data.layers) delete l.uid; await t.loadProject(data, 'old.tintwork'); await t.idle(); return t.snapshots.map((s) => s.name); });
  check(old.length === 1 && old[0] === 'Original', `a version 8 project opens and gets snapshot ${JSON.stringify(old)}`);
}
await ctx.close();
// ================================ D: autosave =================================================================
{
  const c2 = await freshContext(browser); let p = await newPage(c2, 'autosave');
  await open(p, 'portrait-usda.jpg', 'portrait.jpg'); await grab(p, 'orig');
  await p.click('#toolbar button[data-tool="brush"]'); await T(p, () => { window.tintwork.setFg('#0000ff'); Object.assign(window.tintwork.state.opts, { brushSize: 60, brushHardness: 100, brushOpacity: 100 }); });
  await stroke(p, [[300, 660], [420, 660]]);
  await T(p, () => window.tintwork.addSnapshot('Blue cheek'));
  await stroke(p, [[560, 480], [680, 480]]);
  await p.waitForFunction(() => window.tintwork.autosaveSettled, null, { timeout: 15000 }).catch(() => {});
  await p.close({ runBeforeUnload: false });
  p = await newPage(c2, 'autosave-reopen');
  await p.waitForFunction(() => !document.querySelector('#modal').classList.contains('hidden'), null, { timeout: 8000 }).catch(() => {});
  if (await T(p, () => !!document.querySelector('[data-recover]'))) {
    await p.click('[data-recover]'); await p.waitForFunction(() => window.tintwork.doc, null, { timeout: 10000 }).catch(() => {}); await T(p, () => window.tintwork.idle()); await p.waitForTimeout(200);
    const s = await snaps(p);
    check(s.names.join() === 'Original,Blue cheek' && s.src === 'Original', `recovered from the autosave with snapshots ${JSON.stringify(s.names)} (source ${s.src})`);
    await T(p, () => { const t = window.tintwork; const c = document.createElement('canvas'); void c; }); // keep orig from the first page: re-open the original to compare
    await p.click('#toolbar button[data-tool="histbrush"]'); await T(p, () => Object.assign(window.tintwork.state.opts, { histbrushSize: 80, histbrushHardness: 100, histbrushOpacity: 100 }));
    await stroke(p, [[300, 660], [420, 660]]);
    const c = await px(p, 360, 660);
    check(c[2] < 200 && Math.abs(c[0] - c[2]) > 20, `the History brush paints from the recovered "Original" (cheek back to skin: ${c.slice(0, 3)})`);
    await p.locator('#snapshotList li', { hasText: 'Blue cheek' }).click(); await p.waitForTimeout(120);
    const b = await px(p, 360, 660), f = await px(p, 620, 480), o = await px(p, 620, 470);
    check(b[2] > 240 && b[0] < 20 && f[2] < 200, `restoring the recovered "Blue cheek" shows that state (cheek ${b.slice(0, 3)}, forehead not painted ${f.slice(0, 3)})`);
    void o;
  } else check(false, 'no recovery offered');
  await c2.close();
}
// ================================ E: Smooth skin ==============================================================
const c3 = await freshContext(browser); page = await newPage(c3, 'skin');
{
  // arithmetic on a synthetic image: a vertical edge (60 | 200) plus ±12 noise
  const m = await T(page, async () => {
    const t = window.tintwork, W = 256, H = 256, img = new ImageData(W, H); let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, b = x < 128 ? 60 : 200, n = (rnd() - 0.5) * 24; img.data[i] = b + n; img.data[i + 1] = b + n; img.data[i + 2] = b + n; img.data[i + 3] = 255; }
    const stats = (im) => { const d = im.data; let s = 0, s2 = 0, n = 0; for (let y = 40; y < 216; y++) for (let x = 20; x < 100; x++) { const v = d[(y * W + x) * 4]; s += v; s2 += v * v; n++; } const sd = Math.sqrt(s2 / n - (s / n) ** 2); let e = 0; for (let y = 40; y < 216; y++) e += d[(y * W + 132) * 4] - d[(y * W + 124) * 4]; return { sd, edge: e / 176 }; };
    const run = async (p) => stats(await t.ops.process('skinSmooth', new ImageData(img.data.slice(), W, H), p));
    return { o: stats(img), s: await run({ strength: 100, radius: 12, threshold: 25, detail: 0 }), d: await run({ strength: 100, radius: 12, threshold: 25, detail: 100 }), half: await run({ strength: 50, radius: 12, threshold: 25, detail: 0 }) };
  });
  check(m.s.sd < m.o.sd * 0.35 && m.s.edge > m.o.edge * 0.9, `edge-preserving: noise σ ${m.o.sd.toFixed(1)} → ${m.s.sd.toFixed(1)}, edge step ${m.o.edge.toFixed(0)} → ${m.s.edge.toFixed(0)} (kept)`);
  check(m.d.sd > m.s.sd * 1.3 && m.half.sd > m.s.sd && m.half.sd < m.o.sd, `Detail 100 keeps more fine texture (σ ${m.d.sd.toFixed(1)} vs ${m.s.sd.toFixed(1)}); Strength 50 lands in between (σ ${m.half.sd.toFixed(1)})`);
  const st = await T(page, async () => { const { skinSmoothData } = await import('./src/tone.js'); const W = 301, H = 700, a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < a.length; i++) a[i] = (i * 2654435761 >>> 24) & 255; const b = a.slice(); skinSmoothData(a, W, H, 255, { radius: 18, _core: 100000 }); skinSmoothData(b, W, H, 255, { radius: 18, _core: 40 }); let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; });
  check(st === 0, `processing in strips gives exactly the one-pass result (max diff ${st})`);
}
await open(page, 'portrait-usda.jpg', 'portrait.jpg'); await grab(page, 'orig');
{
  const cheek = { x: 250, y: 600, w: 120, h: 90 };
  const local = (p) => T(p, (R) => { const c = window.tintwork.compositeCanvas(), W = c.width, d = c.getContext('2d').getImageData(0, 0, W, c.height).data; let e = 0, n = 0; for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w - 1; x++) { const i = (y * W + x) * 4; e += Math.abs(d[i + 1] - d[i + 5]); n++; } return e / n; }, cheek);
  const t0 = await local(page);
  await menu(page, 'Filter', 'Smooth skin layer (paint where it applies)…');
  await page.waitForSelector('#modal:not(.hidden)');
  const dlg = await T(page, () => ({ title: document.querySelector('#modalTitle').textContent, keys: [...document.querySelectorAll('#modalBody input.pf-num')].map((i) => i.dataset.numKey) }));
  check(dlg.title === 'Smooth skin layer' && ['strength', 'radius', 'threshold', 'detail'].every((k) => dlg.keys.includes(k)), `Filter ▸ Smooth skin layer opens "${dlg.title}" with ${dlg.keys.join(', ')}`);
  axeCounts.dialog = sev(await axe(page));
  await page.click('#modalOk'); await page.waitForTimeout(100);
  const L = await T(page, () => { const t = window.tintwork, l = t.activeLayer(), m = l.mask.canvas.getContext('2d').getImageData(0, 0, l.mask.canvas.width, l.mask.canvas.height).data; let mx = 0; for (let i = 0; i < m.length; i += 4) mx = Math.max(mx, m[i + 3] ? m[i] : 0); return { kind: l.kind, type: l.adj?.type, name: l.name, maskMax: mx, editMask: l.editMask, tool: t.state.tool, fg: t.state.fg, status: document.querySelector('#status').textContent }; });
  const same = await diff(page, 'orig');
  check(L.kind === 'adjust' && L.type === 'skinSmooth' && L.maskMax === 0 && same.max === 0, `a "${L.name}" layer with a black mask: nothing changes yet (max diff ${same.max})`);
  check(L.editMask && L.tool === 'brush' && L.fg === '#ffffff' && /paint white/i.test(L.status), `the Brush is ready, white, on the mask ("${L.status.slice(0, 70)}…")`);
  await T(page, () => Object.assign(window.tintwork.state.opts, { brushSize: 140, brushHardness: 40, brushOpacity: 100 }));
  await stroke(page, [[240, 640], [380, 640], [380, 600], [250, 600], [240, 680], [380, 680]]);
  await T(page, () => window.tintwork.idle()); await page.waitForTimeout(300);
  const t1 = await local(page), out = await diff(page, 'orig', { x: 700, y: 300, w: 100, h: 100 });
  check(t1 < t0 * 0.75 && out.max === 0, `painting the mask smooths the cheek (local texture ${t0.toFixed(2)} → ${t1.toFixed(2)}) and nothing outside the stroke changes (max diff ${out.max})`);
  const steps = await T(page, () => window.tintwork.history.entries.slice(1).map((e) => e.label));
  check(steps.length === 2, `smoothing a cheek took 2 steps (${steps.join(' → ')}); the persona-test workaround took 6`);
  // for the before / after screenshots: the other cheek, forehead and chin too, at 100 % on the face
  await stroke(page, [[560, 600], [700, 600], [700, 660], [560, 660]]); await stroke(page, [[400, 470], [640, 470]]); await stroke(page, [[400, 880], [520, 880]]);
  await T(page, () => window.tintwork.idle()); await page.waitForTimeout(300);
  await page.mouse.move(3, 400);
  await T(page, () => { const t = window.tintwork, s = t.state, r = document.querySelector('#view').getBoundingClientRect(); s.zoom = 1; s.panX = Math.round(r.width / 2 - 470); s.panY = Math.round(r.height / 2 - 600); t.markDirty(); t.renderNow(); });
  await page.waitForTimeout(150);
  await shot(page, 'skin-after');
  await T(page, () => { const l = window.tintwork.activeLayer(); l.visible = false; window.tintwork.markDirty(); window.tintwork.renderNow(); }); await page.waitForTimeout(150);
  await shot(page, 'skin-before');
  await T(page, () => { const l = window.tintwork.activeLayer(); l.visible = true; window.tintwork.markDirty(); window.tintwork.renderNow(); window.tintwork.fitToScreen(); });
  // the direct command respects a selection
  await T(page, () => { const t = window.tintwork; t.cmds.layerDelete?.(); }); await page.waitForTimeout(80);
  await T(page, () => { const t = window.tintwork, d = t.doc; t.setSelection(t.makeSelection(d.width, d.height, t.rectMask(d.width, d.height, { x: 200, y: 560, w: 260, h: 180 })), 'Select'); });
  await menu(page, 'Filter', 'Smooth skin (whole layer / selection)…'); await page.waitForSelector('#modal:not(.hidden)');
  await setParam(page, 'strength', 100); await page.click('#modalOk');
  await page.waitForFunction(() => window.tintwork.history.entries.at(-1)?.label === 'Smooth skin', null, { timeout: 15000 }).catch(() => {});
  const inS = await diff(page, 'orig', { x: 260, y: 600, w: 120, h: 90 }), outS = await diff(page, 'orig', { x: 600, y: 300, w: 200, h: 200 });
  check(inS.mean > 0.5 && outS.max === 0, `Filter ▸ Smooth skin… changes only the selection (inside mean diff ${inS.mean.toFixed(2)}, outside max ${outS.max})`);
  await T(page, () => window.tintwork.run('deselect'));
  // 16-bit
  const deep = await T(page, async () => { const t = window.tintwork; t.run('mode16'); await t.idle(); const l = t.addAdj('skinSmooth', { strength: 100, radius: 10, threshold: 30, detail: 20 }, 'Smooth skin'); t.markDirty(); t.renderNow(); await t.idle(); const d = t.compositeDeepDoc ? t.compositeDeepDoc() : null; return { depth: t.doc.depth, layer: l.adj.type, deep: !!d }; });
  await page.waitForTimeout(300);
  const dd = await diff(page, 'orig', { x: 260, y: 600, w: 120, h: 90 });
  check(deep.depth === 16 && dd.mean > 0.3, `16-bit document: a Smooth skin layer works (depth ${deep.depth}, cheek mean diff ${dd.mean.toFixed(2)})`);
  const perf = await T(page, async () => { const t = window.tintwork, W = 4000, H = 3000, img = new ImageData(W, H); for (let i = 0; i < img.data.length; i += 4) { img.data[i] = (i >> 5) & 255; img.data[i + 1] = 128; img.data[i + 2] = 90; img.data[i + 3] = 255; } const t0 = performance.now(); await t.ops.process('skinSmooth', img, { strength: 70, radius: 12, threshold: 25, detail: 40 }); return Math.round(performance.now() - t0); });
  check(perf < 15000, `12 MP Smooth skin in the pixel worker: ${perf} ms (reported, not a target)`);
}
await c3.close();
// ================================ F: Actions and Batch ========================================================
{
  const c4 = await freshContext(browser); const p = await newPage(c4, 'actions');
  await open(p, 'v126-city.jpg', 'city.jpg');
  const ADJS = [
    ['Vibrance…', 'vibrance', { vibrance: 60, saturation: -10 }],
    ['Shadows / highlights…', 'shadowsHighlights', { shAmount: 50, hlAmount: 30 }],
    ['Color balance…', 'colorBalance', { mCR: 30, sYB: -25 }],
  ];
  await menu(p, 'Actions', 'Start recording');
  for (const [item, , params] of ADJS) { // direct
    await menu(p, 'Adjust', item); await p.waitForSelector('#modal:not(.hidden)');
    for (const [k, v] of Object.entries(params)) await setParam(p, k, v);
    await p.click('#modalOk'); await p.waitForFunction((n) => window.tintwork.history.entries.length >= n, 0); await T(p, () => window.tintwork.idle()); await p.waitForTimeout(150);
  }
  await menu(p, 'Filter', 'Smooth skin (whole layer / selection)…'); await p.waitForSelector('#modal:not(.hidden)'); await setParam(p, 'radius', 8); await p.click('#modalOk');
  await p.waitForFunction(() => window.tintwork.history.entries.at(-1)?.label === 'Smooth skin', null, { timeout: 15000 }); await p.waitForTimeout(100);
  for (const [item, , params] of ADJS) { // as adjustment layers
    await menu(p, 'Layer', `New adjustment layer: ${item}`); await p.waitForSelector('#modal:not(.hidden)');
    for (const [k, v] of Object.entries(params)) await setParam(p, k, Math.round(v / 2));
    await p.click('#modalOk'); await p.waitForTimeout(150);
  }
  await menu(p, 'Layer', 'New adjustment layer: Smooth skin'); await p.waitForSelector('#modal:not(.hidden)'); await setParam(p, 'strength', 90); await p.click('#modalOk'); await p.waitForTimeout(100);
  await T(p, () => window.tintwork.idle()); await p.waitForTimeout(300);
  const rec = await T(p, () => { const t = window.tintwork; const steps = JSON.parse(JSON.stringify(t.recorder.steps)); const a = t.stopRecording('v135 adjustments'); return { steps, desc: steps.map(t.describeStep), id: a?.id }; });
  const kinds = rec.steps.map((s) => `${s.t}:${s.op || s.type}`);
  check(rec.steps.length === 8 && ['adjust:vibrance', 'adjust:shadowsHighlights', 'adjust:colorBalance', 'adjust:skinSmooth', 'adjLayer:vibrance', 'adjLayer:shadowsHighlights', 'adjLayer:colorBalance', 'adjLayer:skinSmooth'].every((k) => kinds.includes(k)), `all 8 record (${rec.desc.join(' ; ')})`);
  const paramsOk = rec.steps[0].params.vibrance === 60 && rec.steps[1].params.shAmount === 50 && rec.steps[2].params.mCR === 30 && rec.steps[2].params.preserve === true && rec.steps[4].params.vibrance === 30 && rec.steps[7].hide === true;
  check(paramsOk, `recorded values are the ones typed (vibrance 60, shadows 50, midtones red 30 + preserve, layer vibrance 30; skin layer keeps its black mask)`);
  await grab(p, 'manual');
  // replay on a fresh copy of the same photo
  await open(p, 'v126-city.jpg', 'city2.jpg');
  const r = await T(p, async (id) => { const t = window.tintwork; const r = await t.playAction(id); await t.idle(); return { ok: r.ok, steps: r.steps, errors: r.errors, layers: t.doc.layers.map((l) => l.adj?.type || 'pixels') }; }, rec.id);
  await p.waitForTimeout(400); await T(p, () => window.tintwork.idle());
  const pd = await diff(p, 'manual');
  check(r.ok && r.steps === 8 && pd.max <= 1, `playAction replays all ${r.steps} steps to the same pixels (max diff ${pd.max}, mean ${pd.mean.toFixed(3)}; layers ${r.layers.join(', ')})`);
  // batch: the same action on the photo file, PNG out, compared with the manual result
  const b = await T(p, async ([id, buf]) => {
    const t = window.tintwork, s = t.memorySink(), files = [new File([new Uint8Array(buf)], 'city.jpg', { type: 'image/jpeg' })];
    const r = await t.runBatch(files, { actionId: id, variants: [{ mode: 'original', type: 'image/png' }], pattern: '{name}', sink: s });
    const f = Object.values(s.files)[0]; const bm = await createImageBitmap(f.blob); const c = new OffscreenCanvas(bm.width, bm.height); c.getContext('2d').drawImage(bm, 0, 0);
    const a = c.getContext('2d').getImageData(0, 0, bm.width, bm.height).data, m = window.__g.manual; let mx = 0, sum = 0; for (let i = 0; i < a.length; i += 4) for (let ch = 0; ch < 3; ch++) { const d = Math.abs(a[i + ch] - m[i + ch]); sum += d; if (d > mx) mx = d; }
    return { done: r.done, failed: r.failed.map((x) => x.name), w: bm.width, max: mx, mean: sum / (a.length * 0.75) };
  }, [rec.id, [...REAL('v126-city.jpg')]]);
  check(b.done === 1 && !b.failed.length && b.max <= 2, `Batch with that action writes a PNG matching the manual edit (max diff ${b.max}, mean ${b.mean.toFixed(3)})`);
  await c4.close();
}
// ================================ G: axe ======================================================================
for (const [k, v] of Object.entries(axeCounts)) check(v.length === 0, `axe (${k}): 0 serious / critical (${fmt(v)})`);

check(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close(); server.close();
console.log(`\nv135: ${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
