/**
 * Runs one search through every Source in a Marquee database and prints what
 * came back. For trying things against real sites from a dev machine.
 *
 *   pnpm --filter @marquee/server exec tsx scripts/search.ts <db> movie "Dune: Part Two" 2024 [tmdbId] [imdbId]
 *   pnpm --filter @marquee/server exec tsx scripts/search.ts <db> tv "Severance" [tvdbId] [season] [episode] [imdbId]
 *
 * Download links carry API keys, so they are never printed. Counts toward each
 * Source's daily limit like any other search.
 */
import { openDb } from '../src/db/index.js';
import { SourceService } from '../src/sources/service.js';
import { TorznabClient } from '../src/sources/torznab.js';
import { ProwlarrClient } from '../src/sources/prowlarr.js';

const [dbPath, kind, title, ...rest] = process.argv.slice(2);
if (!dbPath || (kind !== 'movie' && kind !== 'tv') || !title) {
  console.error('Usage: search.ts <db> movie <title> [year] [tmdbId] [imdbId]  |  search.ts <db> tv <title> [tvdbId] [season] [episode] [imdbId]');
  process.exit(1);
}
const n = (v: string | undefined) => (v ? Number(v) : undefined);

const db = openDb(dbPath);
const sources = new SourceService(db, {
  torznab: (url, key, timeoutMs) => new TorznabClient(url, key, timeoutMs),
  prowlarr: (url, key) => new ProwlarrClient(url, key),
});

const query =
  kind === 'movie'
    ? { kind: 'movie' as const, title, year: n(rest[0]) ?? null, tmdbId: n(rest[1]) ?? null, imdbId: rest[2] ?? null }
    : { kind: 'tv' as const, title, tvdbId: n(rest[0]) ?? null, season: n(rest[1]), episode: n(rest[2]), imdbId: rest[3] ?? null };

const started = Date.now();
const out = await sources.search(query);
console.log(`\n${out.releases.length} copies in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
for (const s of out.sources) console.log(`  ${s.name.padEnd(16)} ${s.status.padEnd(9)} ${String(s.results).padStart(4)}  ${s.ms ? `${s.ms} ms` : ''} ${s.message ?? ''}`);
console.log('');
const gb = (b: number | null) => (b === null ? '   ?   ' : `${(b / 1024 ** 3).toFixed(1).padStart(5)} GB`);
for (const r of [...out.releases].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0)).slice(0, 40)) {
  console.log(`  ${String(r.seeders ?? '?').padStart(5)} sharing  ${gb(r.size)}  ${r.sourceName.padEnd(14)} ${r.title}`);
}
db.$client.close();
