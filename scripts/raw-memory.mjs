// Peak memory of a 24 MP RAW open with different develop worker counts (Linux: reads the renderer's
// /proc/<pid>/smaps_rollup; dedicated and nested workers are threads of the page's renderer process).
// Usage: node scripts/raw-memory.mjs [caps…]    e.g. node scripts/raw-memory.mjs 0 1 2 4 auto
// Prints one JSON line per run: workers, bands, time and peak PSS above the idle page (MB) for the
// whole open (decode + develop) and for the develop after Open.
import { chromium } from 'playwright';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createStaticServer } from './serve.mjs';

const file = process.argv.find((a) => /\.(arw|cr2|cr3|nef|dng|raf|orf|rw2)$/i.test(a)) || 'test-assets/raw-samples/sony-ilce-6000.arw';
const caps = process.argv.slice(2).filter((a) => !/\./.test(a)).map((a) => (a === 'auto' ? null : +a));
if (!caps.length) caps.push(0, 1, 2, 4, null);
const runs = +(process.env.RUNS || 2), BANDS = +(process.env.BANDS || 0);
if (!existsSync(file)) { console.log(`skip: ${file} missing (npm run fetch-raw)`); process.exit(0); }

const pssMB = (pid) => {
  try { const t = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'); return +/^Pss:\s+(\d+)/m.exec(t)[1] / 1024; }
  catch { try { return +/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1] / 1024; } catch { return 0; } }
};
const renderers = () => readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('--type=renderer'); } catch { return false; } });

const server = createStaticServer({ isolated: process.env.ISOLATED === '1' }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const out = [];
for (const cap of caps) for (let k = 0; k < runs; k++) {
  const before = new Set(renderers());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(base); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  await page.evaluate(() => document.querySelector('#welcome .close, #welcomeClose')?.click());
  const mine = renderers().filter((p) => !before.has(p));
  const sample = () => mine.reduce((s, p) => s + pssMB(p), 0);
  await page.evaluate(([c, b]) => window.tintwork.setDevelopEnv({ workerCap: c, bands: b }), [cap, BANDS]);
  await page.waitForTimeout(300);
  const idle = sample(); let peakAll = idle, peakDev = 0, sampling = true;
  const loop = (async () => { while (sampling) { const v = sample(); peakAll = Math.max(peakAll, v); peakDev = Math.max(peakDev, v); await new Promise((r) => setTimeout(r, 15)); } })();
  const t0 = Date.now(); await page.setInputFiles('#fileInput', file);
  await page.waitForFunction(() => window.tintwork.rawUI?.previews >= 1 && window.tintwork.rawUI.idle, null, { timeout: 60000 });
  const tDialog = Date.now() - t0; await page.waitForTimeout(200);
  const dialog = sample(); peakDev = dialog;
  const t1 = Date.now(); await page.click('#modalOk');
  await page.waitForFunction(() => window.tintwork.lastImport?.total && !document.querySelector('.dev-overlay'), null, { timeout: 60000 });
  const tOpen = Date.now() - t1; sampling = false; await loop;
  const li = await page.evaluate(() => window.tintwork.lastImport);
  const dec = await page.evaluate(() => ({ isolated: crossOriginIsolated, decoder: window.tintwork.lastDecoder }));
  const r = { cap: cap ?? 'auto', isolated: dec.isolated, decodeThreads: dec.decoder?.threads ?? null, decode: li.decode, tDialog, workers: li.workers ?? 0, bands: li.bands, tOpen, idleMB: Math.round(idle), dialogMB: Math.round(dialog - idle), peakOpenMB: Math.round(peakAll - idle), peakDevelopMB: Math.round(peakDev - dialog), mp: li.mp };
  out.push(r); console.log(JSON.stringify(r));
  await ctx.close();
}
await browser.close(); server.close();
console.log(`MEMORY_24MP ${JSON.stringify(out)}`);
