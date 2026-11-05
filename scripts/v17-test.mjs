// v1.7 test: the fixes from the workflow benchmark and the site audit (docs/AUDIT.md).
//  - typed values in every dialog slider; export dialog resize + ppi (print exports keep 300 ppi)
//  - Image › Guided upright (two guide lines straighten converging verticals)
//  - masks switch the colours to black/white; menu bar keyboard access (Alt / F10, arrows); dialogs trap Tab
//  - no browser-reserved shortcut advertised; CSP / description / social preview / canonical / 404 page
//  - service worker: revalidating fetches and a "new version ready" bar after a deploy; AA contrast on primary buttons
// TW_ROOT=/path/to/other/checkout runs the same checks against another tree (used to confirm they fail on v1.6.0).
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

// static server with a switchable sw.js (to simulate a deploy)
const inner = createStaticServer(), handler = inner.listeners('request')[0]; let swOverride = null;
const http = await import('node:http');
const server = http.createServer((req, res) => {
  if (swOverride && req.url.split('?')[0] === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' }); res.end(swOverride); return; }
  handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  const W = (window.__pick = { save: 0, lastSave: null });
  window.showSaveFilePicker = async (o) => { W.save++; W.lastSave = o.suggestedName; const root = await navigator.storage.getDirectory(); return root.getFileHandle(o.suggestedName, { create: true }); };
});
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const opfs = (name) => page.evaluate(async (name) => { const root = await navigator.storage.getDirectory(); const f = await (await root.getFileHandle(name)).getFile(); const b = new Uint8Array(await f.arrayBuffer()); const bmp = await createImageBitmap(f); return { w: bmp.width, h: bmp.height, head: [...b.slice(0, 64)], type: f.type }; }, name);
const jfif = (h) => (h[2] === 0xff && h[3] === 0xe0 ? { unit: h[13], x: (h[14] << 8) | h[15], y: (h[16] << 8) | h[17] } : null);
const phys = (h) => { for (let i = 8; i < h.length - 12; i++) if (String.fromCharCode(h[i], h[i + 1], h[i + 2], h[i + 3]) === 'pHYs') return { x: (h[i + 4] << 24 | h[i + 5] << 16 | h[i + 6] << 8 | h[i + 7]) >>> 0, unit: h[i + 12] }; return null; };
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));
const modalOpen = () => page.waitForSelector('#modal:not(.hidden)', { timeout: 4000 }).then(() => true).catch(() => false);
const closeModal = async () => { if (await page.evaluate(() => !document.querySelector('#modal').classList.contains('hidden'))) await page.click('#modalCancel').catch(() => page.keyboard.press('Escape')); };
const photo = () => T(() => { const t = window.tintwork; t.newDocument(1200, 800, 'white', 'photo'); const l = t.activeLayer(), c = l.canvas.getContext('2d'); for (let i = 0; i < 1200; i += 20) { c.fillStyle = i % 40 ? '#335' : '#fc8'; c.fillRect(i, 0, 20, 800); } t.touch(l); t.markDirty(); t.renderNow(); });

// --- 1. typed numbers in dialog sliders
await photo();
await T(() => window.tintwork.run('gaussianBlur'));
let has = await modalOpen() && await page.locator('#modal input.pf-num[data-num-key="radius"]').count() > 0;
check(has, 'Gaussian blur dialog has a number field for Radius');
if (has) {
  const n = page.locator('#modal input.pf-num[data-num-key="radius"]');
  await n.fill('30'); await n.dispatchEvent('input');
  const synced = await page.evaluate(() => { const r = document.querySelector('#modal input.pf-num[data-num-key="radius"]').closest('.field').querySelector('input[type=range]'); return +r.value; });
  check(synced === 30, `typing 30 moves the slider to 30 (${synced})`);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#modal input.pf-num')].every((i) => i.getAttribute('aria-label')));
  check(labels, 'dialog number fields have accessible names');
  await n.press('Enter'); await page.waitForTimeout(300);
  const st = await T(async () => { await window.tintwork.idle(); return { open: !document.querySelector('#modal').classList.contains('hidden'), hist: window.tintwork.history?.entries?.at?.(-1)?.label || document.querySelector('#historyList li:last-child, #history li:last-child')?.textContent || '' }; });
  check(!st.open, `Enter in the number field applies the dialog (dialog closed: ${!st.open}; last step "${st.hist}")`);
  await page.keyboard.press('Control+z');
  await T(() => window.tintwork.run('gaussianBlur')); await modalOpen();
  await n.fill('9999'); await n.dispatchEvent('change');
  const clamped = await page.evaluate(() => { const i = document.querySelector('#modal input.pf-num[data-num-key="radius"]'); return [+i.value, +i.max]; });
  check(clamped[0] === clamped[1], `an out-of-range value is clamped to the maximum (${clamped[0]} / max ${clamped[1]})`);
}
await closeModal();

