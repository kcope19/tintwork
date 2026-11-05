// v1.14 test: soft-proof papers + CMY + remember last; object-select Done + feather / sticky +Subject;
// crop option-bar chips; RAW before/after top/bottom split (Y cycles).
// TW_ROOT=/path/to/other/checkout runs against another tree. TW_URL=https://… against a deployed site.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const load = async () => { await page.goto(`${BASE}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete'); await page.evaluate(() => window.tintwork.engineReady); };
await load();
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));

// --- 1. Version
{
  const v = await T(() => window.tintwork.APP_VERSION);
  check(v === '1.14.0' || v === '1.15.0', `APP_VERSION is 1.14+ (${v})`); // v1.15 tree; TW_ROOT of v1.14 still passes
}

// --- 2. Soft-proof papers: rag, newsprint, approximate CMY + menus
{
  const papers = await T(() => {
    const P = window.tintwork.PROOF_PAPERS;
    return { keys: Object.keys(P || {}), cmy: !!P?.cmy?.cmyView, rag: !!P?.rag, news: !!P?.newsprint };
  });
  check(papers.rag && papers.news && papers.cmy && papers.keys.includes('glossy') && papers.keys.includes('matte'),
    `PROOF_PAPERS has glossy/matte/rag/newsprint/cmy (cmyView=${papers.cmy}; keys=${(papers.keys || []).join(',')})`);
  for (const [cmd, lab] of [['proofRag', 'photo rag'], ['proofNews', 'newsprint'], ['proofCmy', 'approximate CMY'], ['proofLast', 'last used']]) {
    const n = await page.locator(`#menus .menu-items button[data-cmd="${cmd}"]`).count();
    check(n === 1, `View menu has Proof: ${lab} (${cmd})`);
  }
}

// --- 3. Remember last proof + proofLast restores; CMY is greyscale (honest)
{
  await T(() => {
    try { localStorage.removeItem('tintwork.proofLast'); } catch { /* */ }
    window.tintwork.run('proofRag');
    window.tintwork.run('proofWarnOn');
  });
  const saved = await T(() => { try { return JSON.parse(localStorage.getItem('tintwork.proofLast') || 'null'); } catch { return null; } });
  check(saved?.mode === 'rag' && saved?.warn === true, `proof prefs saved (mode=${saved?.mode}, warn=${saved?.warn})`);
  await T(() => { window.tintwork.run('proofOff'); });
  check(await T(() => window.tintwork.proofMode) == null, 'proofOff clears mode');
  await T(() => { window.tintwork.run('proofLast'); });
  const restored = await T(() => ({ mode: window.tintwork.proofMode, warn: window.tintwork.proofWarn }));
  check(restored.mode === 'rag' && restored.warn === true, `proofLast restores rag + ink warning (mode=${restored.mode}, warn=${restored.warn})`);
  await T(() => { window.tintwork.run('proofCmy'); });
  const cmy = await T(() => {
    const v = document.getElementById('view');
    return { mode: window.tintwork.proofMode, filter: v?.style.filter || '', cls: v?.classList.contains('tw-cmy-proof') };
  });
  check(cmy.mode === 'cmy' && cmy.cls && /grayscale/.test(cmy.filter), `CMY proof uses greyscale view (filter=${cmy.filter}, class=${cmy.cls})`);
  await T(() => { window.tintwork.run('proofOff'); });
}

// --- 4. Crop chips in the options bar
{
  await T(() => { window.tintwork.newDocument(800, 600, 'white', 'crop-chips'); window.tintwork.run('zoomFit'); });
  await T(() => { window.tintwork.setTool('crop'); });
  await page.waitForTimeout(50);
  const chips = await T(() => [...document.querySelectorAll('#optionsbar [data-cropchip]')].map((b) => b.dataset.cropchip));
  check(chips.includes('sq') && chips.includes('portrait45') && chips.includes('land169') && chips.includes('p8x10') && chips.includes('orig'),
    `crop chips present (${chips.join(',')})`);
  await page.locator('#optionsbar [data-cropchip="portrait45"]').click();
  await page.waitForTimeout(50);
  const preset = await T(() => window.tintwork.state.opts.cropPreset);
  check(preset === 'portrait45', `4:5 chip sets cropPreset (${preset})`);
}

