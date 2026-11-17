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
import { FakeRadarr, grab, radarrRelease } from '../test/fakes/radarr.js';

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
// Every feed answers every search with these; Marquee sorts out which fit the title.
const dune = [
  release('Dune.Part.Two.2024.2160p.UHD.BluRay.x265.10bit.HDR.DDP5.1.Atmos-GROUP', { seeders: 412, size: 18 * GB, infoHash: 'a1' }),
  release('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { seeders: 290, size: 25 * GB, infoHash: 'a2' }),
  release('Dune.Part.Two.2024.2160p.MA.WEB-DL.DDP5.1.HDR.H.265-HONE', { seeders: 41, size: 20 * GB, infoHash: 'a3' }),
  release('Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX', { seeders: 260, size: 7 * GB, infoHash: 'a4' }),
  release('Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-FGT', { seeders: 88, size: 72 * GB, infoHash: 'a5' }),
  release('Dune.Part.Two.2024.1080p.WEBRip.x265.10bit-LAMA', { seeders: 900, size: 2 * GB, infoHash: 'a6' }),
  release('Dune.Part.Two.2024.2160p.WEB-DL.H.265-TINY', { seeders: 12, size: 3 * GB, infoHash: 'a7' }),
  release('Dune.Part.Two.2024.1080p.WEB-DL.H.264-NOBODY', { seeders: 0, size: 6 * GB, infoHash: 'a8' }),
  release('Dune.2021.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { seeders: 150, size: 22 * GB, infoHash: 'a9' }),
  release('Severance.S02E01.Hello.Ms.Cobel.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { seeders: 120, size: 6 * GB, infoHash: 'b1' }),
  release('Severance.S02E01.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb', { seeders: 300, size: 3 * GB, infoHash: 'b2' }),
  release('Severance.S02E02.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb', { seeders: 250, size: 3 * GB, infoHash: 'b3' }),
  release('Severance.S02.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { seeders: 80, size: 60 * GB, infoHash: 'b4' }),
];
sites.feed('http://prowlarr:9696/1/api', { releases: dune });
sites.feed('http://prowlarr:9696/2/api', { releases: [] });
sites.feed('http://prowlarr:9696/3/api', { releases: dune });
sites.feed('http://prowlarr:9696/5/api', { fail: new TorznabError('blocked', 'The site has a bot check in front of it.') });
// A fake Radarr at http://radarr:7878 with a few downloads to compare against.
const radarr = new FakeRadarr();
const day = 86400_000;
radarr.history = [
  grab(101, 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { date: Date.now() - 2 * day }),
  grab(102, 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-FGT', { id: 102, date: Date.now() - 3 * day, quality: 'Remux-2160p' }),
  grab(103, 'Dune.Part.Two.2024.1080p.WEBRip.x265.10bit-LAMA', { date: Date.now() - 4 * day, quality: 'WEBRip-1080p', score: -100 }),
  grab(104, 'Some.Movie.Not.In.Library.2023.1080p.WEB-DL-GRP', { radarrMovieId: 9, tmdbId: 1, movieTitle: 'Some Movie', date: Date.now() - 5 * day }),
];
radarr.lists.set(1, dune.map((r) => radarrRelease(r.title, { size: r.size, seeders: r.seeders, infoHash: r.infoHash })));
setSetting(db, 'services.radarr_url', 'http://radarr:7878');
setSetting(db, 'services.radarr_api_key', 'radarr-key');
const clients = { tmdb: () => tmdb, arr: () => radarr, radarrHistory: () => radarr, torznab: sites.torznab, prowlarr: sites.prowlarr };
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
