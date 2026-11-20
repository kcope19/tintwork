// v1.32: measure Auto upright kept area (crop area / original area) per photo.
// Usage: node scripts/_v132-kept.mjs [--url URL]  (default: local server of this tree)
// Observe-only for v131-canyon / v131-white (held-out): nothing is tuned on these numbers.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { createStaticServer } = await import(pathToFileURL(path.join(HERE, 'scripts/serve.mjs')).href);
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ui = process.argv.indexOf('--url');
const BASE = ui > 0 ? process.argv[ui + 1] : `http://127.0.0.1:${server.address().port}/`;
const photos = (process.env.PHOTOS || 'v128-towers,v130-below,v131-canyon,v131-white,c4').split(',');
const browser = await chromium.launch();
const out = [];
for (const p of photos) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(`${BASE}?platform=win`);
  await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  await page.evaluate(() => window.tintwork.engineReady);
  await page.setInputFiles('#fileInput', { name: `${p}.jpg`, mimeType: 'image/jpeg', buffer: readFileSync(path.join(HERE, 'test-assets/real', `${p}.jpg`)) });
  await page.waitForFunction(() => window.tintwork.doc?.layers?.length);
  const r = await page.evaluate(async () => {
    const t = window.tintwork, W0 = t.doc.width, H0 = t.doc.height;
    t.state.opts.uprightAsk = false; // v1.32+: no dialog in this measurement (ignored by v1.31)
    const u = t.autoUprightCmd('auto'); if (u?.applyP) await u.applyP;
    return { W0, H0, W: t.doc.width, H: t.doc.height, mode: u?.mode, kept: t.lastUpright?.kept ?? null, hist: t.history.entries.map((e) => e.label) };
  });
  r.photo = p; r.keptArea = Math.round((r.W * r.H) / (r.W0 * r.H0) * 1000) / 10; out.push(r);
  console.log(JSON.stringify(r));
  await page.context().close();
}
await browser.close(); server.close();