// --- 5. Object select: sticky +Subject after box; Done + feather softens edge
{
  await page.setInputFiles('#fileInput', {
    name: 'portrait-usda.jpg', mimeType: 'image/jpeg', buffer: REAL('portrait-usda.jpg'),
  });
  await page.waitForFunction(() => window.tintwork.doc?.name?.includes('portrait'), null, { timeout: 30000 });
  await T(() => { window.tintwork.state.opts.objPaint = 'box'; window.tintwork.setTool('objsel'); window.tintwork.run('zoomFit'); });
  const boxPts = await T(() => {
    const s = window.tintwork.state, r = document.querySelector('#view').getBoundingClientRect(), d = window.tintwork.doc;
    const to = (x, y) => ({ x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom });
    // Subject-ish box on the USDA portrait (centre torso/head region)
    return { a: to(d.width * 0.28, d.height * 0.12), b: to(d.width * 0.72, d.height * 0.92) };
  });
  await page.mouse.move(boxPts.a.x, boxPts.a.y); await page.mouse.down();
  await page.mouse.move(boxPts.b.x, boxPts.b.y, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => window.tintwork.state.objSel || window.tintwork.doc.selection, null, { timeout: 20000 }).catch(() => {});
  await T(async () => { await window.tintwork.idle?.(); await new Promise((r) => setTimeout(r, 300)); });
  const afterBox = await T(() => ({
    paint: window.tintwork.state.opts.objPaint,
    btn: !!document.querySelector('#optionsbar [data-cmd="objSelDoneFeather"]'),
    done: !!document.querySelector('#optionsbar [data-cmd="objSelDone"]'),
    sel: !!window.tintwork.doc.selection,
  }));
  check(afterBox.paint === 'fg', `after box, objPaint sticky +Subject (paint=${afterBox.paint})`);
  check(afterBox.btn && afterBox.done, `Done and Done + feather buttons in options bar (done=${afterBox.done}, feather=${afterBox.btn})`);

  check(typeof (await T(() => window.tintwork.cmds.objSelDoneFeather)) === 'function'
    || await T(() => 'objSelDoneFeather' in window.tintwork.cmds), 'objSelDoneFeather is in cmds');

  const feathered = await T(async () => {
    const t = window.tintwork;
    if (!t.doc.selection) return { ok: false, why: 'no selection after box' };
    t.state.opts.featherRadius = 12;
    if (!t.state.objSel) {
      const d = t.doc;
      t.state.objSel = { doc: d, rect: { x: 10, y: 10, w: 100, h: 100 }, strokes: [], base: null, prev: null, mode: 'new' };
    }
    const before = new Uint8ClampedArray(t.doc.selection.mask);
    const idx0 = t.history.index;
    t.run('objSelDoneFeather');
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const lab = t.history?.entries?.[t.history.index]?.label || '';
      if (/feather/i.test(lab) && t.history.index > idx0) break;
    }
    const sel = t.doc.selection;
    if (!sel) return { ok: false, why: 'selection cleared' };
    let mid = 0, changed = 0;
    for (let i = 0; i < sel.mask.length; i++) {
      if (sel.mask[i] > 10 && sel.mask[i] < 245) mid++;
      if (before[i] !== sel.mask[i]) changed++;
    }
    return { ok: /feather/i.test(t.history?.entries?.[t.history.index]?.label || '') && (mid > 80 || changed > 80), mid, changed, label: t.history?.entries?.[t.history.index]?.label };
  });
  check(feathered.ok, `Done + feather softens the mask (mid=${feathered.mid}, changed=${feathered.changed}, label=${feathered.label}, why=${feathered.why || ''})`);
}

// --- 6. RAW top/bottom split
{
  const dng = path.join(HERE, 'test-assets/raw-samples/adobe-canon-eos-5d-mark-iii.dng');
  check(existsSync(dng), 'RAW sample present for splitH');
  if (existsSync(dng)) {
    await page.setInputFiles('#fileInput', dng);
    await page.waitForFunction(() => window.tintwork.rawUI, null, { timeout: 90000 }).catch(() => {});
    const has = await T(() => !!window.tintwork.rawUI);
    check(has, `RAW develop UI opened (${has})`);
    if (has) {
      await page.waitForFunction(() => window.tintwork.rawUI?.idle && window.tintwork.rawUI.previews >= 1, null, { timeout: 90000 }).catch(() => {});
      const cycled = await T(async () => {
        const u = window.tintwork.rawUI;
        await u.setView('split');
        const a = u.view;
        await u.setView('splitH');
        const b = u.view;
        const horiz = document.querySelector('#rawSplit')?.classList.contains('horiz');
        return { a, b, horiz, label: document.querySelector('#rawSplitBtn')?.textContent };
      });
      check(cycled.a === 'split' && cycled.b === 'splitH' && cycled.horiz,
        `RAW setView split → splitH (a=${cycled.a}, b=${cycled.b}, horiz=${cycled.horiz}, label=${cycled.label})`);
      await T(async () => { await window.tintwork.rawUI.setView('after'); });
      // Focus the develop body so Y is not stolen
      await page.locator('#rawSplitBtn').click({ force: true }).catch(() => {});
      await T(async () => { await window.tintwork.rawUI.setView('after'); });
      await page.keyboard.press('y');
      await page.waitForTimeout(150);
      const y1 = await T(() => window.tintwork.rawUI?.view);
      await page.keyboard.press('y');
      await page.waitForTimeout(150);
      const y2 = await T(() => window.tintwork.rawUI?.view);
      check(y1 === 'split' && y2 === 'splitH', `Y key cycles after→split→splitH (y1=${y1}, y2=${y2})`);
      await page.locator('#modalCancel').click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
  }
}

check(errors.filter((e) => !/ResizeObserver|favicon/i.test(e)).length === 0, `no page errors (${errors.slice(0, 3).join(' | ') || 'none'})`);

console.log(`\n${count - fails}/${count} checks passed`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
