// v1.0 test: end-to-end open → edit → save → reopen → export with autosave recovery, welcome screen, user guide,
// global error catcher, memory guardrails, accessibility labels, dirty-rect brush composite == full composite,
// adjustment-layer proxy then full result, 16-bit inner glow / inner shadow / colour overlay. Screenshots: 10x-*.png.
import { chromium } from 'playwright';
import { createStaticServer } from './serve.mjs';
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const near = (a, b, tol = 2) => a && b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem('tintwork.engine', 'cpu'));
const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(async () => { await window.tintwork.clearAutosave?.(); });

// --- welcome screen -------------------------------------------------------------------------------------
const wl = await page.evaluate(() => { const w = document.querySelector('#welcome'); return { shown: !w.classList.contains('hidden'), presets: w.querySelectorAll('[data-preset]').length, recent: !!w.querySelector('#welcomeRecent'), guide: !!w.querySelector('[data-cmd="userGuide"]') }; });
check(wl.shown && wl.presets >= 5 && wl.recent && wl.guide, `welcome screen with presets, recent files and help (${JSON.stringify(wl)})`);
await page.screenshot({ path: 'screenshots/10x-welcome.png' });
await page.click('#welcomePresets [data-preset="1080x1080"]');
const pd = await page.evaluate(() => { const d = window.tintwork.state.doc; return d && [d.width, d.height, document.querySelector('#welcome').classList.contains('hidden')]; });
check(pd && pd[0] === 1080 && pd[1] === 1080 && pd[2], `welcome preset creates a 1080×1080 canvas and hides the welcome screen (${pd})`);

// --- user guide ---
{ const { readFileSync } = await import('node:fs'); const md = readFileSync('docs/USER_GUIDE.md', 'utf8'); const mod = (await import('../src/user-guide.js')).default;
  check(md === mod, 'src/user-guide.js is in sync with docs/USER_GUIDE.md (npm run guide)'); }
await page.keyboard.press('F1');
await page.waitForSelector('#modal:not(.hidden) .help-doc', { timeout: 5000 }).catch(() => {});
const ug = await page.evaluate(() => { const b = document.querySelector('.help-doc'); return b && { title: document.querySelector('#modalTitle').textContent, h2: b.querySelectorAll('h2').length, toc: b.querySelectorAll('.help-toc a').length, table: !!b.querySelector('table'), adobe: /photoshop|adobe/i.test(b.textContent) }; });
check(ug && /user guide/i.test(ug.title) && ug.h2 >= 8 && ug.toc === ug.h2 && ug.table && !ug.adobe, `F1 opens the user guide with contents (${JSON.stringify(ug)})`);
await page.click('.help-toc a:nth-child(5)'); await page.waitForTimeout(100);
await page.screenshot({ path: 'screenshots/10x-user-guide.png' });
await page.keyboard.press('Escape');
const helpMenu = await page.evaluate(() => [...document.querySelectorAll('#menubar *')].some((e) => e.textContent.trim().startsWith('User guide')));
check(helpMenu, 'Help ▸ User guide menu item');