// --- 2. export dialog: ppi and resize
async function exportVia(set, fmt = 'image/jpeg') {
  await page.evaluate(() => { window.__pick.lastSave = null; });
  await page.keyboard.press('Control+Shift+e');
  if (!(await page.waitForSelector('#modal:not(.hidden) #eFmt', { timeout: 4000 }).then(() => true).catch(() => false))) return null;
  await page.selectOption('#eFmt', fmt);
  for (const [sel, v] of set) { if (!(await page.locator(sel).count())) { await closeModal(); return { missing: sel }; } if ((await page.locator(sel).evaluate((e) => e.tagName)) === 'SELECT') await page.selectOption(sel, v); else { await page.fill(sel, String(v)); await page.locator(sel).dispatchEvent('input'); await page.locator(sel).dispatchEvent('change'); } }
  await page.click('#modalOk');
  const ok = await page.waitForFunction(() => window.__pick.lastSave && /Exported/.test(document.querySelector('#status').textContent), null, { timeout: 20000 }).then(() => true).catch(() => false);
  if (!ok) return null;
  await page.waitForTimeout(150);
  const name = await page.evaluate(() => window.__pick.lastSave);
  return opfs(name).catch(async (e) => { console.log('     export debug:', name, await page.evaluate(() => document.querySelector('#status').textContent)); throw e; });
}
await photo(); await T(() => { window.tintwork.doc.dpi = 300; });
let f = await exportVia([]);
let d = f && jfif(f.head);
check(d && d.unit === 1 && d.x === 300 && d.y === 300, `a 300 ppi document exports a JPEG with 300 ppi in its header (${d ? `unit ${d.unit}, ${d.x}×${d.y}` : 'no export'})`);
f = await exportVia([], 'image/png'); const p = f && phys(f.head);
check(p && p.unit === 1 && Math.round(p.x * 0.0254) === 300, `PNG export carries 300 ppi in pHYs (${p ? `${p.x} px/m` : 'none'})`);
f = await exportVia([['#eSize', 'long'], ['#eSizeV', 600], ['#eDpi', 240]]);
d = f && !f.missing && jfif(f.head);
check(f && !f.missing && Math.max(f.w, f.h) === 600 && Math.min(f.w, f.h) === 400, `export dialog resizes to a 600 px long edge (${f ? (f.missing ? `no ${f.missing}` : `${f.w}×${f.h}`) : 'no export'})`);
check(d && d.x === 240, `export dialog's Resolution field sets the ppi (${d ? d.x : 'none'})`);
await photo();
f = await exportVia([]); d = f && jfif(f.head);
check(f && (!d || d.unit === 0 || d.x === 72), `a document without a ppi is not given a made-up print size (${d ? `unit ${d.unit}, ${d.x}` : 'no JFIF'})`);

// --- 3. guided upright
await T(() => { const t = window.tintwork; t.newDocument(2000, 2400, 'white', 'building'); const l = t.activeLayer(), x = l.canvas.getContext('2d');
  x.fillStyle = '#a9c4dc'; x.fillRect(0, 0, 2000, 2400); x.fillStyle = '#b5a48f'; x.beginPath(); x.moveTo(600, 200); x.lineTo(1400, 200); x.lineTo(1700, 2300); x.lineTo(300, 2300); x.closePath(); x.fill(); x.strokeStyle = '#4a3d30'; x.lineWidth = 14; x.stroke(); t.touch(l); t.markDirty(); t.renderNow(); });
