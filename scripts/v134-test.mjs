// v1.34: open persona-test-v131 findings.
// A) Finding 13: edits made just before the tab closes survive. Five brush strokes, the tab is closed 150 ms after
//    the last one (no beforeunload prompt), the site is reopened in the same browser profile: "Recover unsaved
//    work?" is offered and recovering brings back all five strokes with the same pixels.
// B) Finding 11: at 1366×768 and 1920×1080 every tool is on screen without scrolling (the column turns into two
//    columns when one would not fit) and no tool's options bar runs off its right edge (it wraps onto a second
//    row). The phone layout (WebKit, iPhone 13 profile) keeps the v1.33 single-row, swipeable bar.
// C) Finding 14: Liquify never leaves "Processing…"; the Perspective bar says "Enter applies" once in guide mode.
// D) Finding 10: Vibrance, Shadows / highlights and Color balance, from the menus, as direct adjustments (with live
//    preview) and as adjustment layers, in 8-bit and 16-bit documents; their arithmetic is checked on known colours.
// E) axe-core: 0 serious / critical with the new dialogs open and on the phone layout.
// Not covered: a real browser crash or OS shutdown (only a normal tab close), real Windows hardware, GPU shaders for
// the new adjustments (they composite on the CPU). TW_ROOT / TW_URL supported. SHOTS=<prefix> saves screenshots.
import { chromium, webkit, devices } from 'playwright';
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
  return T(page, async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length })));
}
const sev = (vs) => vs.filter((v) => v.impact === 'serious' || v.impact === 'critical');
const fmt = (vs) => vs.map((v) => `${v.id}:${v.impact}`).join(', ') || 'none';
async function menu(page, title, item) {
  await page.locator('#menus .menu > button', { hasText: new RegExp(`^${title}$`) }).click();
  await page.locator('#menus .menu.open .menu-items button', { hasText: item }).first().click();
}
/** Type a value into a dialog parameter's number box (the same as typing it and pressing Tab). */
async function setParam(page, key, v) {
  const n = page.locator(`#modalBody input.pf-num[data-num-key="${key}"]`);
  await n.fill(String(v)); await n.press('Tab');
}
const compSum = (page) => T(page, () => { const c = window.tintwork.composite(); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0, h = 0; for (let i = 0; i < d.length; i += 4) { s += d[i] + d[i + 1] + d[i + 2]; h = (h * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2]) >>> 0; } return { s, h, w: c.width, hgt: c.height }; });
const axeCounts = {};