// --- end-to-end: open → edit → save → reopen → export -----------------------------------------------
const e2e = await page.evaluate(async () => {
  const t = window.tintwork, out = {};
  const c = document.createElement('canvas'); c.width = 800; c.height = 600; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 800, 0); g.addColorStop(0, '#203040'); g.addColorStop(1, '#e0a060'); x.fillStyle = g; x.fillRect(0, 0, 800, 600);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await t.openFile(new File([blob], 'e2e.png', { type: 'image/png' }));
  out.opened = [t.state.doc.width, t.state.doc.height, t.state.doc.name];
  t.run('layerNew'); t.setFg('#ff0000'); t.state.brushSize = 30; t.state.brushHardness = 100; t.state.brushOpacity = 100;
  t.paintStroke([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
  t.addAdj('hueSaturation', { hue: 0, saturation: -100, lightness: 0 }, 'B&W'); t.commit('adj');
  await t.idle?.();
  const pts = [[200, 100], [600, 400], [50, 550]];
  const px = async () => { const r = []; for (const [a, b] of pts) r.push([...(await t.compositePixelAsync(a, b))].slice(0, 3)); return r; };
  out.before = await px(); out.layers = t.state.doc.layers.length;
  const json = JSON.stringify(t.serializeProject());
  t.newDocument(10, 10, 'white', 'other');
  await t.openFile(new File([json], 'e2e.tintwork', { type: 'application/json' }));
  await t.idle?.();
  out.reopened = await px(); out.layers2 = t.state.doc.layers.length;
  const jpg = await t.renderExportBlob('image/jpeg', 0.92), png = await t.renderExportBlob('image/png');
  const bm = await createImageBitmap(png), cc = document.createElement('canvas'); cc.width = bm.width; cc.height = bm.height; const cx = cc.getContext('2d'); cx.drawImage(bm, 0, 0);
  out.exported = pts.map(([a, b]) => [...cx.getImageData(a, b, 1, 1).data].slice(0, 3)); out.expSize = [bm.width, bm.height]; out.jpgKB = Math.round(jpg.size / 1024);
  return out;
});
check(e2e.opened.join() === '800,600,e2e.png', `opened an 800×600 PNG (${e2e.opened})`);
check(e2e.before[0][0] === e2e.before[0][1] && e2e.before[0][0] > 30, `edit: red stroke under a B&W adjustment layer is grey (${e2e.before[0]})`);
check(e2e.layers2 === e2e.layers && e2e.reopened.every((p, i) => near(p, e2e.before[i], 1)), `save → reopen keeps layers and pixels (${JSON.stringify(e2e.reopened)})`);
check(e2e.expSize.join() === '800,600' && e2e.exported.every((p, i) => near(p, e2e.before[i], 1)) && e2e.jpgKB > 1, `export matches the canvas (PNG ${e2e.expSize}, JPEG ${e2e.jpgKB} KB)`);

// autosave recovery of the reopened, edited document
await page.evaluate(async () => { const t = window.tintwork; t.run('invert'); await t.autosaveNow(); });
const preCrash = await page.evaluate(async () => [...(await window.tintwork.compositePixelAsync(600, 400))].slice(0, 3));
await page.reload(); await page.waitForSelector('#modal:not(.hidden)', { timeout: 6000 }).catch(() => {});
const recTitle = await page.locator('#modalTitle').textContent();
await page.locator('#modalOk').click();
await page.waitForFunction(() => window.tintwork.state.doc?.layers.length > 2, null, { timeout: 8000 }).catch(() => {});
const postCrash = await page.evaluate(async () => { const t = window.tintwork; await t.idle?.(); return { px: [...(await t.compositePixelAsync(600, 400))].slice(0, 3), n: t.state.doc?.layers.length }; });
check(/recover/i.test(recTitle) && near(postCrash.px, preCrash, 1) && postCrash.n === e2e.layers, `autosave recovery restores the edited document (${recTitle}; ${postCrash.px} vs ${preCrash})`);

// --- global error catcher ----------------------------------------------------------------------------------
const er = await page.evaluate(async () => {
  const t = window.tintwork; const before = (await t.readAutosave())?.time || 0;
  await new Promise((r) => setTimeout(r, 20));
  setTimeout(() => { throw new Error('synthetic failure for the test'); }, 0);
  await new Promise((r) => setTimeout(r, 400));
  const after = (await t.readAutosave())?.time || 0;
  return { toast: document.querySelector('#toast')?.textContent || '', saved: after >= before, docOk: !!t.state.doc };
});
check(/went wrong/i.test(er.toast) && /saved/i.test(er.toast) && er.docOk, `uncaught errors show a friendly notice and trigger an autosave ("${er.toast.slice(0, 90)}…")`);
const errorsBefore = errors.filter((m) => !/synthetic failure/.test(m)); errors.length = 0; errors.push(...errorsBefore);
const bad = await page.evaluate(async () => { const t = window.tintwork; const n = t.tabs.length; await t.openFile(new File([new Uint8Array([1, 2, 3, 4])], 'broken.jpg', { type: 'image/jpeg' })); return { toast: document.querySelector('#toast')?.textContent || '', same: t.tabs.length === n }; });
check(/broken\.jpg could not be read/.test(bad.toast) && bad.same, `a damaged file gets a friendly message naming it ("${bad.toast.split('\n').pop()}")`);

// --- memory guardrails -------------------------------------------------------------------------------------
const mg = await page.evaluate(() => { const t = window.tintwork; return { small: t.guardSize(1920, 1080, 3).level, p24: t.guardSize(6000, 4000, 5).level, huge: t.guardSize(16384, 16384, 10, true).level, over: t.guardSize(20000, 100).level, limit: Math.round(t.MEM_LIMIT_MB) }; });
check(mg.small === 'ok' && mg.p24 !== 'refuse' && mg.huge === 'refuse' && mg.over === 'refuse', `memory guardrails: 2 MP ok, 24 MP×5 ${mg.p24}, 268 MP×10 16-bit refused (budget ${mg.limit} MB)`);
await page.evaluate(() => window.tintwork.run('new')); await page.waitForSelector('#nW');
await page.fill('#nW', '16384'); await page.fill('#nH', '16384'); await page.click('#modalOk');
const ng = await page.evaluate(() => ({ open: !document.querySelector('#modal').classList.contains('hidden'), toast: document.querySelector('#toast')?.textContent || '' }));
check(ng.open && /more than this browser can safely use|Large document/.test(ng.toast), `New canvas warns or refuses an oversize canvas ("${ng.toast.split('\n').pop().slice(0, 80)}")`);
await page.keyboard.press('Escape');

// --- accessibility -------------------------------------------------------------------------------------------
const a11y = await page.evaluate(() => {
  const ctrls = [...document.querySelectorAll('button, input, select')].filter((e) => e.offsetParent !== null);
  const unnamed = ctrls.filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || e.title || e.closest('label') || e.id && document.querySelector(`label[for="${e.id}"]`)));
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
  const lum = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (lum(muted) + 0.05) / (lum('#1d1f24') + 0.05);
  return { n: ctrls.length, unnamed: unnamed.map((e) => e.outerHTML.slice(0, 60)), ratio: +ratio.toFixed(2), focusRule: [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.selectorText === ':focus-visible'); } catch { return false; } }) };
});
check(a11y.unnamed.length === 0, `every visible control has an accessible name (${a11y.n} controls; ${a11y.unnamed.slice(0, 3).join(' ')})`);
check(a11y.ratio >= 4.5 && a11y.focusRule, `muted text contrast ${a11y.ratio}:1 (≥ 4.5) and a visible focus outline`);
await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
check(await page.evaluate(() => document.activeElement && document.activeElement !== document.body), 'Tab moves keyboard focus to a control');

