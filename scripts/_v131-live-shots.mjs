// Live-site screenshots for v1.31 (willis now gated, held-outs unchanged, synthetic refuse).
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
if (ver !== '1.31.0') {
  console.error('REFUSING shots; live is', ver);
  process.exit(1);
}

const synthB64 = await page.evaluate(() => {
  const W = 1280, H = 853;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#dce4ee'; g.fillRect(0, 0, W, H);
  const sky = g.createLinearGradient(0, 0, 0, 200);
  sky.addColorStop(0, '#9ec5e8'); sky.addColorStop(1, '#dce4ee');
  g.fillStyle = sky; g.fillRect(0, 0, W, 220);
  const vpV = [640, 40], botY = 840, leftBotX = 180, rightBotX = 1100, facadeTop = 180;
  const interp = (x0, y0, x1, y1, y) => { const t = (y - y0) / (y1 - y0); return [x0 + t * (x1 - x0), y]; };
  const leftAt = (y) => interp(vpV[0], vpV[1], leftBotX, botY, y);
  const rightAt = (y) => interp(vpV[0], vpV[1], rightBotX, botY, y);
  const [ltx, lty] = leftAt(facadeTop), [rtx, rty] = rightAt(facadeTop);
  const [lbx, lby] = leftAt(botY), [rbx, rby] = rightAt(botY);
  g.fillStyle = '#6b5344';
  g.beginPath(); g.moveTo(ltx, lty); g.lineTo(rtx, rty); g.lineTo(rbx, rby); g.lineTo(lbx, lby); g.closePath(); g.fill();
  g.strokeStyle = '#1a120c'; g.lineWidth = 8;
  g.beginPath(); g.moveTo(ltx, lty); g.lineTo(lbx, lby); g.stroke();
  g.beginPath(); g.moveTo(rtx, rty); g.lineTo(rbx, rby); g.stroke();
  g.lineWidth = 4;
  for (const frac of [0.25, 0.5, 0.75]) {
    const bx = leftBotX + frac * (rightBotX - leftBotX);
    const [tx, ty] = interp(vpV[0], vpV[1], bx, botY, facadeTop);
    const [bx2, by2] = interp(vpV[0], vpV[1], bx, botY, botY);
    g.beginPath(); g.moveTo(tx, ty); g.lineTo(bx2, by2); g.stroke();
  }
  for (const y of [250, 400, 550, 700, 820]) {
    const [x1, y1] = leftAt(y), [x2, y2] = rightAt(y);
    g.strokeStyle = '#1a120c'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }
  return c.toDataURL('image/jpeg', 0.92).split(',')[1];
});
const synthBuf = Buffer.from(synthB64, 'base64');

mkdirSync(path.join(HERE, 'screenshots'), { recursive: true });
const shots = [
  ['v131-willis.jpg', '131-live-willis-suggest.png', null],
  ['v131-canyon.jpg', '131-live-canyon-suggest.png', null],
  ['v131-white.jpg', '131-live-white-suggest.png', null],
  ['synth-levelH.jpg', '131-live-synth-refuse.png', synthBuf],
];
for (const [file, shot, buf] of shots) {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: buf || REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await page.evaluate(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
  await page.evaluate(() => window.tintwork.run('guidedUpright'));
  await page.evaluate(() => window.tintwork.applySuggestedGuides(window.tintwork.mxf));
  await page.waitForTimeout(400);
  const dest = path.join(HERE, 'screenshots', shot);
  await page.screenshot({ path: dest });
  const st = await page.evaluate(() => document.getElementById('status')?.textContent);
  console.log(shot, st);
  await page.evaluate(() => window.tintwork.cancelMeshXf?.({ quiet: true }));
}
await browser.close();
