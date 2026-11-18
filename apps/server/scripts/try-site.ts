/**
 * Runs one site file against the real site and prints what came back: for
 * checking the engine by hand on a machine with internet. Read-only (search
 * results only); not used by tests.
 *
 *   pnpm --filter @marquee/server exec tsx scripts/try-site.ts <site.yml> movie "Dune Part Two" 2024
 *   pnpm --filter @marquee/server exec tsx scripts/try-site.ts <site.yml> tv "Severance" 2 1
 *   pnpm --filter @marquee/server exec tsx scripts/try-site.ts <site.yml> recent tv
 *   pnpm --filter @marquee/server exec tsx scripts/try-site.ts knaben tv "Severance" 2 1     (a built-in site, by id)
 */
import fs from 'node:fs';
import { CardigannSite } from '../src/sources/sites/cardigann.js';
import { BUILTIN } from '../src/sources/sites/catalogue.js';
import { readDefinition, unsupportedReason } from '../src/sources/sites/definition.js';
import { SiteHttp, realSiteFetch } from '../src/sources/sites/http.js';
import type { SearchQuery } from '../src/sources/torznab.js';

const [file, kind, a, b, c] = process.argv.slice(2);
if (!file || !kind) throw new Error('Usage: try-site.ts <site.yml> movie|tv|recent <title|kind> [year|season] [episode]');
const http = new SiteHttp({ fetch: realSiteFetch, session: { cookies: {}, userAgent: null }, saveSession: () => {}, solver: async () => null, timeoutMs: 30_000 });
const builtin = BUILTIN[file];
const def = builtin ? null : readDefinition(fs.readFileSync(file, 'utf8'));
const why = def && unsupportedReason(def);
if (why) throw new Error(`Can't run ${def!.name}: ${why}`);
const name = builtin ? builtin.summary.name : def!.name;
const site = builtin
  ? builtin.create({ settings: {}, baseUrl: process.env.SITE_URL ?? builtin.links[0]!, http, now: Date.now })
  : new CardigannSite({ def: def!, settings: {}, baseUrl: process.env.SITE_URL ?? def!.links[0]!, http, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
const query: SearchQuery =
  kind === 'recent' ? { kind: 'recent', for: (a as 'movie' | 'tv') ?? 'tv' } : kind === 'movie' ? { kind: 'movie', title: a!, year: b ? Number(b) : null } : { kind: 'tv', title: a!, season: b ? Number(b) : undefined, episode: c ? Number(c) : undefined };
const t0 = Date.now();
const found = await site.search(query, null);
console.log(`${name}: ${found.length} copies in ${Date.now() - t0} ms`);
for (const r of found.slice(0, 8)) {
  console.log(`  ${r.title}  |  ${r.size ? (r.size / 1e9).toFixed(1) + ' GB' : '?'}  |  seeders ${r.seeders ?? '?'}  |  ${r.publishedAt ? new Date(r.publishedAt).toISOString().slice(0, 10) : '?'}  |  cats ${r.categories.join(',')}  |  ${r.downloadUrl.startsWith('magnet:') ? 'magnet' : 'link'}${r.resolveDownload ? ' (+page)' : ''}`);
}
if (found[0]?.resolveDownload && process.env.RESOLVE) {
  const d = await found[0].resolveDownload();
  console.log(`  first copy downloads from: ${d.url.startsWith('magnet:') ? 'a magnet' : new URL(d.url).host}`);
}
