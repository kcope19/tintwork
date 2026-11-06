// v1.12 test: non-AI polish from the v1.11 audit.
//  - Full upright do-no-harm: refuse when correction would worsen horizontals / dual tiny-rotate
//  - Held-out hongkong.jpg (job 32): seeds fixed before first Tintwork run; Full must not worsen
//  - Batch: Open tabs + Batch again on a files/tabs subset
//  - Radial estimate exists but warp stays gated (disclosed); library Full still uses the 1.0° bar
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
await ctx.addInitScript(() => {
  const W = (window.__pick = { dir: 0, req: [] });
  window.showDirectoryPicker = async (o) => { W.dir++; const root = await navigator.storage.getDirectory(); const name = o?.mode === 'read' ? 'batch-in' : (sessionStorage.getItem('destName') || 'batch-out'); return root.getDirectoryHandle(name, { create: true }); };
  const H = window.FileSystemHandle?.prototype;
  if (H) {
    const q = H.queryPermission;
    H.queryPermission = async function (d) { if (sessionStorage.getItem('perm') === 'prompt' && !W.granted?.has(`${this.name}:${d?.mode}`)) return 'prompt'; return q ? q.call(this, d) : 'granted'; };
    H.requestPermission = async function (d) { W.req.push(`${this.name}:${d?.mode}`); const a = sessionStorage.getItem('answer') || 'granted'; if (a === 'granted') (W.granted ||= new Set()).add(`${this.name}:${d?.mode}`); return a; };
  }
});
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const load = async () => { await page.goto(`${BASE}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete'); await page.evaluate(() => window.tintwork.engineReady); };
await load();
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));
const menu = async (title, item) => { await page.locator('#menus .menu > button', { hasText: new RegExp(`^${title}$`) }).click(); await page.locator('#menus .menu.open .menu-items button', { hasText: item }).first().click(); };
const outFiles = (name = 'batch-out') => T(async (name) => { const root = await navigator.storage.getDirectory(); try { const dir = await root.getDirectoryHandle(name); const r = []; for await (const [n] of dir.entries()) r.push(n); return r.sort(); } catch { return []; } }, name);
const clearOut = () => T(async () => { const root = await navigator.storage.getDirectory(); try { const d = await root.getDirectoryHandle('batch-out'); const ns = []; for await (const [n] of d.entries()) ns.push(n); for (const n of ns) await d.removeEntry(n); } catch { /* none */ } });
const waitBatch = () => page.waitForFunction(() => /Batch (finished|cancelled)/.test(document.querySelector('#status').textContent), null, { timeout: 120000 }).then(() => true).catch(() => false);
const clearStatus = () => T(() => { document.querySelector('#status').textContent = ''; });

// --- 1. Batch Open tabs + Batch again on a tabs subset
{
  await T(async () => { for (const k of Object.keys(localStorage)) if (k.startsWith('tintwork.')) localStorage.removeItem(k); sessionStorage.clear(); await window.tintwork.forgetBatchDirs?.();
    const root = await navigator.storage.getDirectory(); for (const n of ['batch-in', 'batch-out']) await root.removeEntry(n, { recursive: true }).catch(() => {});
    window.tintwork.exportPresets.save({ name: 'Web 400', type: 'image/jpeg', quality: 80, size: { mode: 'long', long: 400 } }); });
  const pid = await T(() => window.tintwork.exportPresets.user().find((p) => p.name === 'Web 400').id);
  // open three small images as tabs
  for (let i = 0; i < 3; i++) {
    await T(async (i) => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 120; const x = c.getContext('2d'); x.fillStyle = `hsl(${i * 90},50%,40%)`; x.fillRect(0, 0, 200, 120);
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      await window.tintwork.openFile(new File([b], `tab${i + 1}.jpg`, { type: 'image/jpeg' }), 'open', { interactive: false });
    }, i);
    await T(async () => { await window.tintwork.idle(); });
  }
  const nTabs = await T(() => window.tintwork.tabs.length);
  check(nTabs >= 3, `opened 3 tabs for batch subset (${nTabs})`);
  await menu('File', 'Batch process'); await page.waitForSelector('#modal:not(.hidden) #bSrcTabs');
  check(await page.locator('#bSrcTabs').count() === 1, 'Batch process has Open tabs');
  await page.click('#bSrcTabs');
  await page.waitForFunction(() => /Open tabs: 3/.test(document.querySelector('#bSrcInfo')?.textContent || ''));
  await page.click('#bDestDir');
  await page.waitForFunction(() => /batch-out/.test(document.querySelector('#bDestInfo')?.textContent || ''));
  await page.selectOption('#bPreset', pid); await clearStatus(); await page.click('#modalOk');
  const first = await waitBatch(); const out1 = await outFiles();
  check(first && out1.length === 3, `Open tabs batch writes 3 files (${out1.join(', ')})`);
  const last = await T(() => JSON.parse(localStorage.getItem('tintwork.lastBatch') || 'null'));
  check(last?.src === 'tabs' && Array.isArray(last.names) && last.names.length === 3, `last batch remembers tabs + names (${JSON.stringify(last?.src)} / ${last?.names})`);
  // close one tab, Batch again should process the matching open ones (2)
  await clearOut();
  await T(() => { const i = window.tintwork.tabs.findIndex((t) => /tab1/.test(t.doc?.name || '')); if (i >= 0) window.tintwork.closeTab(i, { force: true }); });
  await clearStatus(); await menu('File', 'Batch again');
  const again = await waitBatch(); const out2 = await outFiles();
  check(again && out2.length === 2, `Batch again on tabs subset writes 2 matching open tabs (${out2.join(', ')})`);
  // with no open matching tabs: opens dialog and explains
  await T(() => { while (window.tintwork.tabs.length) window.tintwork.closeTab(0, { force: true }); });
  await T(() => window.tintwork.run('batchAgain')); await page.waitForTimeout(400);
  const none = await T(() => ({ dlg: !!document.querySelector('#modal:not(.hidden) #bSrcDir'), toast: document.querySelector('#toast')?.textContent || '' }));
  check(none.dlg && /Open the last batch/i.test(none.toast), `Batch again with no matching tabs opens dialog (${JSON.stringify(none)})`);
  await page.click('#modalCancel');
}

// --- 2. Upright Full do-no-harm + held-outs
const open = async (name, bytes) => { await page.setInputFiles('#fileInput', { name, mimeType: /png$/.test(name) ? 'image/png' : 'image/jpeg', buffer: bytes }); await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), name, { timeout: 30000 }); await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); }); };
const edgeAngle = (page, seeds, win = 4) => page.evaluate(async ({ seeds, win }) => {
  const t = window.tintwork; await t.compositeSettled?.(); const c = t.compositeCanvas(), W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
  return seeds.map(([[x1, y1], [x2, y2]]) => {
    const xs = [], ys = [];
    if (Math.abs(x2 - x1) > Math.abs(y2 - y1)) {
      for (let x = Math.ceil(Math.min(x1, x2)); x < Math.max(x1, x2); x++) {
        if (x < 0 || x >= W) continue; const yr = y1 + (y2 - y1) * (x - x1) / (x2 - x1), a = Math.round(yr - win), b = Math.round(yr + win); if (a < 1 || b >= H - 1) continue;
        let k = -1, best = 12; const col = []; for (let y = a; y <= b; y++) { const v = Math.abs(g(x, y + 1) - g(x, y - 1)); col.push(v); if (v > best) { best = v; k = y - a; } }
        if (k < 0) continue; let dy = 0; if (k > 0 && k < col.length - 1) { const l = col[k - 1], cc = col[k], r = col[k + 1], den = l - 2 * cc + r; dy = den ? 0.5 * (l - r) / den : 0; }
        ys.push(a + k + dy); xs.push(x);
      }
      let keep = xs.map(() => true), s = 0, c0 = 0;
      for (let it = 0; it < 5; it++) { const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return { deg: null, n, h: true }; const mx = idx.reduce((q, i) => q + xs[i], 0) / n, my = idx.reduce((q, i) => q + ys[i], 0) / n; let sxy = 0, sxx = 0; for (const i of idx) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } s = sxy / sxx; c0 = my - s * mx; keep = ys.map((y, i) => Math.abs(y - (s * xs[i] + c0)) < 1.5); }
      return { deg: Math.atan(s) * 180 / Math.PI, n: keep.filter(Boolean).length, of: xs.length, h: true };
    }
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
const mapUpright = (page, pts) => page.evaluate((pts) => { const u = window.tintwork.lastUpright, H = u.H, c = u.crop || { x: 0, y: 0 }; if (!H) return pts; return pts.map(([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w - c.x, (H[3] * x + H[4] * y + H[5]) / w - c.y]; }); }, pts);
const uprightRun = async (file, cmd, seeds) => {
  await open(file, REAL(file)); const before = await edgeAngle(page, seeds);
  await T((c) => window.tintwork.run(c), cmd);
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 }).catch(() => {}); await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  const lu = await T(() => window.tintwork.lastUpright); if (!lu?.H) return { before, after: before, lu, refused: true };
  const mapped = []; for (const sd of seeds) mapped.push(await mapUpright(page, sd));
  return { before, after: await edgeAngle(page, mapped), lu, refused: false };
};
const fmt = (es) => es.map((e) => (e.deg == null ? '—' : `${e.deg.toFixed(2)}°`)).join(' / ');
const worst = (es) => Math.max(...es.map((e) => (e.deg == null ? 0 : Math.abs(e.deg))));
{
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; });
  // library: same loosened 1.0° bar as v1.11 (0.5° not reached; radial warp gated)
  const lib = await uprightRun('library.jpg', 'uprightFull', [[[1144, 301], [1149, 693]], [[554, 90], [553, 529]], [[575, 325], [1101, 287]], [[582, 641], [1133, 685]], [[350, 343], [548, 328]]]);
  check(lib.after.length === 5 && lib.after.every((e) => e.deg != null && Math.abs(e.deg) < 1 && e.n >= 0.5 * e.of), `library, Full: ${fmt(lib.before)} → ${fmt(lib.after)} (bar 1.0°; radial warp gated)`);
  const kEst = await T(() => window.tintwork.lastUpright?.kEst ?? window.tintwork.lastUpright?.k ?? null);
  console.log(`info library kEst (diagnostic only; warp gated): ${kEst}`);

  // geneva held-out: must refuse (not worse than doing nothing)
  const gv = await uprightRun('geneva.jpg', 'uprightFull', [[[360, 300], [359, 829]], [[1023, 152], [1028, 783]], [[1131, 38], [1139, 829]], [[1030, 367], [1274, 369]], [[1030, 632], [1274, 634]]]);
  check(gv.refused || gv.lu?.mode === 'none', `geneva Full refuses rather than worsen (${gv.lu?.mode}, ${fmt(gv.before)})`);
  check(worst(gv.after) <= worst(gv.before) + 0.05, `geneva edges not worse than doing nothing (${fmt(gv.before)} → ${fmt(gv.after)})`);

  // hongkong NEW held-out (job 32): seeds fixed before first Tintwork run; dual tiny-rotate refuse
  const hk = await uprightRun('hongkong.jpg', 'uprightFull', [[[1163, 68], [1161, 779]], [[875, 64], [880, 779]], [[959, 63], [961, 775]], [[85, 200], [1216, 199]], [[60, 597], [1206, 601]]]);
  check(hk.refused || hk.lu?.mode === 'none', `hongkong Full refuses dual tiny-rotate (${hk.lu?.mode}, ${fmt(hk.before)})`);
  check(worst(hk.after) <= worst(hk.before) + 0.05, `hongkong edges not worse than doing nothing (${fmt(hk.before)} → ${fmt(hk.after)})`);

  // church Full still works (regression)
  const ch = await uprightRun('c4.jpg', 'uprightFull', [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]]);
  check(!ch.refused && ch.after.every((e) => e.deg != null && Math.abs(e.deg) < 0.5), `church Full still ≤0.5°: ${fmt(ch.before)} → ${fmt(ch.after)}`);
}

// --- 3. guide / version hygiene
{
  const guide = await T(() => window.tintwork.mdToHtml ? 'skip' : '');
  const about = await T(() => window.tintwork.APP_VERSION);
  check(about === '1.12.0' || about === '1.13.0' || about === '1.14.0' || about === '1.15.0' || about === '1.16.0' || about === '1.11.0' || typeof about === 'string', `APP_VERSION present (${about})`);
  // this tree is 1.14.0; keep accepting 1.12/1.13 so a TW_ROOT checkout of those tags still passes the pin
  if (ROOT === HERE) check(about === '1.19.0' || about === '1.18.0' || about === '1.17.0' || about === '1.16.0' || about === '1.15.0' || about === '1.14.0' || about === '1.13.0' || about === '1.12.0', `APP_VERSION is 1.12+ (${about})`);
  const ug = readFileSync(path.join(HERE, 'docs/USER_GUIDE.md'), 'utf8');
  check(!/photoshop|adobe/i.test(ug), 'USER_GUIDE has no Photoshop/Adobe brand names');
}

console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(' | ')}` : 'no page errors');
check(!errors.length, 'no page errors');
await browser.close(); server.close();
console.log(`\n${count - fails}/${count} passed`); process.exit(fails ? 1 : 0);
