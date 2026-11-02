import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader'] }); const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
p.on('pageerror', (e) => console.log('pageerror', e.message)); p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.text().slice(0, 300)); });
await p.goto('http://127.0.0.1:8080/'); await p.waitForFunction(() => window.tintwork);
console.log(await p.evaluate(async () => { const t = window.tintwork; await t.engineReady; const r = { autoEngine: t.engine?.kind || 'cpu', reason: t.gfx.reason, wr: t.gfx.webgpuReason };
  const e = await t.setEnginePref('webgpu'); r.forced = e?.kind; r.present = e?.present; r.info = document.querySelector('#docinfo').textContent;
  t.newDocument(800, 600, 'white', 'x'); r.px = await t.compositePixelAsync(10, 10); r.path = t.gfx.path; r.frames = t.gfx.asyncFrames;
  return JSON.stringify(r); }));
await b.close();
