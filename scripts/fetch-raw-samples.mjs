// Downloads the camera RAW samples listed in test-assets/raw-samples.json (all CC0 1.0, from raw.pixls.us) into
// test-assets/raw-samples/ (git-ignored: 15–30 MB each). The v1.1 test uses them when present and skips them otherwise.
// Usage: node scripts/fetch-raw-samples.mjs [name-filter]
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const list = JSON.parse(readFileSync('test-assets/raw-samples.json', 'utf8')).samples;
const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
mkdirSync('test-assets/raw-samples', { recursive: true });
for (const s of list) {
  if (filter && !filter.test(s.local)) continue;
  const path = `test-assets/raw-samples/${s.local}`;
  if (existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex') === s.sha256) { console.log(`have  ${s.local}`); continue; }
  process.stdout.write(`fetch ${s.local} (${s.mb} MB, ${s.license}) … `);
  const res = await fetch(encodeURI(s.url)); if (!res.ok) { console.log(`HTTP ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer()), sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== s.sha256) { console.log('checksum mismatch, not saved'); continue; }
  writeFileSync(path, buf); console.log('ok');
}
