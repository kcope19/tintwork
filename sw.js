// Tintwork service worker: makes the editor work offline once it has been opened.
// Network-first for app files (so updates show up immediately when online), falling
// back to the cache when offline. All paths are relative to this file, so the app
// can live in any sub-folder of any static host.
const CACHE = 'tintwork-shell-v1.1.0';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './src/main.js', './src/pixels.js', './src/selection.js', './src/ops.js', './src/worker.js', './src/icons.js',
  './src/curves-editor.js', './src/autosave.js', './src/gpu.js', './src/deep.js', './src/png.js', './src/platform.js', './src/webgpu.js', './src/files.js', './src/bench.js', './src/mesh.js', './src/layerfx.js', './src/auto.js', './src/looks.js', './src/presets.js', './src/batch.js', './vendor/fflate/fflate.js',
  './src/codecs.js', './src/codec-worker.js', './src/psd.js', './src/raw.js', // v1.1 (the RAW decoder's .wasm is cached the first time a RAW file is opened)
  './vendor/flashraw/browser.js', './vendor/flashraw/core.js', './vendor/flashraw/errors.js', './vendor/flashraw/threads.js', './vendor/flashraw/flashraw_bindgen.js', './vendor/flashraw/flashraw_bindgen_jxl.js',
  './src/styles.css', './src/logo.svg', './src/user-guide.js',
  './fonts/fonts.css', './fonts/inter/inter-latin-400-normal.woff2', './fonts/inter/inter-latin-700-normal.woff2',
  './fonts/lora/lora-latin-400-normal.woff2', './fonts/lora/lora-latin-700-normal.woff2', './fonts/bebas-neue/bebas-neue-latin-400-normal.woff2',
  './fonts/pacifico/pacifico-latin-400-normal.woff2', './fonts/jetbrains-mono/jetbrains-mono-latin-400-normal.woff2', './fonts/jetbrains-mono/jetbrains-mono-latin-700-normal.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
      const res = await fetch(req);
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
