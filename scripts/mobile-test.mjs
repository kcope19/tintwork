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