// --- dirty-rect brush composite equals a full composite --------------------------------------------------
const dr = await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(3000, 2000, 'white', 'rect');
  const bg = t.activeLayer(), c = bg.canvas.getContext('2d'); const g = c.createLinearGradient(0, 0, 3000, 2000); g.addColorStop(0, '#335'); g.addColorStop(1, '#fc8'); c.fillStyle = g; c.fillRect(0, 0, 3000, 2000); t.touch(bg);
  t.addAdj('hueSaturation', { hue: 40, saturation: 20, lightness: 0 }, 'tint'); t.run('layerNew'); const top = t.activeLayer(); top.blend = 'multiply';
  t.markDirty(); t.renderNow();
  t.setFg('#3080ff'); t.state.brushSize = 80; t.paintStroke([{ x: 400, y: 400 }, { x: 1200, y: 900 }, { x: 2000, y: 500 }]);
  t.renderNow();
  const samples = [[400, 400], [800, 650], [1999, 500], [1200, 900], [2500, 1500], [1240, 935]];
  const fast = samples.map(([x, y]) => [...t.compositeCanvas().getContext('2d').getImageData(x, y, 1, 1).data]);
  t.markDirty(); t.renderNow();
  const full = samples.map(([x, y]) => [...t.compositeCanvas().getContext('2d').getImageData(x, y, 1, 1).data]);
  return { fast, full };
});
check(dr.fast.every((p, i) => near(p, dr.full[i], 0)), `brush dirty-rect composite equals a full composite (${JSON.stringify(dr.fast.slice(0, 2))})`);

// --- adjustment proxy while dragging, full result after -----------------------------------------------------
const px = await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(2400, 1600, 'white', 'proxy');
  const bg = t.activeLayer(), c = bg.canvas.getContext('2d'); for (let i = 0; i < 2400; i += 2) { c.fillStyle = i % 4 ? '#000' : '#fff'; c.fillRect(i, 0, 1, 1600); } t.touch(bg);
  const a = t.addAdj('brightnessContrast', { brightness: -20, contrast: 0 }, 'bc'); await t.idle(); t.renderNow();
  t.adjInteractive(250); a.adj.params = { ...a.adj.params, brightness: -40 }; t.touch(a); t.renderNow();
  const p = t.compositeCanvas().getContext('2d').getImageData(100, 100, 4, 1).data, during = [p[0], p[4], p[8], p[12]];
  await new Promise((r) => setTimeout(r, 600)); t.renderNow(); await t.idle(); t.renderNow();
  const q = t.compositeCanvas().getContext('2d').getImageData(100, 100, 4, 1).data, after = [q[0], q[4], q[8], q[12]];
  return { during, after };
});
check(px.after[0] === px.after[1] && px.after[0] > 150 && px.after[2] < 40 && px.after[0] < 250, `after the drag the adjustment is full resolution (${px.after}; during the drag ${px.during})`);

