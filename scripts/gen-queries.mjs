#!/usr/bin/env node
// Emits site/queries.json: {key: PromQL expression} for every site/lib/queries.js Q entry — the
// one allow-list both the wall (snapshot lookups, site/lib/prom.js) and the publisher
// (homelab-wall-feed, which polls exactly these queries) read. Regenerated on every
// install/release (ci.yml, release-please.yml); never hand-edited. Run: node scripts/gen-queries.mjs
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, 'site/queries.json');

const { Q } = await import(join(root, 'site/lib/queries.js'));

if (!Q || Object.keys(Q).length === 0) {
  console.error('gen-queries: site/lib/queries.js exported no Q entries');
  process.exit(1);
}

writeFileSync(dest, JSON.stringify(Q, null, 2) + '\n');

if (!existsSync(dest)) {
  console.error(`gen-queries: expected ${dest} after write, not found`);
  process.exit(1);
}
console.log(`gen-queries: wrote ${Object.keys(Q).length} queries ->`, dest);
