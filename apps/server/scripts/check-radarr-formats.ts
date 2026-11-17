/**
 * Checks Marquee's rule matching against Radarr's own: takes Radarr's custom
 * formats (yours, e.g. from Profilarr), asks Radarr for a movie's search
 * results (which lists the formats Radarr matched on each), and checks
 * Marquee matches the same ones.
 *
 *   pnpm --filter @marquee/server exec tsx scripts/check-radarr-formats.ts <marquee.sqlite> <tmdbId> [tmdbId…]
 *
 * Read-only, but each movie makes Radarr search your indexers once (nothing is grabbed).
 */
import { openDb, getSetting } from '../src/db/index.js';
import { matches, unsupported, type Rule } from '../src/releases/formats.js';
import { parseRelease } from '../src/releases/parse.js';

const [dbPath, ...ids] = process.argv.slice(2);
if (!dbPath || ids.length === 0) {
  console.error('Usage: check-radarr-formats.ts <marquee.sqlite> <tmdbId> [tmdbId…]');
  process.exit(1);
}
const db = openDb(dbPath);
const url = getSetting(db, 'services.radarr_url');
const key = getSetting(db, 'services.radarr_api_key');
db.$client.close();
if (!url || !key) throw new Error('Connect Radarr in Settings → Services first.');

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${url}/api/v3${path}`, { headers: { 'X-Api-Key': key! }, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Radarr answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

type ApiSpec = { name: string; implementation: string; negate: boolean; required: boolean; fields: { name: string; value: unknown }[] };
type ApiFormat = { id: number; name: string; specifications: ApiSpec[] };
const formats = (await get<ApiFormat[]>('/customformat')).map(
  (f): Rule => ({
    trash_id: String(f.id),
    name: f.name,
    specifications: f.specifications.map((s) => ({ name: s.name, implementation: s.implementation, negate: s.negate, required: s.required, fields: Object.fromEntries(s.fields.map((x) => [x.name, x.value])) })),
  }),
);
const skipped = formats.filter((f) => unsupported(f));
const checkable = formats.filter((f) => !unsupported(f));
console.log(`${formats.length} of your custom formats, ${checkable.length} checkable by Marquee${skipped.length ? `; left out: ${skipped.map((f) => `${f.name} (${unsupported(f)})`).join(', ')}` : ''}`);

const movies = await get<{ id: number; tmdbId: number; title: string; originalLanguage?: { name: string } }[]>('/movie');
let agree = 0;
let total = 0;
const differences = new Map<string, string[]>();
for (const tmdbId of ids.map(Number)) {
  const movie = movies.find((m) => m.tmdbId === tmdbId);
  if (!movie) {
    console.log(`TMDB ${tmdbId} isn't in Radarr`);
    continue;
  }
  type ApiRelease = { title: string; size: number; indexerFlags?: number; mappedMovieId?: number; customFormats?: { id: number; name: string }[] };
  const all = await get<ApiRelease[]>(`/release?movieId=${movie.id}`);
  // Radarr doesn't score copies it took for another movie ("Matrix Reloaded" in a Matrix search), so neither do we here.
  const releases = all.filter((r) => r.mappedMovieId === movie.id);
  console.log(`\n${movie.title}: ${all.length} copies, ${releases.length} for this movie`);
  for (const r of releases) {
    const parsed = parseRelease(r.title);
    const theirs = new Set((r.customFormats ?? []).map((f) => f.name).filter((n) => checkable.some((c) => c.name === n)));
    const ours = new Set(
      checkable.filter((f) => matches(f, { app: 'radarr', title: r.title, parsed, size: r.size, freeleech: ((r.indexerFlags ?? 0) & 1) === 1, originalLanguage: movie.originalLanguage?.name })).map((f) => f.name),
    );
    total++;
    const missing = [...theirs].filter((n) => !ours.has(n));
    const extra = [...ours].filter((n) => !theirs.has(n));
    if (!missing.length && !extra.length) agree++;
    for (const n of missing) differences.set(`Radarr only: ${n}`, [...(differences.get(`Radarr only: ${n}`) ?? []), r.title]);
    for (const n of extra) differences.set(`Marquee only: ${n}`, [...(differences.get(`Marquee only: ${n}`) ?? []), r.title]);
  }
}
console.log(`\n${agree} of ${total} copies: exactly the same custom formats as Radarr (${((agree / total) * 100).toFixed(1)}%)\n`);
for (const [k, titles] of [...differences.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${k}  (${titles.length})`);
  for (const t of titles.slice(0, 4)) console.log(`    ${t}`);
}
