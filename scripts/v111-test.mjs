// v1.11 test: non-AI polish from the v1.10 audit.
//  - Batch remembers its source and output folders between sessions (handles in IndexedDB, permission asked again)
//  - File ▸ Batch again repeats the last batch; files or a folder can be dropped onto the Batch dialog
//  - Upright Full on real photos (see section 2)
// TW_ROOT=/path/to/other/checkout runs the same checks against another tree (used to confirm they fail on v1.10.0).
// TW_URL=https://… runs the app checks against a deployed site.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = process.env.TW_ROOT ? path.resolve(process.env.TW_ROOT) : HERE;
const REAL = (f) => readFileSync(path.join(HERE, 'test-assets/real', f));
const { createStaticServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/serve.mjs')).href);
let fails = 0, count = 0; const check = (ok, msg) => { count++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

const server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.TW_URL || `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  // folder pickers → OPFS folders; sessionStorage 'perm' simulates a new browser session ('prompt' → the permission
  // must be asked again; the answer is sessionStorage 'answer', default 'granted')
  const W = (window.__pick = { dir: 0, req: [] });
  window.showDirectoryPicker = async (o) => { W.dir++; const root = await navigator.storage.getDirectory(); const name = o?.mode === 'read' ? 'batch-in' : (sessionStorage.getItem('destName') || 'batch-out'); return root.getDirectoryHandle(name, { create: true }); };
  const H = window.FileSystemHandle?.prototype;
  if (H) {
    const q = H.queryPermission;
    H.queryPermission = async function (d) { if (sessionStorage.getItem('perm') === 'prompt' && !W.granted?.has(`${this.name}:${d?.mode}`)) return 'prompt'; return q ? q.call(this, d) : 'granted'; };
    H.requestPermission = async function (d) { W.req.push(`${this.name}:${d?.mode}`); const a = sessionStorage.getItem('answer') || 'granted'; if (a === 'granted') (W.granted ||= new Set()).add(`${this.name}:${d?.mode}`); return a; };
  }
});
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const load = async () => { await page.goto(`${BASE}?platform=win`); await page.waitForFunction(() => window.tintwork && document.readyState === 'complete'); await page.evaluate(() => window.tintwork.engineReady); };
await load();
const T = (fn, arg) => page.evaluate(fn, arg).catch((e) => ({ error: e.message }));
const menu = async (title, item) => { await page.locator('#menus .menu > button', { hasText: new RegExp(`^${title}$`) }).click(); await page.locator('#menus .menu.open .menu-items button', { hasText: item }).first().click(); };
const outFiles = (name = 'batch-out') => T(async (name) => { const root = await navigator.storage.getDirectory(); try { const dir = await root.getDirectoryHandle(name); const r = []; for await (const [n] of dir.entries()) r.push(n); return r.sort(); } catch { return []; } }, name);
const clearOut = () => T(async () => { const root = await navigator.storage.getDirectory(); try { const d = await root.getDirectoryHandle('batch-out'); const ns = []; for await (const [n] of d.entries()) ns.push(n); for (const n of ns) await d.removeEntry(n); } catch { /* none */ } }); // empties the folder (keeps it, so its stored handle stays valid)
const waitBatch = () => page.waitForFunction(() => /Batch (finished|cancelled)/.test(document.querySelector('#status').textContent), null, { timeout: 120000 }).then(() => true).catch(() => false);
const clearStatus = () => T(() => { document.querySelector('#status').textContent = ''; });

// --- 1. remembered folders, Batch again, drop
{
  await T(async () => { for (const k of Object.keys(localStorage)) if (k.startsWith('tintwork.')) localStorage.removeItem(k); sessionStorage.clear(); await window.tintwork.forgetBatchDirs?.();
    const root = await navigator.storage.getDirectory(); for (const n of ['batch-in', 'batch-out']) await root.removeEntry(n, { recursive: true }).catch(() => {});
    const dir = await root.getDirectoryHandle('batch-in', { create: true });
    for (let i = 0; i < 4; i++) { const c = new OffscreenCanvas(1200, 800), x = c.getContext('2d'); x.fillStyle = `hsl(${i * 80},40%,45%)`; x.fillRect(0, 0, 1200, 800); const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 }); const w = await (await dir.getFileHandle(`p${i + 1}.jpg`, { create: true })).createWritable(); await w.write(b); await w.close(); }
    window.tintwork.exportPresets.save({ name: 'Web 600', type: 'image/jpeg', quality: 80, size: { mode: 'long', long: 600 } }); });
  const pid = await T(() => window.tintwork.exportPresets.user().find((p) => p.name === 'Web 600').id);
  // first run: pick both folders
  await menu('File', 'Batch process'); await page.waitForSelector('#modal:not(.hidden) #bSrcDir');
  const hasDest = await page.locator('#bDestDir').count();
  check(hasDest === 1, 'Batch process has an Output folder row');
  await page.click('#bSrcDir'); await page.waitForFunction(() => /4 image/.test(document.querySelector('#bSrcInfo')?.textContent || ''));
  await page.selectOption('#bPreset', pid); await clearStatus(); await page.click('#modalOk');
  const first = await waitBatch(); const out1 = await outFiles();
  check(first && out1.length === 4, `first batch writes 4 files (${out1.join(', ')})`);
  // same session, dialog again: both folders remembered, Run is the only click
  await clearOut(); const before = await T(() => window.__pick.dir);
  await menu('File', 'Batch process'); await page.waitForSelector('#modal:not(.hidden) #bSrcDir');
  await page.waitForFunction(() => /4 images in “batch-in”/.test(document.querySelector('#bSrcInfo')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const shown = await T(() => [document.querySelector('#bSrcInfo')?.textContent, document.querySelector('#bDestInfo')?.textContent]);
  check(/4 images in “batch-in”/.test(shown[0]) && /batch-out.*last used/.test(shown[1] || ''), `the dialog shows the remembered folders (${JSON.stringify(shown)})`);
  await clearStatus(); await page.click('#modalOk'); const second = await waitBatch(); const out2 = await outFiles(); const pickers = (await T(() => window.__pick.dir)) - before;
  check(second && out2.length === 4 && pickers === 0, `second run: Run batch only, no folder pickers (${out2.length} files, ${pickers} pickers)`);

  // new session (reload; permissions forgotten): File ▸ Batch again asks once per folder, no pickers
  await clearOut(); await T(() => sessionStorage.setItem('perm', 'prompt')); await load();
  const hasItem = await page.locator('#menus .menu-items button[data-cmd="batchAgain"]').count();
  check(hasItem === 1, 'File menu has Batch again (last settings)');
  if (hasItem) {
    await clearStatus(); await menu('File', 'Batch again'); const again = await waitBatch(); const out3 = await outFiles();
    const r = await T(() => ({ req: window.__pick.req, dir: window.__pick.dir, prompts: window.tintwork.lastBatchPrompts }));
    check(again && out3.length === 4 && out3.every((n) => /^p\d-edited\.jpg$/.test(n)), `new session: Batch again writes the 4 files with the last settings (${out3.join(', ')})`);
    check(r.dir === 0 && r.req.join() === 'batch-in:read,batch-out:readwrite' && r.prompts === 2, `…asking for read on the source and write on the output, no pickers (${JSON.stringify(r)})`);
    const sz = await T(async () => { const root = await navigator.storage.getDirectory(), d = await root.getDirectoryHandle('batch-out'); const b = await createImageBitmap(await (await d.getFileHandle('p1-edited.jpg')).getFile()); return [b.width, b.height]; });
    check(sz.join() === '600,400', `…at the last preset's size (${sz})`);
    // permission denied: nothing written, no picker
    await clearOut(); await T(() => sessionStorage.setItem('answer', 'denied')); await load(); await clearStatus();
    await menu('File', 'Batch again'); await page.waitForTimeout(1500);
    const den = await T(() => ({ dir: window.__pick.dir, toast: document.querySelector('#toast')?.textContent || '' })); const out4 = await outFiles();
    check(out4.length === 0 && den.dir === 0 && /permission/i.test(den.toast), `permission denied: nothing written, says why (${JSON.stringify(den)})`);
    await T(() => { sessionStorage.removeItem('answer'); sessionStorage.removeItem('perm'); }); await load();
    // output folder deleted since: falls back to the picker instead of failing every file
    await T(async () => { const root = await navigator.storage.getDirectory(); await root.removeEntry('batch-out', { recursive: true }).catch(() => {}); });
    await clearStatus(); await menu('File', 'Batch again'); const gone = await waitBatch(); const out5 = await outFiles(); const p5 = await T(() => window.__pick.dir);
    check(gone && out5.length === 4 && p5 === 1, `a deleted output folder: asks for a folder once and writes 4 files (${out5.length} files, ${p5} picker)`);
    // the output folder is the source folder: a repeat does not process its own outputs
    await T(() => sessionStorage.setItem('destName', 'batch-in'));
    await menu('File', 'Batch process'); await page.waitForSelector('#modal:not(.hidden) #bDestDir'); await page.click('#bDestDir');
    await page.waitForFunction(() => /batch-in/.test(document.querySelector('#bDestInfo')?.textContent || ''));
    await clearStatus(); await page.click('#modalOk'); await waitBatch();
    await clearStatus(); await menu('File', 'Batch again'); await waitBatch();
    const inside = await outFiles('batch-in');
    check(inside.length === 8 && !inside.some((n) => /edited-edited/.test(n)), `same folder in and out: a repeat processes only the 4 originals (${inside.join(', ')})`);
    await T(() => sessionStorage.removeItem('destName'));
  }
  // drop files onto the open dialog: they become the source; nothing is opened as a document
  await T(async () => { await window.tintwork.forgetBatchDirs?.(); localStorage.removeItem('tintwork.lastBatch'); });
  await load();
  await menu('File', 'Batch process'); await page.waitForSelector('#modal:not(.hidden) #bSrcDir');
  const tabsBefore = await T(() => window.tintwork.tabs.length);
  await T(async () => { const dt = new DataTransfer(); for (let i = 0; i < 3; i++) { const c = new OffscreenCanvas(40, 30); c.getContext('2d').fillRect(0, 0, 40, 30); dt.items.add(new File([await c.convertToBlob({ type: 'image/png' })], `d${i}.png`, { type: 'image/png' })); } dt.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    document.querySelector('#modalBody').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); });
  await page.waitForTimeout(500);
  const dropped = await T(() => ({ info: document.querySelector('#bSrcInfo')?.textContent, tabs: window.tintwork.tabs.length, open: !document.querySelector('#modal').classList.contains('hidden') }));
  check(/^3 images/.test(dropped.info || '') && dropped.tabs === tabsBefore && dropped.open, `dropping 3 images and a text file on the dialog: 3 images become the source, none opens (${JSON.stringify(dropped)})`);
  await page.click('#modalCancel');
  // Batch again with nothing to repeat opens the dialog and says why
  await T(() => window.tintwork.run('batchAgain')); await page.waitForTimeout(300);
  const none = await T(() => ({ dlg: !!document.querySelector('#modal:not(.hidden) #bSrcDir'), toast: document.querySelector('#toast')?.textContent || '' }));
  check(none.dlg && /once first/.test(none.toast), `Batch again with no earlier folder run opens Batch process and explains (${JSON.stringify(none)})`);
  await page.click('#modalCancel');
}

//@@UPRIGHT@@

console.log(errors.length ? `page errors: ${errors.slice(0, 3).join(' | ')}` : 'no page errors');
check(!errors.length, 'no page errors');
await browser.close(); server.close();
console.log(`\n${count - fails}/${count} passed`); process.exit(fails ? 1 : 0);
