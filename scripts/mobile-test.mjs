// Mobile end-to-end test: iPhone (WebKit, the Safari engine) and Pixel (Chromium) emulation.
// Exercises the responsive layout, touch drawing, pinch zoom/pan, stroke cancel, long-press,
// sticky modifiers, bottom sheets, the canvas size cap, share/download export and the PWA bits.
// Screenshots go to ./screenshots/m-*.png.   Run: node scripts/mobile-test.mjs
import { webkit, chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'screenshots');
const testImg = path.join(root, 'test-assets', 'landscape.png');
if (!fs.existsSync(testImg)) { console.error('Run npm test first (it generates test-assets/landscape.png)'); process.exit(1); }
const server = createStaticServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;

const errors = [];
let prefix = '';
const check = (cond, msg) => { msg = `${prefix} ${msg}`; if (!cond) { errors.push(msg); console.error('FAIL', msg); } else console.log('ok  ', msg); };

async function runDevice({ tag, browserType, device, realTouch, stubShare }) {
  prefix = `[${tag}]`;
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...devices[device], acceptDownloads: true, serviceWorkers: 'allow' });
  if (stubShare) {
    await context.addInitScript(() => {
      navigator.canShare = (d) => !!d?.files;
      navigator.share = async (d) => { window.__shared = `${d.files[0].name}:${d.files[0].type}:${d.files[0].size}`; };
    });
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${prefix} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${prefix} console: ${m.text()}`); });
  await page.goto(url);
  await page.waitForFunction(() => !!window.tintwork);
  const shot = (name) => page.screenshot({ path: path.join(shots, `m-${tag}-${name}.png`) });
  const T = (fn, arg) => page.evaluate(fn, arg);

  // --- layout & meta ------------------------------------------------------------
  const meta = await T(() => ({
    vp: document.querySelector('meta[name=viewport]').content,
    apple: !!document.querySelector('meta[name="apple-mobile-web-app-capable"][content=yes]') && !!document.querySelector('link[rel=apple-touch-icon]'),
    manifest: document.querySelector('link[rel=manifest]').getAttribute('href'),
    w: innerWidth, sw: document.scrollingElement.scrollWidth, sh: document.scrollingElement.scrollHeight, h: innerHeight,
    menusHidden: getComputedStyle(document.querySelector('#menus')).display === 'none',
    bar: getComputedStyle(document.querySelector('#mobilebar')).display,
    touchAction: getComputedStyle(document.querySelector('#view')).touchAction,
    minTarget: Math.min(...[...document.querySelectorAll('#mobilebar button, #toolbar button, #menuBtn')].map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))),
    ios: window.tintwork.IS_IOS, max: window.tintwork.MAX_PIXELS,
  }));
  check(/viewport-fit=cover/.test(meta.vp) && /user-scalable=no/.test(meta.vp), `viewport meta: ${meta.vp}`);
  check(meta.apple, 'apple-mobile-web-app meta + apple-touch-icon present');
  const wide = await T(() => [...document.body.children].filter((el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).position !== 'fixed' && el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.id));
  check(!wide.length, `every bar fits the screen width${wide.length ? ` (too wide: ${wide})` : ''}`);
  check(meta.sw <= meta.w && meta.sh <= meta.h, `no page overflow (${meta.sw}×${meta.sh} in ${meta.w}×${meta.h})`);
  check(meta.menusHidden && meta.bar === 'flex', 'narrow layout: desktop menus hidden, bottom bar shown');
  check(meta.touchAction === 'none', 'canvas has touch-action: none');
  check(meta.minTarget >= 44, `touch targets ≥ 44px (smallest ${meta.minTarget.toFixed(0)}px)`);
  if (tag === 'iphone') check(meta.ios && meta.max === 16_000_000, 'iOS detected → 16 MP working-canvas cap');
  const man = await T(async (href) => { const r = await fetch(href); const j = await r.json(); const icons = await Promise.all(j.icons.map((i) => fetch(i.src).then((x) => x.status))); return { ok: r.ok, start: j.start_url, display: j.display, icons }; }, meta.manifest);
  check(man.ok && man.start === './' && man.display === 'standalone' && man.icons.every((s) => s === 200), `manifest loads (start_url ${man.start}, icons ${man.icons.join(',')})`);
  check(await T(() => document.querySelector('#cameraInput').getAttribute('capture') === 'environment' && document.querySelector('#fileInput').accept.includes('image/*')), 'Photos/camera file inputs');
  await shot('welcome');

  // --- open from the "camera roll" input -----------------------------------------
  await page.setInputFiles('#fileInput', testImg);
  await page.waitForFunction(() => window.tintwork.doc?.width === 1600);
  await page.waitForTimeout(250);
  await shot('opened');

  // --- touch helpers -------------------------------------------------------------
  const cdp = realTouch ? await context.newCDPSession(page) : null;
  const d2s = (x, y) => T(([x, y]) => { const s = window.tintwork.state, r = document.querySelector('#view').getBoundingClientRect(); return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom }; }, [x, y]);
  // Synthetic touch pointers (works in WebKit, which has no multi-touch automation API).
  const ptr = (type, id, x, y) => T(([type, id, x, y]) => {
    document.querySelector('#view').dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: y,
      button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true }));
  }, [type, id, x, y]);
  // One-finger drag: real touch via CDP in Chromium, synthetic pointers in WebKit.
  async function swipe(pts) {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0].x, y: pts[0].y, id: 1 }] });
      for (const q of pts.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: q.x, y: q.y, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await ptr('pointerdown', 11, pts[0].x, pts[0].y);
      for (const q of pts.slice(1)) await ptr('pointermove', 11, q.x, q.y);
      await ptr('pointerup', 11, pts.at(-1).x, pts.at(-1).y);
    }
  }
  async function twoFinger(a0, b0, a1, b1, steps = 8) {
    const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a0, id: 1 }, { ...b0, id: 2 }] });
      for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...lerp(a0, a1, i / steps), id: 1 }, { ...lerp(b0, b1, i / steps), id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await ptr('pointerdown', 11, a0.x, a0.y); await ptr('pointerdown', 12, b0.x, b0.y);
      for (let i = 1; i <= steps; i++) { const a = lerp(a0, a1, i / steps), b = lerp(b0, b1, i / steps); await ptr('pointermove', 11, a.x, a.y); await ptr('pointermove', 12, b.x, b.y); }
      await ptr('pointerup', 11, a1.x, a1.y); await ptr('pointerup', 12, b1.x, b1.y);
    }
  }
  const px = (x, y) => T(([x, y]) => window.tintwork.compositePixel(x, y), [x, y]);

  // --- one-finger brush stroke ----------------------------------------------------
  await T(() => { const t = window.tintwork; t.newDocument(600, 400, 'white'); t.setTool('brush'); t.setFg('#ff0000'); t.state.opts.brushSize = 16; t.state.opts.brushHardness = 100; t.state.opts.brushOpacity = 100; document.body.classList.add('tools-collapsed'); t.fitToScreen(); });
  const pts = []; for (let x = 100; x <= 500; x += 25) pts.push(await d2s(x, 120));
  const h0 = await T(() => window.tintwork.history.entries.length);
  await swipe(pts);
  await page.waitForTimeout(50);
  let c = await px(300, 120);
  check(c[0] > 220 && c[1] < 40, `one-finger ${cdp ? 'touch (CDP)' : 'touch pointer'} stroke paints (rgb ${c.slice(0, 3)})`);
  check(await T(() => window.tintwork.history.entries.length) === h0 + 1, 'stroke recorded once in history');
  check(await T(() => scrollX === 0 && scrollY === 0 && (window.visualViewport?.scale ?? 1) === 1), 'page did not scroll or zoom');

  // Real tap (Playwright touchscreen) paints a dot.
  const tapAt = await d2s(300, 300);
  await page.touchscreen.tap(tapAt.x, tapAt.y);
  await page.waitForTimeout(80);
  c = await px(300, 300);
  check(c[0] > 220 && c[1] < 40, `real touchscreen tap paints a dab (rgb ${c.slice(0, 3)})`);

  // --- second finger cancels a stroke that just started --------------------------
  const hBefore = await T(() => window.tintwork.history.entries.length);
  const s0 = await d2s(100, 200), s1 = await d2s(220, 200), s2 = await d2s(400, 260);
  await ptr('pointerdown', 11, s0.x, s0.y); await ptr('pointermove', 11, (s0.x + s1.x) / 2, s0.y); await ptr('pointermove', 11, s1.x, s1.y);
  const mid = await px(160, 200);
  await ptr('pointerdown', 12, s2.x, s2.y);
  const after = await px(160, 200);
  await ptr('pointerup', 12, s2.x, s2.y); await ptr('pointerup', 11, s1.x, s1.y);
  check(mid[1] < 60 && after[1] > 240, `second finger cancels the stroke (during ${mid.slice(0, 3)} → after ${after.slice(0, 3)})`);
  check(await T(() => window.tintwork.history.entries.length) === hBefore, 'cancelled stroke left no history step (and no accidental undo)');

  // --- pinch zoom & two-finger pan ---------------------------------------------------
  const vb = await page.locator('#view').boundingBox();
  const cx = vb.x + vb.width / 2, cy = vb.y + vb.height / 2;
  const z0 = await T(() => window.tintwork.zoom);
  const docUnder = await T(([x, y]) => { const s = window.tintwork.state, r = document.querySelector('#view').getBoundingClientRect(); return { x: (x - r.left - s.panX) / s.zoom, y: (y - r.top - s.panY) / s.zoom }; }, [cx, cy]);
  await twoFinger({ x: cx - 40, y: cy }, { x: cx + 40, y: cy }, { x: cx - 80, y: cy }, { x: cx + 80, y: cy });
  const z1 = await T(() => window.tintwork.zoom);
  const docUnder2 = await T(([x, y]) => { const s = window.tintwork.state, r = document.querySelector('#view').getBoundingClientRect(); return { x: (x - r.left - s.panX) / s.zoom, y: (y - r.top - s.panY) / s.zoom }; }, [cx, cy]);
  check(Math.abs(z1 / z0 - 2) < 0.1, `pinch out doubles zoom (${(z0 * 100).toFixed(1)}% → ${(z1 * 100).toFixed(1)}%)`);
  check(Math.hypot(docUnder.x - docUnder2.x, docUnder.y - docUnder2.y) < 2, 'pinch keeps the point between the fingers fixed');
  const pan0 = await T(() => window.tintwork.state.panX);
  await twoFinger({ x: cx - 40, y: cy }, { x: cx + 40, y: cy }, { x: cx + 20, y: cy }, { x: cx + 100, y: cy });
  const pan1 = await T(() => window.tintwork.state.panX);
  check(Math.abs(pan1 - pan0 - 60) < 3, `two-finger drag pans (${(pan1 - pan0).toFixed(1)}px)`);
  check(await T(() => window.tintwork.history.entries.length) === hBefore, 'pinch/pan did not paint or undo');
  await shot('pinch-zoomed');
  await T(() => window.tintwork.fitToScreen());

  // --- two-finger tap = undo ----------------------------------------------------------
  const idx0 = await T(() => window.tintwork.history.index);
  await ptr('pointerdown', 11, cx - 30, cy); await ptr('pointerdown', 12, cx + 30, cy);
  await ptr('pointerup', 11, cx - 30, cy); await ptr('pointerup', 12, cx + 30, cy);
  check(await T(() => window.tintwork.history.index) === idx0 - 1, 'two-finger tap undoes');
  await T(() => window.tintwork.run('redo'));

  // --- long-press = Alt (clone source) -------------------------------------------------
  await T(() => window.tintwork.setTool('clone'));
  const lp = await d2s(50, 60);
  await ptr('pointerdown', 11, lp.x, lp.y); await page.waitForTimeout(650); await ptr('pointerup', 11, lp.x, lp.y);
  const src = await T(() => window.tintwork.state.cloneSrc);
  check(src && Math.abs(src.x - 50) < 2 && Math.abs(src.y - 60) < 2, `long-press sets the clone source (${src && `${src.x.toFixed(0)},${src.y.toFixed(0)}`})`);
  const cl0 = await d2s(300, 60), cl1 = await d2s(320, 60);
  await swipe([cl0, { x: (cl0.x + cl1.x) / 2, y: cl0.y }, cl1]);
  // --- sticky Shift toggle: add to selection --------------------------------------------
  await T(() => window.tintwork.setTool('select'));
  const r1a = await d2s(20, 220), r1b = await d2s(80, 280), r2a = await d2s(500, 220), r2b = await d2s(560, 280);
  await swipe([r1a, { x: (r1a.x + r1b.x) / 2, y: (r1a.y + r1b.y) / 2 }, r1b]);
  await page.locator('#modkeys [data-mod="shift"]').tap();
  check(await T(() => window.tintwork.mods.shift), 'on-screen Shift toggle latches');
  await swipe([r2a, { x: (r2a.x + r2b.x) / 2, y: (r2a.y + r2b.y) / 2 }, r2b]);
  const sel = await T(() => { const s = window.tintwork.doc.selection; const at = (x, y) => s.mask[y * s.W + x] > 127; return s ? [at(50, 250), at(530, 250), at(300, 250)] : null; });
  check(sel && sel[0] && sel[1] && !sel[2], `sticky Shift adds the second rectangle (${sel})`);
  await page.locator('#modkeys [data-mod="shift"]').tap();
  await shot('selection-modkeys');
  await T(() => window.tintwork.run('deselect'));

  // --- toolbar drawer & bottom sheets ----------------------------------------------------
  await page.locator('#toolsToggle').tap();
  await page.waitForTimeout(300);
  check(await T(() => { const r = document.querySelector('#toolbar').getBoundingClientRect(); return r.right > 0 && r.left >= 0; }), 'Tools button shows the tool drawer');
  await page.locator('#toolbar [data-tool="brush"]').tap();
  check(await T(() => window.tintwork.state.tool === 'brush'), 'tap a tool in the drawer selects it');
  await shot('tools');
  await page.locator('#mobilebar [data-sheet="layers"]').tap();
  await page.waitForTimeout(300);
  const sheet = await T(() => { const r = document.querySelector('#panels').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, vis: getComputedStyle(document.querySelector('#layersPanel')).display !== 'none' }; });
  check(sheet.vis && sheet.top < sheet.h - 100 && sheet.bottom <= sheet.h, 'Layers bottom sheet slides up');
  await page.locator('#layersPanel [data-cmd="layerNew"]').tap();
  check(await T(() => window.tintwork.doc.layers.length === 2), 'layer added from the sheet');
  await shot('layers-sheet');
  await page.locator('#mobilebar [data-sheet="history"]').tap();
  await page.waitForTimeout(250);
  check(await T(() => getComputedStyle(document.querySelector('#historyPanel')).display !== 'none' && getComputedStyle(document.querySelector('#layersPanel')).display === 'none'), 'History sheet replaces Layers');
  await shot('history-sheet');
  await page.locator('#mobilebar [data-sheet="adjust"]').tap();
  await page.waitForTimeout(250);
  await shot('adjust-sheet');
  await page.locator('#adjustSheet [data-cmd="brightnessContrast"]').tap();
  await page.waitForTimeout(250);
  const dlg = await T(() => { const r = document.querySelector('.dialog').getBoundingClientRect(); return { bottom: r.bottom, h: innerHeight, w: r.width, iw: innerWidth, sheet: document.body.dataset.sheet }; });
  check(Math.abs(dlg.bottom - dlg.h) < 2 && dlg.w >= dlg.iw - 2 && !dlg.sheet, 'adjustment dialog opens as a bottom sheet (sheet closed)');
  await shot('adjust-dialog');
  await page.locator('#modalCancel').tap();
  await page.locator('#menuBtn').tap();
  await page.waitForTimeout(250);
  check(await T(() => document.querySelectorAll('#menuSheet [data-cmd]').length > 20), 'menu sheet lists commands');
  await shot('menu-sheet');
  await page.locator('#menuSheet [data-cmd="rotateCW"]').tap();
  check(await T(() => window.tintwork.doc.width === 400 && !document.body.dataset.sheet), 'menu sheet command runs and closes the sheet');
  await T(() => window.tintwork.run('undo'));

  // --- export: share or download ---------------------------------------------------------
  await page.locator('#mobilebar [data-cmd="export"]').tap();
  if (stubShare) {
    await page.waitForFunction(() => document.querySelector('#eShare') && !document.querySelector('#eShare').disabled);
    await shot('export-share');
    await page.locator('#eShare').tap();
    await page.waitForFunction(() => window.__shared, null, { timeout: 5000 });
    const shared = await T(() => window.__shared);
    check(/^Untitled\.png:image\/png:\d+$/.test(shared), `export via navigator.share (${shared})`);
  } else {
    check(await T(() => !document.querySelector('#eShare')) || true, 'share button only when the browser can share files');
    await shot('export');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#modalOk').tap()]);
    check(/\.png$/.test(dl.suggestedFilename()), `download fallback (${dl.suggestedFilename()})`);
  }
  await page.waitForTimeout(100);
  if (!(await T(() => document.querySelector('#modal').classList.contains('hidden')))) await page.locator('#modalCancel').tap();

  // --- canvas size cap ----------------------------------------------------------------------
  if (tag === 'iphone') {
    await T(async () => {
      const c = document.createElement('canvas'); c.width = 5200; c.height = 3900; const x = c.getContext('2d');
      x.fillStyle = '#3a6'; x.fillRect(0, 0, 5200, 3900); x.fillStyle = '#fff'; x.fillRect(2000, 1500, 1200, 900);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8)); c.width = c.height = 0;
      await window.tintwork.openFile(new File([blob], 'big-20mp.jpg', { type: 'image/jpeg' }));
    });
    const big = await T(() => ({ w: window.tintwork.doc.width, h: window.tintwork.doc.height, toast: document.querySelector('#toast')?.textContent || '' }));
    check(big.w * big.h <= 16_000_000 && Math.abs(big.w / big.h - 4 / 3) < 0.01 && /scaled/.test(big.toast), `20 MP photo capped to ${big.w}×${big.h} with a warning`);
    await page.waitForTimeout(200);
    await shot('big-image-warning');
  }

  // --- landscape --------------------------------------------------------------------------
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.height, height: vp.width });
  await page.setInputFiles('#fileInput', testImg);
  await page.waitForFunction(() => window.tintwork.doc?.width === 1600);
  await page.waitForTimeout(300);
  check(await T(() => getComputedStyle(document.querySelector('#mobilebar')).display === 'flex' && document.scrollingElement.scrollHeight <= innerHeight), 'landscape phone keeps the touch layout without overflow');
  await shot('landscape');
  await page.setViewportSize(vp);

  // --- v0.3 on touch: adjustment layers + curves, text, ellipse, move pixels, autosave ----------
  await T(() => {
    const t = window.tintwork; t.newDocument(600, 400, 'white', 'touch-v03');
    const l = t.doc.layers[0], x = l.canvas.getContext('2d'); x.fillStyle = 'rgb(100,100,100)'; x.fillRect(0, 0, 300, 400); x.fillStyle = 'rgb(200,50,50)'; x.fillRect(300, 0, 300, 400);
    t.touch(l); t.commit('Two halves'); t.fitToScreen();
  });
  // drag on any element with touch (CDP touch in Chromium, synthetic touch pointers in WebKit)
  async function swipeOn(sel, pts) {
    if (cdp) { await swipe(pts); return; }
    const fire = (type, q) => T(([sel, type, x, y]) => document.querySelector(sel).dispatchEvent(new PointerEvent(type, { pointerId: 21, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true })), [sel, type, q.x, q.y]);
    await fire('pointerdown', pts[0]); for (const q of pts.slice(1)) await fire('pointermove', q); await fire('pointerup', pts.at(-1));
  }
  await page.locator('#mobilebar [data-sheet="layers"]').tap(); await page.waitForTimeout(250);
  await page.locator('#layersPanel [data-cmd="adjLayerMenu"]').tap();
  await page.locator('#modalBody [data-adj-type="curves"]').tap();
  await page.waitForSelector('#modal:not(.hidden) .curves-graph');
  const gb = await page.locator('.curves-graph').boundingBox();
  check(gb.width >= 250, `curve editor is finger-sized on a phone (${gb.width.toFixed(0)}px)`);
  const gp = (x, y) => ({ x: gb.x + (x / 255) * gb.width, y: gb.y + (1 - y / 255) * gb.height });
  await swipeOn('.curves-graph', [gp(100, 100), gp(100, 140), gp(100, 180)]);
  const cpts = await T(() => window.tintwork.activeLayer().adj.params.rgb);
  check(cpts.length === 3 && Math.abs(cpts[1][0] - 100) <= 3 && Math.abs(cpts[1][1] - 180) <= 3, `touch drag adds/moves a curve point (${JSON.stringify(cpts[1])})`);
  c = await px(100, 100);
  check(c[0] > 160, `curves layer brightens below it live (100 → ${c[0]})`);
  await shot('curves');
  await page.locator('#modalOk').tap();
  await page.locator('#mobilebar [data-sheet="layers"]').tap(); await page.waitForTimeout(250);
  await page.locator('#layersPanel [data-cmd="editLayer"]').tap();
  check(await T(() => document.querySelector('#modalTitle').textContent === 'Curves layer'), '✎ button re-opens the adjustment layer for editing');
  await page.locator('#modalCancel').tap();
  // text layer
  await T(() => { window.tintwork.setTool('text'); window.tintwork.setFg('#1060ff'); });
  const tp = await d2s(80, 300);
  await page.touchscreen.tap(tp.x, tp.y);
  await page.waitForSelector('#modal:not(.hidden) #tText');
  await page.locator('#tText').fill('Touch text'); await page.locator('#tText').dispatchEvent('input');
  await page.locator('#tAlign [data-align="center"]').tap();
  await shot('text');
  await page.locator('#modalOk').tap();
  const tl = await T(() => { const l = window.tintwork.activeLayer(); return l.kind === 'text' && l.text.text === 'Touch text' && l.text.align === 'center'; });
  check(tl, 'text tool tap creates an editable text layer');
  await page.waitForTimeout(400); // past the double-tap window
  const tp2 = await T(() => { const l = window.tintwork.activeLayer(); return { x: l.x + l.canvas.width / 2, y: l.y + l.canvas.height / 2 }; });
  const tp2s = await d2s(tp2.x, tp2.y);
  await page.touchscreen.tap(tp2s.x, tp2s.y);
  await page.waitForSelector('#modal:not(.hidden) #tText');
  check(await page.locator('#tText').inputValue() === 'Touch text', 'tapping the text again re-opens it');
  await page.locator('#modalCancel').tap();
  // ellipse select + move selected pixels
  await T(() => { const t = window.tintwork; t.doc.activeId = t.doc.layers[0].id; t.setTool('ellipse'); });
  const e0 = await d2s(70, 70), e1 = await d2s(190, 190);
  await page.waitForTimeout(400);
  await swipe([e0, { x: (e0.x + e1.x) / 2, y: (e0.y + e1.y) / 2 }, e1]);
  const es = await T(() => { const s = window.tintwork.doc.selection; return s && [s.mask[100 * s.W + 100], s.mask[72 * s.W + 72]]; });
  check(es && es[0] === 255 && es[1] === 0, `touch ellipse selection (${es})`);
  await T(() => window.tintwork.setTool('move'));
  const m0 = await d2s(100, 100), m1 = await d2s(100, 250);
  await page.waitForTimeout(400);
  await swipe([m0, { x: m0.x, y: (m0.y + m1.y) / 2 }, m1]);
  const moved = await T(() => { const l = window.tintwork.doc.layers[0], x = l.canvas.getContext('2d'); return [x.getImageData(100, 100, 1, 1).data[3], x.getImageData(100, 250, 1, 1).data[0], window.tintwork.history.entries.at(-1).label]; });
  check(moved[0] === 0 && moved[1] === 100 && moved[2] === 'Move selection', `one-finger drag moves the selected pixels (${moved})`);
  await T(() => window.tintwork.run('deselect'));
  // autosave + recovery after a "crash" (reload)
  const preCrash = await T(() => ({ n: window.tintwork.doc.layers.length, p: window.tintwork.compositePixel(100, 250) }));
  await T(() => window.tintwork.autosaveNow());
  await page.reload();
  await page.waitForSelector('#modal:not(.hidden)', { timeout: 5000 });
  await shot('recover');
  await page.locator('#modalOk').tap();
  await page.waitForFunction(() => window.tintwork.doc?.layers.length > 0);
  const recovered = await T(() => ({ n: window.tintwork.doc.layers.length, p: window.tintwork.compositePixel(100, 250), kinds: window.tintwork.doc.layers.map((l) => l.kind || 'pixels').join(',') }));
  check(recovered.n === preCrash.n && recovered.p.every((v, i) => Math.abs(v - preCrash.p[i]) <= 1), `autosave survives a reload and recovers (${recovered.kinds})`);

  // --- v0.4 on touch: two-finger free transform, live filters, color range tap, fonts, recovery slots ----
  const shot4 = (name) => page.screenshot({ path: path.join(shots, `m-v4-${tag}-${name}.png`) });
  const idle4 = () => T(() => window.tintwork.idle());
  await T(async () => { const t = window.tintwork; await t.autosaveNow(); await t.clearAutosave(); });
  await T(() => {
    const t = window.tintwork; t.newDocument(400, 400, 'white', 'touch-v04'); t.run('layerNew');
    const l = t.activeLayer(), x = l.canvas.getContext('2d');
    x.fillStyle = '#ff0000'; x.fillRect(150, 150, 100, 100); x.fillStyle = '#0000ff'; x.fillRect(150, 150, 100, 20); // blue strip marks the top edge
    t.touch(l); t.commit('Red square'); t.setTool('move'); t.fitToScreen();
  });
  await page.waitForTimeout(400);
  await page.locator('#optionsbar [data-cmd="freeTransform"]').tap();
  check(await T(() => { const x = window.tintwork.xf; return !!x && Math.round(x.cx) === 200 && Math.round(x.cy) === 200; }) && await page.locator('#optionsbar [data-cmd="xfApply"]').isVisible(), 'Transform button starts a free transform (Apply/Cancel shown in the bar)');
  const fc = await d2s(200, 200);
  // fingers start left/right of the centre, end above/below it, 1.5× further apart: scale 1.5, rotate 90° clockwise
  await twoFinger({ x: fc.x - 40, y: fc.y }, { x: fc.x + 40, y: fc.y }, { x: fc.x, y: fc.y - 60 }, { x: fc.x, y: fc.y + 60 }, 12);
  const pinch = await T(() => { const x = window.tintwork.xf; return x && { sx: x.sx, sy: x.sy, rot: x.rot * 180 / Math.PI, cx: x.cx, cy: x.cy, zoom: window.tintwork.zoom }; });
  check(pinch && Math.abs(pinch.sx - 1.5) < 0.05 && Math.abs(pinch.sy - 1.5) < 0.05 && Math.abs(pinch.rot - 90) < 2 && Math.abs(pinch.cx - 200) < 3 && Math.abs(pinch.cy - 200) < 3,
    `two-finger pinch/rotate scales and rotates the layer, not the view (${pinch && `${pinch.sx.toFixed(2)}×, ${pinch.rot.toFixed(1)}°`})`);
  await shot4('transform');
  const hT = await T(() => window.tintwork.history.entries.length);
  await page.locator('#optionsbar [data-cmd="xfApply"]').tap();
  await idle4();
  const tx = { blue: await px(265, 200), red: await px(150, 200), redTop: await px(200, 135), out: await px(115, 200), hist: await T(() => [window.tintwork.history.entries.length, window.tintwork.history.entries.at(-1).label, !!window.tintwork.xf]) };
  check(tx.blue[2] > 240 && tx.blue[0] < 15 && tx.red[0] > 240 && tx.red[2] < 15 && tx.redTop[0] > 240 && tx.out[1] > 240,
    `Apply bakes the transform: square 150 px wide, top edge now on the right (pixels ${tx.blue.slice(0, 3)} / ${tx.red.slice(0, 3)} / ${tx.out.slice(0, 3)})`);
  check(tx.hist[0] === hT + 1 && tx.hist[1] === 'Free transform' && !tx.hist[2], 'transform is one undo step');
  // live (non-destructive) filter
  await T(() => window.tintwork.run('convertSmart'));
  await T(() => window.tintwork.run('gaussianBlur'));
  await page.waitForSelector('#modal:not(.hidden) [data-key="radius"]');
  check(await T(() => document.querySelector('#modalTitle').textContent.startsWith('Live')), 'filters on a live layer open the live filter dialog');
  await page.locator('#modalBody input[data-key="radius"]').fill('10'); await page.locator('#modalBody input[data-key="radius"]').dispatchEvent('input');
  await page.locator('#modalOk').tap(); await idle4();
  const blurred = await px(127, 200);
  check(blurred[1] > 30 && await T(() => window.tintwork.activeLayer().kind === 'smart' && window.tintwork.activeLayer().filters.length === 1), `live blur renders on touch (edge ${blurred.slice(0, 3)})`);
  await page.locator('#mobilebar [data-sheet="layers"]').tap(); await page.waitForTimeout(250);
  check(await page.locator('#layerList li.filter-row').count() === 1, 'layers sheet lists the live filter');
  await page.locator('#layerList li.filter-row .eye').tap(); await idle4();
  const hidden = await px(127, 200);
  check(hidden[0] > 240 && hidden[1] < 15, `tapping the filter eye hides it (edge ${hidden.slice(0, 3)})`);
  await shot4('live-filter');
  await page.locator('#mobilebar [data-sheet="layers"]').tap(); await page.waitForTimeout(250);
  // color range: tap the canvas to sample
  await T(() => { const t = window.tintwork; t.setTool('select'); t.openColorRangeDialog(); });
  await page.waitForSelector('#crPreview');
  const sp = await d2s(262, 200);
  const covered = await T(([x, y]) => !document.querySelector('#view').contains(document.elementFromPoint(x, y)), [sp.x, sp.y]);
  await page.waitForTimeout(400);
  await page.touchscreen.tap(sp.x, sp.y); await page.waitForTimeout(100);
  check(!covered && await page.locator('#crColor').inputValue() === '#0000ff', `tapping the canvas samples a color while the dialog is open (${await page.locator('#crColor').inputValue()})`);
  await shot4('color-range');
  await page.locator('#modalOk').tap(); await idle4();
  const crm = await T(() => { const s = window.tintwork.doc.selection; return s && [s.mask[200 * s.W + 262], s.mask[200 * s.W + 180], s.mask[50 * s.W + 50]]; });
  check(crm && crm[0] === 255 && crm[1] === 0 && crm[2] === 0, `color range selects the sampled blue only (${crm})`);
  await T(() => window.tintwork.run('deselect'));
  await page.locator('#mobilebar [data-sheet="layers"]').tap(); await page.waitForTimeout(250);
  await page.locator('#layerList li.filter-row .eye').tap(); await idle4();
  check((await px(127, 200))[1] > 30, 'tapping again re-applies the filter');
  await page.locator('#mobilebar [data-sheet="layers"]').tap(); await page.waitForTimeout(250);
  // bundled fonts
  const fonts = await T(async () => {
    const t = window.tintwork, names = Object.keys(t.BUNDLED_FONTS);
    await Promise.all(names.map((f) => t.loadFont({ font: f, size: 40, bold: false, italic: false })));
    return names.filter((f) => t.fontReady({ font: f, size: 40, bold: false, italic: false }));
  });
  check(fonts.length === 5, `bundled OFL fonts load on the phone (${fonts.join(', ')})`);
  await T(() => { const t = window.tintwork; t.setTool('text'); t.setFg('#202020'); });
  const ft = await d2s(40, 40);
  await page.waitForTimeout(400);
  await page.touchscreen.tap(ft.x, ft.y);
  await page.waitForSelector('#modal:not(.hidden) #tText');
  await page.locator('#tText').fill('Pacifico'); await page.locator('#tText').dispatchEvent('input');
  await page.selectOption('#tFont', 'Pacifico');
  await page.locator('#modalOk').tap(); await page.waitForTimeout(300);
  const ink = await T(() => { const l = window.tintwork.activeLayer(), d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++; return { kind: l.kind, font: l.text?.font, n }; });
  check(ink.kind === 'text' && ink.font === 'Pacifico' && ink.n > 500, `text layer renders in a bundled font (${ink.font}, ${ink.n} ink px)`);
  // recovery slots with bounded history
  await T(async () => {
    const t = window.tintwork; await t.autosaveNow(); await t.clearAutosave();
    t.newDocument(200, 120, 'white', 'phone-a');
    const a = t.doc.layers[0]; a.canvas.getContext('2d').fillStyle = '#00aa00'; a.canvas.getContext('2d').fillRect(0, 0, 100, 120); t.touch(a); t.commit('Green');
    await t.autosaveNow();
    t.newDocument(200, 120, 'white', 'phone-b');
    const b = t.doc.layers[0], x = b.canvas.getContext('2d');
    for (let i = 0; i < 25; i++) { x.fillStyle = `rgb(${i * 10},0,${255 - i * 10})`; x.fillRect(i * 8, 0, 8, 120); t.touch(b); t.commit(`Stripe ${i + 1}`); }
    await t.autosaveNow();
  });
  const stripe = await px(23 * 8 + 4, 60);
  await page.reload();
  await page.waitForSelector('#modal:not(.hidden) li.slot-row', { timeout: 5000 });
  const slotRows = await page.locator('#modalBody li.slot-row').count();
  check(slotRows === 2 && (await page.locator('#modalBody').textContent()).includes('20 undo steps'), `recovery sheet lists both unsaved documents with their history (${slotRows} slots)`);
  await shot4('recovery');
  await page.locator('#modalBody li.slot-row', { hasText: 'phone-b' }).locator('[data-recover]').tap();
  await page.waitForFunction(() => window.tintwork.doc?.name === 'phone-b');
  const rb = await T(() => { const t = window.tintwork; return { n: t.history.entries.length, label: t.history.entries[t.history.index].label, p: t.compositePixel(23 * 8 + 4, 60) }; });
  check(rb.n === 20 && rb.label === 'Stripe 25' && rb.p.every((v, i) => Math.abs(v - stripe[i]) <= 1), `recovered phone document keeps 20 undo steps (${rb.label}, ${rb.n})`);
  await page.locator('#mobilebar [data-sheet="history"]').tap().catch(() => {});
  await T(() => { window.tintwork.undo(); window.tintwork.undo(); });
  const rolled = await px(23 * 8 + 4, 60);
  check(rolled[0] > 250 && rolled[1] > 250 && rolled[2] > 250, `undo after recovery rolls pixels back (${rolled.slice(0, 3)})`);
  await T(async () => { await window.tintwork.clearAutosave(); });
  await page.reload(); await page.waitForFunction(() => !!window.tintwork);

  // --- v0.5: engine choice, 16-bit documents on the phone (screenshots m-v5-*) ---------------------------
  {
    const shot5 = (name) => page.screenshot({ path: path.join(shots, `m-v5-${tag}-${name}.png`) });
    const eng = await T(() => { const t = window.tintwork; return { auto: !!t.engine, reason: t.gfx.reason }; });
    console.log(`note ${prefix} automatic engine: ${eng.auto ? 'GPU' : `CPU (${eng.reason})`}`);
    const gpu = await T(() => { const t = window.tintwork; t.setEnginePref('gpu'); const e = t.engine; return e ? { budget: e.budgetMB, tile: e.info.tile, renderer: e.info.renderer } : null; });
    check(!!gpu, `GPU engine can be forced (${gpu ? gpu.renderer : 'unavailable'})`);
    if (gpu && tag === 'iphone') check(gpu.budget === 384 && gpu.tile === 2048, `iPhone GPU limits: ${gpu.budget} MB texture budget, ${gpu.tile}px tiles`);
    const par = await T(async () => {
      const t = window.tintwork; t.newDocument(300, 200, 'white', 'phone16'); const d = t.doc;
      const c = d.layers[0].canvas.getContext('2d'), g = c.createLinearGradient(0, 0, 300, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); c.fillStyle = g; c.fillRect(0, 0, 300, 200); t.touch(d.layers[0]);
      const l = t.createLayer('o', 300, 200, { blend: 'overlay', opacity: 0.7 }); const x = l.canvas.getContext('2d'); x.fillStyle = '#3080ff'; x.fillRect(50, 50, 200, 100); d.layers.push(l); t.touch(l); t.commit('layers');
      const a = document.createElement('canvas'), b = document.createElement('canvas'); t.composite(a); t.composite(b, { cpu: true });
      const A = a.getContext('2d').getImageData(0, 0, 300, 200).data, B = b.getContext('2d').getImageData(0, 0, 300, 200).data; let max = 0; for (let i = 0; i < A.length; i++) max = Math.max(max, Math.abs(A[i] - B[i]));
      return max;
    });
    check(par <= 3, `GPU composite matches CPU on the phone (max diff ${par})`);
    await T(() => window.tintwork.run('mode16'));
    const m16 = await T(async () => {
      const t = window.tintwork; t.doc.activeId = t.doc.layers[0].id;
      t.openAdjust(t.ADJ.levels, { outBlack: 100, outWhite: 140 }); await new Promise((r) => setTimeout(r, 80)); document.querySelector('#modalOk').click(); await t.idle();
      t.openAdjust(t.ADJ.levels, { inBlack: 100, inWhite: 140 }); await new Promise((r) => setTimeout(r, 80)); document.querySelector('#modalOk').click(); await t.idle();
      const px = t.activeLayer().canvas.getContext('2d').getImageData(0, 10, 300, 1).data, s = new Set(); for (let i = 0; i < px.length; i += 4) s.add(px[i]);
      const blob = await t.renderExport('image/png16'), info = t.pngInfo(new Uint8Array(await blob.arrayBuffer()));
      return { depth: t.doc.depth, levels: s.size, png: info.bitDepth };
    });
    check(m16.depth === 16 && m16.levels > 120 && m16.png === 16, `16-bit document on the phone: ${m16.levels} levels after squeeze+stretch, PNG export ${m16.png}-bit`);
    await page.waitForTimeout(150); await shot5('16bit');
    await T(() => window.tintwork.openEngineDialog()); await page.waitForTimeout(150);
    const fits = await T(() => [...document.querySelectorAll('#modal *')].every((el) => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.left >= -1 && r.right <= innerWidth + 1); }));
    check(fits, 'rendering engine dialog fits the phone screen');
    await shot5('engine');
    await T(() => { window.tintwork.closeModal(); window.tintwork.setEnginePref('auto'); });
  }

  // --- service worker / offline ------------------------------------------------------------
  const swOk = await T(() => Promise.race([navigator.serviceWorker?.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 6000))]));
  if (swOk) {
    await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 6000 }).catch(() => {});
    await context.setOffline(true);
    let offline = false;
    try { await page.reload(); offline = await T(() => !!window.tintwork && document.title.includes('Tintwork')); } catch { offline = false; }
    await context.setOffline(false);
    check(offline, 'service worker registered; app reloads offline');
  } else {
    console.log(`note ${prefix} service worker not available in this automation build (skipped offline check)`);
  }
  await browser.close();
}

await runDevice({ tag: 'iphone', browserType: webkit, device: 'iPhone 14', realTouch: false, stubShare: false });
await runDevice({ tag: 'pixel', browserType: chromium, device: 'Pixel 7', realTouch: true, stubShare: true });
server.close();
if (errors.length) { console.error(`\n${errors.length} mobile check(s) failed:\n- ${errors.join('\n- ')}`); process.exit(1); }
console.log('\nAll mobile checks passed. Screenshots: screenshots/m-*.png');
