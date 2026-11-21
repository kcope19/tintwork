// axe-core accessibility audit (dev tool; axe-core is a devDependency and is never shipped to the site).
// Usage: node scripts/a11y-audit.mjs [label]   TW_URL=<site> audits a deployed site, otherwise a local static server.
// States: desktop 1366×768 welcome, desktop with a photo open, desktop Curves dialog, iPhone 13 (WebKit) with a photo
// open in Crop. Prints violations by impact and writes docs/audit/a11y-<label>.json.
import { chromium, webkit, devices } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const label = process.argv[2] || 'run';
const axeSrc = readFileSync(path.join(HERE, 'node_modules/axe-core/axe.min.js'), 'utf8');
const { createStaticServer } = await import(pathToFileURL(path.join(HERE, 'scripts/serve.mjs')).href);
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;
const photo = readFileSync(path.join(HERE, 'test-assets/real/v126-city.jpg'));

async function axe(page) {
  await page.addScriptTag({ content: axeSrc });
  return page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })));
}
async function load(browserType, ctxOpts) {
  const b = await browserType.launch(); const ctx = await b.newContext({ ...ctxOpts, bypassCSP: true });
  const page = await ctx.newPage(); await page.goto(`${BASE}?platform=win`);
  await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  await page.evaluate(() => window.tintwork.engineReady); return { b, page };
}
async function openPhoto(page) {
  await page.setInputFiles('#fileInput', { name: 'city.jpg', mimeType: 'image/jpeg', buffer: photo });
  await page.waitForFunction(() => window.tintwork.doc?.name === 'city.jpg', null, { timeout: 30000 });
  await page.waitForTimeout(300);
}
const out = {};
{
  const { b, page } = await load(chromium, { viewport: { width: 1366, height: 768 } });
  out.welcome = await axe(page);
  await openPhoto(page); out.docOpen = await axe(page);
  await page.keyboard.press('Control+m'); await page.waitForSelector('#modal:not(.hidden)'); await page.waitForTimeout(200);
  out.curvesDialog = await axe(page); await b.close();
}
{
  const { b, page } = await load(webkit, { ...devices['iPhone 13'] });
  await openPhoto(page); await page.evaluate(() => window.tintwork.setTool?.('crop'));
  await page.waitForTimeout(200); out.mobileCrop = await axe(page); await b.close();
}
server.close();
const summary = {};
for (const [k, vs] of Object.entries(out)) {
  summary[k] = { critical: vs.filter((v) => v.impact === 'critical').length, serious: vs.filter((v) => v.impact === 'serious').length, total: vs.length };
  console.log(`${k}: ${vs.length} violation types — ${vs.map((v) => `${v.id}(${v.impact}, ${v.nodes})`).join(', ') || 'none'}`);
}
const uniq = (imp) => [...new Set(Object.values(out).flat().filter((v) => v.impact === imp).map((v) => v.id))];
console.log(`UNIQUE serious: ${uniq('serious').join(', ') || 'none'} | critical: ${uniq('critical').join(', ') || 'none'}`);
writeFileSync(path.join(HERE, `docs/audit/a11y-${label}.json`), JSON.stringify({ base: BASE, axe: JSON.parse(readFileSync(path.join(HERE, 'node_modules/axe-core/package.json'), 'utf8')).version, date: new Date().toISOString(), summary, violations: out }, null, 1));
