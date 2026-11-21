// v1.33: phone layout and keyboard / screen-reader access (persona-test-v131 findings #6, #7, #8, #11, #14).
// A) iPhone (WebKit, iPhone 13 profile): crop's Apply / Cancel float over the canvas (always on screen), the 4:5 and
//    other ratio chips are tappable (not drawn under the Ratio select), and the photo is fitted beside the tool
//    column instead of under it. Desktop keeps Apply / Cancel in the options bar and the old fit (inset 0).
// B) Layer and History rows: one Tab stop per list (roving tabindex), ↑/↓/Home/End move, Enter/Space select the
//    layer / jump to that undo state, visible focus ring; a mouse click on a row does not steal the arrow keys
//    (Move-tool nudge) or Enter. #status is an aria-live polite region; the dialog is named by its title; two skip
//    links (canvas, Open image…) are the first Tab stops; page zoom is no longer disabled; axe-core: 0 serious /
//    critical in the audited states.
// C) A "more tools" cue on the tool column at 1366×768, a taller History panel, and the status bar no longer goes
//    stale after an action that sets no message of its own (it shows the history label).
// Not covered here (needs real devices): real iPhone Safari, two-finger pinch on the canvas vs page zoom, NVDA /
// JAWS / Narrator / VoiceOver speech. TW_ROOT / TW_URL supported. SHOTS=<prefix> saves screenshots (e.g. SHOTS=133-live).
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
async function freshPage(browser, ctxOpts, tag) {
  const ctx = await browser.newContext({ acceptDownloads: true, bypassCSP: true, ...ctxOpts }); // bypassCSP: only so axe-core can be injected
  await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; delete window.showDirectoryPicker; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  await page.goto(`${BASE}?platform=win`);
  await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  await page.evaluate(() => window.tintwork.engineReady);
  return page;
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
const active = (page) => T(page, () => { const a = document.activeElement; return { tag: a?.tagName, id: a?.id, rove: a?.dataset?.rove || '', dataId: a?.dataset?.id || '', idx: a?.dataset?.index ?? '', text: (a?.textContent || '').trim().slice(0, 40), fv: (() => { try { return a.matches(':focus-visible'); } catch { return null; } })(), outline: a ? getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth : '' }; });
async function tabUntil(page, pred, max = 80) { for (let i = 1; i <= max; i++) { await page.keyboard.press('Tab'); const a = await active(page); if (pred(a)) return { n: i, a }; } return { n: -1, a: await active(page) }; }

{
  try { const b = await webkit.launch(); const p = await b.newPage(); await p.goto('about:blank'); const ua = await p.evaluate(() => navigator.userAgent); check(/WebKit/i.test(ua), `WebKit launches (${ua.slice(0, 60)}…)`); await b.close(); }
  catch (e) { check(false, `WebKit launches (${e.message.slice(0, 80)})`); }
}

const axeCounts = {};
// ================================ desktop (Chromium, Windows-like 1366×768, mouse + keyboard) ================
const browser = await chromium.launch();
let page = await freshPage(browser, { viewport: { width: 1366, height: 768 } }, 'desktop');
{
  const ver = await T(page, () => window.tintwork.APP_VERSION);
  check(ver === '1.33.0', `APP_VERSION is 1.33.0 (${ver})`);
  if (!process.env.TW_URL) { const m = readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/tintwork-shell-v([\d.]+)/); check(m?.[1] === '1.33.0', `SW CACHE is 1.33.0 (${m?.[1]})`); }
  else { const r = await page.request.get(`${BASE}sw.js`); const m = (await r.text()).match(/tintwork-shell-v([\d.]+)/); check(m?.[1] === '1.33.0', `live SW CACHE is 1.33.0 (${m?.[1]})`); }
}
// ---- B: static semantics -----------------------------------------------------------------------------------
{
  const s = await T(page, () => ({
    vp: document.querySelector('meta[name=viewport]').content,
    st: [document.querySelector('#status').getAttribute('role'), document.querySelector('#status').getAttribute('aria-live')],
    modal: document.querySelector('#modal').getAttribute('aria-labelledby'),
    h1: document.querySelectorAll('h1').length,
  }));
  check(!/user-scalable\s*=\s*no|maximum-scale/.test(s.vp) && /width=device-width/.test(s.vp), `page zoom allowed: viewport meta has no user-scalable=no / maximum-scale ("${s.vp}")`);
  check(s.st[0] === 'status' && s.st[1] === 'polite', `#status is a polite live region (role=${s.st[0]}, aria-live=${s.st[1]})`);
  check(s.modal === 'modalTitle' && s.h1 >= 1, `dialog aria-labelledby=modalTitle; page has an h1 (${s.modal}, h1×${s.h1})`);
  const v = await axe(page); axeCounts.welcome = v; check(sev(v).length === 0, `axe welcome screen: 0 serious/critical (${fmt(v)})`);
}
// ---- B: skip links ------------------------------------------------------------------------------------------
{
  await T(page, () => document.activeElement?.blur());
  await page.keyboard.press('Tab'); const a1 = await active(page);
  await page.keyboard.press('Tab'); const a2 = await active(page);
  const vis = await T(page, () => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(document.activeElement).opacity === '1'; });
  check(a1.text === 'Skip to canvas' && a2.text === 'Open image…' && vis, `Tab 1 = "${a1.text}", Tab 2 = "${a2.text}" (visible when focused: ${vis}); before: 45 Tabs to Open image…`);
  await shot(page, 'skip-link');
  await T(page, () => { window.__pick = 0; document.querySelector('#fileInput').addEventListener('click', () => { window.__pick++; }); });
  const fc = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
  await page.keyboard.press('Enter'); const chooser = await fc; const picks = await T(page, () => window.__pick);
  // the app's part is clicking the file input (that is what shows the system picker); headless Chromium under load
  // occasionally does not surface Playwright's filechooser event for it, so the test opens the file directly then
  check(picks === 1, `Enter on the "Open image…" skip link opens the file picker (file input clicked ${picks}×; chooser event ${chooser ? 'seen' : 'not surfaced'})`);
  if (chooser) { await chooser.setFiles({ name: 'city.jpg', mimeType: 'image/jpeg', buffer: REAL('v126-city.jpg') }); await page.waitForFunction(() => window.tintwork.doc?.name === 'city.jpg'); await T(page, () => window.tintwork.idle()); }
  else await open(page, 'v126-city.jpg', 'city.jpg');
  check((await active(page)).id === 'viewport', `after opening from the skip link, focus continues on the canvas (${(await active(page)).id})`);
  await page.focus('#skipCanvas'); await page.keyboard.press('Enter');
  check((await active(page)).id === 'viewport', 'Enter on "Skip to canvas" focuses the canvas');
}
// ---- C: stale status bar ---------------------------------------------------------------------------------
{
  await T(page, () => window.tintwork.status?.('Opened city.jpg (test)') ?? (document.querySelector('#status').textContent = 'Opened city.jpg (test)'));
  const st0 = await T(page, () => document.querySelector('#status').textContent);
  await page.click('#toolbar button[data-tool="brush"]');
  const box = await page.locator('#view').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 10, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction(() => window.tintwork.history.entries.at(-1)?.label === 'Brush stroke', null, { timeout: 5000 }).catch(() => {});
  const st1 = await T(page, () => document.querySelector('#status').textContent);
  check(/^Opened/.test(st0) && st1 === 'Brush stroke', `status after a brush stroke shows the action, not the stale message ("${st0}" → "${st1}")`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
}
// ---- B: layers panel by keyboard ----------------------------------------------------------------------------
{
  await page.click('#toolbar button[data-tool="move"]');
  await page.keyboard.press('Control+j'); await page.keyboard.press('Control+Shift+n'); await page.waitForTimeout(200);
  const ids = await T(page, () => [...document.querySelectorAll('#layerList li[data-rove]')].map((l) => l.dataset.id));
  const act0 = await T(page, () => String(window.tintwork.doc.activeId));
  await page.locator('#viewport').focus(); // keyboard user parked on the canvas
  const r = await tabUntil(page, (a) => a.rove === 'layer');
  const stops = await T(page, () => [...document.querySelectorAll('#layerList li[data-rove]')].filter((l) => l.tabIndex === 0).length);
  check(r.n > 0 && r.a.dataId === act0 && stops === 1, `Tab reaches the Layers list on the selected layer (${r.n} Tabs from the canvas; ${stops} tab stop in ${ids.length} rows)`);
  check(r.a.fv === true && !/^none/.test(r.a.outline), `focused layer row shows a focus ring (:focus-visible=${r.a.fv}, outline ${r.a.outline})`);
  await page.keyboard.press('ArrowDown'); const a1 = await active(page);
  const act1 = await T(page, () => String(window.tintwork.doc.activeId));
  check(a1.rove === 'layer' && a1.dataId === ids[1] && act1 === act0, `↓ moves focus to the next row without changing the selection (focus ${a1.dataId}, active still ${act1})`);
  await shot(page, 'layer-focus');
  await page.keyboard.press('Enter'); await page.waitForTimeout(100);
  const a2 = await active(page); const act2 = await T(page, () => String(window.tintwork.doc.activeId)); const st2 = await T(page, () => document.querySelector('#status').textContent);
  check(act2 === ids[1] && a2.dataId === ids[1] && a2.fv && /selected/.test(st2), `Enter selects the focused layer and keeps focus on it ("${st2}")`);
  await page.keyboard.press('End'); await page.keyboard.press(' '); await page.waitForTimeout(100);
  const act3 = await T(page, () => String(window.tintwork.doc.activeId)); const a3 = await active(page);
  check(act3 === ids.at(-1) && a3.dataId === ids.at(-1), `End + Space selects the bottom layer (${act3})`);
  await page.keyboard.press('Home'); const a4 = await active(page);
  check(a4.dataId === ids[0], `Home moves to the top row (${a4.dataId})`);
  await page.keyboard.press('Tab'); const eye = await active(page);
  const eyeName = await T(page, () => document.activeElement.getAttribute('aria-label'));
  check(eye.tag === 'BUTTON' && /^(Hide|Show) layer /.test(eyeName || ''), `Tab from the focused row reaches its visibility button ("${eyeName}")`);
  // mouse regression: click a row, then the arrow keys still nudge with the Move tool and focus is not hijacked
  await page.locator(`#layerList li[data-id="${ids[0]}"] .name`).click(); await page.waitForTimeout(100);
  const x0 = await T(page, () => window.tintwork.activeLayer().x);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(80);
  const x1 = await T(page, () => window.tintwork.activeLayer().x); const am = await active(page);
  check(x1 === x0 + 1 && !(am.rove && am.fv), `mouse click on a layer row, then → still nudges the layer (x ${x0} → ${x1}; focus ${am.tag}${am.rove ? ' row' : ''})`);
  await page.waitForTimeout(500); // nudge commit
}
// ---- B: history panel by keyboard ---------------------------------------------------------------------------
{
  const h0 = await T(page, () => ({ i: window.tintwork.history.index, n: window.tintwork.history.entries.length, labels: window.tintwork.history.entries.map((e) => e.label) }));
  await page.locator('#viewport').focus();
  const r = await tabUntil(page, (a) => a.rove === 'history');
  check(r.n > 0 && +r.a.idx === h0.i && r.a.fv, `Tab reaches the History list on the current step (${r.n} Tabs from the canvas; step ${+r.a.idx + 1} of ${h0.n})`);
  const cur = await T(page, () => document.activeElement.getAttribute('aria-current'));
  check(cur === 'step', `the current history row has aria-current="step" (${cur})`);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  const h1 = await T(page, () => window.tintwork.history.index); const a1 = await active(page); const st1 = await T(page, () => document.querySelector('#status').textContent);
  check(h1 === h0.i - 1 && +a1.idx === h1 && /^History:/.test(st1), `↑ + Enter steps back one undo state (index ${h0.i} → ${h1}; "${st1}")`);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press(' '); await page.waitForTimeout(150);
  const h2 = await T(page, () => ({ i: window.tintwork.history.index, layers: window.tintwork.doc.layers.length }));
  check(h2.i === h0.i - 3, `↑↑ + Space steps back two more (index ${h2.i}, ${h2.layers} layer(s))`);
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  const h3 = await T(page, () => ({ i: window.tintwork.history.index, layers: window.tintwork.doc.layers.length }));
  check(h3.i === h0.n - 1 && h3.layers === 3, `End + Enter redoes to the newest step (index ${h3.i}, ${h3.layers} layers)`);
  await shot(page, 'history-focus');
}
// ---- C: History panel height, tool column cue ---------------------------------------------------------------
{
  const hp = await T(page, () => { const p = document.querySelector('#historyPanel').getBoundingClientRect(); const li = document.querySelector('#historyList li').getBoundingClientRect(); const list = document.querySelector('#historyList').getBoundingClientRect(); return { h: Math.round(p.height), rows: Math.floor(list.height / li.height) || Math.floor((p.height - 30) / li.height), bottom: p.bottom <= innerHeight }; });
  check(hp.h >= 120 && hp.bottom, `History panel at 1366×768 is ${hp.h} px tall (was ~62 px, 2 rows), fully on screen`);
  const tm = await T(page, () => { const m = document.querySelector('#toolMore'); const tb = document.querySelector('#toolbar'); return { show: m?.classList.contains('show'), vis: !!m && m.getBoundingClientRect().height > 0 && m.getBoundingClientRect().bottom <= innerHeight, more: tb.scrollHeight > tb.clientHeight }; });
  check(tm.more && tm.show && tm.vis, `1366×768: tool column overflows and shows the "more tools" cue (${JSON.stringify(tm)})`);
  await page.click('#toolMore'); await page.waitForTimeout(600);
  const after = await T(page, () => { const tb = document.querySelector('#toolbar'); const z = document.querySelector('#toolbar button[data-tool="zoom"]').getBoundingClientRect(); return { top: tb.scrollTop, zoomVisible: z.bottom <= tb.getBoundingClientRect().bottom + 1 && z.top >= 0 }; });
  check(after.top > 0 && after.zoomVisible, `clicking the cue scrolls the column; the Zoom tool comes into view (scrollTop ${after.top})`);
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForTimeout(250);
  const big = await T(page, () => ({ h: Math.round(document.querySelector('#historyPanel').getBoundingClientRect().height), show: document.querySelector('#toolMore').classList.contains('show') }));
  check(big.h >= 120 && !big.show, `1920×1080: History ${big.h} px; no cue when every tool fits (${big.show})`);
  await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(150);
}
// ---- A (desktop, no regression): crop keeps Apply / Cancel in the options bar; fit unchanged --------------
{
  await open(page, 'v128-towers.jpg', 'towers.jpg');
  const fit = await T(page, () => { const t = window.tintwork, d = t.doc, vp = document.querySelector('#viewport'); const z = Math.min((vp.clientWidth - 48) / d.width, (vp.clientHeight - 48 - 28) / d.height, 1); return { zoom: t.state.zoom, expect: z, panX: t.state.panX, expectX: Math.round((vp.clientWidth - d.width * z) / 2) }; });
  check(Math.abs(fit.zoom - fit.expect) < 1e-9 && fit.panX === fit.expectX, `desktop fit unchanged (zoom ${fit.zoom.toFixed(4)}, panX ${fit.panX})`);
  await page.click('#toolbar button[data-tool="crop"]'); await page.click('[data-cropchip="portrait45"]'); await page.waitForTimeout(150);
  const d = await T(page, () => ({ float: document.querySelectorAll('#floatActions button').length, apply: (() => { const b = document.querySelector('#optionsbar [data-cmd="cropApply"]'); const r = b?.getBoundingClientRect(); return !!r && r.width > 0 && r.right <= innerWidth; })(), crop: !!window.tintwork.state.crop }));
  check(d.crop && d.float === 0 && d.apply, `desktop crop: Apply stays in the options bar, no floating buttons (${JSON.stringify(d)})`);
  await page.keyboard.press('Escape'); await page.click('#toolbar button[data-tool="hand"]');
}
// ---- B: tabs + dialog name + axe with a document open ------------------------------------------------------
{
  const tb = await T(page, () => [...document.querySelectorAll('#tabbar .doc-tab')].map((t) => ({ role: t.getAttribute('role'), btn: t.querySelector('button.tab-name')?.getAttribute('aria-current') })));
  check(tb.length === 2 && tb.every((t) => t.role === null) && tb.filter((t) => t.btn === 'page').length === 1, `document tabs: no control nested in a role=tab; the current one is aria-current=page (${JSON.stringify(tb)})`);
  const v1 = await axe(page); axeCounts.docOpen = v1; check(sev(v1).length === 0, `axe with documents open: 0 serious/critical (${fmt(v1)})`);
  await page.keyboard.press('Control+m'); await page.waitForSelector('#modal:not(.hidden)');
  const named = await page.getByRole('dialog', { name: 'Curves' }).count();
  check(named === 1, `the Curves dialog is announced by name (getByRole('dialog', { name: 'Curves' }) → ${named})`);
  const v2 = await axe(page); axeCounts.curvesDialog = v2; check(sev(v2).length === 0, `axe in the Curves dialog: 0 serious/critical (${fmt(v2)})`);
  await page.keyboard.press('Escape');
}
await page.context().close();
await browser.close();

// ================================ iPhone (WebKit, iPhone 13 profile, touch) ===============================
const wk = await webkit.launch();
page = await freshPage(wk, { ...devices['iPhone 13'] }, 'iphone');
{
  await open(page, 'v128-towers.jpg', 'towers.jpg');
  const g = await T(page, () => { const t = window.tintwork, tb = document.querySelector('#toolbar').getBoundingClientRect(), vp = document.querySelector('#viewport').getBoundingClientRect(); return { tbRight: Math.round(tb.right - vp.left), imgLeft: t.state.panX, imgRight: t.state.panX + t.doc.width * t.state.zoom, vpW: vp.width, zoom: t.state.zoom, collapsed: document.body.classList.contains('tools-collapsed') }; });
  check(!g.collapsed && g.imgLeft >= g.tbRight && g.imgRight <= g.vpW, `phone: the photo is fitted beside the tool column, not under it (photo x ${Math.round(g.imgLeft)}–${Math.round(g.imgRight)}, column ends at ${g.tbRight}, width ${g.vpW})`);
  await page.tap('#toolsToggle'); await page.waitForTimeout(350);
  const g2 = await T(page, () => ({ left: window.tintwork.state.panX, zoom: window.tintwork.state.zoom, collapsed: document.body.classList.contains('tools-collapsed') }));
  check(g2.collapsed && g2.zoom >= g.zoom && g2.left < g.imgLeft, `hiding the tool column refits the photo to the full width (zoom ${g.zoom.toFixed(3)} → ${g2.zoom.toFixed(3)})`);
  await page.tap('#toolsToggle'); await page.waitForTimeout(350);
  const g3 = await T(page, () => window.tintwork.state.panX);
  check(Math.abs(g3 - g.imgLeft) <= 1, `showing it again moves the photo back beside it (panX ${g3})`);
  await page.locator('#toolbar button[data-tool="crop"]').tap(); await page.waitForTimeout(200);
  const chips = await T(page, () => [...document.querySelectorAll('#optionsbar [data-cropchip]')].map((b) => { const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { id: b.dataset.cropchip, label: b.textContent, inView: r.left >= 0 && r.right <= innerWidth, hit: top === b }; }));
  check(chips.length >= 5 && chips.filter((c) => c.inView && c.hit).length >= 4 && chips.find((c) => c.id === 'portrait45')?.inView && chips.find((c) => c.id === 'portrait45')?.hit, `phone crop: ratio chips on screen without swiping, and a tap hits the chip itself (${chips.map((c) => `${c.label}${c.inView && c.hit ? '✓' : '✗'}`).join(' ')})`);
  await page.locator('[data-cropchip="portrait45"]').tap(); await page.waitForTimeout(250);
  const fl = await T(page, () => { const vp = document.querySelector('#viewport').getBoundingClientRect(); return { preset: window.tintwork.state.opts.cropPreset, crop: window.tintwork.state.crop, btns: [...document.querySelectorAll('#floatActions button')].map((b) => { const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { t: b.textContent, on: r.left >= 0 && r.right <= innerWidth && r.top >= vp.top && r.bottom <= vp.bottom, hit: top === b, h: Math.round(r.height) }; }), barApply: getComputedStyle(document.querySelector('#optionsbar [data-cmd="cropApply"]')).display }; });
  const ratio = fl.crop ? fl.crop.w / fl.crop.h : 0;
  check(fl.preset === 'portrait45' && Math.abs(ratio - 0.8) < 0.01, `tapping 4:5 sets a 4:5 crop (${fl.crop?.w}×${fl.crop?.h})`);
  check(fl.btns.map((b) => b.t).join('|') === 'Cancel|Apply' && fl.btns.every((b) => b.on && b.hit && b.h >= 44) && fl.barApply === 'none', `phone: Cancel and Apply float over the canvas, fully on screen, ≥44 px, not covered (${JSON.stringify(fl.btns)}); options-bar copies hidden`);
  const ov = await T(page, () => { const t = window.tintwork, vp = document.querySelector('#viewport').getBoundingClientRect(), f = document.querySelector('#floatActions').getBoundingClientRect(); return { imgBottom: Math.round(vp.top + t.state.panY + t.doc.height * t.state.zoom), floatTop: Math.round(f.top) }; });
  check(ov.imgBottom <= ov.floatTop, `the fitted photo (and its crop handles) sits above the floating buttons (photo bottom ${ov.imgBottom} ≤ buttons top ${ov.floatTop})`);
  await shot(page, 'phone-crop');
  const w0 = await T(page, () => [window.tintwork.doc.width, window.tintwork.doc.height]);
  await page.locator('#floatActions button', { hasText: 'Cancel' }).tap(); await page.waitForTimeout(200);
  const c1 = await T(page, () => ({ crop: window.tintwork.state.crop, size: [window.tintwork.doc.width, window.tintwork.doc.height], float: document.querySelectorAll('#floatActions button').length }));
  check(!c1.crop && c1.size.join() === w0.join() && c1.float === 0, `floating Cancel drops the crop; the photo is unchanged (${c1.size.join('×')})`);
  await page.locator('[data-cropchip="portrait45"]').tap(); await page.waitForTimeout(200);
  await page.locator('#floatActions button', { hasText: 'Apply' }).tap();
  await page.waitForFunction((w) => window.tintwork.doc.width !== w, w0[0], { timeout: 10000 }).catch(() => {});
  const c2 = await T(page, () => ({ size: [window.tintwork.doc.width, window.tintwork.doc.height], st: document.querySelector('#status').textContent, float: document.querySelectorAll('#floatActions button').length }));
  check(Math.abs(c2.size[0] / c2.size[1] - 0.8) < 0.01 && c2.float === 0 && !/^Opened/.test(c2.st), `floating Apply crops to 4:5 (${c2.size.join('×')}); status "${c2.st}"`);
  await shot(page, 'phone-cropped');
  const v = await axe(page); axeCounts.iphone = v; check(sev(v).length === 0, `axe on iPhone after crop: 0 serious/critical (${fmt(v)})`);
  // layer rows still tap-select in the Layers sheet
  await page.keyboard.press('Control+j').catch(() => {}); await T(page, () => window.tintwork.run('layerNew')); await page.waitForTimeout(150);
  await page.locator('#mobilebar [data-sheet="layers"]').tap(); await page.waitForTimeout(300);
  const ids = await T(page, () => [...document.querySelectorAll('#layerList li[data-rove]')].map((l) => l.dataset.id));
  await page.locator(`#layerList li[data-id="${ids.at(-1)}"] .name`).tap(); await page.waitForTimeout(150);
  check(await T(page, () => String(window.tintwork.doc.activeId)) === ids.at(-1), `phone: tapping a layer row in the Layers sheet still selects it (${ids.length} rows)`);
}
await page.context().close(); await wk.close();

console.log(`axe serious+critical: ${Object.entries(axeCounts).map(([k, v]) => `${k} ${sev(v).length}`).join(', ')}`);
check(!errors.length, `no page errors (${errors.slice(0, 2).join(' | ')})`);
server.close();
console.log(`\nv133: ${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
