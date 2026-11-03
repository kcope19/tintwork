// Tintwork service worker: makes the editor work offline once it has been opened.
// Network-first for app files (so updates show up immediately when online), falling
// back to the cache when offline. All paths are relative to this file, so the app
// can live in any sub-folder of any static host.
// v1.7: every network fetch revalidates with the server (cache: 'no-cache'), so a host that sends
// max-age (GitHub Pages: 10 minutes) cannot serve a mix of old and new modules after a deploy; the
// precache bypasses the HTTP cache too. A new worker takes over at once and the page shows a
// "new version ready, reload" bar (see src/main.js).
const CACHE = 'tintwork-shell-v1.11.0';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './src/main.js', './src/pixels.js', './src/selection.js', './src/ops.js', './src/worker.js', './src/icons.js',
  './src/curves-editor.js', './src/autosave.js', './src/gpu.js', './src/deep.js', './src/png.js', './src/platform.js', './src/webgpu.js', './src/files.js', './src/bench.js', './src/mesh.js', './src/layerfx.js', './src/auto.js', './src/looks.js', './src/presets.js', './src/batch.js', './src/segment.js', './vendor/fflate/fflate.js',
  './src/codecs.js', './src/codec-worker.js', './src/develop-worker.js', './src/psd.js', './src/raw.js', './src/gpu-develop.js', // v1.1 / v1.2 / v1.6
  // v1.2: the RAW decoder's WebAssembly is pre-cached so camera RAW files open offline from the first visit
  './vendor/flashraw/flashraw_simd.wasm', './vendor/flashraw/flashraw.wasm',
  './vendor/flashraw/browser.js', './vendor/flashraw/core.js', './vendor/flashraw/errors.js', './vendor/flashraw/threads.js', './vendor/flashraw/flashraw_bindgen.js', './vendor/flashraw/flashraw_bindgen_jxl.js',
  './src/styles.css', './src/logo.svg', './src/user-guide.js',
  './fonts/fonts.css', './fonts/inter/inter-latin-400-normal.woff2', './fonts/inter/inter-latin-700-normal.woff2',
  './fonts/lora/lora-latin-400-normal.woff2', './fonts/lora/lora-latin-700-normal.woff2', './fonts/bebas-neue/bebas-neue-latin-400-normal.woff2',
  './fonts/pacifico/pacifico-latin-400-normal.woff2', './fonts/jetbrains-mono/jetbrains-mono-latin-400-normal.woff2', './fonts/jetbrains-mono/jetbrains-mono-latin-700-normal.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];

// Cached too, but a failure does not stop the install: the decoder build for JPEG XL compressed DNG files (4.5 MB).
const EXTRA = ['./vendor/flashraw/flashraw_simd_jxl.wasm', './vendor/flashraw/flashraw_simd_threads.wasm', './vendor/flashraw/flashraw_bindgen_threads.js', './vendor/flashraw/thread-worker.browser.js'];

const fresh = (u) => new Request(u, { cache: 'reload' });

self.addEventListener('message', (e) => { if (e.data && e.data.type === 'VERSION' && e.ports[0]) e.ports[0].postMessage(CACHE.replace(/^tintwork-shell-v/, '')); });

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map(fresh)).then(() => Promise.all(EXTRA.map((u) => c.add(fresh(u)).catch(() => {})))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tintwork-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // revalidate instead of trusting the HTTP cache (navigations cannot be re-initialised, so rebuild them from the URL)
      const res = await fetch(req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(req, { cache: 'no-cache' }));
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      throw err;
    }
  })());
});
