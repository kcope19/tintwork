// Tintwork data-safety / privacy / keyboard audit (Chromium, Windows layout). Run: node scripts/safety-audit.mjs [url] [--json out.json]
// Each check runs on a fresh page load. Local by default (a static server on a random port), or pass a URL.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createStaticServer } from './serve.mjs';

const argUrl = process.argv.slice(2).find((a) => /^https?:/.test(a));
let server = null, BASE = argUrl;
if (!BASE) { server = createStaticServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); BASE = `http://127.0.0.1:${server.address().port}/`; }
const URL = BASE + (BASE.includes('?') ? '&' : '?') + 'platform=win';
const browser = await chromium.launch();
const results = []; let fails = 0;
const check = (ok, msg) => { results.push({ ok: !!ok, msg }); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const origin = new globalThis.URL(BASE).origin;
async function fresh(ctx) {
  const page = await ctx.newPage(); const log = { req: [], errors: [], csp: [] };
  page.on('request', (r) => log.req.push({ url: r.url(), method: r.method(), body: r.postData() ? r.postData().length : 0 }));
  page.on('pageerror', (e) => log.errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') log.errors.push(m.text()); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  await page.goto(URL); await page.waitForFunction(() => window.tintwork && window.tintwork.newDocument);
  return { page, log };
}
const jpeg = async (page, w, h) => page.evaluate(async ({ w, h }) => { const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#246'); g.addColorStop(1, '#fc6'); x.fillStyle = g; x.fillRect(0, 0, w, h); return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer())]; }, { w, h });

// 1. Privacy: a full edit session sends nothing anywhere
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true }); const { page, log } = await fresh(ctx);
  const bytes = await jpeg(page, 1600, 1000);
  await page.setInputFiles('#fileInput', { name: 'private.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => window.tintwork.doc && window.tintwork.doc.width === 1600, null, { timeout: 30000 });
  await page.evaluate(async () => { const t = window.tintwork; t.run('autoEnhance'); await t.idle(); t.run('invert'); await t.idle(); await t.renderExport('image/jpeg', 0.9); await t.renderExport('image/png16', 1).catch(() => {}); });
  await page.waitForTimeout(1500);
  const third = log.req.filter((r) => !r.url.startsWith(origin) && !/^(blob|data):/.test(r.url));
  const posts = log.req.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  check(third.length === 0, `no third-party requests during open/edit/export (${log.req.length} requests, third-party: ${third.map((r) => r.url).slice(0, 3).join(', ') || 'none'})`);
  check(posts.length === 0, `no uploads: every request is GET (${posts.map((r) => `${r.method} ${r.url}`).slice(0, 2).join(', ') || 'none'})`);
  const csp = await page.evaluate(() => ({ meta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '', v: window.__csp }));
  check(/connect-src 'self'/.test(csp.meta) && /default-src 'self'/.test(csp.meta), `Content-Security-Policy limits connections to the site itself (${csp.meta.slice(0, 60)}…)`);
  check(csp.v.length === 0, `no CSP violations during the session (${csp.v.slice(0, 3).join(' | ') || 'none'})`);
  check(log.errors.length === 0, `no console errors (${log.errors.slice(0, 2).join(' | ') || 'none'})`);
  await ctx.close();
}

// 2. Unsaved-changes guard and crash recovery
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const { page } = await fresh(ctx);
  await page.evaluate(async () => { const t = window.tintwork; t.newDocument(800, 600, 'white', 'unsaved work'); t.run('invert'); await t.idle(); });
  await page.mouse.click(640, 300); // Chrome only shows the leave-page prompt after a real user gesture (sticky activation)
  let guarded = false; page.on('dialog', async (d) => { if (d.type() === 'beforeunload') guarded = true; await d.dismiss().catch(() => {}); });
  await page.close({ runBeforeUnload: true }); await new Promise((r) => setTimeout(r, 800));
  check(guarded, 'closing a tab with unsaved changes asks first (beforeunload)');
  // the page is still open after the dismissed prompt: wait for autosave, then "crash" (close without unload handlers)
  const p2 = ctx.pages()[0] || null;
  if (p2) { await p2.waitForTimeout(4500); await p2.evaluate(() => window.tintwork.autosaveNow?.()); await p2.close({ runBeforeUnload: false }); }
  const { page: p3 } = await fresh(ctx);
  const rec = await p3.waitForSelector('#modal:not(.hidden)', { timeout: 8000 }).then(() => p3.textContent('#modalBody')).catch(() => '');
  check(/unsaved work|recover|restore/i.test(rec || ''), `after a crash the next visit offers recovery ("${(rec || '').replace(/\s+/g, ' ').slice(0, 80)}")`);
  await ctx.close();
}

// 3. Storage failure: autosave errors are reported, not silent
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const page = await ctx.newPage();
  await page.addInitScript(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { if (window.__quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return put.apply(this, arguments); }; });
  await page.goto(URL); await page.waitForFunction(() => window.tintwork && window.tintwork.newDocument);
  const msg = await page.evaluate(async () => { const t = window.tintwork; window.__quota = true; t.newDocument(400, 300, 'white', 'q'); t.run('invert'); await t.idle(); await t.autosaveNow?.(); await new Promise((r) => setTimeout(r, 300)); return document.querySelector('#toast')?.textContent || document.querySelector('#status')?.textContent || ''; });
  check(/autosave/i.test(msg) && /quota|unavailable|save/i.test(msg), `a full disk / quota error shows a warning ("${msg.replace(/\s+/g, ' ').slice(0, 90)}")`);
  await ctx.close();
}

// 4. Oversized / corrupt files fail gracefully
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const { page, log } = await fresh(ctx);
  // a PNG header claiming 60000 × 60000 px (3.6 gigapixels) with no image data
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ihdr = Buffer.alloc(25); ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'ascii'); ihdr.writeUInt32BE(60000, 8); ihdr.writeUInt32BE(60000, 12); ihdr[16] = 8; ihdr[17] = 6;
  await page.setInputFiles('#fileInput', { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.concat([sig, ihdr, Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])]) });
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({ doc: !!window.tintwork.doc, status: document.querySelector('#status')?.textContent || '', toast: document.querySelector('#toast')?.textContent || '', modal: !document.querySelector('#modal')?.classList.contains('hidden') ? document.querySelector('#modalBody')?.textContent : '' }));
  check(!st.doc && /(could not|can't|cannot|failed|too large|not supported|unsupported|corrupt)/i.test(st.status + st.toast + st.modal), `a corrupt 60000×60000 PNG is refused with a message ("${(st.status || st.toast || st.modal).replace(/\s+/g, ' ').slice(0, 90)}")`);
  check(!log.errors.some((e) => /Uncaught|TypeError|RangeError/.test(e)), `no uncaught errors on the bad file (${log.errors.slice(0, 1).join('') || 'none'})`);
  await ctx.close();
}

// 5. Keyboard-only basics
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const { page } = await fresh(ctx);
  await page.evaluate(() => window.tintwork.newDocument(800, 600, 'white', 'kbd'));
  await page.keyboard.press('Alt'); await page.waitForTimeout(200);
  const altMenu = await page.evaluate(() => { const a = document.activeElement; return a && a.closest && !!a.closest('#menus') ? a.textContent.trim() : null; });
  await page.keyboard.press('Escape');
  check(altMenu, `Alt moves focus to the menu bar ("${altMenu}") so menus work without a mouse`);
  await page.keyboard.press('Control+l'); // Levels
  const modal = await page.waitForSelector('#modal:not(.hidden)', { timeout: 3000 }).then(() => true).catch(() => false);
  const inModal = modal && await page.evaluate(() => document.querySelector('#modal').contains(document.activeElement));
  for (let i = 0; i < 40 && modal; i++) await page.keyboard.press('Tab');
  const trapped = modal && await page.evaluate(() => document.querySelector('#modal').contains(document.activeElement));
  check(modal && inModal && trapped, `a dialog takes focus and Tab stays inside it (opened ${modal}, focus inside ${inModal}, after 40 Tabs ${trapped})`);
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => document.querySelector('#modal').classList.contains('hidden'));
  check(closed, 'Escape closes the dialog');
  const focusStyle = await page.evaluate(() => { const b = document.querySelector('#toolbar button'); b.focus(); const s = getComputedStyle(b, ':focus-visible'); return [...document.styleSheets].some((ss) => { try { return [...ss.cssRules].some((r) => /focus-visible/.test(r.selectorText || '')); } catch { return false; } }); });
  check(focusStyle, 'a :focus-visible outline style exists for keyboard users');
  await ctx.close();
}

