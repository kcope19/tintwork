// v1.34.1: other vendors' product names are kept out of the UI and docs.
// A) APP_VERSION and the service-worker cache are 1.34.1.
// B) With a photo open and the Perspective bar showing, no visible text, tooltip (title), aria-label or placeholder
//    anywhere in the page names another editor's vendor or products (the upright "Crop edges" tooltip used to).
// C) The in-app user guide (F1) has none either.
// D) README.md and the docs (read from disk, or fetched from the live site with TW_URL) have none either.
// Technical identifiers such as the PSD MIME type in the file picker's accept list are not text a person reads and
// are not checked. TW_ROOT / TW_URL supported.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
// Case-insensitive brand words, plus the vendor's RAW plug-in name in its exact casing (the generic "camera RAW" is fine).
const hits = (t) => { const m = [...(String(t).match(/photoshop|lightroom|\badobe\b/gi) || []), ...(String(t).match(/Camera Raw\b/g) || [])]; return m.length ? [...new Set(m)].join(', ') : ''; };

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}?platform=win`);
await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
await page.evaluate(() => window.tintwork.engineReady);

const ver = await page.evaluate(() => window.tintwork.APP_VERSION);
check(ver === '1.34.1' || ver === '1.35.0', `APP_VERSION is 1.34.1 (${ver})`);
const swText = process.env.TW_URL ? await (await page.request.get(`${BASE}sw.js`)).text() : readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const sw = swText.match(/tintwork-shell-v([\d.]+)/)?.[1];
check(sw === '1.34.1' || sw === '1.35.0', `SW CACHE is 1.34.1 (${sw})`);

await page.setInputFiles('#fileInput', { name: 'library.jpg', mimeType: 'image/jpeg', buffer: readFileSync(path.join(HERE, 'test-assets/real/library.jpg')) });
await page.waitForFunction(() => window.tintwork.doc?.name === 'library.jpg');
await page.evaluate(() => window.tintwork.idle());
await page.evaluate(() => window.tintwork.run('perspective')); await page.waitForTimeout(300);
const ui = await page.evaluate(() => {
  const parts = [document.body.textContent];
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) parts.push(el.getAttribute('title') || '', el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', el.getAttribute('alt') || '');
  const crop = [...document.querySelectorAll('#optionsbar button')].find((b) => b.textContent.trim() === 'Crop edges');
  return { text: parts.join('\n'), n: parts.length, crop: crop?.title || '' };
});
check(!hits(ui.text), `UI text, tooltips and labels name no other editor (${ui.n} strings; hits: ${hits(ui.text) || 'none'})`);
check(/paid desktop editors/.test(ui.crop) && !hits(ui.crop), `upright "Crop edges" tooltip is neutral ("${ui.crop}")`);
await page.evaluate(() => window.tintwork.run('mxfCancel')); await page.waitForTimeout(200);

await page.keyboard.press('F1');
await page.waitForSelector('#modal:not(.hidden) .help-doc', { timeout: 5000 }).catch(() => {});
const guide = await page.evaluate(() => document.querySelector('.help-doc')?.textContent || '');
check(guide.length > 5000 && !hits(guide), `user guide (F1, ${guide.length} chars) names no other editor (hits: ${hits(guide) || 'none'})`);

for (const f of ['README.md', 'docs/USER_GUIDE.md', 'docs/COMPARISON.md', 'docs/WORKFLOW_BENCHMARK.md', 'docs/AUDIT.md']) {
  const t = process.env.TW_URL ? await (await page.request.get(`${BASE}${f}`)).text() : readFileSync(path.join(ROOT, f), 'utf8');
  check(t.length > 1000 && !hits(t), `${f} (${t.length} chars) names no other editor (hits: ${hits(t) || 'none'})`);
}
const cmp = process.env.TW_URL ? await (await page.request.get(`${BASE}docs/COMPARISON.md`)).text() : readFileSync(path.join(ROOT, 'docs/COMPARISON.md'), 'utf8');
check(/\| Feature \| Subscription RAW editor \| Leading subscription editor \|/.test(cmp), 'COMPARISON table columns use the neutral names');
check(errors.length === 0, `no page errors (${errors.join(' | ') || 'none'})`);

await browser.close(); server.close();
console.log(`\n${count - fails}/${count} checks passed`);
process.exit(fails ? 1 : 0);
