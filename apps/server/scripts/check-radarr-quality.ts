/**
 * Compares Marquee's release-name parser with Radarr's own verdict on every
 * movie file Radarr has. Read-only: it only lists movies from Radarr.
 *
 *   pnpm --filter @marquee/server exec tsx scripts/check-radarr-quality.ts <marquee.sqlite>
 *
 * Uses the Radarr address and key saved in Settings → Services of that database.
 */
import { openDb, getSetting } from '../src/db/index.js';
import { parseRelease } from '../src/releases/parse.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: check-radarr-quality.ts <marquee.sqlite>');
  process.exit(1);
}
const db = openDb(dbPath);
const url = getSetting(db, 'services.radarr_url');
const key = getSetting(db, 'services.radarr_api_key');
db.$client.close();
if (!url || !key) {
  console.error('Connect Radarr in Settings → Services first.');
  process.exit(1);
}

type MovieFile = { relativePath: string; sceneName?: string; originalFilePath?: string; quality: { quality: { name: string } } };
const res = await fetch(`${url}/api/v3/movie`, { headers: { 'X-Api-Key': key } });
if (!res.ok) throw new Error(`Radarr answered ${res.status}`);
const movies = (await res.json()) as { title: string; movieFile?: MovieFile }[];

let same = 0;
let total = 0;
const differ = new Map<string, string[]>();
for (const m of movies) {
  const f = m.movieFile;
  if (!f) continue;
  // The release name Radarr grabbed is the fairest input; fall back to the file name.
  const name = f.sceneName || f.originalFilePath?.split('/').pop() || f.relativePath.split('/').pop()!;
  const ours = parseRelease(name).quality;
  const theirs = f.quality.quality.name;
  total++;
  if (ours === theirs) same++;
  else {
    const k = `Radarr ${theirs} · Marquee ${ours}`;
    differ.set(k, [...(differ.get(k) ?? []), name]);
  }
}
console.log(`\n${same} of ${total} files: same quality as Radarr (${((same / total) * 100).toFixed(1)}%)\n`);
for (const [k, names] of [...differ.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${k}  (${names.length})`);
  for (const n of names.slice(0, 6)) console.log(`    ${n}`);
}
