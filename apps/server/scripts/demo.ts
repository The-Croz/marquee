/**
 * Demo mode: runs Marquee with a fake TMDB and a generated sample library, so
 * the UI can be tried without internet access or real media.
 *   pnpm --filter @marquee/server demo        (serves the built web app on :9797)
 * Data lives in a temp folder and is thrown away. Sign up as any admin.
 * Settings → Sources: link Prowlarr at http://prowlarr:9696 with the key prowlarr-key.
 * Settings → Downloader: a fake qBittorrent at http://qbittorrent:8080 (admin / adminadmin).
 * Settings → Services: fake Plex at http://plex:32400 (token plex-token), Jellyfin at http://jellyfin:8096 (key jellyfin-key).
 * Radarr (http://radarr:7878) and Sonarr (http://sonarr:8989) are fakes too, already filled in.
 * Severance season 2 airs around today, so the Calendar and "Coming up this week" have something to show.
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
import { FakeQbit, fakeFetchTorrent } from '../test/fakes/qbittorrent.js';
import { FakeMediaServer } from '../test/fakes/mediaServers.js';

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
// Move Severance season 2 and a new Bluey episode around today, so the calendar has something on it.
const dayOffset = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
const tmdbSeason = tmdb.season.bind(tmdb);
tmdb.season = async (showId, season) => {
  const eps = await tmdbSeason(showId, season);
  if (showId === 95396 && season === 2) {
    return [
      { ...eps[0]!, airDate: dayOffset(-8) },
      { season: 2, episode: 2, title: 'Goodbye, Mrs. Selvig', airDate: dayOffset(-1), overview: null },
      { season: 2, episode: 3, title: 'Who Is Alive?', airDate: dayOffset(2), overview: null },
      { season: 2, episode: 4, title: 'Woe’s Hollow', airDate: dayOffset(9), overview: null },
    ];
  }
  if (showId === 82728 && season === 1) return [...eps, { season: 1, episode: 4, title: 'Daddy Robot', airDate: dayOffset(1), overview: null }];
  return eps;
};

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
radarr.movies = [
  { title: 'Dune: Part Two', monitored: true },
  { title: 'The Matrix', monitored: true },
  { title: 'Up', monitored: false },
];
setSetting(db, 'services.radarr_url', 'http://radarr:7878');
setSetting(db, 'services.radarr_api_key', 'radarr-key');
// A fake Sonarr at http://sonarr:8989, still watching both shows, for the TV switch-over checklist.
const sonarr = new FakeRadarr();
sonarr.movies = [
  { title: 'Severance', monitored: true },
  { title: 'Bluey', monitored: true },
];
setSetting(db, 'services.sonarr_url', 'http://sonarr:8989');
setSetting(db, 'services.sonarr_api_key', 'sonarr-key');
// A fake qBittorrent at http://qbittorrent:8080 (admin / adminadmin), behind a VPN that's up.
const qbit = new FakeQbit();
setSetting(db, 'downloader.url', 'http://qbittorrent:8080');
setSetting(db, 'downloader.username', 'admin');
setSetting(db, 'downloader.password', 'adminadmin');
const qbitTvHashes = new Set<string>();
/** The copy name for each fake torrent, so finished ones get a real-looking file name. */
const qbitNames = new Map<string, string>();
// Make the fake qBittorrent's downloads move along. TV episodes get stuck with nobody sharing, to show that state.
setInterval(() => {
  for (const t of qbit.list) {
    if (t.progress >= 1) {
      // Sharing: the ratio climbs so the seeding rule can be seen working.
      t.ratio += 0.25;
      t.seedingSeconds += 6 * 3600;
      continue;
    }
    if (t.state === 'stoppedDL') continue;
    if (t.state === 'metaDL') {
      t.state = 'downloading';
      continue;
    }
    if (qbitTvHashes.has(t.hash)) {
      Object.assign(t, { state: 'stalledDL', downloadSpeed: 0, seedsConnected: 0, seedsKnown: 0 });
      continue;
    }
    t.progress = Math.min(1, t.progress + 0.05);
    if (t.progress >= 1) {
      // Finished: put a (sparse) file where qBittorrent would have saved it, so Marquee can put it in the library.
      t.name = qbitNames.get(t.hash) ?? t.name;
      t.size = 3 * GB;
      file(`torrents/${t.name}/${t.name}.mkv`, t.size, 0);
      t.savePath = path.join(root, 'torrents');
    }
    Object.assign(t, { downloadSpeed: 6.5 * 1024 ** 2, eta: Math.round(((1 - t.progress) / 0.02) * 3), seedsConnected: 40, state: t.progress >= 1 ? 'stalledUP' : 'downloading' });
  }
}, 3000).unref();
// Fake Plex (http://plex:32400, token plex-token) and Jellyfin (http://jellyfin:8096, key jellyfin-key), using the demo's library folders.
const plex = new FakeMediaServer('plex', [
  { id: '1', name: 'Movies', kind: 'movie', locations: [path.join(root, 'movies')] },
  { id: '2', name: 'TV Shows', kind: 'tv', locations: [path.join(root, 'tv')] },
]);
const jellyfin = new FakeMediaServer('jellyfin', [
  { id: 'a1', name: 'Movies', kind: 'movie', locations: [path.join(root, 'movies')] },
  { id: 'b2', name: 'Shows', kind: 'tv', locations: [path.join(root, 'tv')] },
]);
const clients = {
  plexServer: (url: string, token: string) => plex.as(url, token),
  jellyfin: (url: string, key: string) => jellyfin.as(url, key),
  qbittorrent: (url: string, user: string, pass: string) => qbit.as(url, user, pass),
  fetchTorrent: async (url: string) => {
    const t = await fakeFetchTorrent()(url);
    const name = new URL(url).searchParams.get('file');
    if (name) qbitNames.set(t.infoHash, name);
    if (/S\d\dE\d\d/i.test(decodeURIComponent(url))) qbitTvHashes.add(t.infoHash);
    return t;
  },
  tmdb: () => tmdb, arr: (kind: 'radarr' | 'sonarr') => (kind === 'sonarr' ? sonarr : radarr), radarrHistory: () => radarr, torznab: sites.torznab, prowlarr: sites.prowlarr };
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
