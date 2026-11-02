// Desktop keyboard/platform test: Windows-style labels and shortcuts in Chromium (Chrome/Edge engine), Mac labels in desktop WebKit.
import { chromium, webkit } from 'playwright';
import { createStaticServer } from './serve.mjs';
const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

async function run(name, bt, platform, mod) {
  const browser = await bt.launch(); const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?platform=${platform}`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete');
  const p = `[${name}/${platform}]`;
  const labels = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.menu-items button')].map((b) => [b.dataset.cmd, b.querySelector('kbd')?.textContent || ''])));
  if (platform === 'mac') {
    check(labels.undo === '⌘Z' && labels.redo === '⇧⌘Z' && labels.refineEdge === '⌥⌘R', `${p} menu labels use ⌘ ⌥ ⇧ (${labels.undo}, ${labels.redo}, ${labels.refineEdge})`);
    check(labels.new === '⌥⌘N' && labels.freeTransform === '⌥⌘T' && labels.curves === '⇧⌘M', `${p} reserved ⌘N/⌘T/⌘M replaced by alternates (${labels.new}, ${labels.freeTransform}, ${labels.curves})`);
  } else {
    check(labels.undo === 'Ctrl+Z' && labels.redo === 'Ctrl+Shift+Z' && labels.refineEdge === 'Ctrl+Alt+R', `${p} menu labels use Ctrl/Alt/Shift (${labels.undo}, ${labels.redo}, ${labels.refineEdge})`);
    check(labels.new === 'Ctrl+Alt+N' && labels.layerNew === 'Ctrl+Alt+Shift+N' && labels.freeTransform === 'Ctrl+Alt+T' && labels.invertSelection === 'Shift+F7',
      `${p} browser-reserved Ctrl+N / Ctrl+Shift+N / Ctrl+T / Ctrl+Shift+I replaced by alternates (${labels.new}, ${labels.layerNew}, ${labels.freeTransform}, ${labels.invertSelection})`);
  }
  const tips = await page.evaluate(() => ({ tool: document.querySelector('[data-tool="clone"]').title, layer: document.querySelector('#layersPanel [data-cmd="layerNew"], [data-cmd="layerNew"][title]')?.title }));
  check(platform === 'mac' ? /⌥-click/.test(tips.tool) && /⌥⇧⌘N/.test(tips.layer) : /Alt\+click/.test(tips.tool) && /Ctrl\+Alt\+Shift\+N/.test(tips.layer), `${p} tooltips: "${tips.tool}", "${tips.layer}"`);
  // shortcuts with the platform's primary modifier
  await page.evaluate(() => { window.tintwork.newDocument(200, 120, 'white', 'kb'); });
  const layers = () => page.evaluate(() => window.tintwork.doc.layers.length);
  const n0 = await layers();
  await page.keyboard.press(`${mod}+Alt+Shift+KeyN`); check(await layers() === n0 + 1, `${p} ${mod}+Alt+Shift+N adds a layer`);
  await page.keyboard.press(`${mod}+KeyZ`); check(await layers() === n0, `${p} ${mod}+Z undoes`);
  await page.keyboard.press(platform === 'mac' ? 'Meta+Shift+KeyZ' : 'Control+KeyY'); check(await layers() === n0 + 1, `${p} ${platform === 'mac' ? '⇧⌘Z' : 'Ctrl+Y'} redoes`);
  const other = platform === 'mac' ? 'Control' : 'Meta';
  await page.keyboard.press(`${other}+KeyZ`); check(await layers() === n0 + 1, `${p} ${other}+Z (not the primary modifier here) is ignored`);
  await page.evaluate(() => { const t = window.tintwork; t.doc.activeId = t.doc.layers[0].id; });
  await page.keyboard.press(`${mod}+Alt+KeyT`); check(await page.evaluate(() => !!window.tintwork.state.xf), `${p} ${mod}+Alt+T starts free transform`); await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Slash'); await page.waitForTimeout(100);
  const kb = await page.evaluate(() => ({ t: document.querySelector('#kbTable')?.textContent || '', n: document.querySelector('#kbNote')?.textContent || '' }));
  check(platform === 'mac' ? kb.t.includes('⌘Z') && !kb.t.includes('Ctrl') && kb.n.includes('⌘ Command') : kb.t.includes('Ctrl+Z') && !kb.t.includes('⌘') && kb.n.includes('Windows'), `${p} shortcuts dialog shows platform keys`);
  await page.screenshot({ path: `screenshots/4x-shortcuts-${platform}.png` });
  check(!errors.length, `${p} no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
}
await run('chromium', chromium, 'win', 'Control');
await run('webkit', webkit, 'mac', 'Meta');
await run('webkit', webkit, 'win', 'Control');
server.close();
console.log(fails ? `\n${fails} desktop platform check(s) FAILED` : '\nAll desktop platform checks passed.');
process.exit(fails ? 1 : 0);
