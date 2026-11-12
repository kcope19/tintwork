// Live-site screenshots for v1.28 (glass mixed Suggest, plus a couple of regression shots).
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const BASE = process.env.TW_URL || 'https://kcope19.github.io/tintwork/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}?platform=win&_=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.tintwork);
await page.evaluate(() => window.tintwork.engineReady);
const ver = await page.evaluate(() => window.tintwork.APP_VERSION);
console.log('live APP_VERSION', ver);

const shots = [
  ['v126-glass.jpg', '128-live-glass-suggest.png'],
  ['v126-city.jpg', '128-live-city-suggest.png'],
  ['v117-cathedral.jpg', '128-live-cathedral-suggest.png'],
  ['v117-interior.jpg', '128-live-interior-suggest.png'],
];
mkdirSync(path.join(HERE, 'screenshots'), { recursive: true });
for (const [file, shot] of shots) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await page.evaluate(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await page.evaluate(() => window.tintwork.run('guidedUpright'));
  await page.evaluate(() => window.tintwork.applySuggestedGuides(window.tintwork.mxf));
  await page.waitForTimeout(400);
  const dest = path.join(HERE, 'screenshots', shot);
  await page.screenshot({ path: dest });
  const st = await page.evaluate(() => document.getElementById('status')?.textContent);
  console.log(shot, st);
  await page.evaluate(() => window.tintwork.cancelMeshXf({ quiet: true }));
}
await browser.close();
