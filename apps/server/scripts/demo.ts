/**
 * Demo mode: runs Marquee with a fake TMDB and a generated sample library, so
 * the UI can be tried without internet access or real media.
 *   pnpm --filter @marquee/server demo        (serves the built web app on :9797)
 * Data lives in a temp folder and is thrown away. Sign up as any admin.
 * Settings → Sources: link Prowlarr at http://prowlarr:9696 with the key prowlarr-key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb, setSetting } from '../src/db/index.js';
import { RateLimiter } from '../src/auth/rateLimit.js';
import { PlexClient, plexClientId } from '../src/auth/plex.js';
import { LibraryScanner } from '../src/library/scanner.js';
import { FakeTmdb } from '../test/fakes/tmdb.js';
import { FakeSites, release, site } from '../test/fakes/sources.js';
import { SourceService } from '../src/sources/service.js';
import { TorznabError } from '../src/sources/torznab.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-demo-'));
const GB = 1024 ** 3;
function file(rel: string, size: number, ageDays: number) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  const t = new Date(Date.now() - ageDays * 86400_000);
  fs.utimesSync(p, t, t);
}
file('movies/The Matrix (1999)/The Matrix (1999) Bluray-1080p.mkv', 8 * GB, 400);
file('movies/Dune Part Two (2024) {tmdb-693134}/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.DV.HDR.H.265-FLUX.mkv', 21 * GB, 2);
file('movies/Inside.Out.2.2024.1080p.WEB-DL.DDP5.1.H.264-GRP/Inside.Out.2.2024.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv', 6 * GB, 3);
file('movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) Remux-2160p.mkv', 60 * GB, 100);
file('movies/Up (2009)/Up (2009) WEBDL-720p.mkv', 2 * GB, 30);
file('movies/weird-folder-name/movie.mkv', 4 * GB, 50);
file('tv/Severance (2022)/Season 01/Severance - S01E01 - Good News About Hell [WEBDL-2160p][DV HDR10][h265].mkv', 5 * GB, 5);
file('tv/Severance (2022)/Season 01/Severance - S01E02 - Half Loop [WEBDL-2160p][DV HDR10][h265].mkv', 5 * GB, 5);
file('tv/Severance (2022)/Season 02/Severance - S02E01 - Hello, Ms. Cobel [WEBDL-2160p].mkv', 5 * GB, 1);
file('tv/Bluey (2018) {tvdb-353546}/Season 1/Bluey.S01E01-E03.720p.WEBRip.mkv', GB, 10);

const config = { ...loadConfig(), webDir: process.env.MARQUEE_WEB_DIR ?? path.resolve('../web/dist') };
const db = openDb(':memory:');
setSetting(db, 'services.tmdb_api_key', 'good-key');
setSetting(db, 'library.movies_root', path.join(root, 'movies'));
setSetting(db, 'library.tv_root', path.join(root, 'tv'));
const tmdb = new FakeTmdb();

// A fake Prowlarr at http://prowlarr:9696 (key "prowlarr-key") with a few sites, one of them failing.
const sites = new FakeSites();
sites.prowlarrSites = [
  site(1, 'YTS', { categories: [2000, 2040, 2045] }),
  site(2, 'EZTV', { categories: [5000, 5040] }),
  site(3, 'IPTorrents', { privacy: 'private', priority: 10 }),
  site(4, 'MyAnonamouse', { privacy: 'private', categories: [7000, 3030] }),
  site(5, 'The Pirate Bay'),
];
const dune = [
  release('Dune.Part.Two.2024.2160p.UHD.BluRay.x265.10bit.HDR.DDP5.1.Atmos-GROUP', { seeders: 412, size: 18 * GB }),
  release('Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX', { seeders: 260, size: 7 * GB }),
];
sites.feed('http://prowlarr:9696/1/api', { releases: dune });
sites.feed('http://prowlarr:9696/2/api', { releases: [] });
sites.feed('http://prowlarr:9696/3/api', { releases: dune });
sites.feed('http://prowlarr:9696/5/api', { fail: new TorznabError('blocked', 'The site has a bot check in front of it.') });
const clients = { tmdb: () => tmdb, arr: () => Promise.reject(new Error('not in demo')) as never, torznab: sites.torznab, prowlarr: sites.prowlarr };
const app = createApp({
  db,
  config,
  oidc: null,
  plex: () => new PlexClient(plexClientId(db)),
  loginLimiter: new RateLimiter(100, 60_000),
  clients,
  scanner: new LibraryScanner(db),
  sources: new SourceService(db, clients),
  now: Date.now,
});
serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`Marquee demo on http://localhost:${i.port} (library at ${root})`));
