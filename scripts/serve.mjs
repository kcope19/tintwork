// Tiny static server for Tintwork. Only the files the app needs are served (no .git,
// tests or assets), with no-cache headers so edits show up on the next reload.
// Usage: node scripts/serve.mjs [port] [--isolated]   (default 8080, binds 127.0.0.1; --isolated sends COOP/COEP)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
const ALLOW = [/^\/$/, /^\/index\.html$/, /^\/manifest\.webmanifest$/, /^\/sw\.js$/, /^\/src\/[\w.-]+\.(js|css|svg)$/, /^\/icons\/[\w.-]+\.png$/, /^\/fonts\/([\w-]+\/)?[\w.-]+\.(woff2|css|txt|md)$/, /^\/vendor\/[\w-]+\/[\w.-]+\.(js|wasm)$/, /^\/vendor\/[\w-]+\/LICENSE(-[A-Z]+)?$/];

/** isolated: send COOP/COEP like the _headers file does on Netlify / Cloudflare Pages (enables threaded RAW decode). */
export function createStaticServer({ isolated = false } = {}) {
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if (!ALLOW.some((r) => r.test(pathname))) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      ...(pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
      ...(isolated ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = +process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 8080, isolated = process.argv.includes('--isolated');
  createStaticServer({ isolated }).listen(port, '127.0.0.1', () => console.log(`Tintwork on http://127.0.0.1:${port}/${isolated ? ' (cross-origin isolated: COOP/COEP)' : ''} (${new Date().toISOString()})`));
}
