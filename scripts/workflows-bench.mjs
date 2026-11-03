// Task-based workflow benchmark: 12 everyday photographer jobs driven through Tintwork's real UI (menu clicks,
// tool drags, keystrokes, dialog fields) in Chromium at 1280×800, plus an iPhone emulation smoke pass.
// Each user action counts as one step: a click (a menu title and its item are 2), a drag, a keystroke or shortcut,
// typing one value into a field, or picking a file in a file dialog. Time is wall-clock for the whole job, including
// the app's processing. Every job checks its result (pixels, sizes, layers, exported files) — a job only passes if the
// outcome is right, not just if nothing crashed.
//
// Usage: node scripts/workflows-bench.mjs [url] [--label before|after] [--only 1,4] [--runs 1]
// Default url: the live site. Output: docs/audit/workflows-<label>.json and screenshots/18x-wf-<job>.png.
// v1.8: jobs 13+ use real, freely licensed photos from test-assets/real (see LICENSES.md there) as well as the drawn ones.
// File pickers (open / save / folder) are backed by the browser's private file system (OPFS) so they can be
// scripted; each picker use still counts as the step a real user would take.
import { chromium, devices } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createStaticServer } from './serve.mjs';

const args = process.argv.slice(2);
let URL0 = args.find((a) => /^https?:/.test(a)) || 'https://kcope19.github.io/tintwork/';
const argv = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const label = argv('--label', 'run'), only = argv('--only', '') ? argv('--only').split(',').map(Number) : null, RUNS = +argv('--runs', 1);
let server = null;
if (args.includes('--local')) { server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); URL0 = `http://127.0.0.1:${server.address().port}/`; }
mkdirSync('screenshots', { recursive: true }); mkdirSync('docs/audit', { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// Test images (drawn in the page, deterministic): a portrait-like subject with a blemish, a tilted seascape,
// a keystoned building, a sky, and a folder of six photos for batch work.
// ---------------------------------------------------------------------------------------------------------
async function makeAssets(page) {
  return page.evaluate(async () => {
    const mk = (w, h, draw, type = 'image/jpeg') => { const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); draw(x, w, h); return c.convertToBlob({ type, quality: 0.92 }).then(async (b) => [...new Uint8Array(await b.arrayBuffer())]); };
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const noise = (x, w, h, a) => { const d = x.getImageData(0, 0, w, h); for (let i = 0; i < d.data.length; i += 4) { const n = (rnd() - 0.5) * a; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; } x.putImageData(d, 0, 0); };
    const out = {};
    out.portrait = await mk(2400, 1600, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#2f6a55'); g.addColorStop(1, '#6f9a7c'); x.fillStyle = g; x.fillRect(0, 0, w, h); // leafy green backdrop
      for (let i = 0; i < 400; i++) { x.fillStyle = `rgba(${20 + rnd() * 60},${80 + rnd() * 80},${40 + rnd() * 50},0.5)`; x.beginPath(); x.arc(rnd() * w, rnd() * h, 10 + rnd() * 40, 0, 7); x.fill(); }
      x.fillStyle = '#2b3a8c'; x.beginPath(); x.ellipse(1200, 1650, 520, 520, 0, 0, 7); x.fill(); // shoulders (blue shirt)
      x.fillStyle = '#d9a27e'; x.beginPath(); x.ellipse(1200, 760, 300, 380, 0, 0, 7); x.fill(); x.fillRect(1110, 1050, 180, 160); // face + neck
      x.fillStyle = '#3a2a20'; x.beginPath(); x.ellipse(1200, 470, 320, 170, 0, Math.PI, 0); x.fill(); // hair
      x.fillStyle = '#c38b68'; x.fillRect(1000, 640, 400, 25); // a shadowed brow band (dodge target)
      x.fillStyle = '#5a3a2c'; x.beginPath(); x.arc(1300, 880, 14, 0, 7); x.fill(); // the blemish
      noise(x, w, h, 10);
    });
    out.tilted = await mk(2400, 1600, (x, w, h) => {
      x.fillStyle = '#9cc6e8'; x.fillRect(0, 0, w, h); x.save(); x.translate(w / 2, h / 2); x.rotate(3 * Math.PI / 180);
      x.fillStyle = '#1f4f7a'; x.fillRect(-w, 0, 2 * w, h); x.fillStyle = '#e8d9a8'; x.fillRect(-w, 420, 2 * w, h); x.restore(); noise(x, w, h, 6);
    });
    out.building = await mk(2000, 2400, (x, w, h) => {
      x.fillStyle = '#a9c4dc'; x.fillRect(0, 0, w, h); x.fillStyle = '#b5a48f'; // keystoned facade: narrower at the top
      x.beginPath(); x.moveTo(600, 200); x.lineTo(1400, 200); x.lineTo(1700, 2300); x.lineTo(300, 2300); x.closePath(); x.fill();
      x.strokeStyle = '#4a3d30'; x.lineWidth = 14; x.stroke(); x.fillStyle = '#6d7f91';
      // v1.8: windows are projected with the same keystone as the facade (v1.7 drew upright rectangles inside the
      // trapezoid, so the outer windows leaned after any correction: a test-image artifact, measured in WORKFLOW_BENCHMARK.md)
      const P = (u, v) => { const t = v; return [600 - 300 * t + u * (800 + 600 * t), 200 + 2100 * v]; }; // facade (u,v) ∈ [0,1]² → image (vertical lines stay straight)
      if (window.__legacyWindows) for (let r = 0; r < 8; r++) for (let c = 0; c < 4; c++) { const y = 350 + r * 240, t = (y - 200) / 2100, l = 600 - 300 * t, rr = 1400 + 300 * t, cw = (rr - l) / 4; x.fillRect(l + c * cw + cw * 0.25, y, cw * 0.5, 120); }
      else for (let r = 0; r < 8; r++) for (let c = 0; c < 4; c++) {
        const v0 = (150 + r * 240) / 2100, v1 = v0 + 120 / 2100, u0 = (c + 0.25) / 4, u1 = (c + 0.75) / 4;
        x.beginPath(); [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)].forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.closePath(); x.fill();
      }
      x.fillStyle = '#5c6b3c'; x.fillRect(0, 2300, w, 100); noise(x, w, h, 6);
    });
    out.sky = await mk(2400, 1600, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#20184a'); g.addColorStop(0.6, '#d86a3c'); g.addColorStop(1, '#f2c46b'); x.fillStyle = g; x.fillRect(0, 0, w, h); noise(x, w, h, 6); });
    out.batch = [];
    for (let i = 0; i < 6; i++) out.batch.push(await mk(3000, 2000, (x, w, h) => { x.fillStyle = `hsl(${i * 60},50%,50%)`; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.font = '400px sans-serif'; x.fillText(String(i + 1), 1300, 1200); }));
    return out;
  });
}

