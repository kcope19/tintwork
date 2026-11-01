// Renders the original Tintwork logo (src/logo.svg) into the PNG icons used by the
// web app manifest and iOS "Add to Home Screen". Run: node scripts/make-icons.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const svg = readFileSync(new URL('../src/logo.svg', import.meta.url), 'utf8');
const out = new URL('../icons/', import.meta.url).pathname;
// [file, size, logo scale, background]
const jobs = [
  ['icon-192.png', 192, 0.86, null], ['icon-512.png', 512, 0.86, null],
  ['icon-maskable-512.png', 512, 0.62, '#16171b'], ['apple-touch-icon.png', 180, 0.74, '#16171b'],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, scale, bg] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  const s = Math.round(size * scale);
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${bg || 'transparent'}">
    <div style="width:${s}px;height:${s}px">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</div></body></html>`);
  await page.screenshot({ path: out + file, omitBackground: !bg });
  console.log('wrote icons/' + file);
}
await browser.close();