// --- 16-bit inner glow / inner shadow / colour overlay ------------------------------------------------------
for (const [type, extra] of [['innerGlow', { size: 16, opacity: 90 }], ['innerShadow', { size: 10, distance: 8, opacity: 90 }], ['colorOverlay', { color: '#2050a0', opacity: 60, blend: 'multiply' }]]) {
  const r = await page.evaluate(async ([type, extra]) => {
    const t = window.tintwork; t.newDocument(120, 120, 'white', 'Deep'); t.setDepth(16);
    t.run('layerNew'); const l = t.activeLayer(), c = l.canvas.getContext('2d'); const g = c.createLinearGradient(30, 0, 90, 0); g.addColorStop(0, '#4080c0'); g.addColorStop(1, '#c08040'); c.fillStyle = g; c.fillRect(30, 30, 60, 60); t.touch(l);
    l.styles = [Object.assign(t.defaultEffect(type), extra)]; t.touch(l);
    const deep = t.compositeDeepDoc(t.state.doc), W = t.state.doc.width; let fine = 0, max = 0;
    for (let y = 30; y < 90; y++) for (let x = 30; x < 90; x++) { const v = deep.data[(y * W + x) * 4]; if (v % 257) fine++; }
    for (const [x, y] of [[32, 60], [45, 45], [60, 60], [85, 80]]) { const i = (y * W + x) * 4, p = [...(await t.compositePixelAsync(x, y))].slice(0, 3); max = Math.max(max, ...p.map((v, k) => Math.abs(v - deep.data[i + k] / 257))); }
    return { fine, max };
  }, [type, extra]);
  check(r.fine > 400 && r.max <= 4, `16-bit ${type}: effect pixels keep 16-bit values (${r.fine} fine samples) and match the 8-bit look (max diff ${r.max.toFixed(2)})`);
}

// --- version / about ------------------------------------------------------------------------------------------
const ver = await page.evaluate(() => window.tintwork.APP_VERSION || document.title);
check(/^1\.\d+\.\d+$/.test(ver), `version 1.x (${ver})`);

// screenshot: a finished edit on a photo-like scene
await page.evaluate(async () => {
  const t = window.tintwork; t.newDocument(1600, 1000, 'white', 'Harbour at dusk'); const l = t.activeLayer(), c = l.canvas.getContext('2d');
  const sky = c.createLinearGradient(0, 0, 0, 600); sky.addColorStop(0, '#2b3a67'); sky.addColorStop(0.6, '#e48a5a'); sky.addColorStop(1, '#f6d29a'); c.fillStyle = sky; c.fillRect(0, 0, 1600, 1000);
  c.fillStyle = '#1d2b3a'; c.fillRect(0, 620, 1600, 380); c.fillStyle = '#f7c97a'; c.beginPath(); c.arc(1100, 560, 70, 0, Math.PI * 2); c.fill();
  for (let i = 0; i < 9; i++) { c.fillStyle = '#121a24'; c.fillRect(120 + i * 150, 480 - (i % 3) * 40, 90, 160 + (i % 3) * 40); }
  t.touch(l); t.commit('scene');
  t.addAdj('curves', undefined, 'Curves'); t.addAdj('hueSaturation', { hue: 0, saturation: 18, lightness: 0 }, 'Vibrance');
  t.run('layerNew'); const tx = t.activeLayer(); const x2 = tx.canvas.getContext('2d'); x2.fillStyle = '#fff'; x2.font = 'bold 72px Inter, sans-serif'; x2.fillText('HARBOUR', 120, 200); t.touch(tx);
  tx.styles = [Object.assign(t.defaultEffect('dropShadow'), { distance: 6, size: 12 }), Object.assign(t.defaultEffect('innerGlow'), { size: 8, color: '#ffd9a0' })]; t.touch(tx); t.commit('title');
  await t.idle(); t.run('zoomFit');
});
await page.evaluate(() => document.querySelector('#toast')?.classList.add('fade')); await page.waitForTimeout(600);
await page.screenshot({ path: 'screenshots/10x-workspace.png' });

check(!errors.length, `no page errors ${errors.join(' | ')}`);
await browser.close(); server.close();
console.log(fails ? `\n${fails} v1.0 check(s) FAILED` : '\nAll v1.0 checks passed.');
process.exit(fails ? 1 : 0);