// 6. Ctrl shortcuts that Chrome / Edge on Windows keep for themselves: the app must not depend on them
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const { page } = await fresh(ctx);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#menus .menu-items button .kbd, #menus .menu-items button kbd, #menus .menu-items button span:last-child')].map((s) => s.textContent.trim()).filter((s) => /Ctrl|Alt|Shift/.test(s)));
  const bad = labels.filter((s) => /^(Ctrl\+N|Ctrl\+T|Ctrl\+W|Ctrl\+Shift\+N|Ctrl\+Shift\+T|Ctrl\+Shift\+W|Ctrl\+Tab|Ctrl\+Shift\+Tab|Alt\+F4|Ctrl\+Shift\+I|Ctrl\+Shift\+J)$/i.test(s.replace(/\s/g, '')));
  check(labels.length > 10 && bad.length === 0, `no menu advertises a browser-reserved shortcut (${labels.length} shortcuts listed; reserved used: ${bad.join(', ') || 'none'})`);
  await ctx.close();
}

const outArg = process.argv.indexOf('--json'); if (outArg > 0) fs.writeFileSync(process.argv[outArg + 1], JSON.stringify({ date: new Date().toISOString(), base: BASE, results }, null, 1));
console.log(`\n${results.length - fails}/${results.length} safety checks passed`);
await browser.close(); server?.close(); process.exit(fails ? 1 : 0);
