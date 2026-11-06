// v1.25: upright/perspective UX — Plumb refuse reason+median/worst; Apply Lens+Full one undo;
// panel keys/tooltips/Enter; docs in-sample caveat. TW_ROOT / TW_URL supported.
import { chromium, webkit } from 'playwright';
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

{
  try {
    const b = await webkit.launch();
    const p = await b.newPage();
    await p.goto('about:blank');
    const ua = await p.evaluate(() => navigator.userAgent);
    check(/WebKit/i.test(ua), `WebKit launches (${ua.slice(0, 60)}…)`);
    await b.close();
  } catch (e) {
    check(false, `WebKit launches (${e.message.slice(0, 80)})`);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}?platform=win`);
await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));

check(await T(() => window.tintwork.APP_VERSION) === '1.25.0', `APP_VERSION is 1.25.0 (${await T(() => window.tintwork.APP_VERSION)})`);
{
  const swText = await page.evaluate(async (base) => (await fetch(new URL('sw.js', base), { cache: 'no-store' })).text(), BASE);
  const m = /tintwork-shell-v([\d.]+)/.exec(swText);
  check(m?.[1] === '1.25.0', `SW CACHE is 1.25.0 (${m?.[1]})`);
}

const open = async (file, as = file) => {
  await page.setInputFiles('#fileInput', { name: as, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), as, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};

{
  const api = await T(() => ({
    thenFull: typeof window.tintwork.applyLensThenFullFromMxf === 'function',
    refuse: typeof window.tintwork.plumbRefuseStatus === 'function',
    cmds: !!(window.tintwork.cmds.mxfLensApplyFull && window.tintwork.cmds.mxfLensApply),
  }));
  check(api.thenFull && api.refuse && api.cmds, `v1.25 APIs/cmds present (${JSON.stringify(api)})`);
}

// Docs from disk (serve.mjs does not expose /docs/)
{
  const guide = readFileSync(path.join(HERE, 'docs/USER_GUIDE.md'), 'utf8');
  const g = {
    table: /When each mode works|Refuses when/i.test(guide),
    plumb: /check-set median|worst/i.test(guide),
    lensFull: /Apply Lens \+ Full/i.test(guide),
  };
  check(g.table && g.plumb && g.lensFull, `USER_GUIDE perspective when-works/refuses + Lens+Full (${JSON.stringify(g)})`);
}
{
  const bare = [];
  for (const [name, file] of [['README', 'README.md'], ['WORKFLOW', 'docs/WORKFLOW_BENCHMARK.md']]) {
    const text = readFileSync(path.join(HERE, file), 'utf8');
    const re = /0\.73°/g; let m;
    while ((m = re.exec(text))) {
      const ctx = text.slice(Math.max(0, m.index - 80), m.index + 40);
      if (/horizontals\s+0\.73/i.test(ctx)) continue;
      if (!/library/i.test(ctx) && !/Distortion/i.test(ctx) && !/cited library/i.test(ctx)) continue;
      if (!/in-sample/i.test(ctx) && !/held-out/i.test(ctx)) bare.push(`${name}:${ctx.replace(/\s+/g, ' ').trim().slice(-90)}`);
    }
  }
  check(bare.length === 0, `0.73° cites carry in-sample/held-out caveat (bare=${JSON.stringify(bare)})`);
}

// Panel: Distortion≠0 shows Apply Lens + Full; default focus Full
{
  await open('c4.jpg', 'c4-panel-v125.jpg');
  await T(() => window.tintwork.run('perspective'));
  const before = await T(() => ({
    fullBtn: !!document.querySelector('#optionsbar [data-cmd="mxfLensApplyFull"]'),
    tip: document.querySelector('#optionsbar [data-cmd="uprightFull"]')?.title || '',
    focus: document.activeElement?.getAttribute?.('data-cmd') || '',
  }));
  check(!before.fullBtn, `Distortion 0: no Apply Lens + Full button`);
  check(/Full \(F\)|Refuses when/i.test(before.tip), `Full tooltip mentions key/refuse (${before.tip.slice(0, 80)})`);
  check(before.focus === 'uprightFull', `default focus Full (focus=${before.focus})`);

  // Cross 0→10 via input so syncLens rebuilds the bar
  await page.evaluate(() => {
    const x = window.tintwork.mxf;
    x.lensSlider = 0;
    const r = document.querySelector('#mxfLensDist');
    r.value = '10';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const after = await T(() => ({
    fullBtn: !!document.querySelector('#optionsbar [data-cmd="mxfLensApplyFull"]'),
    primary: document.querySelector('#optionsbar [data-cmd="mxfLensApplyFull"]')?.classList.contains('primary'),
    hint: document.querySelector('#optionsbar .muted')?.textContent || '',
  }));
  check(after.fullBtn && after.primary, `Distortion ≠ 0: Apply Lens + Full primary (fullBtn=${after.fullBtn})`);
  check(/Apply Lens \+ Full|Enter = Apply Lens/i.test(after.hint), `hint mentions Enter = Lens + Full (${after.hint.slice(0, 100)})`);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
}

// Plumb refuse status includes reason + median/worst
{
  await open('library.jpg', 'lib-plumb-v125.jpg');
  await T(() => window.tintwork.run('perspective'));
  const r = await T(() => {
    const x = window.tintwork.mxf;
    x.plumbs = [[[554, 90], [553, 529]], [[1144, 301], [1149, 693]], [[350, 343], [548, 328]]];
    window.tintwork.solvePlumbOnMxf(x);
    const status = document.getElementById('status')?.textContent || '';
    return {
      slider: x.lensSlider,
      reason: x.plumbMeta?.refined?.reason,
      status,
      hasMed: /median\s+[\d.]+°/i.test(status),
      hasWorst: /worst\s+[\d.]+°/i.test(status),
    };
  });
  check(r.slider === 0, `library plumb still Distortion 0 (reason=${r.reason})`);
  check(/No reliable lens bend found:/i.test(r.status), `plumb refuse has plain-language colon reason (${r.status.slice(0, 120)})`);
  check(r.hasMed && r.hasWorst, `plumb refuse includes median and worst (med=${r.hasMed}, worst=${r.hasWorst})`);
  await T(() => window.tintwork.cancelMeshXf({ quiet: true }));
}

// Apply Lens + Full = one history entry; undo/redo
{
  await open('library.jpg', 'lib-lensfull-v125.jpg');
  const h0 = await T(() => window.tintwork.history.index);
  await T(() => {
    window.tintwork.state.opts.uprightEdges = 'crop';
    window.tintwork.run('perspective');
    const x = window.tintwork.mxf; x.lensSlider = 10; window.tintwork.previewLensOnMxf(x);
  });
  await T(async () => { await window.tintwork.applyLensThenFullFromMxf(); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 20000 });
  const after = await T((h0) => {
    const h = window.tintwork.history;
    const labels = h.entries.slice(h0 + 1, h.index + 1).map((e) => e.label);
    return { labels, label: h.entries[h.index]?.label, indexDelta: h.index - h0, mode: window.tintwork.lastUpright?.mode };
  }, h0);
  check(after.mode && after.mode !== 'none', `Lens+Full applied (mode=${after.mode})`);
  check(after.label === 'Lens + Full', `single History label Lens + Full (label=${after.label}, labels=${JSON.stringify(after.labels)})`);
  check(after.indexDelta === 1, `exactly one History step after Lens+Full (delta=${after.indexDelta})`);

  await T(() => window.tintwork.undo());
  const undone = await T((h0) => window.tintwork.history.index === h0, h0);
  check(undone === true, `one Undo restores pre-Lens+Full`);

  await T(() => window.tintwork.redo());
  const redone = await T(() => window.tintwork.history.entries[window.tintwork.history.index]?.label);
  check(redone === 'Lens + Full', `Redo restores Lens + Full (label=${redone})`);
}

// Full refuse plain language (geneva)
{
  await open('geneva.jpg', 'geneva-refuse-v125.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 5000 }).catch(() => {});
  const r = await T(() => ({
    mode: window.tintwork.lastUpright?.mode,
    status: document.getElementById('status')?.textContent || '',
    mxf: !!window.tintwork.mxf,
  }));
  check(!r.mxf && r.mode === 'none', `geneva Full still refuses (mode=${r.mode})`);
  check(/refused|already|Guides|worse|uncertain|nearly level/i.test(r.status), `geneva refuse plain language (${r.status.slice(0, 140)})`);
}

// c4 Full ≤0.5° quality pin
{
  const seeds = [[[124, 446], [15, 1774]], [[543, 277], [541, 547]], [[935, 492], [968, 996]]];
  await open('c4.jpg', 'c4-full-v125.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  const w = await page.evaluate(async ({ seeds }) => {
    const t = window.tintwork; await t.compositeSettled?.();
    const u = t.lastUpright, H = u?.H, c = u?.crop || { x: 0, y: 0 };
    const map = (pts) => pts.map(([x, y]) => {
      if (!H) return [x, y];
      const w = H[6] * x + H[7] * y + H[8];
      return [(H[0] * x + H[1] * y + H[2]) / w - c.x, (H[3] * x + H[4] * y + H[5]) / w - c.y];
    });
    const canvas = t.compositeCanvas(), W = canvas.width, Ht = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, W, Ht).data;
    const g = (x, y) => 0.299 * d[(y * W + x) * 4] + 0.587 * d[(y * W + x) * 4 + 1] + 0.114 * d[(y * W + x) * 4 + 2];
    const edge = ([[x1, y1], [x2, y2]]) => {
      const xs = [], ys = []; const win = 4;
      for (let y = Math.ceil(Math.min(y1, y2)); y < Math.max(y1, y2); y++) {
        if (y < 0 || y >= Ht) continue;
        const xr = x1 + (x2 - x1) * (y - y1) / (y2 - y1), a = Math.round(xr - win), b = Math.round(xr + win);
        if (a < 1 || b >= W - 1) continue;
        let k = -1, best = 12;
        for (let x = a; x <= b; x++) { const v = Math.abs(g(x + 1, y) - g(x - 1, y)); if (v > best) { best = v; k = x; } }
        if (k < 0) continue; xs.push(k); ys.push(y);
      }
      if (xs.length < 10) return null;
      let s = 0, keep = xs.map(() => true);
      for (let it = 0; it < 5; it++) {
        const idx = xs.map((_, i) => i).filter((i) => keep[i]); const n = idx.length; if (n < 10) return null;
        const my = idx.reduce((q, i) => q + ys[i], 0) / n, mx = idx.reduce((q, i) => q + xs[i], 0) / n;
        let sxy = 0, syy = 0; for (const i of idx) { sxy += (ys[i] - my) * (xs[i] - mx); syy += (ys[i] - my) ** 2; }
        s = sxy / (syy || 1); keep = xs.map((x, i) => Math.abs(x - (s * ys[i] + mx - s * my)) < 1.5);
      }
      return Math.atan(s) * 180 / Math.PI;
    };
    const degs = seeds.map((sd) => edge(map(sd))).filter((d) => d != null).map(Math.abs);
    return degs.length ? Math.max(...degs) : null;
  }, { seeds });
  check(w != null && w <= 0.5, `c4 Full ≤0.5° pin (w=${w?.toFixed?.(2)})`);
}

// Letter key F while panel open
{
  await open('c4.jpg', 'c4-key-v125.jpg');
  await T(() => { window.tintwork.state.opts.uprightEdges = 'keep'; window.tintwork.run('perspective'); });
  await page.locator('#viewport').click({ position: { x: 20, y: 20 } }).catch(() => {});
  await page.keyboard.press('f');
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 });
  const mode = await T(() => window.tintwork.lastUpright?.mode);
  check(mode && mode !== 'none', `key F runs Full while panel open (mode=${mode})`);
}

// Global shortcut Ctrl+Alt+Shift+F
{
  await open('c4.jpg', 'c4-chord-v125.jpg');
  const h0 = await T(() => window.tintwork.history.index);
  await page.locator('#viewport').click({ position: { x: 20, y: 20 } }).catch(() => {});
  await page.keyboard.press('Control+Alt+Shift+KeyF');
  await page.waitForFunction((h0) => window.tintwork.history.index > h0 || window.tintwork.lastUpright?.mode, h0, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 15000 }).catch(() => {});
  const r = await T((h0) => ({ mode: window.tintwork.lastUpright?.mode, delta: window.tintwork.history.index - h0 }), h0);
  check(r.mode && r.mode !== 'none' && r.delta >= 1, `Ctrl+Alt+Shift+F runs Full (mode=${r.mode}, delta=${r.delta})`);
}

check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ') || 'none'})`);

console.log(`\n${count - fails}/${count} passed`);
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