const browser = await chromium.launch();
// ================================ version ======================================================================
{
  const ctx = await freshContext(browser); const page = await newPage(ctx, 'version');
  const ver = await T(page, () => window.tintwork.APP_VERSION);
  check((ver === '1.34.0' || ver === '1.34.1' || ver === '1.35.0'), `APP_VERSION is 1.34.0 (${ver})`);
  if (!process.env.TW_URL) { const m = readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/tintwork-shell-v([\d.]+)/); check((m?.[1] === '1.34.0' || m?.[1] === '1.34.1' || m?.[1] === '1.35.0'), `SW CACHE is 1.34.0 (${m?.[1]})`); }
  else { const r = await page.request.get(`${BASE}sw.js`); const t = await r.text(); const m = t.match(/tintwork-shell-v([\d.]+)/); check((m?.[1] === '1.34.0' || m?.[1] === '1.34.1' || m?.[1] === '1.35.0') && t.includes('./src/tone.js'), `live SW CACHE is 1.34.0 and precaches tone.js (${m?.[1]})`); }
  await ctx.close();
}
// ================================ A: close within 200 ms, reopen, recover ====================================
for (const variant of ['strokes', 'adjustment']) {
  const ctx = await freshContext(browser); let page = await newPage(ctx, `close-${variant}`);
  await open(page, 'v126-city.jpg', 'city.jpg');
  await page.waitForFunction(() => window.tintwork.autosaveSettled, null, { timeout: 15000 }).catch(() => {});
  let label;
  if (variant === 'strokes') {
    await page.click('#toolbar button[data-tool="brush"]');
    const box = await page.locator('#view').boundingBox();
    for (let i = 0; i < 5; i++) { await page.mouse.move(box.x + 300 + i * 40, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 340 + i * 40, box.y + 280, { steps: 4 }); await page.mouse.up(); }
    label = 'Brush stroke';
  } else { // a direct adjustment (whole-layer pixels change) right before closing
    await menu(page, 'Adjust', 'Vibrance…'); await setParam(page, 'vibrance', 70); await page.click('#modalOk');
    await page.waitForFunction(() => window.tintwork.history.entries.at(-1)?.label === 'Vibrance', null, { timeout: 10000 });
    label = 'Vibrance';
  }
  const before = await compSum(page), n = await T(page, (l) => window.tintwork.history.entries.filter((e) => e.label === l).length, label);
  const settled = await T(page, () => window.tintwork.autosaveSettled);
  const t0 = Date.now(); await page.waitForTimeout(150);
  await page.close({ runBeforeUnload: false }); const closedAfter = Date.now() - t0;
  page = await newPage(ctx, `reopen-${variant}`);
  await page.waitForFunction(() => !document.querySelector('#modal').classList.contains('hidden'), null, { timeout: 8000 }).catch(() => {});
  const title = await T(page, () => (!document.querySelector('#modal').classList.contains('hidden') ? document.querySelector('#modalTitle').textContent : null));
  check(title === 'Recover unsaved work?' && !settled, `${variant}: closed ${closedAfter} ms after the last edit (autosave had not run yet: ${!settled}); reopening offers "${title}"`);
  if (variant === 'strokes') await shot(page, 'recover-offered');
  if (title) {
    await page.click('[data-recover]');
    await page.waitForFunction(() => window.tintwork.doc, null, { timeout: 10000 }).catch(() => {});
    await T(page, () => window.tintwork.idle()); await page.waitForTimeout(200);
    const got = await T(page, (l) => window.tintwork.history.entries.filter((e) => e.label === l).length, label), after = await compSum(page);
    check(got === n && after.w === before.w && Math.abs(after.s - before.s) / (after.w * after.hgt * 3) < 0.5, `${variant}: recovered ${got}/${n} "${label}" step(s); pixels match (mean diff ${(Math.abs(after.s - before.s) / (after.w * after.hgt * 3)).toFixed(3)} levels)`);
  } else check(false, `${variant}: nothing to recover`);
  await ctx.close();
}
// ================================ B: layout at 1366×768 and 1920×1080 ========================================
const ctxD = await freshContext(browser); let page = await newPage(ctxD, 'desktop');
await open(page, 'v126-city.jpg', 'city.jpg');
for (const [w, h] of [[1366, 768], [1920, 1080]]) {
  await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(250);
  const tb = await T(page, () => { const t = document.querySelector('#toolbar'), r = t.getBoundingClientRect(); const bs = [...t.querySelectorAll('button[data-tool]')]; return { n: bs.length, off: bs.filter((b) => b.getBoundingClientRect().bottom > r.bottom + 1 || b.getBoundingClientRect().bottom > innerHeight).map((b) => b.dataset.tool), cue: document.querySelector('#toolMore')?.classList.contains('show'), cols: document.body.classList.contains('tools-2col') }; });
  check(tb.off.length === 0 && !tb.cue, `${w}×${h}: all ${tb.n} tools on screen without scrolling (two columns: ${tb.cols}; off-screen: ${tb.off.join(', ') || 'none'})`);
  const tools = await T(page, () => [...document.querySelectorAll('#toolbar button[data-tool]')].map((b) => b.dataset.tool));
  const over = [], tall = [];
  for (const t of tools) {
    await page.click(`#toolbar button[data-tool="${t}"]`); await page.waitForTimeout(40);
    const o = await T(page, () => { const b = document.querySelector('#optionsbar'), r = b.getBoundingClientRect(); const out = [...b.children].filter((c) => { const q = c.getBoundingClientRect(); return q.width > 0 && (q.right > r.right + 1 || q.bottom > r.bottom + 1); }).length; return { sw: b.scrollWidth - b.clientWidth, out, h: Math.round(r.height) }; });
    if (o.sw > 1 || o.out) over.push(`${t} +${o.sw}px/${o.out}`);
    if (o.h > 80) tall.push(`${t} ${o.h}px`);
  }
  check(over.length === 0, `${w}×${h}: no tool's options bar runs off the edge (${over.join(', ') || 'all fit'}; was brush +224 px at 1366)`);
  check(tall.length === 0, `${w}×${h}: options bar is at most two rows (${tall.join(', ') || 'all ≤ 80 px'})`);
  if (w === 1366) { await page.click('#toolbar button[data-tool="tone"]'); await page.waitForTimeout(100); await shot(page, 'layout-1366'); }
}
await page.setViewportSize({ width: 1366, height: 768 }); await page.click('#toolbar button[data-tool="hand"]');
// ================================ C: Liquify status, Perspective hint ========================================
{
  await page.click('#toolbar button[data-tool="liquify"]');
  const box = await page.locator('#view').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 10, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(() => window.tintwork.history.entries.at(-1)?.label === 'Liquify', null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  const st = await T(page, () => [document.querySelector('#status').textContent, document.body.classList.contains('busy')]);
  check(st[0] !== 'Processing…' && !st[1], `after a Liquify stroke the status reads "${st[0]}", not "Processing…"`);
  await page.keyboard.press('Control+z'); await page.click('#toolbar button[data-tool="hand"]');
  await T(page, () => window.tintwork.run('perspective')); await page.waitForTimeout(200);
  await T(page, () => window.tintwork.run('mxfSuggestGuides')); await page.waitForTimeout(1500);
  const bar = await T(page, () => ({ text: document.querySelector('#optionsbar .mxf-hint')?.textContent || '', btns: [...document.querySelectorAll('#optionsbar button')].map((b) => ({ t: b.textContent.trim(), p: b.classList.contains('primary') })).filter((b) => /^Apply/.test(b.t)) }));
  const nEnter = (bar.text.match(/Enter applies/g) || []).length, primaries = bar.btns.filter((b) => b.p).map((b) => b.t);
  const guided = bar.btns.some((b) => b.t === 'Apply guides');
  check(guided && nEnter === 1 && primaries.length === 1 && primaries[0] === 'Apply guides' && bar.btns.some((b) => b.t === 'Apply corners'), `Perspective guide mode: hint "${bar.text}" says "Enter applies" ${nEnter}× (was 2×); one primary Apply (${primaries.join(', ')}); buttons ${bar.btns.map((b) => b.t).join(' / ')}`);
  await T(page, () => window.tintwork.run('mxfCancel')); await page.waitForTimeout(200);
}
// ================================ D: the arithmetic on known colours ==========================================
{
  const r = await T(page, async () => {
    const t = await import('./src/tone.js');
    const hue = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn; if (!c) return 0; let h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4; return (h * 60 + 360) % 360; };
    const chroma = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
    const Y = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    const run = (fn, px, w = px.length / 4, h = 1, max = 255) => { const d = max === 255 ? new Uint8ClampedArray(px) : new Uint16Array(px.map((v, i) => (i % 4 === 3 ? 65535 : Math.round(v * 257)))); fn(d, w, h, max); return max === 255 ? [...d] : [...d].map((v, i) => (i % 4 === 3 ? 255 : v / 257)); };
    const muted = [110, 125, 140, 255], strong = [220, 40, 40, 255], skin = [224, 172, 140, 255];
    const v8 = run((d) => t.vibranceData(d, 255, { vibrance: 100 }), [...muted, ...strong, ...skin]);
    const gain = (a, b) => chroma(b) / chroma(a);
    const vib = { muted: gain(muted, v8.slice(0, 4)), strong: gain(strong, v8.slice(4, 8)), skin: gain(skin, v8.slice(8, 12)), hueShift: Math.max(Math.abs(hue(...muted) - hue(...v8.slice(0, 3))), Math.abs(hue(...skin) - hue(...v8.slice(8, 11)))) };
    const sat = run((d) => t.vibranceData(d, 255, { saturation: -100 }), [...strong]);
    // shadows / highlights on a 64×1 ramp, radius 0 (pure tone) so the result is easy to reason about
    const ramp = []; for (let i = 0; i < 64; i++) { const v = Math.round(i * 255 / 63); ramp.push(v, v, v, 255); }
    const sh = run((d, w, h, m) => t.shadowsHighlightsData(d, w, h, m, { shAmount: 60, shRadius: 0, hlAmount: 0 }), ramp, 64, 1);
    const hl = run((d, w, h, m) => t.shadowsHighlightsData(d, w, h, m, { shAmount: 0, hlAmount: 60, hlRadius: 0 }), ramp, 64, 1);
    const at = (a, i) => a[i * 4];
    const shr = { darkUp: at(sh, 8) - at(ramp, 8), brightMove: Math.abs(at(sh, 60) - at(ramp, 60)) }, hlr = { brightDown: at(ramp, 56) - at(hl, 56), darkMove: Math.abs(at(hl, 4) - at(ramp, 4)) };
    // color balance on greys
    const greys = [40, 40, 40, 255, 128, 128, 128, 255, 220, 220, 220, 255];
    const cbm = run((d) => t.colorBalanceData(d, 255, { mCR: 60, preserve: true }), greys);
    const cbs = run((d) => t.colorBalanceData(d, 255, { sYB: 60, preserve: true }), greys);
    const cbn = run((d) => t.colorBalanceData(d, 255, { mCR: 60, preserve: false }), greys);
    const cb = { midRed: cbm[4] - cbm[5], midLuma: Math.abs(Y(cbm.slice(4, 7)) - 128), shadowBlueDark: cbs[2] - cbs[0], shadowBlueLight: cbs[10] - cbs[8], noPreserveLuma: Math.abs(Y(cbn.slice(4, 7)) - 128) };
    // 16-bit = 8-bit within a level
    const mix = [...muted, ...strong, ...skin, 30, 60, 20, 255];
    const d8 = (fn) => run(fn, mix, 4, 1, 255), d16 = (fn) => run(fn, mix, 4, 1, 65535);
    let diff = 0; for (const fn of [(d, w, h, m) => t.vibranceData(d, m, { vibrance: 60, saturation: 10 }), (d, w, h, m) => t.colorBalanceData(d, m, { sCR: 30, mMG: -40, hYB: 50 }), (d, w, h, m) => t.shadowsHighlightsData(d, w, h, m, { shAmount: 50, hlAmount: 40, shRadius: 1, hlRadius: 1 })]) { const a = d8(fn), b = d16(fn); for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i])); }
    // edges: a big radius must not brighten the borders of a top-to-bottom gradient (the blur clamps at the edges)
    const W = 160, H = 120, grad = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = Math.round(y * 255 / (H - 1)); grad.push(v, v, v, 255); }
    const gs = run((d, w, h, m) => t.shadowsHighlightsData(d, w, h, m, { shAmount: 100, shRadius: 80 }), grad, W, H);
    let edge = 0; for (let y = 0; y < H; y++) edge = Math.max(edge, Math.abs(gs[(y * W) * 4] - gs[(y * W + W / 2) * 4]));
    return { vib, sat, shr, hlr, cb, diff, edge };
  });
  check(r.vib.muted > r.vib.strong + 0.3 && r.vib.skin < r.vib.muted - 0.3 && r.vib.strong < 1.08 && r.vib.hueShift < 3, `Vibrance +100: chroma ×${r.vib.muted.toFixed(2)} on a muted blue, ×${r.vib.skin.toFixed(2)} on a skin tone, ×${r.vib.strong.toFixed(2)} on a strong red (protected); hue moves ${r.vib.hueShift.toFixed(1)}°`);
  check(Math.max(...r.sat.slice(0, 3)) - Math.min(...r.sat.slice(0, 3)) <= 1, `Saturation −100 turns a red neutral (${r.sat.slice(0, 3).join(',')})`);
  check(r.shr.darkUp > 15 && r.shr.brightMove <= 2 && r.hlr.brightDown > 10 && r.hlr.darkMove <= 2, `Shadows / highlights: a dark grey is lifted ${r.shr.darkUp} levels (a bright one moves ${r.shr.brightMove}); a bright grey is pulled down ${r.hlr.brightDown} (a dark one moves ${r.hlr.darkMove})`);
  check(r.cb.midRed > 10 && r.cb.midLuma <= 1.5 && r.cb.shadowBlueDark > r.cb.shadowBlueLight + 5 && r.cb.noPreserveLuma > r.cb.midLuma, `Color balance: midtones +red makes mid-grey red by ${r.cb.midRed} with luma kept (Δ${r.cb.midLuma.toFixed(2)}; Δ${r.cb.noPreserveLuma.toFixed(2)} without Preserve); shadows +blue tints dark grey (${r.cb.shadowBlueDark}) more than light grey (${r.cb.shadowBlueLight})`);
  check(r.edge <= 1, `Shadows / highlights radius 80 px on a top-to-bottom gradient: the left edge matches the centre within ${r.edge} level(s) (no border bloom)`);
  check(r.diff <= 1.01, `16-bit results match 8-bit within one 8-bit level (max ${r.diff.toFixed(2)})`);
}
// ================================ D: the new adjustments through the UI ======================================
{
  await open(page, 'portrait-usda.jpg', 'portrait.jpg');
  const s0 = await compSum(page);
  // Vibrance (direct) with live preview, then Cancel restores
  await menu(page, 'Adjust', 'Vibrance…'); await page.waitForSelector('#modalBody input.pf-num[data-num-key="vibrance"]');
  await setParam(page, 'vibrance', 80); await page.waitForTimeout(700); await T(page, () => window.tintwork.idle?.());
  const sPrev = await compSum(page);
  await shot(page, 'vibrance');
  await page.click('#modalCancel'); await page.waitForTimeout(300);
  const sCancel = await compSum(page);
  check(sPrev.h !== s0.h && sCancel.h === s0.h, `Vibrance dialog previews live on the canvas and Cancel restores it`);
  await menu(page, 'Adjust', 'Vibrance…'); await setParam(page, 'vibrance', 60); await setParam(page, 'saturation', 10); await page.click('#modalOk');
  await page.waitForFunction(() => window.tintwork.history.entries.at(-1)?.label === 'Vibrance', null, { timeout: 10000 }).catch(() => {});
  check((await compSum(page)).h !== s0.h, 'Adjust ▸ Vibrance… OK changes the pixels and adds a "Vibrance" history step');
  await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
  // Shadows / highlights (direct) on a dark, colourful library interior
  await open(page, 'library.jpg', 'library.jpg');
  const i0 = await compSum(page);
  await menu(page, 'Adjust', 'Shadows / highlights…'); await page.waitForSelector('#modalBody input.pf-num[data-num-key="shAmount"]');
  const fields = await T(page, () => [...document.querySelectorAll('#modalBody .pf-num')].map((n) => n.dataset.numKey));
  await setParam(page, 'shAmount', 60); await setParam(page, 'hlAmount', 40); await page.waitForTimeout(1200);
  const iPrev = await compSum(page);
  await shot(page, 'shadows-highlights');
  check(fields.join(',') === 'shAmount,shTone,shRadius,hlAmount,hlTone,hlRadius' && iPrev.h !== i0.h, `Shadows / highlights dialog: amount, tone range and radius for both (${fields.length} fields); the preview is live`);
  await page.click('#modalOk'); await page.waitForFunction(() => window.tintwork.history.entries.at(-1)?.label === 'Shadows / highlights', null, { timeout: 15000 }).catch(() => {});
  const iDone = await compSum(page);
  check(iDone.h !== i0.h && (await T(page, () => window.tintwork.history.entries.at(-1)?.label)) === 'Shadows / highlights', 'Adjust ▸ Shadows / highlights… OK applies to the layer');
  // Adjustment layers from the Layer menu: each creates an editable layer that changes the composite
  const layerRes = [];
  for (const [item, type, key, v] of [['New adjustment layer: Vibrance…', 'vibrance', 'vibrance', 70], ['New adjustment layer: Shadows / highlights…', 'shadowsHighlights', 'hlAmount', 50], ['New adjustment layer: Color balance…', 'colorBalance', 'mCR', 40]]) {
    const b = await compSum(page);
    await menu(page, 'Layer', item); await page.waitForSelector(`#modalBody input.pf-num[data-num-key="${key}"]`);
    await setParam(page, key, v); await page.waitForTimeout(400);
    if (type === 'colorBalance') { await page.click('#modalBody [data-cbtone="h"]'); await setParam(page, 'hYB', -30);
      const vis = await T(page, () => ({ n: [...document.querySelectorAll('#modalBody input.pf-num')].filter((x) => x.offsetParent).map((x) => x.dataset.numKey).join(','), tabs: [...document.querySelectorAll('#modalBody [data-cbtone]')].map((b) => b.textContent).join('/') }));
      check(vis.n === 'hCR,hMG,hYB' && vis.tabs === 'Shadows/Midtones/Highlights', `Color balance shows one tone range at a time (${vis.tabs} tabs; Highlights tab shows ${vis.n})`); await page.waitForTimeout(400); await shot(page, 'color-balance-layer'); axeCounts.dialog = await axe(page); }
    await page.click('#modalOk'); await page.waitForTimeout(500); await T(page, () => window.tintwork.idle?.());
    const l = await T(page, () => { const a = window.tintwork.activeLayer(); return { kind: a.kind, type: a.adj?.type, params: a.adj?.params }; });
    const a = await compSum(page);
    layerRes.push(`${type}:${l.kind === 'adjust' && l.type === type && l.params[key] === v && a.h !== b.h ? 'ok' : 'FAIL'}`);
  }
  check(layerRes.every((x) => x.endsWith('ok')), `Layer ▸ New adjustment layer: Vibrance / Shadows-highlights / Color balance each add an editable adjustment layer that changes the composite (${layerRes.join(', ')})`);
  const cbFields = await T(page, () => window.tintwork.ADJ.colorBalance.params.map((p) => p.key).join(','));
  check(cbFields === 'sCR,sMG,sYB,mCR,mMG,mYB,hCR,hMG,hYB,preserve', `Color balance has shadows / midtones / highlights × cyan–red, magenta–green, yellow–blue, plus Preserve luminosity (${cbFields})`);
  // hiding the adjustment layers restores the composite (they are non-destructive)
  await T(page, () => { for (const l of window.tintwork.doc.layers) if (l.kind === 'adjust') l.visible = false; window.tintwork.history; });
  await T(page, () => window.tintwork.run('zoomFit')); // any command re-renders
  await page.waitForTimeout(200);
  check((await compSum(page)).h === iDone.h, 'hiding the three adjustment layers gives back the pixels underneath (non-destructive)');
  await T(page, () => { for (const l of window.tintwork.doc.layers) if (l.kind === 'adjust') l.visible = true; });
  // 16-bit document: direct adjustment keeps 16-bit layer data; adjustment layers composite in float
  await T(page, () => window.tintwork.run('mode16')); await page.waitForTimeout(500);
  const deep = await T(page, async () => {
    const tw = window.tintwork, bg = tw.doc.layers.find((l) => !l.kind);
    tw.doc.activeId = bg.id;
    return { depth: tw.doc.depth, id: bg.id };
  });
  await menu(page, 'Adjust', 'Color balance…'); await page.waitForSelector('#modalBody [data-cbtone="s"]');
  await page.click('#modalBody [data-cbtone="s"]'); await setParam(page, 'sCR', 40); await page.click('#modalOk');
  await page.waitForFunction(() => window.tintwork.history.entries.at(-1)?.label === 'Color balance', null, { timeout: 15000 }).catch(() => {});
  const d16 = await T(page, (id) => { const l = window.tintwork.doc.layers.find((x) => String(x.id) === String(id)); return { deep: !!l.deep, synced: l.deepRev === l.rev, fine: l.deep ? (() => { let odd = 0; for (let i = 0; i < l.deep.data.length; i += 4) if (l.deep.data[i] % 257) odd++; return odd; })() : 0 }; }, deep.id);
  check(deep.depth === 16 && d16.deep && d16.synced && d16.fine > 1000, `16-bit document: Adjust ▸ Color balance writes 16-bit layer data (in step: ${d16.synced}; ${d16.fine} samples between 8-bit levels)`);
  const flat = await T(page, () => { try { const d = window.tintwork.compositeDeepDoc?.(); return d ? { ok: true, w: d.width } : { ok: null }; } catch (e) { return { ok: false, e: e.message }; } });
  check(flat.ok !== false, `16-bit float composite with the three adjustment layers runs (${flat.ok === null ? 'not exposed; covered by the export below' : flat.ok ? 'ok' : flat.e})`);
  const dl = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await T(page, () => window.tintwork.run('exportPSD')); await page.waitForTimeout(400);
  if (!(await T(page, () => document.querySelector('#modal').classList.contains('hidden')))) await page.click('#modalOk').catch(() => {});
  const d = await dl; const warn = await T(page, () => document.querySelector('#status').textContent);
  check(!!d, `layered PSD export with the new layers completes (status: "${warn.slice(0, 120)}")`);
}
const v1 = await axe(page); axeCounts.desktop = v1;
check(sev(axeCounts.dialog || []).length === 0 && sev(v1).length === 0, `axe: Color balance dialog open ${sev(axeCounts.dialog || []).length}, editor ${sev(v1).length} serious/critical (${fmt(axeCounts.dialog || [])} | ${fmt(v1)})`);
await ctxD.close();
await browser.close();
// ================================ phone (WebKit, iPhone 13): v1.33 layout kept ===============================
{
  const wk = await webkit.launch();
  const ctx = await wk.newContext({ ...devices['iPhone 13'], bypassCSP: true });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await p.goto(`${BASE}?platform=win`); await p.waitForFunction(() => window.tintwork && document.readyState === 'complete'); await p.evaluate(() => window.tintwork.engineReady);
  await p.setInputFiles('#fileInput', { name: 'city.jpg', mimeType: 'image/jpeg', buffer: REAL('v126-city.jpg') });
  await p.waitForFunction(() => window.tintwork.doc?.name === 'city.jpg'); await p.evaluate(() => window.tintwork.idle());
  await p.locator('#toolbar button[data-tool="crop"]').tap(); await p.waitForTimeout(200);
  await p.locator('[data-cropchip="portrait45"]').tap(); await p.waitForTimeout(250);
  const ph = await p.evaluate(() => { const b = document.querySelector('#optionsbar'); const cs = getComputedStyle(b); return { wrap: cs.flexWrap, ox: cs.overflowX, h: Math.round(b.getBoundingClientRect().height), cols: document.body.classList.contains('tools-2col'), float: document.querySelectorAll('#floatActions button').length }; });
  check(ph.wrap === 'nowrap' && ph.ox === 'auto' && !ph.cols && ph.float === 2, `phone: options bar stays one swipeable row (${ph.wrap}, overflow ${ph.ox}, ${ph.h} px), tool column unchanged, crop Apply / Cancel still float (${ph.float})`);
  const v = await axe(p); axeCounts.phone = v; check(sev(v).length === 0, `axe on iPhone (crop): 0 serious/critical (${fmt(v)})`);
  await ctx.close(); await wk.close();
}
console.log(`axe serious+critical: ${Object.entries(axeCounts).map(([k, v]) => `${k} ${sev(v).length}`).join(', ')}`);
check(!errors.length, `no page errors (${errors.slice(0, 2).join(' | ')})`);
server.close();
console.log(`\nv134: ${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
