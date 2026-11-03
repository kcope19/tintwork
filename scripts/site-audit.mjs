// Site audit: loads the published site (default: the live GitHub Pages URL) in Chromium the way a first-time
// visitor would, and reports first-load size and time, console errors, failed requests, third-party requests,
// service worker / offline behaviour, PWA manifest, page metadata and broken links in README + user guide.
// Usage: node scripts/site-audit.mjs [url] [--label before|after] [--runs 3]
import { chromium, webkit, devices } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const URL0 = args.find((a) => /^https?:/.test(a)) || 'https://kcope19.github.io/tintwork/';
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'run';
const RUNS = args.includes('--runs') ? +args[args.indexOf('--runs') + 1] : 3;
const origin = new URL(URL0).origin;
const out = { url: URL0, label, date: new Date().toISOString(), runs: [], checks: [] };
const check = (ok, msg, extra) => { out.checks.push({ ok: !!ok, msg, ...(extra ? { extra } : {}) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

async function coldLoad(browserType, ctxOpts = {}) {
  const b = await browserType.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ...ctxOpts });
  const page = await ctx.newPage();
  const reqs = [], errors = [], failed = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', async (r) => { reqs.push({ url: r.url(), status: r.status(), fromSW: r.fromServiceWorker() }); });
  const cdp = browserType === chromium ? await ctx.newCDPSession(page) : null;
  let bytes = 0; if (cdp) { await cdp.send('Network.enable'); cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; }); }
  const t0 = Date.now();
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.tintwork && document.querySelector('#welcome:not(.hidden)'), null, { timeout: 30000 });
  const tReady = Date.now() - t0;
  await page.waitForTimeout(1500);
  const swReady = await page.evaluate(async () => { if (!('serviceWorker' in navigator)) return 'unsupported'; const r = await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 15000))]); return r ? 'ready' : 'timeout'; });
  const version = await page.evaluate(() => window.tintwork?.APP_VERSION);
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const p = performance.getEntriesByType('paint'); return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: Math.round(p.find((x) => x.name === 'first-contentful-paint')?.startTime || 0) }; });
  const firstBytes = bytes;
  // wait for the SW to finish precaching, then go offline and reload
  await page.waitForTimeout(4000);
  let offline = 'skipped';
  try {
    await page.reload({ waitUntil: 'load' });
    const controlled = await page.evaluate(() => !!navigator.serviceWorker?.controller);
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => window.tintwork && document.querySelector('#welcome:not(.hidden)'), null, { timeout: 20000 });
    offline = controlled ? 'works' : 'not-controlled';
  } catch (e) { offline = `fails: ${String(e).slice(0, 120)}`; }
  await ctx.setOffline(false);
  await b.close();
  return { engine: browserType.name(), tReady, nav, firstBytes, requests: reqs.length, thirdParty: [...new Set(reqs.map((r) => new URL(r.url).origin).filter((o) => o !== origin && !o.startsWith('blob') && !o.startsWith('data')))], bad: reqs.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`), failed, errors, swReady, offline, version };
}

for (let i = 0; i < RUNS; i++) { const r = await coldLoad(chromium); out.runs.push(r); console.log(JSON.stringify(r)); }
try { out.webkit = await coldLoad(webkit, { ...devices['iPhone 14'] }); console.log('webkit', JSON.stringify(out.webkit)); } catch (e) { out.webkit = { error: String(e) }; }

const R = out.runs, med = (k) => R.map(k).sort((a, b) => a - b)[Math.floor(R.length / 2)];
out.summary = { readyMs: med((r) => r.tReady), fcpMs: med((r) => r.nav.fcp), firstLoadKB: Math.round(med((r) => r.firstBytes) / 1024), requests: med((r) => r.requests) };
check(R.every((r) => !r.errors.length), `no console errors on load (${RUNS}/${RUNS} runs)`, R.flatMap((r) => r.errors));
check(R.every((r) => !r.bad.length && !r.failed.length), 'no 4xx/5xx or failed requests on load', R.flatMap((r) => [...r.bad, ...r.failed]));
check(R.every((r) => !r.thirdParty.length), 'no third-party requests (all same-origin)', R.flatMap((r) => r.thirdParty));
check(R.every((r) => r.swReady === 'ready'), 'service worker installs');
check(R.every((r) => r.offline === 'works'), 'reload works offline after the first visit', R.map((r) => r.offline));

// metadata / manifest
{
  const html = await (await fetch(URL0)).text();
  const has = (re) => re.test(html);
  check(has(/<meta name="description"/), 'meta description present');
  check(has(/property="og:title"/) && has(/property="og:image"/), 'social preview (Open Graph title + image)');
  check(has(/http-equiv="Content-Security-Policy"/), 'Content-Security-Policy present');
  check(has(/<link rel="canonical"/), 'canonical link');
  const man = await (await fetch(new URL('manifest.webmanifest', URL0))).json();
  check(man.name && man.short_name && man.start_url && man.display && man.icons.some((i) => i.sizes === '512x512') && man.icons.some((i) => i.purpose === 'maskable'), 'manifest has the fields Chrome / Edge need to offer install');
  for (const ic of man.icons) { const r = await fetch(new URL(ic.src, URL0)); check(r.ok, `manifest icon ${ic.src} loads (${r.status})`); }
  const nf = await fetch(new URL('no-such-page-xyz', URL0)); const nft = await nf.text();
  check(nf.status === 404 && /Tintwork/.test(nft), `unknown URLs show a Tintwork 404 page (status ${nf.status})`);
  for (const p of ['sw.js', 'index.html']) { const r = await fetch(new URL(p, URL0)); check(r.ok, `${p} served (cache-control: ${r.headers.get('cache-control')})`); }
}

// links in README and user guide
{
  const md = ['README.md', 'docs/USER_GUIDE.md'].map((f) => [f, readFileSync(f, 'utf8')]);
  const links = new Set();
  for (const [f, t] of md) for (const m of t.matchAll(/\]\(([^)\s]+)\)/g)) links.add(`${f}|${m[1]}`);
  const broken = [];
  for (const k of links) {
    const [f, l] = k.split('|'); if (l.startsWith('#') || l.startsWith('mailto:')) continue;
    let u; if (/^https?:/.test(l)) u = l; else u = new URL(l, `https://github.com/kcope19/tintwork/blob/main/${f}`).href;
    try { const r = await fetch(u, { method: 'GET', redirect: 'follow' }); if (r.status >= 400) broken.push(`${f}: ${l} → ${r.status}`); } catch (e) { broken.push(`${f}: ${l} → ${e.message}`); }
  }
  check(!broken.length, `README / user guide links resolve (${links.size} checked)`, broken);
}
console.log('summary', out.summary);
mkdirSync('docs/audit', { recursive: true });
writeFileSync(`docs/audit/site-audit-${label}.json`, JSON.stringify(out, null, 2));