const menuHas = await page.locator('#menus .menu-items button[data-cmd="guidedUpright"]').count();
check(menuHas === 1, 'Image menu has Guided upright');
if (menuHas) {
  // v1.13 applies Guided immediately after the second line (Crop by default). This check measures uncropped
  // geometry, so choose Keep *before* the guides are drawn.
  await T(() => { window.tintwork.state.opts.uprightEdges = 'keep'; });
  await T(() => window.tintwork.run('guidedUpright'));
  const toS = (x, y) => page.evaluate(({ x, y }) => { const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state; return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom }; }, { x, y });
  const drag = async (a, b) => { const s = await toS(...a), e = await toS(...b); await page.mouse.move(s.x, s.y); await page.mouse.down(); for (let k = 1; k <= 8; k++) await page.mouse.move(s.x + (e.x - s.x) * k / 8, s.y + (e.y - s.y) * k / 8); await page.mouse.up(); };
  const ex = (y) => { const t = (y - 200) / 2100; return [600 - 300 * t, 1400 + 300 * t]; };
  await drag([ex(300)[0], 300], [ex(2200)[0], 2200]);
  const mid = await T(() => ({ guides: window.tintwork.mxf?.guides?.length, bar: document.querySelector('#optionsbar').textContent }));
  check(mid.guides === 1 && /second line/i.test(mid.bar), `after one guide the options bar asks for a second (${mid.guides}, "${(mid.bar || '').slice(0, 60)}")`);
  await drag([ex(300)[1], 300], [ex(2200)[1], 2200]);
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 }).catch(() => {});
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const e = await T(async () => { const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), x = c.getContext('2d'); const scan = (y, dir) => { const d = x.getImageData(0, y, c.width, 1).data; for (let k = 0; k < c.width; k++) { const i = dir > 0 ? k : c.width - 1 - k, j = i * 4; if (d[j + 3] > 200 && d[j] < 110 && d[j + 1] < 100) return i; } return -1; }; return [scan(360, 1), scan(2040, 1), scan(360, -1), scan(2040, -1)]; });
  check(e.every((v) => v > 0) && Math.abs(e[0] - e[1]) <= 6 && Math.abs(e[2] - e[3]) <= 6, `guided upright makes both walls vertical (left ${e[0]}→${e[1]}, right ${e[2]}→${e[3]})`);
  const id = await T(() => window.tintwork.uprightFromGuides([[0, 0], [100, 0], [100, 100], [0, 100]], [[[10, 0], [10, 100]], [[90, 0], [90, 100]]]));
  check(Array.isArray(id) && id.every(([x, y], i) => Math.abs(x - [0, 100, 100, 0][i]) < 1e-6 && Math.abs(y - [0, 0, 100, 100][i]) < 1e-6), 'guides that are already vertical leave the image unchanged');
}