// ---------------------------------------------------------------------------------------------------------
async function newSession(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...opts });
  await ctx.addInitScript(() => {
    // OPFS-backed stand-ins for the Windows file dialogs (the user would type a name / pick a file: 1 step each)
    const W = (window.__pick = { save: 0, open: 0, dir: 0, nextOpen: null });
    window.showSaveFilePicker = async (o) => { W.save++; W.lastSave = o.suggestedName; const root = await navigator.storage.getDirectory(); return root.getFileHandle(o.suggestedName, { create: true }); };
    window.showOpenFilePicker = async () => { W.open++; const root = await navigator.storage.getDirectory(); return [await root.getFileHandle(W.nextOpen)]; };
    window.showDirectoryPicker = async (o) => { W.dir++; const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(o?.mode === 'read' ? 'batch-in' : 'batch-out', { create: true }); };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${URL0}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  await page.evaluate(() => window.tintwork.engineReady);
  return { ctx, page, errors };
}

function recorder(page) {
  const R = { steps: 0, log: [], notes: [] };
  const step = (kind, what) => { R.steps++; R.log.push(`${kind}: ${what}`); };
  const settle = async () => { await page.evaluate(async () => { const t = window.tintwork; await t.idle(); await t.compositeSettled?.(); }); };
  const toScreen = (p) => page.evaluate(({ x, y }) => { const r = document.querySelector('#view').getBoundingClientRect(), s = window.tintwork.state; return { x: r.left + s.panX + x * s.zoom, y: r.top + s.panY + y * s.zoom }; }, p);
  Object.assign(R, {
    step, settle, toScreen,
    async menu(title, item) {
      await page.locator('#menus .menu > button', { hasText: new RegExp(`^${title}$`) }).click(); step('click', `${title} menu`);
      await page.locator('#menus .menu.open .menu-items button', { hasText: item }).first().click(); step('click', `${title} ▸ ${item}`); await settle();
    },
    async click(sel, what = sel) { await page.locator(sel).first().click(); step('click', what); await settle(); },
    async tool(id) { await page.click(`#toolbar button[data-tool="${id}"]`); step('click', `tool ${id}`); },
    async key(k) { await page.keyboard.press(k); step('key', k); await settle(); },
    async type(sel, v, what = sel) { await page.locator(sel).first().fill(String(v)); await page.locator(sel).first().dispatchEvent('change'); await page.locator(sel).first().dispatchEvent('input'); step('type', `${what} = ${v}`); },
    async select(sel, v, what = sel) { await page.selectOption(sel, v); step('click', `${what} → ${v}`); },
    async slider(sel, v, what = sel) { // drag a range slider: one step
      await page.locator(sel).first().evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v); step('drag', `${what} slider → ${v}`);
    },
    async clickDoc(p, mods = [], what = 'canvas') { const s = await toScreen(p); for (const m of mods) await page.keyboard.down(m); await page.mouse.click(s.x, s.y); for (const m of mods) await page.keyboard.up(m); step('click', `${mods.length ? mods.join('+') + '+' : ''}${what} at ${Math.round(p.x)},${Math.round(p.y)}`); await settle(); },
    async drag(pts, what = 'drag', mods = []) {
      const s = []; for (const p of pts) s.push(await toScreen(p));
      for (const m of mods) await page.keyboard.down(m);
      await page.mouse.move(s[0].x, s[0].y); await page.mouse.down();
      for (let i = 1; i < s.length; i++) { const a = s[i - 1], b = s[i], n = 8; for (let k = 1; k <= n; k++) await page.mouse.move(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n); }
      await page.mouse.up(); for (const m of mods) await page.keyboard.up(m); step('drag', what); await settle();
    },
    async openFile(name, bytes) { await page.setInputFiles('#fileInput', { name, mimeType: /\.png$/.test(name) ? 'image/png' : /\.jpe?g$/.test(name) ? 'image/jpeg' : 'application/octet-stream', buffer: Buffer.from(bytes) }); step('pick', `file ${name}`); },
    /** Set a dialog value: type it in the number field (v1.7+), or drag the slider when there is none. */
    async value(key, v, what = key) {
      const num = page.locator(`#modalBody input.pf-num[data-num-key="${key}"]`);
      if (await num.count()) return R.type(`#modalBody input.pf-num[data-num-key="${key}"]`, v, what);
      R.note(`${what}: no number field, slider only`); return R.slider(`#modalBody input[type=range][data-key="${key}"]`, v, what);
    },
    async ok() { await page.click('#modalOk'); step('click', 'OK'); await settle(); },
    note(s) { R.notes.push(s); },
  });
  return R;
}
const ctrlO = async (R, page, name, bytes) => { // Ctrl+O then pick the file (the bench routes the picker through the file input)
  await page.evaluate(() => { delete window.showOpenFilePicker; });
  const fc = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await page.keyboard.press('Control+o'); R.step('key', 'Ctrl+O');
  const ch = await fc; if (ch) { await ch.setFiles({ name, mimeType: /\.png$/.test(name) ? 'image/png' : 'image/jpeg', buffer: Buffer.from(bytes) }); R.step('pick', `file ${name}`); }
  else await R.openFile(name, bytes);
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')) || document.querySelector('#modal:not(.hidden)'), name, { timeout: 60000 });
  await R.settle();
};
const meanIn = (page, r) => page.evaluate(async (r) => { const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(); const d = c.getContext('2d').getImageData(r.x, r.y, r.w, r.h).data; let s = [0, 0, 0], v = 0, n = d.length / 4; for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; } s = s.map((a) => a / n); for (let i = 0; i < d.length; i += 4) v += (d[i] - s[0]) ** 2; return { mean: s.map((a) => Math.round(a)), sd: Math.round(Math.sqrt(v / n) * 10) / 10 }; }, r);
const opfsFile = (page, dir, name) => page.evaluate(async ({ dir, name }) => { let root = await navigator.storage.getDirectory(); if (dir) root = await root.getDirectoryHandle(dir); const f = await (await root.getFileHandle(name)).getFile(); const b = new Uint8Array(await f.arrayBuffer()); const bmp = /png|jpe?g|webp/i.test(name) ? await createImageBitmap(f) : null; return { size: f.size, w: bmp?.width, h: bmp?.height, head: [...b.subarray(0, 40)] }; }, { dir, name });
/** Outer-window lean on the building: per row, the first / last window pixel; robust line fit → degrees from vertical. */
const windowLean = (page) => page.evaluate(async () => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const isWin = (j) => d[j + 3] > 200 && Math.abs(d[j] - 109) < 22 && Math.abs(d[j + 1] - 127) < 22 && Math.abs(d[j + 2] - 145) < 22;
  // per row: x of the first / last run of 6 window pixels (anti-aliased wall-edge pixels can match the window colour)
  const rows = [];
  for (let y = 0; y < H; y++) { let a = -1, b = -1, run = 0; for (let x = 0; x < W; x++) { run = isWin((y * W + x) * 4) ? run + 1 : 0; if (run === 6 && a < 0) a = x - 5; if (run >= 6) b = x; } rows.push(a >= 0 && b - a > W * 0.2 ? [a, b] : null); }
  // each window row is a band of consecutive rows: fit the outer windows' side edges inside each band (that is the lean
  // a viewer sees), skipping 4 rows at the band's top and bottom (anti-aliased corners)
  const slope = (pts) => { const n = pts.length, my = pts.reduce((s, p) => s + p[0], 0) / n, mx = pts.reduce((s, p) => s + p[1], 0) / n; let sxy = 0, syy = 0; for (const [y, x] of pts) { sxy += (y - my) * (x - mx); syy += (y - my) ** 2; } return Math.atan(sxy / syy) * 180 / Math.PI; };
  const L = [], R = []; let y = 0;
  while (y < H) { if (!rows[y]) { y++; continue; } const y0 = y; while (y < H && rows[y]) y++; const band = []; for (let k = y0 + 4; k < y - 4; k++) band.push(k); if (band.length >= 20) { L.push(slope(band.map((k) => [k, rows[k][0]]))); R.push(slope(band.map((k) => [k, rows[k][1]]))); } }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null), worst = (a) => (a.length ? a.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0) : null);
  return { left: mean(L), right: mean(R), worstL: worst(L), worstR: worst(R), bands: L.length };
});
/** JS port of the sub-pixel edge fit used to measure real photos: strongest horizontal gradient within ±win px of a seed line. */
const edgeAngle = (page, seeds, win = 4) => page.evaluate(async ({ seeds, win }) => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
  return seeds.map(([[x1, y1], [x2, y2]]) => {
    const xs = [], ys = [];
    for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
      if (y < 0 || y >= H) continue; const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win); if (a < 1 || b >= W - 1) continue;
      let k = -1, best = 12; const row = []; for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); row.push(v); if (v > best) { best = v; k = x - a; } }
      if (k < 0) continue; let dx = 0; if (k > 0 && k < row.length - 1) { const l = row[k - 1], cc = row[k], r = row[k + 1], den = l - 2 * cc + r; dx = den ? 0.5 * (l - r) / den : 0; }
      xs.push(a + k + dx); ys.push(y);
    }
    let keep = xs.map(() => true), s = 0, c0 = 0, res = [];
    for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null, n }; const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n; let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; } s = sxy / syy; c0 = mx - s * my; res = xs.map((x, i) => Math.abs(x - (s * ys[i] + c0))); keep = res.map((r) => r < 1.5); }
    return { deg: Math.atan(s) * 180 / Math.PI, n: keep.filter(Boolean).length, of: xs.length };
  });
}, { seeds, win });
/** Map points of the original photo through the last upright correction (homography, then the edge crop). */
const mapUpright = (page, pts) => page.evaluate((pts) => { const u = window.tintwork.lastUpright, H = u.H, c = u.crop || { x: 0, y: 0 }; return pts.map(([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w - c.x, (H[3] * x + H[4] * y + H[5]) / w - c.y]; }); }, pts);
const REAL = (f) => readFileSync(`test-assets/real/${f}`);
const imgDiff = (page, a, b, r) => page.evaluate(async ({ a, b, r }) => { const dec = async (u8) => { const bm = await createImageBitmap(new Blob([new Uint8Array(u8)])); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(r.x, r.y, r.w, r.h).data; }; const p = await dec(a), q = await dec(b); let s = 0; for (let i = 0; i < p.length; i += 4) s += (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2])) / 3; return s / (p.length / 4); }, { a: [...a], b: [...b], r });
const jpegDpi = (h) => (h[2] === 0xff && h[3] === 0xe0 ? { unit: h[13], x: (h[14] << 8) | h[15] } : null);

