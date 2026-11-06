import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const HERE = '/workspace/photo-editor';
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(HERE, 'scripts/serve.mjs')).href);
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://127.0.0.1:${server.address().port}/?platform=win`);
await page.waitForFunction(() => window.tintwork); await page.evaluate(() => window.tintwork.engineReady);
const T = (fn, arg) => page.evaluate(fn, arg);
const open = async (file) => {
  await page.setInputFiles('#fileInput', { name: file, mimeType: 'image/jpeg', buffer: REAL(file) });
  await page.waitForFunction((n) => window.tintwork.doc?.name?.startsWith(n.replace(/\.[^.]+$/, '')), file, { timeout: 30000 });
  await T(async () => { await window.tintwork.idle(); await window.tintwork.compositeSettled?.(); });
};
async function refuse(file) {
  await open(file);
  await T(() => { window.tintwork.state.opts.uprightEdges = 'crop'; window.tintwork.run('uprightFull'); });
  await page.waitForFunction(() => !window.tintwork.mxf, null, { timeout: 5000 }).catch(() => {});
  return T(() => ({ mode: window.tintwork.lastUpright?.mode, H: !!window.tintwork.lastUpright?.H }));
}
const out = { c4: await refuse('c4.jpg'), geneva: await refuse('geneva.jpg'), hongkong: await refuse('hongkong.jpg'), v117: {} };
for (const f of ['v117-cathedral.jpg','v117-curvy.jpg','v117-flat.jpg','v117-frame.jpg','v117-geo.jpg','v117-interior.jpg','v117-lookup.jpg','v117-lowangle.jpg','v117-station.jpg']) {
  out.v117[f] = await refuse(f);
  console.log(f, out.v117[f]);
}
console.log('gates', { c4: out.c4, geneva: out.geneva, hongkong: out.hongkong });
writeFileSync(path.join(HERE, 'docs/audit/workflows-v123-gates.json'), JSON.stringify(out, null, 2));
await browser.close(); server.close();
