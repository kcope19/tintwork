// v1.15 test: adversarial polish — Done+feather one undo; Export defaults to PNG 16-bit on 16-bit docs;
// soft-proof off; crop chip + undo; dialog Escape/Tab; SW version match.
// TW_ROOT=/path/to/other/checkout · TW_URL=https://… against a deployed site.
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
await page.goto(`${BASE}?platform=win`);
await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));

check(['1.15.0','1.16.0','1.17.0','1.18.0','1.19.0','1.20.0','1.21.0','1.22.0'].includes(await T(() => window.tintwork.APP_VERSION)), `APP_VERSION is 1.15+ (${await T(() => window.tintwork.APP_VERSION)})`);

// SW CACHE matches
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check(m?.[1] === '1.15.0' || m?.[1] === '1.16.0' || m?.[1] === '1.17.0' || m?.[1] === '1.18.0' || m?.[1] === '1.19.0' || m?.[1] === '1.21.0' || m?.[1] === '1.22.0' || m?.[1] === '1.20.0', `SW CACHE is 1.15+ (${m?.[1]})`);
}

// Soft-proof off restores view
{
  await T(() => { window.tintwork.newDocument(200, 100, 'white', 'proof'); window.tintwork.run('proofCmy'); });
  check(await T(() => document.getElementById('view').classList.contains('tw-cmy-proof')), 'CMY proof class on');
  await T(() => window.tintwork.run('proofOff'));
  const off = await T(() => ({ filter: document.getElementById('view').style.filter, cls: document.getElementById('view').classList.contains('tw-cmy-proof'), mode: window.tintwork.proofMode }));
  check(!off.filter && !off.cls && off.mode == null, `proofOff clears view (filter=${off.filter}, cls=${off.cls})`);
}

// Dialog Escape + Tab trap
{
  await T(() => window.tintwork.run('imageSize'));
  await page.waitForSelector('#modalOk');
  let escaped = 0;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    if (!(await T(() => document.getElementById('modal').contains(document.activeElement)))) escaped++;
  }
  check(escaped === 0, `Tab stays in Image size (${escaped} escapes)`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  check(await T(() => document.getElementById('modal').classList.contains('hidden')), 'Escape closes Image size');
}

// Crop chip + undo
{
  await T(() => { window.tintwork.newDocument(800, 600, 'white', 'crop'); window.tintwork.setTool('crop'); });
  await page.locator('#optionsbar [data-cropchip="portrait45"]').click();
  await page.waitForTimeout(40);
  check(await T(() => window.tintwork.state.opts.cropPreset) === 'portrait45', '4:5 chip sets preset');
  await page.keyboard.press('Enter');
  await T(async () => { await window.tintwork.idle?.(); });
  await page.waitForTimeout(80);
  const sized = await T(() => ({ w: window.tintwork.doc.width, h: window.tintwork.doc.height }));
  check(sized.w === 1080 && sized.h === 1350, `crop applied ${sized.w}×${sized.h}`);
  await T(() => window.tintwork.undo());
  const u = await T(() => ({ w: window.tintwork.doc.width, h: window.tintwork.doc.height }));
  check(u.w === 800 && u.h === 600, `undo crop restores 800×600 (${u.w}×${u.h})`);
}