// ---------------------------------------------------------------------------------------------------------
// The jobs. `paid` = step counts in other editors from their public documentation (see docs/WORKFLOW_BENCHMARK.md).
// ---------------------------------------------------------------------------------------------------------
const RAW_FILE = ['test-assets/raw-samples/google-pixel-4a.dng', 'test-assets/raw-samples/adobe-canon-eos-5d-mark-iii.dng'].find(existsSync);
const JOBS = [
  { id: 1, name: 'RAW: fix exposure + white balance, open as 16-bit', async run(R, page, A) {
    if (!RAW_FILE) { R.note('no RAW sample on this machine (npm run fetch-raw)'); return { ok: false, skip: true }; }
    await R.openFile(RAW_FILE.split('/').pop(), readFileSync(RAW_FILE));
    await page.waitForFunction(() => window.tintwork.rawUI && window.tintwork.rawUI.idle, null, { timeout: 60000 });
    if (await page.locator('#rawAutoTone').count()) { await R.click('#rawAutoTone', 'Auto tone'); }
    else { await R.select('#rawWb', 'auto', 'White balance preset'); await R.slider('#modalBody input[type=range][data-k="exposure"], #modalBody [data-key="exposure"]', 0.4, 'Exposure'); }
    if (await page.locator('#rawWbPick').count()) R.note('white-balance eyedropper available in the develop window');
    await page.waitForFunction(() => window.tintwork.rawUI?.idle, null, { timeout: 60000 });
    await R.ok(); await page.waitForFunction(() => window.tintwork.doc && !window.tintwork.rawUI && window.tintwork.activeLayer()?.raw, null, { timeout: 90000 }); await R.settle();
    const r = await page.evaluate(() => ({ bits: window.tintwork.doc.depth || window.tintwork.doc.bits, w: window.tintwork.doc.width, s: window.tintwork.activeLayer().raw.settings }));
    return { ok: r.w > 1000 && (r.s.wb === 'auto' || r.s.autoTone || r.s.exposure !== 0), detail: `${r.w}px, ${r.bits || '?'}-bit, wb ${r.s.wb}, exposure ${r.s.exposure}` };
  }, paid: { 'Lightroom Classic': 3, 'Photoshop (Camera Raw)': 4, 'Affinity Photo (Develop)': 5, 'Photopea': 6 } },

  { id: 2, name: 'Crop and straighten a tilted horizon', async run(R, page, A) {
    await ctrlO(R, page, 'seascape.jpg', A.tilted);
    await R.tool('straighten');
    // drag along the horizon: it was drawn rotated 3° about the centre, so it runs through (1200,800) at +3°
    const t = Math.tan(3 * Math.PI / 180); await R.drag([{ x: 300, y: 800 - 900 * t }, { x: 2100, y: 800 + 900 * t }], 'along the horizon');
    await R.tool('crop'); const d = await page.evaluate(() => ({ w: window.tintwork.doc.width, h: window.tintwork.doc.height }));
    await R.drag([{ x: d.w * 0.1, y: d.h * 0.1 }, { x: d.w * 0.9, y: d.h * 0.9 }], 'crop rectangle'); await R.key('Enter');
    const tilt = await page.evaluate(() => window.tintwork.detectTilt());
    const r = await page.evaluate(() => ({ w: window.tintwork.doc.width, h: window.tintwork.doc.height }));
    const ang = tilt?.angle ?? tilt; return { ok: Math.abs(+ang || 0) < 0.6 && r.w < d.w, detail: `residual tilt ${(+ang || 0).toFixed(2)}°, ${r.w}×${r.h}` };
  }, paid: { 'Lightroom Classic': 4, 'Photoshop': 4, 'Affinity Photo': 5, 'Pixelmator Pro': 4, 'Photopea': 5 } },

  { id: 3, name: 'Remove a blemish', async run(R, page, A) {
    await ctrlO(R, page, 'portrait.jpg', A.portrait);
    const before = await meanIn(page, { x: 1292, y: 872, w: 16, h: 16 });
    await R.tool('spot'); await R.drag([{ x: 1295, y: 880 }, { x: 1305, y: 880 }], 'paint over the blemish');
    const after = await meanIn(page, { x: 1292, y: 872, w: 16, h: 16 }), skin = await meanIn(page, { x: 1340, y: 820, w: 16, h: 16 });
    const dist = Math.hypot(...after.mean.map((v, i) => v - skin.mean[i]));
    return { ok: dist < 25, detail: `blemish RGB ${before.mean} → ${after.mean} (skin ${skin.mean}, Δ ${dist.toFixed(0)})` };
  }, paid: { 'Photoshop': 2, 'Lightroom Classic': 2, 'Affinity Photo': 2, 'Pixelmator Pro': 2, 'Photopea': 2 } },

  { id: 4, name: 'Select the subject and blur the background', async run(R, page, A) {
    await ctrlO(R, page, 'portrait.jpg', A.portrait);
    const bg0 = await meanIn(page, { x: 100, y: 100, w: 300, h: 300 }), face0 = await meanIn(page, { x: 1100, y: 700, w: 100, h: 100 });
    if (await page.locator('#menus .menu-items button[data-cmd="selectSubject"]').count()) {
      await R.menu('Select', 'Subject'); await R.menu('Select', 'Invert selection');
    } else if (await page.locator('#toolbar button[data-tool="objsel"]').count()) {
      // v1.8 object select: a box around the head and shoulders, then invert (Shift+F7: Ctrl+Shift+I is the browser's)
      await R.tool('objsel'); await R.drag([{ x: 640, y: 250 }, { x: 1770, y: 1599 }], 'box around the subject');
      await page.evaluate(() => window.tintwork.objSel.settled()); await R.key('Enter'); await R.key('Shift+F7');
    } else {
      // no subject select: magic wand on the background (not contiguous, tolerance up), then refine
      await R.tool('wand'); await R.type('#optionsbar input[type=number][data-opt="wandTolerance"]', 70, 'Tolerance');
      await R.clickDoc({ x: 150, y: 150 }, [], 'background'); await R.clickDoc({ x: 2250, y: 1450 }, ['Shift'], 'more background'); await R.clickDoc({ x: 300, y: 1300 }, ['Shift'], 'more background');
    }
    await R.menu('Filter', 'Gaussian blur'); await R.value('radius', 30, 'Radius'); await R.ok();
    await R.key('Control+d');
    const bg1 = await meanIn(page, { x: 100, y: 100, w: 300, h: 300 }), face1 = await meanIn(page, { x: 1100, y: 700, w: 100, h: 100 });
    const faceShift = Math.hypot(...face1.mean.map((v, i) => v - face0.mean[i]));
    return { ok: bg1.sd < bg0.sd * 0.6 && faceShift < 6 && face1.sd < face0.sd + 3, detail: `background texture σ ${bg0.sd} → ${bg1.sd}; face shift Δ ${faceShift.toFixed(1)}` };
  }, paid: { 'Photoshop (Select Subject)': 5, 'Lightroom Classic (Select Subject mask)': 4, 'Affinity Photo': 7, 'Pixelmator Pro (ML select)': 5, 'Photopea (Magic Cut / select)': 6 } },

  { id: 5, name: 'Dodge and burn a portrait', async run(R, page, A) {
    await ctrlO(R, page, 'portrait.jpg', A.portrait);
    const b0 = await meanIn(page, { x: 1100, y: 645, w: 200, h: 15 });
    await R.key('Control+j'); // work on a copy (non-destructive habit)
    await R.tool('tone');
    await R.drag([{ x: 1010, y: 652 }, { x: 1390, y: 652 }], 'dodge the brow band');
    await R.drag([{ x: 1010, y: 652 }, { x: 1390, y: 652 }], 'dodge again');
    const b1 = await meanIn(page, { x: 1100, y: 645, w: 200, h: 15 });
    const n = await page.evaluate(() => window.tintwork.doc.layers.length);
    return { ok: b1.mean[0] > b0.mean[0] + 6 && n >= 2, detail: `brow band R ${b0.mean[0]} → ${b1.mean[0]}, ${n} layers` };
  }, paid: { 'Photoshop': 6, 'Lightroom Classic (local brush)': 5, 'Affinity Photo': 5, 'Pixelmator Pro': 4, 'Photopea': 5 } },

  { id: 6, name: 'Add a text watermark at 50% opacity', async run(R, page, A) {
    await ctrlO(R, page, 'portrait.jpg', A.portrait);
    await R.tool('text'); await R.clickDoc({ x: 1700, y: 1500 }, [], 'watermark spot');
    await page.waitForSelector('#modal:not(.hidden) #tText');
    await R.type('#tText', '© K. Cope 2026', 'Text'); await R.type('#tSize', 72, 'Size'); await R.ok();
    await R.slider('#layerOpacity', 50, 'Layer opacity');
    const l = await page.evaluate(() => { const a = window.tintwork.activeLayer(); return { kind: a.kind, op: a.opacity, text: a.text?.text }; });
    return { ok: l.kind === 'text' && Math.abs(l.op - 0.5) < 0.02, detail: `${l.kind} layer “${l.text}”, opacity ${Math.round(l.op * 100)}%` };
  }, paid: { 'Photoshop': 6, 'Lightroom Classic (export watermark)': 6, 'Affinity Photo': 5, 'Pixelmator Pro': 5, 'Photopea': 5 } },

  { id: 7, name: 'Instagram portrait post: 4:5 crop, 1080×1350 JPEG', async run(R, page, A) {
    await ctrlO(R, page, 'portrait.jpg', A.portrait);
    await R.tool('crop');
    const opt = await page.locator('#optionsbar select[data-croppreset] option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
    const ig = opt.find(([, t]) => /1080\s*×\s*1350/.test(t)) || opt.find(([, t]) => /4:5/.test(t)); await R.select('#optionsbar select[data-croppreset]', ig[0], 'Ratio');
    await page.waitForTimeout(200);
    const has = await page.evaluate(() => !!window.tintwork.state.crop);
    if (!has) await R.drag([{ x: 700, y: 100 }, { x: 1700, y: 1350 }], 'crop rectangle');
    await R.key('Enter');
    await R.key('Control+Shift+e'); await page.waitForSelector('#modal:not(.hidden) #eFmt');
    await R.select('#eFmt', 'image/jpeg', 'Format'); await R.ok();
    await page.waitForFunction(() => window.__pick.save > 0 && /Exported/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
    const name = await page.evaluate(() => window.__pick.lastSave), f = await opfsFile(page, null, name);
    return { ok: f.w === 1080 && f.h === 1350, detail: `${name}: ${f.w}×${f.h}, ${(f.size / 1024).toFixed(0)} KB` };
  }, paid: { 'Lightroom Classic': 7, 'Photoshop': 8, 'Affinity Photo': 8, 'Pixelmator Pro': 7, 'Photopea': 8 } },

  { id: 8, name: 'Print export: 8×10 in at 300 ppi JPEG', async run(R, page, A) {
    await ctrlO(R, page, 'portrait.jpg', A.portrait);
    await R.tool('crop');
    const opt = await page.locator('#optionsbar select[data-croppreset] option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
    const pr = opt.find(([, t]) => /8\s*[×x]\s*10/.test(t)); await R.select('#optionsbar select[data-croppreset]', pr[0], 'Ratio');
    await page.waitForTimeout(200);
    // a landscape photo → the print preset follows it; the job wants a portrait print, so swap the orientation
    if (await page.evaluate(() => { const a = window.tintwork.cropAspect?.(); return a && a.w > a.h; })) await R.click('#optionsbar [data-cropswap]', 'swap orientation');
    if (!(await page.evaluate(() => !!window.tintwork.state.crop))) await R.drag([{ x: 600, y: 50 }, { x: 1800, y: 1550 }], 'crop rectangle');
    await R.key('Enter');
    await R.key('Control+Shift+e'); await page.waitForSelector('#modal:not(.hidden) #eFmt');
    await R.select('#eFmt', 'image/jpeg', 'Format'); await R.ok();
    await page.waitForFunction(() => window.__pick.save > 0 && /Exported/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
    const name = await page.evaluate(() => window.__pick.lastSave), f = await opfsFile(page, null, name), dpi = jpegDpi(f.head);
    const port = f.h > f.w, ok = Math.min(f.w, f.h) === 2400 && Math.max(f.w, f.h) === 3000 && dpi?.unit === 1 && dpi.x === 300;
    return { ok, detail: `${f.w}×${f.h}${port ? '' : ' (landscape)'}, JFIF density ${dpi ? `${dpi.x} (unit ${dpi.unit})` : 'none'}` };
  }, paid: { 'Lightroom Classic': 6, 'Photoshop': 8, 'Affinity Photo': 8, 'Pixelmator Pro': 7, 'Photopea': 9 } },

  { id: 9, name: 'Batch-resize a folder of 6 photos to 2048 px long edge JPEG', async run(R, page, A) {
    await page.evaluate(async (files) => { const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('batch-in', { create: true }); for (let i = 0; i < files.length; i++) { const w = await (await dir.getFileHandle(`photo-${i + 1}.jpg`, { create: true })).createWritable(); await w.write(new Uint8Array(files[i])); await w.close(); } }, A.batch);
    if (!(await page.evaluate(() => !!window.tintwork.doc))) R.note('Batch process is in the File menu even with no document open');
    await R.menu('File', 'Batch process'); await page.waitForSelector('#modal:not(.hidden) #bSrcDir');
    await R.click('#bSrcDir', 'Choose folder…'); R.step('pick', 'folder in the folder dialog');
    await page.waitForFunction(() => /6 image/.test(document.querySelector('#bSrcInfo')?.textContent || ''), null, { timeout: 10000 });
    await R.select('#modalBody tr[data-i="0"] select[data-f="mode"]', 'long', 'Size mode'); await page.waitForTimeout(100);
    await R.type('#modalBody tr[data-i="0"] input[data-f="long"]', 2048, 'Long edge');
    await R.select('#modalBody tr[data-i="0"] select[data-f="type"]', 'image/jpeg', 'Format');
    const t0 = Date.now(); await R.ok(); R.step('pick', 'output folder in the folder dialog');
    await page.waitForFunction(() => /Batch finished/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
    const secs = (Date.now() - t0) / 1000;
    const outs = await page.evaluate(async () => { const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('batch-out'); const r = []; for await (const [n, h] of dir.entries()) { const f = await h.getFile(); const b = await createImageBitmap(f); r.push([n, b.width, b.height]); } return r; });
    return { ok: outs.length === 6 && outs.every(([, w, h]) => Math.max(w, h) === 2048), detail: `${outs.length} files, ${outs.map((o) => `${o[1]}×${o[2]}`)[0]}, ${secs.toFixed(1)} s for the batch` };
  }, paid: { 'Lightroom Classic (Export)': 6, 'Photoshop (Image Processor)': 7, 'Affinity Photo (Batch Job)': 8, 'Pixelmator Pro (Export / Shortcuts)': 7, 'Photopea': 'no batch' } },

  { id: 10, name: 'Fix converging verticals on a building', async run(R, page, A) {
    await ctrlO(R, page, 'building.jpg', A.building);
    const ex = (y) => { const t = (y - 200) / 2100; return [600 - 300 * t, 1400 + 300 * t]; }; // the facade's true edges
    if (await page.locator('#menus .menu-items button[data-cmd="autoUpright"]').count()) { await R.menu('Image', 'Auto upright'); await R.key('Enter'); }
    else if (await page.locator('#menus .menu-items button[data-cmd="guidedUpright"]').count()) {
      await R.menu('Image', 'Guided upright');
      await page.waitForFunction(() => window.tintwork.mxf);
      await R.drag([{ x: ex(300)[0], y: 300 }, { x: ex(2200)[0], y: 2200 }], 'guide along the left wall');
      await R.drag([{ x: ex(300)[1], y: 300 }, { x: ex(2200)[1], y: 2200 }], 'guide along the right wall');
      await page.waitForFunction(() => window.tintwork.mxf && !window.tintwork.mxf.guideMode, null, { timeout: 5000 }).catch(() => {});
      await R.key('Enter');
    } else {
      await R.menu('Edit', 'Perspective');
      await page.waitForFunction(() => window.tintwork.mxf);
      const pts = await page.evaluate(() => window.tintwork.mxf.pts.map(([x, y]) => ({ x, y })));
      // corners are TL, TR, BL, BR (or TL TR BR BL): drag the two top corners outwards by the keystone amount
      const top = pts.filter((p) => p.y < 1000).sort((a, b) => a.x - b.x);
      await R.drag([top[0], { x: top[0].x - 330, y: top[0].y }], 'top-left corner outwards');
      await R.drag([top[1], { x: top[1].x + 330, y: top[1].y }], 'top-right corner outwards');
      await R.key('Enter');
    }
    // measure: x of the facade's left edge near the top and bottom
    const edges = await page.evaluate(async () => { const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), x = c.getContext('2d'); const at = (y) => { const d = x.getImageData(0, y, c.width, 1).data; for (let i = 0; i < c.width; i++) { const j = i * 4; if (d[j + 3] > 200 && d[j] < 110 && d[j + 1] < 100) return i; } return -1; }; const atR = (y) => { const d = x.getImageData(0, y, c.width, 1).data; for (let i = c.width - 1; i >= 0; i--) { const j = i * 4; if (d[j + 3] > 200 && d[j] < 110 && d[j + 1] < 100) return i; } return -1; }; const y1 = Math.round(c.height * 0.15), y2 = Math.round(c.height * 0.85); return { top: at(y1), bot: at(y2), rtop: atR(y1), rbot: atR(y2) }; });
    const lean = await windowLean(page), lu = await page.evaluate(() => window.tintwork.lastUpright || null);
    const leanOK = lean.left != null && Math.abs(lean.left) < 0.5 && Math.abs(lean.right) < 0.5;
    const ok = edges.top > 0 && Math.abs(edges.top - edges.bot) < 40 && edges.rtop > 0 && Math.abs(edges.rtop - edges.rbot) < 40 && leanOK;
    return { ok, detail: `left edge x at 15% / 85% height: ${edges.top} / ${edges.bot}; right edge ${edges.rtop} / ${edges.rbot}; outer-window lean ${lean.left?.toFixed(2)}° / ${lean.right?.toFixed(2)}° (worst ${lean.worstL?.toFixed(2)}° / ${lean.worstR?.toFixed(2)}°, ${lean.bands} rows)${lu?.crop ? `; cropped to ${lu.crop.w}×${lu.crop.h}` : ''}` };
  }, paid: { 'Lightroom Classic (Upright Auto)': 2, 'Photoshop (Camera Raw filter Upright)': 4, 'Affinity Photo (Perspective)': 5, 'Pixelmator Pro (Perspective)': 4, 'Photopea (Perspective transform)': 5 } },

  { id: 11, name: 'Combine two photos with a gradient mask (sky blend)', async run(R, page, A) {
    await ctrlO(R, page, 'seascape.jpg', A.tilted);
    await page.evaluate(() => { window.__placeOK = true; });
    const fc = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await page.keyboard.press('Control+Shift+o'); R.step('key', 'Ctrl+Shift+O (place image)');
    const ch = await fc; if (ch) { await ch.setFiles({ name: 'sky.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(A.sky) }); R.step('pick', 'file sky.jpg'); } else { R.note('Ctrl+Shift+O opened no file dialog'); return { ok: false, detail: 'place shortcut failed' }; }
    await page.waitForFunction(() => window.tintwork.doc.layers.length >= 2, null, { timeout: 30000 }); await R.settle();
    if (await page.evaluate(() => !!window.tintwork.xf)) await R.key('Enter'); // place may start a transform
    await R.click('#layersPanel [data-cmd="addMask"]', 'Add layer mask');
    await R.tool('gradient');
    const fg = await page.evaluate(() => window.tintwork.state.fg);
    if (!/^#(000000|ffffff)$/i.test(fg)) { await R.key('d'); R.note(`default foreground is ${fg}, not black: press D before painting a mask`); }
    // black (foreground) at the sea, white (background) at the sky: the sky shows at the top
    await R.drag([{ x: 1200, y: 900 }, { x: 1200, y: 500 }], 'gradient on the mask (sea → sky)');
    const top = await meanIn(page, { x: 1100, y: 100, w: 200, h: 100 }), bot = await meanIn(page, { x: 1100, y: 1400, w: 200, h: 100 });
    // sky.jpg is dark purple at the top; seascape bottom is sand
    const mask = await page.evaluate(() => !!window.tintwork.activeLayer().mask);
    const okTop = top.mean[2] < 140 && top.mean[0] < 120, okBot = bot.mean[0] > 180;
    // white→black from top to bottom: with default colours black→white the gradient may need reversing
    return { ok: mask && ((okTop && okBot) || (!okTop && !okBot && false)), detail: `top ${top.mean} / bottom ${bot.mean} (expect sky purple top, sand bottom)` };
  }, paid: { 'Photoshop': 6, 'Affinity Photo': 6, 'Pixelmator Pro': 6, 'Photopea': 6, 'Lightroom Classic': 'not possible' } },

  { id: 12, name: 'Re-edit a saved project (change an adjustment after reopening)', async run(R, page, A) {
    await ctrlO(R, page, 'portrait.jpg', A.portrait);
    await R.click('#layersPanel [data-cmd="adjLayerMenu"]', 'New adjustment layer');
    const pick = page.locator('#modal:not(.hidden) .choice-list button', { hasText: /Brightness/ });
    if (await pick.count()) { await pick.first().click(); R.step('click', 'Brightness / contrast'); } else { await R.menu('Layer', 'New adjustment layer: Brightness'); }
    await page.waitForSelector('#modal:not(.hidden)'); await R.value('brightness', 30, 'Brightness'); await R.ok();
    await R.key('Control+s'); await page.waitForFunction(() => window.__pick.save > 0 && /Saved/i.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
    const saved = await page.evaluate(() => window.__pick.lastSave);
    await R.key('Control+Alt+w'); if (await page.locator('#modal:not(.hidden)').count()) await R.ok();
    // reopen through the welcome screen's Recent files list
    await page.waitForSelector('#welcomeRecent li button, #welcomeRecent li a, #welcomeRecent li[data-id]', { timeout: 10000 }).catch(() => null);
    const rec = page.locator('#welcomeRecent li button, #welcomeRecent li a, #welcomeRecent li[data-id]').first();
    if (await rec.count()) { await rec.click(); R.step('click', 'recent project'); } else { await page.evaluate((n) => { window.__pick.nextOpen = n; }, saved); await R.key('Control+o'); }
    await page.waitForFunction(() => window.tintwork.doc?.layers?.some((l) => l.kind === 'adjust'), null, { timeout: 30000 }); await R.settle();
    const th = page.locator('#layerList li', { hasText: /Brightness/ }).locator('.thumb').first();
    await th.dblclick(); R.step('dblclick', 'adjustment layer thumbnail');
    await page.waitForSelector('#modal:not(.hidden) input[data-key="brightness"]');
    await R.value('brightness', -20, 'Brightness'); await R.ok();
    const v = await page.evaluate(() => window.tintwork.doc.layers.find((l) => l.kind === 'adjust').adj.params.brightness);
    return { ok: v === -20, detail: `reopened ${saved}; brightness now ${v}` };
  }, paid: { 'Photoshop (PSD adjustment layer)': 5, 'Affinity Photo': 5, 'Pixelmator Pro': 5, 'Lightroom Classic (catalog, always editable)': 3, 'Photopea': 6 } },

  // ---- v1.8: real photos (test-assets/real, public domain / CC0) and the new export features ----------------------
  { id: 13, name: '3R: remove a blemish on a real portrait (USDA, public domain)', async run(R, page) {
    // an artificial dark spot (r 8 px) is painted on freckled cheek skin; the result is compared with the untouched photo.
    // v1.9: the reference images stay in the page (v1.8 shipped multi-MB number arrays back and forth, which made this
    // job look like 66 s; the app's own time is now reported separately as “heal …ms”).
    const spot = await page.evaluate(async (b64) => { const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const bm = await createImageBitmap(new Blob([u8])); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0);
      window.__heal = { orig: x.getImageData(0, 0, bm.width, bm.height) };
      const g = x.createRadialGradient(590, 640, 0, 590, 640, 8); g.addColorStop(0, 'rgba(70,35,25,0.95)'); g.addColorStop(0.7, 'rgba(85,45,30,0.85)'); g.addColorStop(1, 'rgba(90,50,35,0)'); x.fillStyle = g; x.beginPath(); x.arc(590, 640, 8, 0, 7); x.fill();
      window.__heal.spot = x.getImageData(0, 0, bm.width, bm.height);
      const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); }, REAL('portrait-usda.jpg').toString('base64'));
    await ctrlO(R, page, 'portrait-usda.png', Buffer.from(spot, 'base64'));
    await R.tool('spot'); const t0 = Date.now(); await R.drag([{ x: 585, y: 640 }, { x: 595, y: 640 }], 'paint over the blemish'); const healMs = Date.now() - t0;
    const m = await page.evaluate(async () => {
      const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), now = c.getContext('2d').getImageData(0, 0, c.width, c.height), { orig, spot } = window.__heal, W = orig.width;
      const diff = (A, r) => { let s = 0; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const i = (y * W + x) * 4; s += (Math.abs(A.data[i] - orig.data[i]) + Math.abs(A.data[i + 1] - orig.data[i + 1]) + Math.abs(A.data[i + 2] - orig.data[i + 2])) / 3; } return s / (r.w * r.h); };
      // texture: high-pass energy (pixel minus its 4 neighbours) inside the spot, relative to the untouched photo (1 = same grain)
      const hp = (A, r) => { let s = 0, n = 0; const L = (i) => 0.299 * A.data[i * 4] + 0.587 * A.data[i * 4 + 1] + 0.114 * A.data[i * 4 + 2]; for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) { const i = y * W + x, v = L(i) - (L(i - 1) + L(i + 1) + L(i - W) + L(i + W)) / 4; s += v * v; n++; } return Math.sqrt(s / n); };
      const box = { x: 578, y: 628, w: 24, h: 24 };
      return { before: diff(spot, box), after: diff(now, box), ring: diff(now, { x: 560, y: 610, w: 60, h: 14 }), tex: hp(now, box) / hp(orig, box) };
    });
    return { ok: m.after < m.before * 0.3 && m.ring < 2, detail: `mean error vs the untouched photo in the spot: ${m.before.toFixed(1)} → ${m.after.toFixed(1)} levels (${Math.round(100 - 100 * m.after / m.before)}% removed); grain ${m.tex.toFixed(2)}× the photo's; skin above the spot changed ${m.ring.toFixed(2)}; stroke + heal ${healMs} ms` };
  }, paid: { 'Photoshop': 2, 'Lightroom Classic': 2, 'Affinity Photo': 2, 'Pixelmator Pro': 2, 'Photopea': 2 } },

  { id: 14, name: '4R: select a real subject (public-domain portrait) — object select', async run(R, page) {
    await ctrlO(R, page, 'evers-scene.jpg', REAL('evers-scene.jpg'));
    if (!(await page.locator('#toolbar button[data-tool="objsel"]').count())) { R.note('no object select tool in this version'); return { ok: false, detail: 'no object select' }; }
    const W = await page.evaluate(() => window.tintwork.doc.width), H = await page.evaluate(() => window.tintwork.doc.height);
    await R.tool('objsel'); await R.drag([{ x: 280, y: 225 }, { x: W - 1, y: H - 1 }], 'box around the subject');
    await page.evaluate(() => window.tintwork.objSel.settled());
    await R.drag([{ x: 520, y: 1300 }, { x: 640, y: 1450 }], 'Shift-paint the suit (subject)', ['Shift']); await page.evaluate(() => window.tintwork.objSel.settled());
    await R.drag([{ x: 1180, y: 960 }, { x: 1230, y: 1010 }], 'Alt-paint the person behind (background)', ['Alt']); await page.evaluate(() => window.tintwork.objSel.settled());
    const ms = await page.evaluate(() => window.tintwork.objSel.state?.ms ?? null);
    await R.key('Enter');
    const iou = { ...(await selIoU(page)), ms };
    return { ok: iou.iou > 0.8, detail: `IoU ${iou.iou.toFixed(3)} against the published cut-out (inside its frame), ${iou.ms} ms per solve` };
  }, paid: { 'Photoshop (Object Selection, ML)': 2, 'Lightroom Classic (Select Subject, ML)': 2, 'Affinity Photo (Selection Brush)': 4, 'Pixelmator Pro (Quick Selection ML)': 3, 'Photopea (Magic Cut)': 4 } },

  { id: 21, name: '4R holdout: a second real subject (CC0 cut-out, not used for tuning) — box only', async run(R, page) {
    await ctrlO(R, page, 'macaque.jpg', REAL('macaque.jpg'));
    if (!(await page.locator('#toolbar button[data-tool="objsel"]').count())) { R.note('no object select tool in this version'); return { ok: false, detail: 'no object select' }; }
    const H = await page.evaluate(() => window.tintwork.doc.height);
    await R.tool('objsel'); await R.drag([{ x: 0, y: 240 }, { x: 940, y: H - 1 }], 'box around the subject');
    await page.evaluate(() => window.tintwork.objSel.settled()); await R.key('Enter');
    const iou = await selIoU(page, 'macaque-gt.png', null);
    return { ok: iou.iou > 0.8, detail: `IoU ${iou.iou.toFixed(3)} against the published cut-out (whole frame)` };
  }, paid: { 'Photoshop (Object Selection, ML)': 2, 'Lightroom Classic (Select Subject, ML)': 2, 'Affinity Photo (Selection Brush)': 4, 'Pixelmator Pro (Quick Selection ML)': 3, 'Photopea (Magic Cut)': 4 } },

  { id: 15, name: '4R baseline: the same subject with the magic wand (v1.7 route)', async run(R, page) {
    await ctrlO(R, page, 'evers-scene.jpg', REAL('evers-scene.jpg'));
    // a careful wand attempt: select the background (sky, jet, the people at the sides) and invert
    await R.tool('wand'); await R.type('#optionsbar input[type=number][data-opt="wandTolerance"]', 40, 'Tolerance');
    for (const [p, what] of [[{ x: 300, y: 80 }, 'sky'], [{ x: 1500, y: 80 }, 'sky right'], [{ x: 200, y: 700 }, 'jet left'], [{ x: 1450, y: 700 }, 'jet right'], [{ x: 80, y: 400 }, 'person left'], [{ x: 1220, y: 980 }, 'person behind'], [{ x: 100, y: 1450 }, 'shoulder left']])
      await R.clickDoc(p, ['Shift'], what);
    await R.key('Shift+F7');
    const iou = await selIoU(page);
    return { ok: iou.iou > 0.8, detail: `IoU ${iou.iou.toFixed(3)} with 7 wand clicks + invert` };
  }, paid: { 'Photoshop (Object Selection, ML)': 2, 'Lightroom Classic (Select Subject, ML)': 2, 'Affinity Photo (Selection Brush)': 4, 'Pixelmator Pro (Quick Selection ML)': 3, 'Photopea (Magic Cut)': 4 } },

  { id: 16, name: '10R: Auto upright on a real photo (church among towers, CC0)', async run(R, page) {
    return realUpright(R, page, 'c4.jpg', [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]], 'auto');
  }, paid: { 'Lightroom Classic (Upright Auto)': 2, 'Photoshop (Camera Raw filter Upright)': 4, 'Affinity Photo (Perspective)': 5, 'Pixelmator Pro (Perspective)': 4, 'Photopea (Perspective transform)': 5 } },

  { id: 17, name: '10R: Auto upright on a real photo (high-rise looking up, CC0)', async run(R, page) {
    return realUpright(R, page, 'c6.jpg', [[[481, 368], [449, 573]], [[845, 368], [887, 598]]], 'auto');
  }, paid: { 'Lightroom Classic (Upright Auto)': 2, 'Photoshop (Camera Raw filter Upright)': 4, 'Affinity Photo (Perspective)': 5, 'Pixelmator Pro (Perspective)': 4, 'Photopea (Perspective transform)': 5 } },

  { id: 18, name: '10R: Guided upright on the same real photo (two drawn guides)', async run(R, page) {
    return realUpright(R, page, 'c4.jpg', [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]], 'guided');
  }, paid: { 'Lightroom Classic (Upright Guided)': 5, 'Photoshop (Camera Raw filter Upright Guided)': 7, 'Affinity Photo (Perspective)': 5, 'Pixelmator Pro (Perspective)': 4, 'Photopea (Perspective transform)': 5 } },

  { id: 19, name: 'Export for web with a saved preset and a text watermark (first time)', async run(R, page, A) {
    await ctrlO(R, page, 'portrait.jpg', A.portrait);
    await R.key('Control+Shift+e'); await page.waitForSelector('#modal:not(.hidden) #eFmt');
    if (!(await page.locator('#ePreset').count())) { R.note('no export presets in this version'); return { ok: false, detail: 'no presets / watermark' }; }
    await R.select('#ePreset', 'web', 'Preset');
    await R.click('[data-wmedit="eWm"]', 'Watermark…'); await R.type('.wm-panel [data-wm=text]', '© K. Cope 2026', 'Watermark text'); await R.click('.wm-panel [data-wmdone]', 'Done (ticks “Add watermark”)');
    await R.ok();
    await page.waitForFunction(() => window.__pick.save > 0 && /Exported/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
    const name = await page.evaluate(() => window.__pick.lastSave), f = await opfsFile(page, null, name), wm = await watermarkCheck(page, name, null);
    // the repeat: one shortcut exports again with the same preset
    const n0 = R.steps; await R.key('Control+Alt+Shift+e');
    await page.waitForFunction(() => window.__pick.save > 1 && /Exported/.test(document.querySelector('#status').textContent), null, { timeout: 30000 }).catch(() => {});
    const again = await page.evaluate(() => window.__pick.save);
    return { ok: Math.max(f.w, f.h) === 2048 && wm.corner > 2 && wm.away < 0.05 && again === 2, detail: `${f.w}×${f.h}; watermark changes ${wm.corner.toFixed(1)}% of the bottom-right band (elsewhere ${wm.away.toFixed(2)}%); repeat export: ${R.steps - n0} step` };
  }, paid: { 'Lightroom Classic (Export preset + watermark)': 6, 'Photoshop (text layer + Export As)': 9, 'Affinity Photo (text layer + Export)': 8, 'Pixelmator Pro (text layer + Export)': 8, 'Photopea (text layer + Export)': 8 } },

  { id: 20, name: 'Batch-resize 6 photos to 2048 px JPEG with a watermark', async run(R, page, A) {
    await page.evaluate(async (files) => { const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('batch-in', { create: true }); for (let i = 0; i < files.length; i++) { const w = await (await dir.getFileHandle(`photo-${i + 1}.jpg`, { create: true })).createWritable(); await w.write(new Uint8Array(files[i])); await w.close(); } }, A.batch);
    await R.menu('File', 'Batch process'); await page.waitForSelector('#modal:not(.hidden) #bSrcDir');
    if (!(await page.locator('#bWm').count())) { R.note('no batch watermark in this version'); return { ok: false, detail: 'no batch watermark' }; }
    await R.click('#bSrcDir', 'Choose folder…'); R.step('pick', 'folder in the folder dialog');
    await page.waitForFunction(() => /6 image/.test(document.querySelector('#bSrcInfo')?.textContent || ''), null, { timeout: 10000 });
    await R.select('#modalBody tr[data-i="0"] select[data-f="mode"]', 'long', 'Size mode'); await page.waitForTimeout(100);
    await R.type('#modalBody tr[data-i="0"] input[data-f="long"]', 2048, 'Long edge');
    await R.select('#modalBody tr[data-i="0"] select[data-f="type"]', 'image/jpeg', 'Format');
    await R.click('[data-wmedit="bWm"]', 'Watermark…'); await R.type('.wm-panel [data-wm=text]', '© K. Cope 2026', 'Watermark text'); await R.click('.wm-panel [data-wmdone]', 'Done (ticks “Add watermark”)');
    await R.ok(); R.step('pick', 'output folder in the folder dialog');
    await page.waitForFunction(() => /Batch finished/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
    const outs = await page.evaluate(async () => { const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('batch-out'); const r = []; for await (const [n, h] of dir.entries()) { const f = await h.getFile(); const b = await createImageBitmap(f); const c = new OffscreenCanvas(b.width, b.height), x = c.getContext('2d'); x.drawImage(b, 0, 0); const px = (rx, ry, rw, rh) => { const d = x.getImageData(rx, ry, rw, rh).data; let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i] + d[i + 1] + d[i + 2]); return m / 3; }; r.push([n, b.width, b.height, px(b.width - 500, b.height - 120, 480, 100) - px(20, 20, 480, 100)]); } return r; });
    return { ok: outs.length === 6 && outs.every(([, w, h, br]) => Math.max(w, h) === 2048 && br > 30), detail: `${outs.length} files, ${outs[0]?.[1]}×${outs[0]?.[2]}, watermark brightness +${Math.round(Math.min(...outs.map((o) => o[3])))} in the corner (min over files)` };
  }, paid: { 'Lightroom Classic (Export, watermark)': 8, 'Photoshop (Image Processor + action with text)': 12, 'Affinity Photo (Batch Job, macro)': 12, 'Pixelmator Pro (Shortcuts)': 10, 'Photopea': 'no batch' } },
  { id: 22, name: '10R: Upright Full on the church photo (verticals + horizontals)', async run(R, page) {
    return realUpright(R, page, 'c4.jpg', [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]], 'full');
  }, paid: { 'Lightroom Classic (Upright Full)': 2, 'Photoshop (Camera Raw filter Upright Full)': 4, 'Affinity Photo (Perspective)': 5, 'Pixelmator Pro (Perspective)': 4, 'Photopea (Perspective transform)': 5 } },

  { id: 23, name: 'Level a tilted sea horizon (3°) with Upright: level', async run(R, page) {
    // synthetic seascape: sky gradient over darker sea, horizon tilted 3°, with sensor-like noise
    const png = await page.evaluate(async () => { const W = 1600, H = 1000, c = new OffscreenCanvas(W, H), x = c.getContext('2d'), im = x.createImageData(W, H), tn = Math.tan(3 * Math.PI / 180);
      let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 12;
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { const hy = 500 + (xx - 800) * tn, sea = y > hy, i = (y * W + xx) * 4, n = rnd(); im.data[i] = (sea ? 30 : 150 + y * 0.08) + n; im.data[i + 1] = (sea ? 70 : 190 + y * 0.04) + n; im.data[i + 2] = (sea ? 110 : 235) + n; im.data[i + 3] = 255; }
      x.putImageData(im, 0, 0); const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); let b = ''; for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(b); });
    await ctrlO(R, page, 'sea.png', Buffer.from(png, 'base64'));
    if (!(await page.locator('#menus .menu-items button[data-cmd="uprightLevel"]').count())) { R.note('no Level upright in this version'); return { ok: false, detail: 'no Level mode' }; }
    await R.menu('Image', 'Upright: level'); await R.key('Enter'); await R.settle();
    const m = await page.evaluate(async () => { const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
      // horizon row at a column: the y where blue drops most (sub-pixel by threshold crossing on a 9-px column average)
      const row = (x0) => { const b = (y) => { let s = 0, n = 0; for (let x = x0 - 4; x <= x0 + 4; x++) { const i = (y * W + x) * 4; if (d[i + 3] > 250) { s += d[i + 2]; n++; } } return n ? s / n : null; };
        for (let y = 50; y < H - 50; y++) { const a = b(y), c2 = b(y + 1); if (a != null && c2 != null && a >= 172 && c2 < 172) return y + (a - 172) / (a - c2); } return null; };
      const xa = Math.round(W * 0.2), xb = Math.round(W * 0.8), ya = row(xa), yb = row(xb);
      return { deg: ya != null && yb != null ? Math.atan2(yb - ya, xb - xa) * 180 / Math.PI : null, mode: t.lastUpright?.mode, W, H };
    });
    return { ok: m.deg != null && Math.abs(m.deg) < 0.2, detail: `horizon tilt 3.00° → ${m.deg?.toFixed(2)}° (${m.mode}, ${m.W}×${m.H})` };
  }, paid: { 'Lightroom Classic (Upright Level)': 2, 'Photoshop (Camera Raw filter Upright Level / crop auto-straighten)': 3, 'Affinity Photo (Straighten)': 3, 'Pixelmator Pro (Auto straighten)': 2, 'Photopea (ruler + rotate)': 4 } },

  { id: 24, name: 'Batch-resize 6 photos to 2048 px JPEG with a logo watermark', async run(R, page, A) {
    await page.evaluate(async (files) => { const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('batch-in', { create: true }); for (let i = 0; i < files.length; i++) { const w = await (await dir.getFileHandle(`photo-${i + 1}.jpg`, { create: true })).createWritable(); await w.write(new Uint8Array(files[i])); await w.close(); } }, A.batch);
    const logo = await page.evaluate(async () => { const c = new OffscreenCanvas(400, 200), x = c.getContext('2d'); x.fillStyle = '#ff00ff'; x.fillRect(0, 0, 400, 200); x.fillStyle = '#fff'; x.fillRect(150, 50, 100, 100); const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); let b = ''; for (let i = 0; i < buf.length; i++) b += String.fromCharCode(buf[i]); return btoa(b); });
    await R.menu('File', 'Batch process'); await page.waitForSelector('#modal:not(.hidden) #bSrcDir');
    await R.click('#bSrcDir', 'Choose folder…'); R.step('pick', 'folder in the folder dialog');
    await page.waitForFunction(() => /6 image/.test(document.querySelector('#bSrcInfo')?.textContent || ''), null, { timeout: 10000 });
    await R.select('#modalBody tr[data-i="0"] select[data-f="mode"]', 'long', 'Size mode'); await page.waitForTimeout(100);
    await R.type('#modalBody tr[data-i="0"] input[data-f="long"]', 2048, 'Long edge');
    await R.select('#modalBody tr[data-i="0"] select[data-f="type"]', 'image/jpeg', 'Format');
    await R.click('[data-wmedit="bWm"]', 'Watermark…');
    if (!(await page.locator('.wm-panel [data-wm=kind]').count())) { R.note('no logo watermark in this version'); return { ok: false, detail: 'text watermark only' }; }
    await R.select('.wm-panel [data-wm=kind]', 'image', 'Type: logo image');
    const fc = page.waitForEvent('filechooser', { timeout: 5000 }); await R.click('.wm-panel [data-wmpick]', 'Choose image…'); (await fc).setFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(logo, 'base64') }); R.step('pick', 'logo file');
    await page.waitForTimeout(300); await R.click('.wm-panel [data-wmdone]', 'Done (ticks “Add watermark”)');
    await R.ok(); R.step('pick', 'output folder in the folder dialog');
    await page.waitForFunction(() => /Batch finished/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
    const outs = await page.evaluate(async () => { const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('batch-out'); const r = []; for await (const [n, h] of dir.entries()) { const f = await h.getFile(); const b = await createImageBitmap(f); const c = new OffscreenCanvas(b.width, b.height), x = c.getContext('2d'); x.drawImage(b, 0, 0); const f0 = x.getImageData(10, 10, 1, 1).data; /* the photo's own flat colour */ const red = (rx, ry, rw, rh) => { const d = x.getImageData(rx, ry, rw, rh).data; let k = 0; for (let i = 0; i < d.length; i += 4) if ((d[i] + d[i + 2]) / 2 - d[i + 1] > 110 && Math.abs(d[i] - d[i + 2]) < 60 && Math.abs(d[i] - f0[0]) + Math.abs(d[i + 1] - f0[1]) + Math.abs(d[i + 2] - f0[2]) > 80) k++; return k; }; r.push([n, b.width, b.height, red(Math.round(b.width * 0.6), Math.round(b.height * 0.6), Math.round(b.width * 0.4), Math.round(b.height * 0.4)), red(0, 0, Math.round(b.width * 0.4), Math.round(b.height * 0.4))]); } return r; });
    return { ok: outs.length === 6 && outs.every(([, w, h, br, tl]) => Math.max(w, h) === 2048 && br > 5000 && tl < br * 0.05), detail: `${outs.length} files, ${outs[0]?.[1]}×${outs[0]?.[2]}, magenta logo pixels in the bottom-right ${Math.min(...outs.map((o) => o[3]))}+ per file (top-left ${Math.max(...outs.map((o) => o[4]))})` };
  }, paid: { 'Lightroom Classic (Export, graphic watermark)': 9, 'Photoshop (Image Processor + action placing the logo)': 13, 'Affinity Photo (Batch Job, macro)': 13, 'Pixelmator Pro (Shortcuts)': 11, 'Photopea': 'no batch' } },
];
/** IoU of the current selection with the published cut-out's alpha, inside the cut-out's frame (it touches 3 sides). */
const GT_RECT = { x: 300, y: 150, w: 1056, h: 1408 };
async function selIoU(page, gtFile = 'evers-gt.png', rect = GT_RECT) {
  return page.evaluate(async ({ gt, r }) => {
    const t = window.tintwork, s = t.doc.selection, bm = await createImageBitmap(new Blob([new Uint8Array(gt)])); r = r || { x: 0, y: 0, w: bm.width, h: bm.height }; const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0);
    const g = x.getImageData(0, 0, bm.width, bm.height).data; let I = 0, U = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let xx = r.x; xx < r.x + r.w; xx++) { const i = y * bm.width + xx, a = g[i * 4] >= 128 /* grey PNG: value = alpha of the cut-out */, b = s ? s.mask[i] >= 128 : false; if (a && b) I++; if (a || b) U++; }
    return { iou: U ? I / U : 0, ms: t.objSel?.state?.ms ?? null };
  }, { gt: [...REAL(gtFile)], r: rect });
}
/** Real-photo upright: run Auto (Image ▸ Auto upright, Enter) or Guided (two drags), then refit the seeded edges. */
async function realUpright(R, page, file, seeds, how) {
  await ctrlO(R, page, file, REAL(file));
  const before = await edgeAngle(page, seeds);
  if (how === 'auto') {
    if (!(await page.locator('#menus .menu-items button[data-cmd="autoUpright"]').count())) { R.note('no Auto upright in this version'); return { ok: false, detail: 'no auto upright' }; }
    await R.menu('Image', 'Auto upright');
  } else if (how === 'full') {
    if (!(await page.locator('#menus .menu-items button[data-cmd="uprightFull"]').count())) { R.note('no Full upright in this version'); return { ok: false, detail: 'no Full mode' }; }
    await R.menu('Image', 'Upright: full');
  } else {
    await R.menu('Image', 'Guided upright'); await page.waitForFunction(() => window.tintwork.mxf);
    for (const [a, b] of [seeds[0], seeds[seeds.length - 1]]) await R.drag([{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }], 'guide along a vertical edge');
    await page.waitForFunction(() => window.tintwork.mxf && !window.tintwork.mxf.guideMode, null, { timeout: 5000 }).catch(() => {});
  }
  await R.key('Enter'); await R.settle();
  const lu = await page.evaluate(() => window.tintwork.lastUpright || null);
  if (!lu?.H) return { ok: false, detail: `no correction (${lu?.mode || 'none'}); edges before ${before.map((e) => e.deg?.toFixed(2)).join('° / ')}°` };
  const mapped = []; for (const sd of seeds) mapped.push(await mapUpright(page, sd));
  const after = await edgeAngle(page, mapped), d = await page.evaluate(() => [window.tintwork.doc.width, window.tintwork.doc.height]);
  // Full (v1.9) also corrects the horizontals, so its crop can push an edge near the border out of the frame: that edge
  // is reported as cropped away and the job needs every edge still in the frame within 0.5° (and at least 2 of them)
  const inFrame = how === 'full' ? after.filter((e) => e.of) : after, cut = after.length - inFrame.length;
  const ok = inFrame.length >= 2 && inFrame.every((e) => e.deg != null && Math.abs(e.deg) < 0.5 && e.n >= 0.5 * e.of);
  return { ok, detail: `edge tilt ${before.map((e) => `${e.deg?.toFixed(2)}°`).join(' / ')} → ${after.map((e) => `${e.deg?.toFixed(2)}°`).join(' / ')} (edge support ${after.map((e) => `${e.n}/${e.of}`).join(', ')}) (${lu.lines ?? 2} lines${lu.hlines ? ` + ${lu.hlines} horizontal` : ''}${lu.crop ? `, cropped to ${d[0]}×${d[1]}` : ''}${cut ? `; ${cut} edge cropped out of the frame` : ''})` };
}
/** Watermark present in the exported file's bottom-right corner and nowhere else (compared with a render without it). */
async function watermarkCheck(page, name) {
  return page.evaluate(async (name) => {
    const t = window.tintwork, root = await navigator.storage.getDirectory(), f = await (await root.getFileHandle(name)).getFile();
    const plain = await t.renderExportWith('image/jpeg', 0.85, { size: { mode: 'long', long: 2048 } });
    const dec = async (b) => { const bm = await createImageBitmap(b); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x; };
    const a = await dec(f), b = await dec(plain), W = a.canvas.width, H = a.canvas.height;
    const diff = (r) => { const p = a.getImageData(r.x, r.y, r.w, r.h).data, q = b.getImageData(r.x, r.y, r.w, r.h).data; let n = 0; for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 60) n++; return 100 * n / (p.length / 4); }; // % of pixels clearly changed (JPEG noise stays far below 60)
    return { corner: diff({ x: Math.round(W * 0.55), y: Math.round(H * 0.85), w: Math.round(W * 0.42), h: Math.round(H * 0.12) }), away: diff({ x: 20, y: 20, w: Math.round(W * 0.4), h: Math.round(H * 0.4) }) };
  }, name);
}