// --- 4. mask colours, keyboard, shortcuts
await photo(); await T(() => { window.tintwork.setFg('#e8553a'); window.tintwork.run('layerNew'); window.tintwork.run('addMask'); });
const fg = await T(() => [window.tintwork.state.fg, window.tintwork.state.bg]);
check(/^#000000$/i.test(fg[0]) && /^#ffffff$/i.test(fg[1]), `adding a mask switches colours to black / white (${fg})`);
await page.mouse.click(640, 400); await page.keyboard.press('Escape');
await page.keyboard.press('Alt');
let foc = await T(() => document.activeElement?.textContent?.trim());
check(foc === 'File', `Alt on its own focuses the menu bar (${foc})`);
await page.keyboard.press('ArrowRight'); foc = await T(() => document.activeElement?.textContent?.trim());
check(foc === 'Edit', `→ moves to the next menu (${foc})`);
await page.keyboard.press('ArrowDown');
foc = await T(() => ({ open: !!document.querySelector('.menu.open'), inItems: !!document.activeElement?.closest('.menu-items'), cmd: document.activeElement?.dataset?.cmd }));
check(foc.open && foc.inItems, `↓ opens the menu and focuses its first item (${foc.cmd})`);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
foc = await T(() => ({ open: !!document.querySelector('.menu.open'), inMenus: !!document.activeElement?.closest('#menus') }));
check(!foc.open && !foc.inMenus, 'Esc twice closes the menu and leaves the menu bar');
await page.keyboard.press('F10'); foc = await T(() => document.activeElement?.textContent?.trim()); await page.keyboard.press('F10');
check(foc === 'File', `F10 focuses the menu bar too (${foc})`);
await photo(); await page.keyboard.press('Control+l'); const lv = await modalOpen();
check(lv, `Ctrl+L opens Levels (${lv ? '' : await T(() => [document.activeElement?.tagName, document.activeElement?.textContent?.slice(0, 20), document.querySelector('#status').textContent].join(' | '))})`);
const inside = () => T(() => document.querySelector('#modal').contains(document.activeElement));
let out = 0; for (let i = 0; i < 30; i++) { await page.keyboard.press('Tab'); if (!(await inside())) out++; }
check(out === 0, `Tab stays inside an open dialog (${out} of 30 presses left it)`);
out = 0; for (let i = 0; i < 30; i++) { await page.keyboard.press('Shift+Tab'); if (!(await inside())) out++; }
check(out === 0, `Shift+Tab stays inside an open dialog (${out} of 30 presses left it)`);
await closeModal();
const kbd = await T(() => [...document.querySelectorAll('#menus .menu-items button[data-cmd="docPrev"] kbd')].map((k) => k.textContent));
check(kbd.length === 1 && kbd[0] === 'Ctrl+Shift+F6', `Previous document shows Ctrl+Shift+F6, not the browser's Ctrl+Shift+Tab (${kbd})`);

// --- 5. page metadata, CSP, contrast
const meta = await T(async () => {
  const q = (s) => document.querySelector(s);
  const og = q('meta[property="og:image"]')?.content || '';
  const rel = og ? new URL(og).pathname.replace(/^\/tintwork\//, './') : '';
  const ogOk = rel ? (await fetch(rel)).ok : false, nf = await fetch('./404.html').then((r) => r.text()).catch(() => '');
  const L = (h) => { const c = h.match(/\d+/g).slice(0, 3).map((v) => +v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const b = document.createElement('button'); b.className = 'primary'; b.textContent = 'x'; document.body.append(b); const cs = getComputedStyle(b); const cr = (L(cs.color) + 0.05) / (L(cs.backgroundColor) + 0.05); b.remove();
  return { csp: q('meta[http-equiv="Content-Security-Policy"]')?.content || '', desc: q('meta[name="description"]')?.content || '', og, ogOk, canon: q('link[rel="canonical"]')?.href || '', nf: /Tintwork/.test(nf) && /not found/i.test(nf), contrast: Math.max(cr, 1 / cr) };
});
check(/default-src 'self'/.test(meta.csp) && /object-src 'none'/.test(meta.csp) && !/unsafe-eval'/.test(meta.csp.replace("'wasm-unsafe-eval'", '')), 'a Content-Security-Policy keeps scripts and connections on the site');
check(meta.desc.length > 50, `meta description present (${meta.desc.length} chars)`);
check(meta.og && meta.ogOk, `social preview image declared and served (${meta.og})`);
check(/^https:\/\//.test(meta.canon), `canonical link (${meta.canon})`);
check(meta.nf, '404.html is a Tintwork page');
check(meta.contrast >= 4.5, `white text on primary buttons has ≥ 4.5:1 contrast (${meta.contrast.toFixed(2)})`);

// --- 6. service worker: a deploy shows the "new version ready" bar
const swReady = await T(() => navigator.serviceWorker?.ready.then(() => !!navigator.serviceWorker.controller || new Promise((r) => { navigator.serviceWorker.addEventListener('controllerchange', () => r(true)); setTimeout(() => r(!!navigator.serviceWorker.controller), 5000); })));
check(swReady === true, 'service worker controls the page');
const swSrc = await (await fetch(BASE + 'sw.js')).text();
check(/cache:\s*'no-cache'/.test(swSrc) && /cache:\s*'reload'/.test(swSrc), 'service worker revalidates network fetches and precaches past the HTTP cache');
swOverride = swSrc.replace(/const CACHE = '[^']+'/, "const CACHE = 'tintwork-shell-v9.9.9'");
await T(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
const bar = await page.waitForSelector('#updateBar', { timeout: 15000 }).then((h) => h.textContent()).catch(() => '');
check(/9\.9\.9/.test(bar) && /reload/i.test(bar), `after a deploy the page offers a reload ("${bar.replace(/\s+/g, ' ').slice(0, 90)}")`);
if (bar) { await page.click('#updateBar [data-act="later"]'); check(!(await page.locator('#updateBar').count()), '"Later" dismisses the update bar'); }

check(errors.length === 0, `no console errors (${errors.slice(0, 2).join(' | ')})`);
console.log(`\n${count - fails}/${count} v1.7 checks passed`);
await browser.close(); server.close(); process.exit(fails ? 1 : 0);