// Done + feather: one history entry; one Undo clears selection
{
  await page.setInputFiles('#fileInput', { name: 'portrait-usda.jpg', mimeType: 'image/jpeg', buffer: REAL('portrait-usda.jpg') });
  await page.waitForFunction(() => window.tintwork.doc?.width > 100, null, { timeout: 30000 });
  await T(() => { window.tintwork.state.opts.objPaint = 'box'; window.tintwork.setTool('objsel'); window.tintwork.run('zoomFit'); window.tintwork.state.opts.featherRadius = 10; });
  const box = await T(() => {
    const s = window.tintwork.state, r = document.querySelector('#view').getBoundingClientRect(), d = window.tintwork.doc;
    const to = (x, y) => ({ x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom });
    return { a: to(d.width * 0.28, d.height * 0.12), b: to(d.width * 0.72, d.height * 0.92) };
  });
  await page.mouse.move(box.a.x, box.a.y); await page.mouse.down();
  await page.mouse.move(box.b.x, box.b.y, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(700);
  await page.locator('#optionsbar [data-cmd="objSelDoneFeather"]').click();
  await page.waitForTimeout(500);
  const hist = await T(() => ({
    labels: window.tintwork.history.entries.map((e) => e.label),
    sel: !!window.tintwork.doc.selection,
  }));
  const objLabels = hist.labels.filter((l) => /^Object select/.test(l));
  check(objLabels.length === 1 && /feather/i.test(objLabels[0]), `Done+feather one history entry (${objLabels.join(' | ')})`);
  await T(() => window.tintwork.undo());
  const u1 = await T(() => ({ label: window.tintwork.history.entries[window.tintwork.history.index]?.label, sel: !!window.tintwork.doc.selection }));
  check(!u1.sel, `one Undo after Done+feather clears selection (label=${u1.label})`);
}

// Auto upright undo
{
  await page.setInputFiles('#fileInput', { name: 'c4.jpg', mimeType: 'image/jpeg', buffer: REAL('c4.jpg') });
  await page.waitForFunction(() => window.tintwork.doc?.name?.startsWith('c4'), null, { timeout: 30000 });
  const before = await T(() => ({ w: window.tintwork.doc.width, h: window.tintwork.doc.height }));
  await T(async () => { window.tintwork.state.opts.uprightEdges = 'crop'; await window.tintwork.idle?.(); window.tintwork.run('autoUpright'); await window.tintwork.idle?.(); await window.tintwork.compositeSettled?.(); });
  check(await T(() => !!window.tintwork.lastUpright?.H), 'Auto upright applied');
  await T(async () => { window.tintwork.undo(); await window.tintwork.idle?.(); await window.tintwork.compositeSettled?.(); });
  const after = await T(() => ({ w: window.tintwork.doc.width, h: window.tintwork.doc.height }));
  check(after.w === before.w && after.h === before.h, `undo upright restores size (${after.w}×${after.h})`);
}

// Export defaults to PNG 16-bit on 16-bit docs (no last preset)
{
  const dng = path.join(HERE, 'test-assets/raw-samples/adobe-canon-eos-5d-mark-iii.dng');
  check(existsSync(dng), 'RAW sample present');
  if (existsSync(dng)) {
    await page.setInputFiles('#fileInput', dng);
    await page.waitForFunction(() => window.tintwork.rawUI, null, { timeout: 90000 });
    await page.waitForFunction(() => window.tintwork.rawUI?.idle && window.tintwork.rawUI.previews >= 1, null, { timeout: 90000 });
    await page.click('#modalOk');
    await page.waitForFunction(() => !window.tintwork.rawUI && window.tintwork.activeLayer()?.raw, null, { timeout: 90000 });
    await T(() => { try { localStorage.removeItem('tintwork.lastExportPreset'); } catch { /* */ } window.tintwork.run('export'); });
    await page.waitForSelector('#eFmt');
    const fmt = await T(() => document.querySelector('#eFmt')?.value);
    check(fmt === 'image/png16', `16-bit doc Export defaults to PNG 16-bit (${fmt})`);
    // bit-depth of a png16 render
    const bit = await T(async () => {
      const b = await window.tintwork.renderExportBlob('image/png16', 1);
      const a = new Uint8Array(await b.arrayBuffer());
      return a[24];
    });
    check(bit === 16, `png16 export IHDR bit depth ${bit}`);
    await page.keyboard.press('Escape');
  }
}

// Ctrl+Z in modal does not undo document
{
  await T(() => { window.tintwork.newDocument(64, 64, 'white', 'z'); window.tintwork.run('imageSize'); });
  await page.waitForSelector('#modalOk');
  const hi = await T(() => window.tintwork.history.index);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(50);
  const hi2 = await T(() => ({ i: window.tintwork.history.index, modal: !document.getElementById('modal').classList.contains('hidden') }));
  check(hi2.i === hi && hi2.modal, 'Ctrl+Z in modal does not undo underneath');
  await page.keyboard.press('Escape');
}

check(errors.filter((e) => !/ResizeObserver|favicon/i.test(e)).length === 0, `no page errors (${errors.slice(0, 3).join(' | ') || 'none'})`);
console.log(`\n${count - fails}/${count} checks passed`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