// ---------------------------------------------------------------------------------------------------------
const browser = await chromium.launch();
const results = [];
let assets;
{ const s = await newSession(browser); if (process.env.TW_LEGACY_WIN === '1') await s.page.evaluate(() => { window.__legacyWindows = true; }); assets = await makeAssets(s.page); await s.ctx.close(); }
for (const job of JOBS) {
  if (only && !only.includes(job.id)) continue;
  for (let run = 0; run < RUNS; run++) {
    const s = await newSession(browser), R = recorder(s.page), t0 = Date.now();
    let res;
    try { res = await job.run(R, s.page, assets); } catch (e) { res = { ok: false, detail: `error: ${String(e.message || e).split('\n')[0].slice(0, 200)}` }; }
    const ms = Date.now() - t0;
    if (process.env.TW_DUMP) try { const b = await s.page.evaluate(async () => { const c = window.tintwork.compositeCanvas(); const bl = await new Promise((r) => c.toBlob(r, 'image/png')); return [...new Uint8Array(await bl.arrayBuffer())]; }); writeFileSync(`/tmp/dump-${job.id}.png`, Buffer.from(b)); } catch { /* ignore */ }
    try { await s.page.screenshot({ path: `screenshots/18x-wf-${String(job.id).padStart(2, '0')}.png` }); } catch { /* ignore */ }
    const r = { id: job.id, name: job.name, run: run + 1, ok: !!res.ok, skip: !!res.skip, detail: res.detail, steps: R.steps, ms, errors: s.errors.slice(0, 5), notes: R.notes, log: R.log, paid: job.paid };
    results.push(r); console.log(`${r.ok ? 'PASS' : 'FAIL'} #${job.id} ${job.name}: ${r.steps} steps, ${(ms / 1000).toFixed(1)} s — ${r.detail}${r.errors.length ? ` · errors: ${r.errors.join(' | ').slice(0, 300)}` : ''}`);
    await s.ctx.close();
  }
}
// iPhone smoke: open an image, run one adjustment through the Adjust sheet, export
let phone = null;
if (!only) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'] }); const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const t0 = Date.now();
  try {
    await page.goto(URL0); await page.waitForFunction(() => window.tintwork);
    await page.setInputFiles('#fileInput', { name: 'portrait.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(assets.portrait) });
    await page.waitForFunction(() => window.tintwork.doc); await page.tap('#mobilebar [data-sheet="adjust"]');
    await page.tap('#adjustSheet button[data-cmd="brightnessContrast"]'); await page.waitForSelector('#modal:not(.hidden)'); await page.tap('#modalOk');
    await page.evaluate(() => window.tintwork.idle());
    const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await page.tap('#mobilebar [data-cmd="export"]'); await page.waitForSelector('#modal:not(.hidden) #eFmt'); await page.tap('#modalOk');
    const d = await dl; phone = { ok: !errs.length, export: d ? d.suggestedFilename() : 'share sheet / none', ms: Date.now() - t0, errors: errs };
    await page.screenshot({ path: 'screenshots/18x-wf-iphone.png' });
  } catch (e) { phone = { ok: false, error: String(e.message).split('\n')[0], errors: errs }; }
  console.log('iPhone smoke', JSON.stringify(phone)); await ctx.close();
}
await browser.close(); server?.close();
const prev = existsSync(`docs/audit/workflows-${label}.json`) && only ? JSON.parse(readFileSync(`docs/audit/workflows-${label}.json`, 'utf8')) : null;
const merged = prev ? [...prev.results.filter((r) => !results.some((x) => x.id === r.id)), ...results].sort((a, b) => a.id - b.id) : results;
writeFileSync(`docs/audit/workflows-${label}.json`, JSON.stringify({ url: URL0, label, date: new Date().toISOString(), results: merged, phone: phone || prev?.phone }, null, 2));
const pass = results.filter((r) => r.ok).length; console.log(`\n${pass}/${results.length} jobs passed`);
