// Copies docs/USER_GUIDE.md into src/user-guide.js (the in-app Help ▸ User guide reads the module, so the guide
// is cached for offline use like the rest of the app). Run after editing the guide: npm run guide
import { readFileSync, writeFileSync } from 'node:fs';
const md = readFileSync(new URL('../docs/USER_GUIDE.md', import.meta.url), 'utf8');
writeFileSync(new URL('../src/user-guide.js', import.meta.url), `// Generated from docs/USER_GUIDE.md by scripts/build-guide.mjs. Do not edit.\nexport default ${JSON.stringify(md)};\n`);
console.log(`src/user-guide.js written (${md.length} chars)`);
