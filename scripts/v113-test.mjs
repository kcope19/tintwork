// v1.13 test: non-AI polish — auto-apply upright, soft-proof ink warning, JPEG sRGB ICC, denser spot heal / textured edge fill.
// TW_ROOT=/path/to/other/checkout runs against another tree. TW_URL=https://… against a deployed site.
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
const load = async () => { await page.goto(`${BASE}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete'); await page.evaluate(() => window.tintwork.engineReady); };
await load();
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));

// --- 1. Auto upright applies without Enter
{
  await page.setInputFiles('#fileInput', { name: 'c4.jpg', mimeType: 'image/jpeg', buffer: REAL('c4.jpg') });
  await page.waitForFunction(() => window.tintwork.doc?.name?.startsWith('c4'), null, { timeout: 30000 });
  await T(async () => { window.tintwork.state.opts.uprightEdges = 'crop'; await window.tintwork.idle(); });
  await T(() => window.tintwork.run('autoUpright'));
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const u = await T(() => ({ mxf: !!window.tintwork.mxf, H: !!window.tintwork.lastUpright?.H, mode: window.tintwork.lastUpright?.mode, crop: !!window.tintwork.lastUpright?.crop }));
  check(!u.mxf && u.H && u.mode && u.mode !== 'none', `Auto upright applies without Enter (mxf=${u.mxf}, H=${u.H}, mode=${u.mode}, crop=${u.crop})`);
}

// --- 2. Guided upright applies after the second guide (no Enter)
{
  await page.setInputFiles('#fileInput', { name: 'c4b.jpg', mimeType: 'image/jpeg', buffer: REAL('c4.jpg') });
  await page.waitForFunction(() => window.tintwork.doc?.name?.startsWith('c4b'), null, { timeout: 30000 });
  await T(async () => { window.tintwork.state.opts.uprightEdges = 'crop'; await window.tintwork.idle(); });
  await T(() => window.tintwork.run('guidedUpright'));
  await page.waitForFunction(() => window.tintwork.mxf?.guideMode);
  // draw two vertical guides in document space via the API (same as two mouse drags)
  await T(() => {
    const x = window.tintwork.mxf;
    const g1 = [[124, 446], [15, 900]], g2 = [[935, 492], [968, 900]];
    // call the same path the pointer uses
    const add = (g) => {
      const fn = Object.getOwnPropertyDescriptor(window, '__twAddGuide')?.value;
    };
  });
  // drive through pointer on the view
  const toScreen = async (p) => page.evaluate(({ x, y }) => {
    const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state;
    return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom };
  }, p);
  for (const pts of [[[124, 446], [15, 900]], [[935, 492], [968, 900]]]) {
    const a = await toScreen({ x: pts[0][0], y: pts[0][1] }), b = await toScreen({ x: pts[1][0], y: pts[1][1] });
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y); await page.mouse.up();
    await T(async () => { await window.tintwork.idle(); });
  }
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 }).catch(() => {});
  const g = await T(() => ({ mxf: !!window.tintwork.mxf, H: !!window.tintwork.lastUpright?.H, kind: window.tintwork.lastUpright?.kind }));
  check(!g.mxf && g.H, `Guided upright applies after second guide (mxf=${g.mxf}, H=${g.H}, kind=${g.kind})`);
}

// --- 3. Soft-proof ink warning: pure white flagged under matte paper; mid-grey not
{
  await T(async () => {
    const t = window.tintwork; t.newDocument(300, 100, 'white', 'proof-warn');
    const l = t.activeLayer(), x = l.canvas.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 100, 100);
    x.fillStyle = '#808080'; x.fillRect(100, 0, 100, 100);
    x.fillStyle = '#000000'; x.fillRect(200, 0, 100, 100);
    t.touch(l); t.markDirty(); t.renderNow(); await t.compositeSettled?.(); t.run('zoomFit');
  });
  check(await T(() => typeof window.tintwork.setProofWarn === 'function'), 'setProofWarn is exported');
  check(await page.locator('#menus .menu-items button[data-cmd="proofWarnOn"]').count() === 1, 'View menu has Proof: ink warning on');
  await T(() => { window.tintwork.run('proofMatte'); window.tintwork.run('proofWarnOn'); });
  await page.waitForTimeout(200);
  const sample = await T(() => {
    // re-run mask logic on the composite the same way the overlay does
    const t = window.tintwork, c = t.compositeCanvas(), d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const paper = t.PROOF_PAPERS.matte;
    const srgbToLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const wLin = paper.white.map(srgbToLin), bLin = paper.black.map(srgbToLin), lim = paper.inkLimit;
    const at = (x) => {
      const i = ((50 * c.width + x) * 4);
      const rl = srgbToLin(d.data[i]), gl = srgbToLin(d.data[i + 1]), bl = srgbToLin(d.data[i + 2]);
      const crush = rl > wLin[0] + 1e-4 || gl > wLin[1] + 1e-4 || bl > wLin[2] + 1e-4 || rl < bLin[0] - 1e-4 || gl < bLin[1] - 1e-4 || bl < bLin[2] - 1e-4;
      const ink = (1 - rl) + (1 - gl) + (1 - bl);
      return crush || ink > lim;
    };
    return { white: at(50), grey: at(150), black: at(250), warn: t.proofWarn, mode: t.proofMode };
  });
  check(sample.warn && sample.mode === 'matte' && sample.white && !sample.grey && sample.black, `ink warning flags white+black, not mid-grey (${JSON.stringify(sample)})`);
  await T(() => window.tintwork.run('proofOff'));
}

// --- 4. JPEG export embeds sRGB ICC; PNG still has sRGB chunk
{
  await T(async () => { window.tintwork.newDocument(64, 64, '#336699', 'icc'); await window.tintwork.idle(); });
  const jpg = await T(async () => {
    const b = await window.tintwork.renderExportWith('image/jpeg', 0.9, { dpi: 72 });
    const u8 = new Uint8Array(await b.arrayBuffer());
    let found = false;
    for (let i = 2; i + 20 < u8.length && u8[i] === 0xff;) {
      const m = u8[i + 1], len = (u8[i + 2] << 8) | u8[i + 3];
      if (m === 0xe2) {
        const tag = String.fromCharCode(...u8.subarray(i + 4, i + 15));
        if (tag.startsWith('ICC_PROFILE')) { found = true; break; }
      }
      if (m === 0xda || len < 2) break;
      i += 2 + len;
    }
    return { type: b.type, found, n: u8.length };
  });
  check(jpg.found, `JPEG export embeds ICC_PROFILE (${JSON.stringify(jpg)})`);
  const png = await T(async () => {
    const b = await window.tintwork.renderExportWith('image/png', 1);
    const u8 = new Uint8Array(await b.arrayBuffer());
    // look for sRGB chunk type
    let found = false;
    for (let i = 8; i + 8 < u8.length;) {
      const len = (u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3];
      const type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
      if (type === 'sRGB') { found = true; break; }
      if (type === 'IEND') break;
      i += 12 + len;
    }
    return found;
  });
  check(png === true, `PNG export still has sRGB chunk (${png})`);
}

// --- 5. Spot heal still removes a blemish without smearing grain (bar ≥75%, grain 0.5–2×)
{
  const spot = await page.evaluate(async (b64) => {
    const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bm = await createImageBitmap(new Blob([u8]));
    const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0);
    window.__heal = { orig: x.getImageData(0, 0, bm.width, bm.height) };
    const g = x.createRadialGradient(590, 640, 0, 590, 640, 8);
    g.addColorStop(0, 'rgba(70,35,25,0.95)'); g.addColorStop(0.7, 'rgba(85,45,30,0.85)'); g.addColorStop(1, 'rgba(90,50,35,0)');
    x.fillStyle = g; x.beginPath(); x.arc(590, 640, 8, 0, 7); x.fill();
    window.__heal.spot = x.getImageData(0, 0, bm.width, bm.height);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, REAL('portrait-usda.jpg').toString('base64'));
  await page.setInputFiles('#fileInput', { name: 'portrait-heal.png', mimeType: 'image/png', buffer: Buffer.from(spot, 'base64') });
  await page.waitForFunction(() => window.tintwork.doc?.name?.startsWith('portrait-heal'), null, { timeout: 30000 });
  await T(() => window.tintwork.run('toolSpot' in window.tintwork ? 'toolSpot' : null));
  await page.click('#toolbar button[data-tool="spot"]');
  const a = await page.evaluate(() => { const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state; return { x: r.left + s.panX + 585 * s.zoom, y: r.top + s.panY + 640 * s.zoom }; });
  const b = await page.evaluate(() => { const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state; return { x: r.left + s.panX + 595 * s.zoom, y: r.top + s.panY + 640 * s.zoom }; });
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y); await page.mouse.up();
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const m = await T(async () => {
    const t = window.tintwork; await t.compositeSettled?.();
    const c = t.compositeCanvas(), now = c.getContext('2d').getImageData(0, 0, c.width, c.height), { orig, spot } = window.__heal, W = orig.width;
    const diff = (A, r) => { let s = 0; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const i = (y * W + x) * 4; s += (Math.abs(A.data[i] - orig.data[i]) + Math.abs(A.data[i + 1] - orig.data[i + 1]) + Math.abs(A.data[i + 2] - orig.data[i + 2])) / 3; } return s / (r.w * r.h); };
    const L = (A, i) => 0.299 * A.data[i * 4] + 0.587 * A.data[i * 4 + 1] + 0.114 * A.data[i * 4 + 2];
    const hp = (A, r) => { let s = 0, n = 0; for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) { const i = y * W + x, v = L(A, i) - (L(A, i - 1) + L(A, i + 1) + L(A, i - W) + L(A, i + W)) / 4; s += v * v; n++; } return Math.sqrt(s / n); };
    const box = { x: 578, y: 628, w: 24, h: 24 };
    return { before: diff(spot, box), after: diff(now, box), grain: hp(now, box) / hp(orig, box) };
  });
  const removed = 100 - 100 * m.after / m.before;
  check(removed >= 75 && m.grain > 0.5 && m.grain < 2, `spot heal ${removed.toFixed(0)}% removed, grain ${m.grain.toFixed(2)}× (bar ≥75%, grain 0.5–2)`);
}

// --- 6. Fill empty edges: leaves opaque pixels alone and fills transparency
{
  const e = await T(async () => {
    const t = window.tintwork; t.newDocument(200, 200, 'transparent', 'edges2');
    const l = t.activeLayer(), x = l.canvas.getContext('2d');
    x.fillStyle = '#6a8'; x.fillRect(40, 40, 120, 120);
    const id = x.getImageData(40, 40, 120, 120);
    for (let i = 0; i < id.data.length; i += 4) { const n = ((i * 17) % 13) - 6; id.data[i] = Math.min(255, Math.max(0, id.data[i] + n)); id.data[i + 1] = Math.min(255, Math.max(0, id.data[i + 1] + n)); }
    x.putImageData(id, 40, 40); const before = new Uint8ClampedArray(id.data);
    t.touch(l); t.markDirty(); await t.compositeSettled?.();
    t.fillEmptyEdges(); await t.idle(); await t.compositeSettled?.();
    const after = t.activeLayer().canvas.getContext('2d').getImageData(0, 0, 200, 200);
    let opaqueSame = 0, filled = 0;
    for (let y = 0; y < 200; y++) for (let x0 = 0; x0 < 200; x0++) {
      const i = (y * 200 + x0) * 4;
      if (x0 >= 40 && x0 < 160 && y >= 40 && y < 160) {
        const j = ((y - 40) * 120 + (x0 - 40)) * 4;
        if (Math.abs(after.data[i] - before[j]) + Math.abs(after.data[i + 1] - before[j + 1]) + Math.abs(after.data[i + 2] - before[j + 2]) < 4) opaqueSame++;
      } else if (after.data[i + 3] === 255) filled++;
    }
    return { opaqueSame, filled, need: 120 * 120 };
  });
  check(e.opaqueSame >= e.need * 0.98 && e.filled >= 200 * 200 - e.need, `Fill empty edges keeps opaque (${e.opaqueSame}/${e.need}) and fills gaps (${e.filled})`);
}

check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ') || 'none'})`);

console.log(`\n${count - fails}/${count} checks passed`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
