// v1.16 test: export output sharpening (screen/matte/glossy); Guided upright 2–4 guides (preview + Enter/4th).
// TW_ROOT=/path/to/other/checkout · TW_URL=https://… against a deployed site.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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

check(['1.16.0','1.17.0','1.18.0','1.19.0','1.20.0','1.21.0','1.22.0','1.23.0'].includes(await T(() => window.tintwork.APP_VERSION)), `APP_VERSION is 1.16+ (${await T(() => window.tintwork.APP_VERSION)})`);

{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check(m?.[1] === '1.16.0' || m?.[1] === '1.17.0' || m?.[1] === '1.18.0' || m?.[1] === '1.19.0' || m?.[1] === '1.21.0' || m?.[1] === '1.22.0' || m?.[1] === '1.23.0' || m?.[1] === '1.20.0', `SW CACHE is 1.16.0 (${m?.[1]})`);
  check(swText.includes('export-sharpen.js'), 'SW SHELL lists export-sharpen.js');
}

// Export sharpen: dialog options + pixel change vs off
{
  await T(() => {
    const t = window.tintwork;
    t.newDocument(800, 600, 'white', 'sharp');
    const l = t.activeLayer(), x = l.canvas.getContext('2d');
    x.fillStyle = '#808080'; x.fillRect(0, 0, 800, 600);
    x.fillStyle = '#ffffff'; x.fillRect(200, 150, 400, 300);
    t.touch(l); t.markDirty();
  });
  const sharp = await T(async () => {
    const t = window.tintwork;
    const plain = await t.renderExportWith('image/jpeg', 0.95, { sharpen: 'off' });
    const sh = await t.renderExportWith('image/jpeg', 0.95, { sharpen: 'screen-high' });
    const dec = async (b) => {
      const bm = await createImageBitmap(b);
      const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
      c.getContext('2d').drawImage(bm, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height);
    };
    const a = await dec(plain), b = await dec(sh);
    let diff = 0; for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - b.data[i]);
    t.run('export');
    await new Promise((r) => setTimeout(r, 40));
    const opts = [...document.querySelectorAll('#eSharp option')].map((o) => o.value);
    document.getElementById('modalCancel')?.click();
    const web = t.exportPresets.builtin.find((p) => p.id === 'web');
    const print = t.exportPresets.builtin.find((p) => p.id === 'print');
    return { diff, n: opts.length, hasScreen: opts.includes('screen-std'), hasMatte: opts.includes('matte-std'), hasGlossy: opts.includes('glossy-high'), web: web?.sharpen, print: print?.sharpen };
  });
  check(sharp.diff > 1000, `screen-high changes JPEG pixels (diff=${sharp.diff})`);
  check(sharp.n === 10 && sharp.hasScreen && sharp.hasMatte && sharp.hasGlossy, `eSharp has 10 options incl. media (${sharp.n})`);
  check(sharp.web === 'screen-std' && sharp.print === 'matte-std', `builtin presets sharpen web=${sharp.web} print=${sharp.print}`);
}

// PNG16 skips sharpen with note
{
  await T(() => {
    const t = window.tintwork;
    t.newDocument(64, 64, 'white', 'p16');
    // force 16-bit if API exists
    if (typeof t.convertTo16 === 'function') t.convertTo16();
    else if (t.doc) { t.doc.depth = 16; }
  });
  const note = await T(async () => {
    const t = window.tintwork;
    if (!t.is16?.() && t.doc?.depth !== 16) {
      // synthesize via renderExport path on png16 type
      await t.renderExportWith('image/png16', 1, { sharpen: 'matte-high' });
      return { notes: t.lastExportNotes || [], depthOk: true };
    }
    await t.renderExportWith('image/png16', 1, { sharpen: 'matte-high' });
    return { notes: t.lastExportNotes || [], depthOk: true };
  });
  check((note.notes || []).some((n) => /sharpen|16-bit/i.test(n)), `PNG16 skip note (${JSON.stringify(note.notes)})`);
}

// Guided: 2 guides preview, Enter finishes
{
  await page.setInputFiles('#fileInput', { name: 'c4-g2.jpg', mimeType: 'image/jpeg', buffer: REAL('c4.jpg') });
  await page.waitForFunction(() => window.tintwork.doc?.name?.startsWith('c4-g2'), null, { timeout: 30000 });
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('guidedUpright'); });
  await page.waitForFunction(() => window.tintwork.mxf?.guideMode);
  const toScreen = async (p) => page.evaluate(({ x, y }) => {
    const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state;
    return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom };
  }, p);
  for (const pts of [[[124, 446], [15, 900]], [[935, 492], [968, 900]]]) {
    const a = await toScreen({ x: pts[0][0], y: pts[0][1] }), b = await toScreen({ x: pts[1][0], y: pts[1][1] });
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(80);
  }
  const mid = await T(() => ({ mxf: !!window.tintwork.mxf, guides: window.tintwork.mxf?.guides?.length, mode: !!window.tintwork.mxf?.guideMode }));
  check(mid.mxf && mid.guides === 2 && mid.mode, `after 2 guides: preview open (guides=${mid.guides})`);
  check(await page.locator('#optionsbar [data-cmd="mxfGuidedApply"]').count() === 1, 'Apply guides button visible');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 }).catch(() => {});
  const done = await T(() => ({ mxf: !!window.tintwork.mxf, H: !!window.tintwork.lastUpright?.H, kind: window.tintwork.lastUpright?.kind || window.tintwork.lastUpright?.mode }));
  check(!done.mxf && done.H, `Enter finishes guided (H=${done.H}, kind=${done.kind})`);
}

// Guided: 4th guide auto-finishes
{
  await page.setInputFiles('#fileInput', { name: 'c4-g4.jpg', mimeType: 'image/jpeg', buffer: REAL('c4.jpg') });
  await page.waitForFunction(() => window.tintwork.doc?.name?.startsWith('c4-g4'), null, { timeout: 30000 });
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('guidedUpright'); });
  await page.waitForFunction(() => window.tintwork.mxf?.guideMode);
  const toScreen = async (p) => page.evaluate(({ x, y }) => {
    const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state;
    return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom };
  }, p);
  const guides = [[[124, 446], [15, 900]], [[935, 492], [968, 900]], [[50, 200], [900, 180]], [[80, 700], [920, 720]]];
  for (const pts of guides) {
    const a = await toScreen({ x: pts[0][0], y: pts[0][1] }), b = await toScreen({ x: pts[1][0], y: pts[1][1] });
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(100);
  }
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 }).catch(() => {});
  const four = await T(() => ({ mxf: !!window.tintwork.mxf, H: !!window.tintwork.lastUpright?.H }));
  check(!four.mxf && four.H, `4th guide auto-finishes (mxf=${four.mxf}, H=${four.H})`);
}

// No brand words in visible export / sharpen labels (MIME types may contain vendor strings)
{
  const labels = await T(async () => {
    window.tintwork.run('export');
    await new Promise((r) => setTimeout(r, 40));
    const body = document.getElementById('modalBody');
    const text = (body?.innerText || '') + ' ' + ([...document.querySelectorAll('#eSharp option, #eSharp optgroup')].map((el) => el.label || el.textContent).join(' '));
    document.getElementById('modalCancel')?.click();
    return text;
  });
  check(!/photoshop|lightroom|\badobe\b/i.test(labels), `export visible labels have no brand words (${String(labels).slice(0, 80)})`);
}

check(errors.filter((e) => !/Deprecated|favicon/i.test(e)).length === 0, `no page errors (${errors.slice(0, 3).join('; ')})`);

console.log(`\n${count - fails}/${count} passed`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
